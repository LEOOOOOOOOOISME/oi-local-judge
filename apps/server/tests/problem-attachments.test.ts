import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createProblem, type ProblemOwnerType } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(tmpdir(), 'oij-attachments-'));
const db: DatabaseSync = openDatabase(join(root, 'test.db'));
const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;

const ids = { admin: 0, owner: 0, other: 0, alice: 0 };
const cookies: Record<string, string> = {};

function seedUser(username: string, role: 'admin' | 'setter' | 'contestant'): number {
  return createUser(db, {
    username,
    passwordHash: hashPassword(`${username}123`),
    role,
  });
}

function makeProblem(options: {
  title: string;
  visibility?: 'public' | 'hidden';
  ownerType?: ProblemOwnerType;
  ownerId?: number | null;
}): number {
  return createProblem(db, {
    title: options.title,
    type: 'standard',
    difficulty: 2,
    tags: ['attachment'],
    timeMs: 1000,
    memoryMb: 128,
    visibility: options.visibility ?? 'public',
    ownerType: options.ownerType ?? 'system',
    ownerId: options.ownerId ?? null,
    testcases: [],
  });
}

interface AttachmentDto {
  id: number;
  problemId: number;
  filename: string;
  size: number;
  mime: string;
  visibility: string;
  createdAt: number;
  downloadUrl: string;
}

interface ApiError {
  ok: false;
  error: { code: string; message?: string };
}

interface UploadOptions {
  name?: string;
  mime?: string;
  visibility?: string;
  replace?: number;
}

async function upload(
  problemId: number,
  who: keyof typeof cookies | null,
  data: Buffer,
  options: UploadOptions = {},
) {
  const query = new URLSearchParams();
  if (options.name !== undefined) query.set('name', options.name);
  if (options.visibility !== undefined) query.set('visibility', options.visibility);
  if (options.replace !== undefined) query.set('replace', String(options.replace));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return app.inject({
    method: 'POST',
    url: `/api/admin/problems/${problemId}/attachments${suffix}`,
    headers: {
      ...(who ? { cookie: cookies[who] } : {}),
      'content-type': options.mime ?? 'application/octet-stream',
    },
    payload: data,
  });
}

async function download(attachmentId: number, who: keyof typeof cookies | null = null) {
  return app.inject({
    method: 'GET',
    url: `/api/attachments/${attachmentId}`,
    headers: who ? { cookie: cookies[who] } : {},
  });
}

async function list(problemId: number, who: keyof typeof cookies | null = null) {
  return app.inject({
    method: 'GET',
    url: `/api/problems/${problemId}/attachments`,
    headers: who ? { cookie: cookies[who] } : {},
  });
}

async function adminList(problemId: number, who: keyof typeof cookies = 'admin') {
  return app.inject({
    method: 'GET',
    url: `/api/admin/problems/${problemId}/attachments`,
    headers: { cookie: cookies[who] },
  });
}

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  ids.admin = seedUser('admin', 'admin');
  ids.owner = seedUser('owner', 'setter');
  ids.other = seedUser('other', 'setter');
  ids.alice = seedUser('alice', 'contestant');
  for (const [name, id] of Object.entries(ids)) {
    cookies[name] = `oij.sid=${signSession({ userId: id, version: 0 }, config.sessionSecret, 3600)}`;
  }
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('problem attachments', () => {
  it('lets the owner upload a PDF, lists it and streams it back with safe headers', async () => {
    const problemId = makeProblem({ title: 'Attachment PDF', ownerType: 'user', ownerId: ids.owner });
    const created = await upload(problemId, 'owner', Buffer.from('%PDF-1.7 hello'), {
      name: 'guide.pdf',
      mime: 'application/pdf',
    });
    expect(created.statusCode).toBe(201);
    const dto = (created.json() as { data: AttachmentDto }).data;
    expect(dto.filename).toBe('guide.pdf');
    expect(dto.mime).toBe('application/pdf');
    expect(dto.problemId).toBe(problemId);
    expect(dto.size).toBe(14);
    expect(dto.visibility).toBe('problem');
    expect(dto.downloadUrl).toBe(`/api/attachments/${dto.id}`);
    // The real storage path must never leak through the API.
    expect(dto).not.toHaveProperty('storage_path');
    expect(dto).not.toHaveProperty('storagePath');
    expect(JSON.stringify(dto)).not.toContain('problems/');
    expect(dto).not.toHaveProperty('created_by');
  });

  it('exposes problem-visible attachments to everyone who can see the problem', async () => {
    const problemId = makeProblem({ title: 'Public list', ownerType: 'user', ownerId: ids.owner });
    const pdf = Buffer.from('%PDF-1.7');
    const first = await upload(problemId, 'owner', pdf, { name: 'a.pdf', mime: 'application/pdf' });
    const firstId = (first.json() as { data: AttachmentDto }).data.id;

    const anonymous = await list(problemId);
    expect(anonymous.statusCode).toBe(200);
    expect((anonymous.json() as { data: AttachmentDto[] }).data).toHaveLength(1);

    const contestant = await list(problemId, 'alice');
    expect(contestant.statusCode).toBe(200);
    expect((contestant.json() as { data: AttachmentDto[] }).data[0].id).toBe(firstId);
  });

  it('hides attachments of problems the caller cannot view', async () => {
    const problemId = makeProblem({
      title: 'Hidden list',
      visibility: 'hidden',
      ownerType: 'user',
      ownerId: ids.owner,
    });
    await upload(problemId, 'owner', Buffer.from('zzz'), {
      name: 'secret.zip',
      mime: 'application/zip',
    });
    expect((await list(problemId)).statusCode).toBe(404);
    expect((await list(problemId, 'alice')).statusCode).toBe(404);
    expect((await list(problemId, 'other')).statusCode).toBe(404);
    expect((await list(problemId, 'owner')).statusCode).toBe(200);
    expect((await adminList(problemId, 'admin')).statusCode).toBe(200);
  });

  it('downloads with content-type and attachment disposition while checking visibility', async () => {
    const problemId = makeProblem({ title: 'Download', ownerType: 'user', ownerId: ids.owner });
    const body = Buffer.from('PDF-BODY');
    const created = await upload(problemId, 'owner', body, {
      name: 'download.pdf',
      mime: 'application/pdf',
    });
    const dto = (created.json() as { data: AttachmentDto }).data;

    const response = await download(dto.id, 'alice');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-disposition']).toContain('download.pdf');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.rawPayload.equals(body)).toBe(true);

    // Unknown ids and missing files are both 404.
    expect((await download(999_999)).statusCode).toBe(404);
  });

  it('rejects unsupported file types and unsafe names', async () => {
    const problemId = makeProblem({ title: 'Reject', ownerType: 'user', ownerId: ids.owner });
    const exe = await upload(problemId, 'owner', Buffer.from('MZ'), {
      name: 'tool.exe',
      mime: 'application/octet-stream',
    });
    expect(exe.statusCode).toBe(400);
    expect((exe.json() as ApiError).error.code).toBe('UNSUPPORTED_TYPE');

    const traversal = await upload(problemId, 'owner', Buffer.from('%PDF'), {
      name: '../evil.pdf',
      mime: 'application/pdf',
    });
    expect(traversal.statusCode).toBe(400);
    expect((traversal.json() as ApiError).error.code).toBe('UNSAFE_FILENAME');

    const nested = await upload(problemId, 'owner', Buffer.from('%PDF'), {
      name: 'a/b.pdf',
      mime: 'application/pdf',
    });
    expect(nested.statusCode).toBe(400);
    expect((nested.json() as ApiError).error.code).toBe('UNSAFE_FILENAME');
  });

  it('accepts PDF, image and ZIP payloads and rejects non-allowed MIME declarations', async () => {
    const problemId = makeProblem({ title: 'Types', ownerType: 'user', ownerId: ids.owner });
    const cases: Array<[string, string, string]> = [
      ['doc.pdf', 'application/pdf', '%PDF-1.7'],
      ['picture.png', 'image/png', 'PNG'],
      ['bundle.zip', 'application/zip', 'PK'],
    ];
    for (const [name, mime, content] of cases) {
      const response = await upload(problemId, 'owner', Buffer.from(content), { name, mime });
      expect(response.statusCode).toBe(201);
      expect((response.json() as { data: AttachmentDto }).data.mime).toBe(mime);
    }

    const html = await upload(problemId, 'owner', Buffer.from('<html>'), {
      name: 'page.pdf',
      mime: 'text/html',
    });
    expect(html.statusCode).toBe(201);
    // Extension determines the served type; the declared type is never trusted.
    expect((html.json() as { data: AttachmentDto }).data.mime).toBe('application/pdf');
  });

  it('enforces the 50 MiB limit', async () => {
    const problemId = makeProblem({ title: 'Too big', ownerType: 'user', ownerId: ids.owner });
    const oversized = Buffer.alloc(50 * 1024 * 1024 + 1, 0x61);
    const response = await upload(problemId, 'owner', oversized, {
      name: 'big.bin.zip',
      mime: 'application/zip',
    });
    expect(response.statusCode).toBe(413);
    expect((response.json() as ApiError).error.code).toBe('FILE_TOO_LARGE');
  }, 60_000);

  it('requires an owner, team captain or admin to manage attachments', async () => {
    const problemId = makeProblem({ title: 'Permissions', ownerType: 'user', ownerId: ids.owner });
    const denied = await upload(problemId, 'other', Buffer.from('%PDF'), {
      name: 'x.pdf',
      mime: 'application/pdf',
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as ApiError).error.code).toBe('FORBIDDEN');

    const contestant = await upload(problemId, 'alice', Buffer.from('%PDF'), {
      name: 'x.pdf',
      mime: 'application/pdf',
    });
    expect(contestant.statusCode).toBe(403);

    const admin = await upload(problemId, 'admin', Buffer.from('%PDF'), {
      name: 'admin.pdf',
      mime: 'application/pdf',
    });
    expect(admin.statusCode).toBe(201);
  });

  it('supports admin-only attachments that others can neither list nor download', async () => {
    const problemId = makeProblem({ title: 'Admin only', ownerType: 'user', ownerId: ids.owner });
    const created = await upload(problemId, 'owner', Buffer.from('internal'), {
      name: 'internal.pdf',
      mime: 'application/pdf',
      visibility: 'admin',
    });
    expect(created.statusCode).toBe(201);
    const dto = (created.json() as { data: AttachmentDto }).data;

    const anonymous = await list(problemId);
    expect((anonymous.json() as { data: AttachmentDto[] }).data).toHaveLength(0);
    const alice = await list(problemId, 'alice');
    expect((alice.json() as { data: AttachmentDto[] }).data).toHaveLength(0);
    const ownerList = await list(problemId, 'owner');
    expect((ownerList.json() as { data: AttachmentDto[] }).data).toHaveLength(1);

    expect((await download(dto.id, 'alice')).statusCode).toBe(404);
    expect((await download(dto.id, 'owner')).statusCode).toBe(200);
  });

  it('replaces an attachment in place when replace is supplied', async () => {
    const problemId = makeProblem({ title: 'Replace', ownerType: 'user', ownerId: ids.owner });
    const created = await upload(problemId, 'owner', Buffer.from('old'), {
      name: 'old.pdf',
      mime: 'application/pdf',
    });
    const oldDto = (created.json() as { data: AttachmentDto }).data;

    const replaced = await upload(problemId, 'owner', Buffer.from('new-image'), {
      name: 'new.png',
      mime: 'image/png',
      replace: oldDto.id,
    });
    expect(replaced.statusCode).toBe(200);
    const dto = (replaced.json() as { data: AttachmentDto }).data;
    expect(dto.id).toBe(oldDto.id);
    expect(dto.filename).toBe('new.png');
    expect(dto.mime).toBe('image/png');
    expect(dto.size).toBe(9);
    expect((await adminList(problemId, 'admin')).json()).toMatchObject({
      data: [{ id: oldDto.id, filename: 'new.png' }],
    });

    const downloadAfter = await download(oldDto.id, 'owner');
    expect(downloadAfter.statusCode).toBe(200);
    expect(downloadAfter.rawPayload.toString()).toBe('new-image');
  });

  it('deletes the file and row, and refuses non-owners', async () => {
    const problemId = makeProblem({ title: 'Delete', ownerType: 'user', ownerId: ids.owner });
    const created = await upload(problemId, 'owner', Buffer.from('%PDF'), {
      name: 'gone.pdf',
      mime: 'application/pdf',
    });
    const dto = (created.json() as { data: AttachmentDto }).data;

    const denied = await app.inject({
      method: 'DELETE',
      url: `/api/admin/problems/${problemId}/attachments/${dto.id}`,
      headers: { cookie: cookies.other },
    });
    expect(denied.statusCode).toBe(403);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/admin/problems/${problemId}/attachments/${dto.id}`,
      headers: { cookie: cookies.owner },
    });
    expect(deleted.statusCode).toBe(200);

    expect((await download(dto.id, 'owner')).statusCode).toBe(404);
    expect((await adminList(problemId, 'owner')).json()).toMatchObject({ data: [] });
  });

  it('validates the problem, body, visibility and filename header safety', async () => {
    const problemId = makeProblem({ title: 'Validation', ownerType: 'user', ownerId: ids.owner });
    expect(
      (
        await upload(999_999, 'owner', Buffer.from('%PDF'), {
          name: 'x.pdf',
          mime: 'application/pdf',
        })
      ).statusCode,
    ).toBe(404);

    const empty = await upload(problemId, 'owner', Buffer.alloc(0), {
      name: 'empty.pdf',
      mime: 'application/pdf',
    });
    expect(empty.statusCode).toBe(400);
    expect((empty.json() as ApiError).error.code).toBe('EMPTY_BODY');

    const badVisibility = await upload(problemId, 'owner', Buffer.from('%PDF'), {
      name: 'v.pdf',
      mime: 'application/pdf',
      visibility: 'world',
    });
    expect(badVisibility.statusCode).toBe(400);
    expect((badVisibility.json() as ApiError).error.code).toBe('BAD_VISIBILITY');

    const quoted = await upload(problemId, 'owner', Buffer.from('note'), {
      name: '题解 "v2".pdf',
      mime: 'application/pdf',
    });
    expect(quoted.statusCode).toBe(201);
    const quotedDto = (quoted.json() as { data: AttachmentDto }).data;
    const response = await download(quotedDto.id, 'owner');
    const disposition = String(response.headers['content-disposition']);
    expect(disposition).toContain('attachment');
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
    expect(disposition).toContain("filename*=UTF-8''");
  });
});
