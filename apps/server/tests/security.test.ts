import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { resetAuthRateLimits } from '../src/http/auth.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'security-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie = '';

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('security hardening', () => {
  beforeEach(() => {
    resetAuthRateLimits();
  });

  it('rate limits repeated failed logins and records them', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong' },
      });
      lastStatus = response.statusCode;
    }
    expect(lastStatus).toBe(429);
  });

  it('records admin mutations in the audit log', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'admin123' },
    });
    expect(login.statusCode).toBe(200);
    adminCookie = login.headers['set-cookie'] as string;
    const cookie = adminCookie.split(';')[0];

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/problems',
      headers: { cookie },
      payload: { title: 'Audited', timeMs: 1000, memoryMb: 64 },
    });
    expect(created.statusCode).toBe(201);

    const audit = await app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: { cookie },
    });
    expect(audit.statusCode).toBe(200);
    const rows = (audit.json() as { data: Array<{ action: string }> }).data;
    expect(rows.some((row) => row.action === 'POST /api/admin/problems')).toBe(true);
    expect(rows.some((row) => row.action === 'auth.login_failed')).toBe(true);
    expect(rows.some((row) => row.action === 'auth.login')).toBe(true);
  });
});
