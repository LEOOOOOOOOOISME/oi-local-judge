import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'admin-problems-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie = '';
let contestantCookie = '';

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  const adminId = createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  const contestantId = createUser(db, {
    username: 'alice',
    passwordHash: hashPassword('alice123'),
    role: 'contestant',
  });
  adminCookie = `oij.sid=${signSession({ userId: adminId, version: 0 }, config.sessionSecret, 3600)}`;
  contestantCookie = `oij.sid=${signSession(
    { userId: contestantId, version: 0 },
    config.sessionSecret,
    3600,
  )}`;
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('admin problem assets and data', () => {
  it('creates a problem, uploads std, compiles it and imports data zip', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/problems',
      headers: { cookie: adminCookie },
      payload: { title: 'Asset Test', type: 'standard', timeMs: 1000, memoryMb: 64 },
    });
    expect(created.statusCode).toBe(201);
    const problemId = (created.json() as { data: { id: number } }).data.id;

    const upload = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/assets/std?name=std.cpp`,
      headers: { cookie: adminCookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('#include <iostream>\nint main(){std::cout<<"ok";}'),
    });
    expect(upload.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${problemId}/assets`,
      headers: { cookie: adminCookie },
    });
    expect((list.json() as { data: unknown[] }).data).toHaveLength(1);

    const source = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${problemId}/assets/std/source`,
      headers: { cookie: adminCookie },
    });
    expect(source.statusCode).toBe(200);
    expect((source.json() as { data: { source: string } }).data.source).toContain('int main');

    const compiled = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/assets/std/compile`,
      headers: { cookie: adminCookie },
    });
    expect(compiled.statusCode).toBe(200);
    expect((compiled.json() as { data: { compiled: boolean } }).data.compiled).toBe(true);

    const zip = zipSync({
      'data/1.in': new TextEncoder().encode('1 2\n'),
      'data/1.out': new TextEncoder().encode('3\n'),
      'data/2.in': new TextEncoder().encode('2 3\n'),
      'data/2.out': new TextEncoder().encode('5\n'),
    });
    const imported = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/data/import?points=50`,
      headers: { cookie: adminCookie, 'content-type': 'application/zip' },
      payload: Buffer.from(zip),
    });
    expect(imported.statusCode).toBe(201);

    const testcases = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${problemId}/testcases`,
      headers: { cookie: adminCookie },
    });
    const rows = (testcases.json() as { data: Array<{ id: number; points: number }> }).data;
    expect(rows).toHaveLength(2);
    expect(rows[0].points).toBe(50);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/admin/problems/${problemId}/testcases`,
      headers: { cookie: adminCookie },
      payload: { items: rows.map((row) => ({ id: row.id, points: 60 })) },
    });
    expect(updated.statusCode).toBe(200);
  }, 30_000);

  it('rejects zip entries that escape the data directory', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/problems',
      headers: { cookie: adminCookie },
      payload: { title: 'Zip Slip', type: 'standard', timeMs: 1000, memoryMb: 64 },
    });
    const problemId = (created.json() as { data: { id: number } }).data.id;
    const zip = zipSync({
      '../escape.in': new TextEncoder().encode('x'),
      '../escape.out': new TextEncoder().encode('x'),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/data/import`,
      headers: { cookie: adminCookie, 'content-type': 'application/zip' },
      payload: Buffer.from(zip),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('UNSAFE_PATH');
  });

  it('forbids contestants from the admin API', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/problems',
      headers: { cookie: contestantCookie },
      payload: { title: 'Nope', timeMs: 1000, memoryMb: 64 },
    });
    expect(res.statusCode).toBe(403);
  });
});
