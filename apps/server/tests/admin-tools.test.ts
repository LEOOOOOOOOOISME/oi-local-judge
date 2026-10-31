import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'admin-tools-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  const adminId = createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  cookie = `oij.sid=${signSession({ userId: adminId, version: 0 }, config.sessionSecret, 3600)}`;
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function upload(problemId: number, kind: string, name: string, path: string) {
  return app.inject({
    method: 'POST',
    url: `/api/admin/problems/${problemId}/assets/${kind}?name=${name}`,
    headers: { cookie, 'content-type': 'application/octet-stream' },
    payload: readFileSync(join(process.cwd(), 'tests/fixtures/tools', path)),
  });
}

describe('generator and stress tools', () => {
  it('generates data with std answers and appends testcases', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/problems',
      headers: { cookie },
      payload: { title: 'Generate', timeMs: 3000, memoryMb: 128 },
    });
    const problemId = (created.json() as { data: { id: number } }).data.id;
    expect((await upload(problemId, 'generator', 'generator.cpp', 'generator.cpp')).statusCode).toBe(201);
    expect((await upload(problemId, 'std', 'std.cpp', 'std.cpp')).statusCode).toBe(201);

    const generated = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/generate`,
      headers: { cookie },
      payload: { count: 2, seedStart: 5, points: 60 },
    });
    expect(generated.statusCode, generated.body).toBe(201);
    const body = generated.json() as { data: { generated: Array<{ seed: number }>; total: number } };
    expect(body.data.generated.map((row) => row.seed)).toEqual([5, 6]);
    expect(body.data.total).toBe(2);

    const testcases = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${problemId}/testcases`,
      headers: { cookie },
    });
    const rows = (testcases.json() as { data: Array<{ points: number }> }).data;
    expect(rows).toHaveLength(2);
    expect(rows[0].points).toBe(60);
  }, 60_000);

  it('finds a counterexample with std vs brute', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/problems',
      headers: { cookie },
      payload: { title: 'Stress', timeMs: 3000, memoryMb: 128 },
    });
    const problemId = (created.json() as { data: { id: number } }).data.id;
    await upload(problemId, 'generator', 'generator.cpp', 'generator.cpp');
    await upload(problemId, 'std', 'std.cpp', 'std.cpp');
    await upload(problemId, 'brute', 'brute.cpp', 'brute.cpp');

    const stressed = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/stress`,
      headers: { cookie },
      payload: { rounds: 3, seedStart: 1 },
    });
    expect(stressed.statusCode, stressed.body).toBe(200);
    const body = stressed.json() as {
      data: {
        passed: number;
        total: number;
        mismatch: { seed: number; input: string; stdOutput: string; bruteOutput: string } | null;
      };
    };
    expect(body.data.mismatch).not.toBeNull();
    expect(body.data.mismatch?.seed).toBe(1);
    expect(body.data.mismatch?.input).toContain('1');
    expect(body.data.mismatch?.stdOutput.trim()).not.toBe(body.data.mismatch?.bruteOutput.trim());
  }, 60_000);
});
