import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createContest, getContest } from '../src/storage/repos/contests.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'admin-ranking-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
let contestId = 0;

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  const adminId = createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  cookie = `oij.sid=${signSession({ userId: adminId, version: 0 }, config.sessionSecret, 3600)}`;
  contestId = createContest(db, { name: 'Ranking Config', mode: 'oi' });
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('admin ranking config and plugins', () => {
  it('saves ranking config and validates presets', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/admin/contests/${contestId}/ranking-config`,
      headers: { cookie },
      payload: { preset: 'acm', tie: 'none', cfLike: { decay: 0.4 } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const loaded = await app.inject({
      method: 'GET',
      url: `/api/admin/contests/${contestId}/ranking-config`,
      headers: { cookie },
    });
    expect((loaded.json() as { data: { preset: string; tie: string } }).data).toMatchObject({
      preset: 'acm',
      tie: 'none',
    });

    const invalid = await app.inject({
      method: 'PUT',
      url: `/api/admin/contests/${contestId}/ranking-config`,
      headers: { cookie },
      payload: { preset: 'not-a-preset' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('releases the official hack freeze', async () => {
    db.prepare('UPDATE contests SET official_frozen_until = ? WHERE id = ?').run(
      Date.now() + 60_000,
      contestId,
    );
    const released = await app.inject({
      method: 'POST',
      url: `/api/admin/contests/${contestId}/official-freeze/release`,
      headers: { cookie },
    });
    expect(released.statusCode, released.body).toBe(200);
    expect(getContest(db, contestId)!.official_frozen_until).toBeNull();
  });

  it('uploads a compiled ranking plugin and allows selecting it', async () => {
    const source = Buffer.from(
      'export const apiVersion = 1; export function compute() { return []; }\n',
    );
    const upload = await app.inject({
      method: 'POST',
      url: '/api/admin/ranking-plugins?name=reverse',
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: source,
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/ranking-plugins',
      headers: { cookie },
    });
    const plugins = (list.json() as { data: Array<{ name: string; enabled: boolean }> }).data;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ name: 'reverse', enabled: true });

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/admin/contests/${contestId}/ranking-config`,
      headers: { cookie },
      payload: { preset: 'plugin:reverse' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(JSON.parse(getContest(db, contestId)!.ranking_rule_json).preset).toBe('plugin:reverse');
  });
});
