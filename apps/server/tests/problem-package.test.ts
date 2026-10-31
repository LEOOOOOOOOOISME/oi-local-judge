import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { importProblemDirectory } from '../src/services/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'package-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
let sourceProblemId = 0;

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  const adminId = createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  cookie = `oij.sid=${signSession({ userId: adminId, version: 0 }, config.sessionSecret, 3600)}`;
  sourceProblemId = importProblemDirectory({
    db,
    config,
    sourceDir: join(process.cwd(), 'tools/seed/sample-problem'),
  });
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('problem package export/import', () => {
  it('exports a zip and imports it back with data', async () => {
    const exported = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${sourceProblemId}/export`,
      headers: { cookie },
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers['content-type']).toContain('application/zip');

    const imported = await app.inject({
      method: 'POST',
      url: '/api/admin/problems/import-zip',
      headers: { cookie, 'content-type': 'application/zip' },
      payload: exported.rawPayload,
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const id = (imported.json() as { data: { id: number } }).data.id;
    const detail = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    const data = detail.json() as {
      data: { title: string; testcases?: unknown; samples: unknown[] };
    };
    expect(data.data.title).toBe('A+B Problem');
    const testcases = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${id}/testcases`,
      headers: { cookie },
    });
    expect((testcases.json() as { data: unknown[] }).data.length).toBeGreaterThan(0);
  }, 30_000);
});
