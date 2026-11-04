import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(tmpdir(), 'oij-admin-teams-http-'));
const db: DatabaseSync = openDatabase(join(root, 'test.db'));
const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;

const ids: Record<'admin' | 'manager' | 'alice' | 'bob', number> = {
  admin: 0,
  manager: 0,
  alice: 0,
  bob: 0,
};
const cookies: Record<string, string> = {};

interface ApiError {
  ok: false;
  error: { code: string; message?: string };
}

interface AdminTeamItem {
  id: number;
  name: string;
  ownerId: number;
  memberCount: number;
  createdAt: number;
}

interface AdminTeamListBody {
  ok: true;
  data: AdminTeamItem[];
}

function seedUser(
  username: string,
  role: 'admin' | 'contestmanager' | 'contestant' = 'contestant',
): number {
  return createUser(db, {
    username,
    passwordHash: hashPassword(`${username}123`),
    role,
  });
}

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  ids.admin = seedUser('admin', 'admin');
  ids.manager = seedUser('manager', 'contestmanager');
  ids.alice = seedUser('alice');
  ids.bob = seedUser('bob');
  for (const [name, id] of Object.entries(ids)) {
    cookies[name] = `oij.sid=${signSession({ userId: id, version: 0 }, config.sessionSecret, 3600)}`;
  }
  app = await buildApp({ db, config });

  for (const name of ['Alpha One', 'alpha two', 'Beta', '100% Club', 'under_score']) {
    const response = await api('POST', '/api/teams', 'alice', { name });
    expect(response.statusCode, response.body).toBe(201);
  }
  // 让 Alpha One 有 2 名成员，验证 memberCount。
  const list = await api('GET', '/api/teams', 'alice');
  const alpha = (list.json() as { data: Array<{ id: number; name: string }> }).data.find(
    (team) => team.name === 'Alpha One',
  );
  expect(alpha).toBeDefined();
  const added = await api('POST', `/api/teams/${alpha!.id}/members`, 'alice', {
    username: 'bob',
  });
  expect(added.statusCode, added.body).toBe(201);
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function api(
  method: 'GET' | 'POST',
  url: string,
  username: string | null,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: username ? { cookie: cookies[username] } : {},
    ...(payload === undefined ? {} : { payload }),
  });
}

function errorCode(body: unknown): string {
  return (body as ApiError).error.code;
}

function teamNames(response: Awaited<ReturnType<typeof api>>): string[] {
  return (response.json() as AdminTeamListBody).data.map((team) => team.name);
}

describe('GET /api/admin/teams', () => {
  it('requires authentication and an admin/contestmanager role', async () => {
    const anonymous = await api('GET', '/api/admin/teams', null);
    expect(anonymous.statusCode).toBe(401);
    expect(errorCode(anonymous.json())).toBe('UNAUTHORIZED');

    const contestant = await api('GET', '/api/admin/teams', 'alice');
    expect(contestant.statusCode).toBe(403);
    expect(errorCode(contestant.json())).toBe('FORBIDDEN');
  });

  it('lists every team sorted by name for admins and contest managers', async () => {
    for (const actor of ['admin', 'manager']) {
      const response = await api('GET', '/api/admin/teams', actor);
      expect(response.statusCode, response.body).toBe(200);
      expect(teamNames(response)).toEqual([
        '100% Club',
        'Alpha One',
        'alpha two',
        'Beta',
        'under_score',
      ]);
      const alpha = (response.json() as AdminTeamListBody).data.find(
        (team) => team.name === 'Alpha One',
      );
      expect(alpha).toMatchObject({ ownerId: ids.alice, memberCount: 2 });
      expect(alpha?.createdAt).toBeGreaterThan(0);
    }
  });

  it('filters by team name case-insensitively', async () => {
    const lower = await api('GET', '/api/admin/teams?query=alpha', 'admin');
    expect(lower.statusCode).toBe(200);
    expect(teamNames(lower)).toEqual(['Alpha One', 'alpha two']);

    const upper = await api('GET', '/api/admin/teams?query=ALPHA', 'manager');
    expect(teamNames(upper)).toEqual(['Alpha One', 'alpha two']);

    const blank = await api('GET', '/api/admin/teams?query=%20%20', 'admin');
    expect(blank.statusCode).toBe(200);
    expect(teamNames(blank)).toHaveLength(5);
  });

  it('escapes LIKE wildcards so % and _ match literally', async () => {
    const percent = await api('GET', '/api/admin/teams?query=%25', 'admin');
    expect(teamNames(percent)).toEqual(['100% Club']);

    const underscore = await api('GET', '/api/admin/teams?query=_', 'admin');
    expect(teamNames(underscore)).toEqual(['under_score']);
  });

  it('applies the default limit, caps it at 100 and ignores invalid values', async () => {
    const one = await api('GET', '/api/admin/teams?limit=1', 'admin');
    expect(one.statusCode).toBe(200);
    expect((one.json() as AdminTeamListBody).data).toHaveLength(1);

    const capped = await api('GET', '/api/admin/teams?limit=500', 'admin');
    expect(capped.statusCode).toBe(200);
    expect((capped.json() as AdminTeamListBody).data).toHaveLength(5);

    const fallback = await api('GET', '/api/admin/teams?limit=not-a-number', 'admin');
    expect(fallback.statusCode).toBe(200);
    expect((fallback.json() as AdminTeamListBody).data).toHaveLength(5);
  });
});
