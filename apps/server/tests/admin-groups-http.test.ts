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

const root = mkdtempSync(join(tmpdir(), 'oij-admin-groups-http-'));
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

interface AdminGroupItem {
  id: number;
  name: string;
  kind: 'team' | 'class';
  ownerId: number;
  allowContest: boolean;
  memberCount: number;
  createdAt: number;
}

interface AdminGroupListBody {
  ok: true;
  data: AdminGroupItem[];
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

const classIds: Record<'alpha' | 'beta', number> = { alpha: 0, beta: 0 };

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

  for (const name of ['Alpha Team', 'Beta Team', '100% Team', 'under_score Team']) {
    const response = await api('POST', '/api/teams', 'alice', { name });
    expect(response.statusCode, response.body).toBe(201);
  }

  for (const name of ['Alpha Class', 'Beta Class']) {
    const response = await api('POST', '/api/admin/classes', 'admin', { name });
    expect(response.statusCode, response.body).toBe(201);
    classIds[name === 'Alpha Class' ? 'alpha' : 'beta'] = (
      response.json() as { data: { id: number } }
    ).data.id;
  }
  // 让 Alpha Class 有 2 名成员（创建者是 coach），验证 memberCount。
  const added = await api('POST', `/api/classes/${classIds.alpha}/members`, 'admin', {
    username: 'bob',
  });
  expect(added.statusCode, added.body).toBe(201);
  // 关闭 Beta Class 的比赛开关，验证 allowContest 字段。
  const patched = await api('PATCH', `/api/classes/${classIds.beta}`, 'admin', {
    allowContest: false,
  });
  expect(patched.statusCode, patched.body).toBe(200);
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function api(
  method: 'GET' | 'POST' | 'PATCH',
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

function groups(response: Awaited<ReturnType<typeof api>>): AdminGroupItem[] {
  return (response.json() as AdminGroupListBody).data;
}

describe('GET /api/admin/groups', () => {
  it('requires authentication and an admin/contestmanager role', async () => {
    const anonymous = await api('GET', '/api/admin/groups', null);
    expect(anonymous.statusCode).toBe(401);
    expect(errorCode(anonymous.json())).toBe('UNAUTHORIZED');

    const contestant = await api('GET', '/api/admin/groups', 'alice');
    expect(contestant.statusCode).toBe(403);
    expect(errorCode(contestant.json())).toBe('FORBIDDEN');
  });

  it('lists classes and teams with the selector fields for staff roles', async () => {
    for (const actor of ['admin', 'manager']) {
      const response = await api('GET', '/api/admin/groups', actor);
      expect(response.statusCode, response.body).toBe(200);
      expect(groups(response).map((group) => group.name)).toEqual([
        '100% Team',
        'Alpha Class',
        'Alpha Team',
        'Beta Class',
        'Beta Team',
        'under_score Team',
      ]);

      const alphaClass = groups(response).find((group) => group.name === 'Alpha Class');
      expect(alphaClass).toMatchObject({
        kind: 'class',
        ownerId: ids.admin,
        allowContest: true,
        memberCount: 2,
      });
      expect(alphaClass?.createdAt).toBeGreaterThan(0);

      const betaClass = groups(response).find((group) => group.name === 'Beta Class');
      expect(betaClass).toMatchObject({ kind: 'class', allowContest: false });

      const alphaTeam = groups(response).find((group) => group.name === 'Alpha Team');
      expect(alphaTeam).toMatchObject({
        kind: 'team',
        ownerId: ids.alice,
        allowContest: true,
        memberCount: 1,
      });
    }
  });

  it('filters by kind', async () => {
    const classes = await api('GET', '/api/admin/groups?kind=class', 'admin');
    expect(classes.statusCode).toBe(200);
    expect(groups(classes).map((group) => group.name)).toEqual(['Alpha Class', 'Beta Class']);
    expect(groups(classes).every((group) => group.kind === 'class')).toBe(true);

    const teams = await api('GET', '/api/admin/groups?kind=team', 'manager');
    expect(teams.statusCode).toBe(200);
    expect(groups(teams).map((group) => group.name)).toEqual([
      '100% Team',
      'Alpha Team',
      'Beta Team',
      'under_score Team',
    ]);
    expect(groups(teams).every((group) => group.kind === 'team')).toBe(true);

    const emptyKind = await api('GET', '/api/admin/groups?kind=', 'admin');
    expect(emptyKind.statusCode).toBe(200);
    expect(groups(emptyKind)).toHaveLength(6);
  });

  it('rejects an unknown kind with 400', async () => {
    const response = await api('GET', '/api/admin/groups?kind=user', 'admin');
    expect(response.statusCode).toBe(400);
    expect(errorCode(response.json())).toBe('BAD_REQUEST');
  });

  it('filters by name case-insensitively across both kinds', async () => {
    const lower = await api('GET', '/api/admin/groups?query=alpha', 'admin');
    expect(lower.statusCode).toBe(200);
    expect(groups(lower).map((group) => group.name)).toEqual(['Alpha Class', 'Alpha Team']);

    const upper = await api('GET', '/api/admin/groups?query=ALPHA', 'manager');
    expect(groups(upper).map((group) => group.name)).toEqual(['Alpha Class', 'Alpha Team']);

    const combined = await api('GET', '/api/admin/groups?kind=team&query=alpha', 'admin');
    expect(groups(combined).map((group) => group.name)).toEqual(['Alpha Team']);

    const blank = await api('GET', '/api/admin/groups?query=%20%20', 'admin');
    expect(blank.statusCode).toBe(200);
    expect(groups(blank)).toHaveLength(6);
  });

  it('escapes LIKE wildcards so % and _ match literally', async () => {
    const percent = await api('GET', '/api/admin/groups?query=%25', 'admin');
    expect(groups(percent).map((group) => group.name)).toEqual(['100% Team']);

    const underscore = await api('GET', '/api/admin/groups?query=_', 'admin');
    expect(groups(underscore).map((group) => group.name)).toEqual(['under_score Team']);
  });

  it('applies the default limit, caps it at 100 and ignores invalid values', async () => {
    const one = await api('GET', '/api/admin/groups?limit=1', 'admin');
    expect(one.statusCode).toBe(200);
    expect(groups(one)).toHaveLength(1);

    const capped = await api('GET', '/api/admin/groups?limit=500', 'admin');
    expect(capped.statusCode).toBe(200);
    expect(groups(capped)).toHaveLength(6);

    const fallback = await api('GET', '/api/admin/groups?limit=not-a-number', 'admin');
    expect(fallback.statusCode).toBe(200);
    expect(groups(fallback)).toHaveLength(6);
  });
});
