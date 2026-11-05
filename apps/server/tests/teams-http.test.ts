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

const root = mkdtempSync(join(tmpdir(), 'oij-teams-http-'));
const db: DatabaseSync = openDatabase(join(root, 'test.db'));
const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;

const ids: Record<'admin' | 'alice' | 'bob' | 'carol', number> = {
  admin: 0,
  alice: 0,
  bob: 0,
  carol: 0,
};
const cookies: Record<string, string> = {};

interface ApiError {
  ok: false;
  error: { code: string; message?: string };
}

interface TeamDetailBody {
  ok: true;
  data: {
    id: number;
    name: string;
    ownerId: number;
    createdAt: number;
    viewerRole: 'captain' | 'member' | null;
    members?: Array<{ userId: number; username: string; role: 'captain' | 'member' }>;
  };
}

interface TeamListBody {
  ok: true;
  data: Array<{ id: number; name: string; role: 'captain' | 'member'; memberCount: number }>;
}

function seedUser(username: string, role: 'admin' | 'contestant' = 'contestant'): number {
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
  ids.alice = seedUser('alice');
  ids.bob = seedUser('bob');
  ids.carol = seedUser('carol');
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

async function api(
  method: 'GET' | 'POST' | 'DELETE',
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

async function createTeam(username: string, name: string): Promise<number> {
  const response = await api('POST', '/api/teams', username, { name });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { data: { id: number } }).data.id;
}

async function addMember(actor: string, teamId: number, username: string): Promise<void> {
  const response = await api('POST', `/api/teams/${teamId}/members`, actor, { username });
  expect(response.statusCode, response.body).toBe(201);
}

function errorCode(body: unknown): string {
  return (body as ApiError).error.code;
}

describe('team HTTP API', () => {
  it('requires authentication on every team route', async () => {
    const routes: Array<['GET' | 'POST' | 'DELETE', string, unknown?]> = [
      ['GET', '/api/teams'],
      ['GET', '/api/teams/1'],
      ['POST', '/api/teams', { name: 'Anonymous' }],
      ['POST', '/api/teams/1/members', { username: 'bob' }],
      ['DELETE', '/api/teams/1/members/2'],
      ['POST', '/api/teams/1/leave'],
      ['POST', '/api/teams/1/transfer', { userId: 2 }],
      ['DELETE', '/api/teams/1'],
    ];
    for (const [method, url, payload] of routes) {
      const response = await api(method, url, null, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(errorCode(response.json())).toBe('UNAUTHORIZED');
    }
  });

  it('creates a team and lists only the current user teams', async () => {
    const teamId = await createTeam('alice', 'Alpha');
    expect(teamId).toBeGreaterThan(0);

    const duplicate = await api('POST', '/api/teams', 'bob', { name: '  Alpha  ' });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate.json())).toBe('TEAM_NAME_TAKEN');

    const tooShort = await api('POST', '/api/teams', 'alice', { name: 'A' });
    expect(tooShort.statusCode).toBe(400);
    expect(errorCode(tooShort.json())).toBe('TEAM_NAME_INVALID');

    const missing = await api('POST', '/api/teams', 'alice', {});
    expect(missing.statusCode).toBe(400);
    expect(errorCode(missing.json())).toBe('TEAM_NAME_INVALID');

    const aliceTeams = await api('GET', '/api/teams', 'alice');
    expect(aliceTeams.statusCode).toBe(200);
    const aliceList = (aliceTeams.json() as TeamListBody).data;
    expect(aliceList).toContainEqual(
      expect.objectContaining({ id: teamId, name: 'Alpha', role: 'captain', memberCount: 1 }),
    );

    const bobTeams = await api('GET', '/api/teams', 'bob');
    expect(bobTeams.statusCode).toBe(200);
    expect((bobTeams.json() as TeamListBody).data).toEqual([]);
  });

  it('shows members to members and admins but hides the roster from outsiders', async () => {
    const teamId = await createTeam('alice', 'Visible');
    await addMember('alice', teamId, 'bob');

    const asMember = await api('GET', `/api/teams/${teamId}`, 'bob');
    expect(asMember.statusCode).toBe(200);
    const memberBody = asMember.json() as TeamDetailBody;
    expect(memberBody.data.viewerRole).toBe('member');
    expect(memberBody.data.members?.map((member) => member.username)).toEqual(['alice', 'bob']);

    const asAdmin = await api('GET', `/api/teams/${teamId}`, 'admin');
    expect(asAdmin.statusCode).toBe(200);
    const adminBody = asAdmin.json() as TeamDetailBody;
    expect(adminBody.data.viewerRole).toBeNull();
    expect(adminBody.data.members).toHaveLength(2);

    const asOutsider = await api('GET', `/api/teams/${teamId}`, 'carol');
    expect(asOutsider.statusCode).toBe(200);
    const outsiderBody = asOutsider.json() as TeamDetailBody;
    expect(outsiderBody.data).toMatchObject({
      id: teamId,
      name: 'Visible',
      ownerId: memberBody.data.ownerId,
    });
    expect(outsiderBody.data.viewerRole).toBeNull();
    expect(outsiderBody.data.members).toBeUndefined();

    const missing = await api('GET', '/api/teams/999999', 'alice');
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing.json())).toBe('TEAM_NOT_FOUND');

    const invalid = await api('GET', '/api/teams/not-a-number', 'alice');
    expect(invalid.statusCode).toBe(404);
    expect(errorCode(invalid.json())).toBe('TEAM_NOT_FOUND');
  });

  it('lets the captain add and remove members with mapped errors', async () => {
    const teamId = await createTeam('alice', 'Roster');
    await addMember('alice', teamId, 'bob');

    const duplicate = await api('POST', `/api/teams/${teamId}/members`, 'alice', {
      username: 'bob',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate.json())).toBe('TEAM_MEMBER_EXISTS');

    const unknown = await api('POST', `/api/teams/${teamId}/members`, 'alice', {
      username: 'nobody',
    });
    expect(unknown.statusCode).toBe(404);
    expect(errorCode(unknown.json())).toBe('USER_NOT_FOUND');

    const invalidBody = await api('POST', `/api/teams/${teamId}/members`, 'alice', {});
    expect(invalidBody.statusCode).toBe(400);
    expect(errorCode(invalidBody.json())).toBe('BAD_REQUEST');

    const nonCaptain = await api('POST', `/api/teams/${teamId}/members`, 'bob', {
      username: 'carol',
    });
    expect(nonCaptain.statusCode).toBe(403);
    expect(errorCode(nonCaptain.json())).toBe('TEAM_FORBIDDEN');

    const missingTeam = await api('POST', '/api/teams/999999/members', 'alice', {
      username: 'bob',
    });
    expect(missingTeam.statusCode).toBe(404);
    expect(errorCode(missingTeam.json())).toBe('TEAM_NOT_FOUND');

    const removed = await api('DELETE', `/api/teams/${teamId}/members/${ids.bob}`, 'alice');
    expect(removed.statusCode).toBe(200);

    const removedAgain = await api('DELETE', `/api/teams/${teamId}/members/${ids.bob}`, 'alice');
    expect(removedAgain.statusCode).toBe(404);
    expect(errorCode(removedAgain.json())).toBe('TEAM_MEMBER_NOT_FOUND');
  });

  it('lets an administrator add and remove members without being captain', async () => {
    const teamId = await createTeam('alice', 'AdminRoster');

    const added = await api('POST', `/api/teams/${teamId}/members`, 'admin', {
      username: 'bob',
    });
    expect(added.statusCode).toBe(201);

    const detail = await api('GET', `/api/teams/${teamId}`, 'admin');
    expect((detail.json() as TeamDetailBody).data.members?.map((m) => m.username)).toEqual([
      'alice',
      'bob',
    ]);

    const removed = await api('DELETE', `/api/teams/${teamId}/members/${ids.bob}`, 'admin');
    expect(removed.statusCode).toBe(200);

    const missingTeam = await api('POST', '/api/teams/999999/members', 'admin', {
      username: 'bob',
    });
    expect(missingTeam.statusCode).toBe(404);
    expect(errorCode(missingTeam.json())).toBe('TEAM_NOT_FOUND');
  });

  it('supports leaving, rejects captain departure and self-kick', async () => {
    const teamId = await createTeam('alice', 'Leavers');
    await addMember('alice', teamId, 'bob');

    const left = await api('POST', `/api/teams/${teamId}/leave`, 'bob');
    expect(left.statusCode).toBe(200);

    const leftAgain = await api('POST', `/api/teams/${teamId}/leave`, 'bob');
    expect(leftAgain.statusCode).toBe(404);
    expect(errorCode(leftAgain.json())).toBe('TEAM_MEMBER_NOT_FOUND');

    const captainLeaves = await api('POST', `/api/teams/${teamId}/leave`, 'alice');
    expect(captainLeaves.statusCode).toBe(409);
    expect(errorCode(captainLeaves.json())).toBe('TEAM_CAPTAIN_LAST');

    const selfKick = await api('DELETE', `/api/teams/${teamId}/members/${ids.alice}`, 'alice');
    expect(selfKick.statusCode).toBe(403);
    expect(errorCode(selfKick.json())).toBe('TEAM_FORBIDDEN');
  });

  it('transfers captaincy as captain, as admin and maps invalid transfers', async () => {
    const teamId = await createTeam('alice', 'Transfer');
    await addMember('alice', teamId, 'bob');
    await addMember('alice', teamId, 'carol');

    const forbidden = await api('POST', `/api/teams/${teamId}/transfer`, 'bob', {
      userId: ids.bob,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(errorCode(forbidden.json())).toBe('TEAM_FORBIDDEN');

    const transferred = await api('POST', `/api/teams/${teamId}/transfer`, 'alice', {
      userId: ids.bob,
    });
    expect(transferred.statusCode).toBe(200);

    const detail = await api('GET', `/api/teams/${teamId}`, 'alice');
    const afterTransfer = (detail.json() as TeamDetailBody).data;
    expect(afterTransfer.ownerId).toBe(ids.bob);
    expect(afterTransfer.viewerRole).toBe('member');
    expect(afterTransfer.members?.find((m) => m.username === 'bob')?.role).toBe('captain');

    // The former captain is now an ordinary member and may leave.
    const formerCaptainLeaves = await api('POST', `/api/teams/${teamId}/leave`, 'alice');
    expect(formerCaptainLeaves.statusCode).toBe(200);

    const adminTeamId = await createTeam('alice', 'AdminTransfer');
    await addMember('alice', adminTeamId, 'bob');
    const adminTransfer = await api('POST', `/api/teams/${adminTeamId}/transfer`, 'admin', {
      userId: ids.bob,
    });
    expect(adminTransfer.statusCode).toBe(200);

    const adminDetail = await api('GET', `/api/teams/${adminTeamId}`, 'bob');
    expect((adminDetail.json() as TeamDetailBody).data.ownerId).toBe(ids.bob);

    const missingTarget = await api('POST', `/api/teams/${teamId}/transfer`, 'bob', {
      userId: 999999,
    });
    expect(missingTarget.statusCode).toBe(404);
    expect(errorCode(missingTarget.json())).toBe('TEAM_MEMBER_NOT_FOUND');

    const invalidTarget = await api('POST', `/api/teams/${teamId}/transfer`, 'bob', {
      userId: 'nope',
    });
    expect(invalidTarget.statusCode).toBe(400);
    expect(errorCode(invalidTarget.json())).toBe('BAD_REQUEST');
  });

  it('lets the owner or an administrator dissolve a team and rejects everyone else', async () => {
    const ownerTeamId = await createTeam('alice', 'OwnerDissolve');
    const outsider = await api('DELETE', `/api/teams/${ownerTeamId}`, 'bob');
    expect(outsider.statusCode).toBe(403);
    expect(errorCode(outsider.json())).toBe('TEAM_FORBIDDEN');

    const ownerDissolve = await api('DELETE', `/api/teams/${ownerTeamId}`, 'alice');
    expect(ownerDissolve.statusCode).toBe(200);

    const dissolveAgain = await api('DELETE', `/api/teams/${ownerTeamId}`, 'alice');
    expect(dissolveAgain.statusCode).toBe(404);
    expect(errorCode(dissolveAgain.json())).toBe('TEAM_NOT_FOUND');

    const adminTeamId = await createTeam('alice', 'AdminDissolve');
    const adminDissolve = await api('DELETE', `/api/teams/${adminTeamId}`, 'admin');
    expect(adminDissolve.statusCode).toBe(200);

    const adminDissolveAgain = await api('DELETE', `/api/teams/${adminTeamId}`, 'admin');
    expect(adminDissolveAgain.statusCode).toBe(404);
    expect(errorCode(adminDissolveAgain.json())).toBe('TEAM_NOT_FOUND');
  });
});
