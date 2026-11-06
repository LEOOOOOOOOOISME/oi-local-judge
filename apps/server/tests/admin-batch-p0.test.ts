import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { registerAdminBatchRoutes } from '../src/http/admin-batch.js';
import { startScheduler, type SchedulerHandle } from '../src/judge/scheduler.js';
import { hashPassword } from '../src/security/password.js';
import { importProblemDirectory } from '../src/services/problems.js';
import { createUser, getUserByUsername } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'admin-batch-p0-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: FastifyInstance;
let scheduler: SchedulerHandle;
let problemId = 0;

const AC_SOURCE =
  '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}';
const WA_SOURCE =
  '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b+1<<"\\n";}';

function encode(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

async function upload(zip: Uint8Array): Promise<string> {
  const uploaded = await app.inject({
    method: 'POST',
    url: '/api/admin/batch/upload',
    headers: { 'content-type': 'application/zip' },
    payload: Buffer.from(zip),
  });
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  return (uploaded.json() as { data: { uploadId: string } }).data.uploadId;
}

async function waitForBatch(batchId: number): Promise<{
  status: string;
  total: number;
  skippedCount: number;
  errorCount: number;
  importedCount: number;
  items: Array<{
    id: number;
    student: string;
    sourcePath: string;
    problemId: number | null;
    importStatus: string | null;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
    verdict: string | null;
    submissionId: number | null;
  }>;
  skipped: Array<{ student: string; errorCode: string }>;
  errors: Array<{ student: string; errorCode: string; errorMessage: string }>;
}> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/batch/${batchId}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { data: Awaited<ReturnType<typeof waitForBatch>> };
    if (body.data.status !== 'running' || Date.now() > deadline) return body.data;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  problemId = importProblemDirectory({
    db,
    config,
    sourceDir: join(process.cwd(), 'tools/seed/sample-problem'),
  });
  app = Fastify({ logger: false });
  app.addContentTypeParser(
    ['application/octet-stream', 'application/zip'],
    { parseAs: 'buffer', bodyLimit: 64 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
  registerAdminBatchRoutes(app, {
    db,
    config,
    adminGuard: async () => {},
    maxSourceBytes: 1024,
  });
  await app.ready();
  scheduler = startScheduler({ db, config, pollIntervalMs: 50 });
});

afterAll(async () => {
  await scheduler.stop();
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('admin batch P0 failure isolation', () => {
  it('imports valid sources and reports skipped/error items without a 500', async () => {
    const uploadId = await upload(
      zipSync({
        'Alice/mapped/main.cpp': encode(AC_SOURCE),
        'Alice/mapped/zzz.cpp': encode(WA_SOURCE),
        'Bob/mapped/empty.cpp': new Uint8Array(0),
        'Carol/mapped/huge.cpp': new Uint8Array(4096).fill(65),
        'Dave/notes.txt': encode('not source'),
        'Empty/': new Uint8Array(0),
        'Grace/unknown/main.cpp': encode(AC_SOURCE),
      }),
    );

    const started = await app.inject({
      method: 'POST',
      url: '/api/admin/batch/run',
      payload: {
        uploadId,
        studentLevel: 1,
        problemLevel: 2,
        problemMap: { mapped: problemId },
      },
    });
    expect(started.statusCode, started.body).toBe(201);
    const runData = (started.json() as {
      data: {
        id: number;
        count: number;
        status: string;
        total: number;
        skippedCount: number;
        errorCount: number;
        duplicateCount: number;
        skipped: Array<{ student: string; errorCode: string }>;
        errors: Array<{ student: string; errorCode: string }>;
      };
    }).data;
    expect(runData.count).toBe(1);
    expect(runData.total).toBe(6);
    expect(runData.skippedCount).toBe(2);
    expect(runData.errorCount).toBe(3);
    expect(runData.duplicateCount).toBe(1);
    expect(runData.status).not.toBe('failed');
    expect(new Set(runData.skipped.map((item) => item.student))).toEqual(new Set(['Dave', 'Empty']));
    expect(new Set(runData.errors.map((item) => item.errorCode))).toEqual(
      new Set(['EMPTY_SOURCE', 'SOURCE_TOO_LARGE', 'UNMAPPED_PROBLEM']),
    );

    const job = await waitForBatch(runData.id);
    expect(job.status).toBe('finished');
    expect(job.total).toBe(6);
    expect(job.skippedCount).toBe(2);
    expect(job.errorCount).toBe(3);
    expect(job.importedCount).toBe(1);

    const alice = job.items.filter((item) => item.student === 'Alice');
    expect(alice).toHaveLength(1);
    expect(alice[0]!.sourcePath).toBe('Alice/mapped/main.cpp');
    expect(alice[0]!.importStatus).toBe('imported');
    expect(alice[0]!.verdict).toBe('AC');
    expect(alice[0]!.submissionId).toBeTypeOf('number');

    const byStudent = new Map(job.items.map((item) => [item.student, item]));
    expect(byStudent.get('Bob')?.errorCode).toBe('EMPTY_SOURCE');
    expect(byStudent.get('Carol')?.errorCode).toBe('SOURCE_TOO_LARGE');
    expect(byStudent.get('Grace')?.errorCode).toBe('UNMAPPED_PROBLEM');
    expect(byStudent.get('Dave')?.importStatus).toBe('skipped');
    expect(byStudent.get('Dave')?.errorCode).toBe('INVALID_STUDENT_FOLDER');
    expect(byStudent.get('Empty')?.importStatus).toBe('skipped');
    expect(byStudent.get('Empty')?.errorCode).toBe('INVALID_STUDENT_FOLDER');
    expect(byStudent.get('Dave')?.submissionId).toBeNull();
    expect(job.skipped.map((item) => item.errorCode)).toEqual([
      'INVALID_STUDENT_FOLDER',
      'INVALID_STUDENT_FOLDER',
    ]);
    expect(job.errors.map((item) => item.errorCode).sort()).toEqual([
      'EMPTY_SOURCE',
      'SOURCE_TOO_LARGE',
      'UNMAPPED_PROBLEM',
    ]);
  }, 40_000);

  it('finishes as failed when every source fails', async () => {
    const uploadId = await upload(
      zipSync({
        'Huge/mapped/huge.cpp': new Uint8Array(4096).fill(65),
        'Nobody/readme.txt': encode('nothing to submit'),
      }),
    );
    const started = await app.inject({
      method: 'POST',
      url: '/api/admin/batch/run',
      payload: {
        uploadId,
        studentLevel: 1,
        problemLevel: 2,
        problemMap: { mapped: problemId },
      },
    });
    expect(started.statusCode, started.body).toBe(201);
    const data = (started.json() as {
      data: { id: number; status: string; count: number; skippedCount: number; errorCount: number };
    }).data;
    expect(data.status).toBe('failed');
    expect(data.count).toBe(0);
    expect(data.skippedCount).toBe(1);
    expect(data.errorCount).toBe(1);

    const job = await waitForBatch(data.id);
    expect(job.status).toBe('failed');
    expect(job.importedCount).toBe(0);
    expect(job.items.every((item) => item.importStatus === 'skipped' || item.importStatus === 'error')).toBe(
      true,
    );
  }, 20_000);

  it('rejects a zip with no student sources', async () => {
    const uploadId = await upload(zipSync({ 'notes.txt': encode('nothing') }));
    const started = await app.inject({
      method: 'POST',
      url: '/api/admin/batch/run',
      payload: { uploadId, problemId, studentLevel: 1 },
    });
    expect(started.statusCode).toBe(400);
    expect((started.json() as { error: { code: string } }).error.code).toBe('NO_SOURCES');
  }, 20_000);

  it('paginates batch items with a bounded page size', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let index = 0; index < 5; index += 1) {
      files[`P${index}/mapped/main.cpp`] = encode(AC_SOURCE);
    }
    const uploadId = await upload(zipSync(files));
    const started = await app.inject({
      method: 'POST',
      url: '/api/admin/batch/run',
      payload: {
        uploadId,
        studentLevel: 1,
        problemLevel: 2,
        problemMap: { mapped: problemId },
      },
    });
    expect(started.statusCode, started.body).toBe(201);
    const batchId = (started.json() as { data: { id: number } }).data.id;

    const first = await app.inject({
      method: 'GET',
      url: `/api/admin/batch/${batchId}?offset=0&limit=2`,
    });
    const firstData = (first.json() as {
      data: { items: unknown[]; total: number; offset: number; limit: number };
    }).data;
    expect(first.statusCode, first.body).toBe(200);
    expect(firstData.items).toHaveLength(2);
    expect(firstData.total).toBe(5);
    expect(firstData.offset).toBe(0);
    expect(firstData.limit).toBe(2);

    const middle = (
      (
        await app.inject({ method: 'GET', url: `/api/admin/batch/${batchId}?offset=2&limit=2` })
      ).json() as { data: { items: unknown[]; offset: number } }
    ).data;
    expect(middle.items).toHaveLength(2);
    expect(middle.offset).toBe(2);

    const last = (
      (
        await app.inject({ method: 'GET', url: `/api/admin/batch/${batchId}?offset=4&limit=2` })
      ).json() as { data: { items: unknown[] } }
    ).data;
    expect(last.items).toHaveLength(1);

    const capped = (
      (
        await app.inject({ method: 'GET', url: `/api/admin/batch/${batchId}?limit=99999` })
      ).json() as { data: { items: unknown[]; limit: number } }
    ).data;
    expect(capped.limit).toBe(1000);
    expect(capped.items).toHaveLength(5);

    await waitForBatch(batchId);
  }, 40_000);

  it('reuses an existing synthetic batch student instead of failing', async () => {
    const existing = createUser(db, {
      username: 'batch_Reuse',
      passwordHash: hashPassword('existing-pass'),
      realName: 'Reuse',
      role: 'contestant',
    });
    const uploadId = await upload(zipSync({ 'Reuse/main.cpp': encode(AC_SOURCE) }));
    const started = await app.inject({
      method: 'POST',
      url: '/api/admin/batch/run',
      payload: { uploadId, problemId, studentLevel: 1 },
    });
    expect(started.statusCode, started.body).toBe(201);
    const batchId = (started.json() as { data: { id: number } }).data.id;
    const job = await waitForBatch(batchId);
    const item = job.items.find((entry) => entry.student === 'Reuse');
    expect(item?.importStatus).toBe('imported');
    let userId: number | null = null;
    if (item?.submissionId) {
      const row = db
        .prepare('SELECT user_id FROM submissions WHERE id = ?')
        .get(item.submissionId) as { user_id: number } | undefined;
      userId = row?.user_id ?? null;
    }
    expect(userId).toBe(existing);
    expect(getUserByUsername(db, 'batch_Reuse')?.id).toBe(existing);
  }, 40_000);

  it('gives long student names stable, distinct synthetic usernames', async () => {
    const first = `${'A'.repeat(80)}1`;
    const second = `${'A'.repeat(80)}2`;
    const uploadId = await upload(
      zipSync({
        [`${first}/main.cpp`]: encode(AC_SOURCE),
        [`${second}/main.cpp`]: encode(AC_SOURCE),
      }),
    );
    const started = await app.inject({
      method: 'POST',
      url: '/api/admin/batch/run',
      payload: { uploadId, problemId, studentLevel: 1 },
    });
    expect(started.statusCode, started.body).toBe(201);
    const data = (started.json() as {
      data: { id: number; count: number; errorCount: number };
    }).data;
    expect(data.count).toBe(2);
    expect(data.errorCount).toBe(0);

    const rows = db
      .prepare("SELECT username FROM users WHERE username LIKE 'batch_%' AND username <> 'batch_Reuse'")
      .all() as unknown as Array<{ username: string }>;
    const longNames = rows.filter((row) => row.username.includes('AAAAAAAAAA'));
    expect(longNames).toHaveLength(2);
    expect(longNames[0]!.username).not.toBe(longNames[1]!.username);
    expect(longNames.every((row) => row.username.length <= 64)).toBe(true);

    await waitForBatch(data.id);
  }, 40_000);
});
