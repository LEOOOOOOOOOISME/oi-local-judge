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

const root = mkdtempSync(join(tmpdir(), 'oij-classes-http-'));
const db: DatabaseSync = openDatabase(join(root, 'test.db'));
const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;

type Username = 'admin' | 'manager' | 'alice' | 'bob' | 'carol';

const ids: Record<Username, number> = {
  admin: 0,
  manager: 0,
  alice: 0,
  bob: 0,
  carol: 0,
};
const cookies: Record<string, string> = {};

interface ApiError {
  ok: false;
  error: { code: string; message?: string };
}

interface ClassDetailBody {
  ok: true;
  data: {
    id: number;
    name: string;
    kind: 'team' | 'class';
    allowContest: boolean;
    ownerId: number;
    createdAt: number;
    viewerRole: 'captain' | 'coach' | 'assistant' | 'member' | null;
    members?: Array<{
      userId: number;
      username: string;
      role: 'captain' | 'coach' | 'assistant' | 'member';
    }>;
  };
}

interface ClassListBody {
  ok: true;
  data: Array<{
    id: number;
    name: string;
    kind: 'team' | 'class';
    allowContest: boolean;
    role: 'captain' | 'coach' | 'assistant' | 'member';
    memberCount: number;
  }>;
}

function seedUser(username: string, role: 'admin' | 'contestmanager' | 'contestant'): number {
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
  ids.alice = seedUser('alice', 'contestant');
  ids.bob = seedUser('bob', 'contestant');
  ids.carol = seedUser('carol', 'contestant');
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

async function createClass(
  username: string,
  name: string,
  allowContest?: boolean,
): Promise<number> {
  const payload: { name: string; allowContest?: boolean } = { name };
  if (allowContest !== undefined) payload.allowContest = allowContest;
  const response = await api('POST', '/api/admin/classes', username, payload);
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { data: { id: number } }).data.id;
}

describe('class HTTP API', () => {
  it('requires authentication on every class route', async () => {
    const routes: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown?]> = [
      ['GET', '/api/classes'],
      ['GET', '/api/classes/1'],
      ['PATCH', '/api/classes/1', { name: 'Anonymous' }],
      ['DELETE', '/api/classes/1'],
      ['POST', '/api/admin/classes', { name: 'Anonymous' }],
      ['POST', '/api/classes/1/members', { username: 'bob' }],
      ['DELETE', '/api/classes/1/members/2'],
      ['POST', '/api/classes/1/coaches', { username: 'bob' }],
      ['DELETE', '/api/classes/1/coaches/2'],
    ];
    for (const [method, url, payload] of routes) {
      const response = await api(method, url, null, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(errorCode(response.json())).toBe('UNAUTHORIZED');
    }
  });

  it('lets admins and contest managers create classes and rejects everyone else', async () => {
    const classId = await createClass('manager', 'Class A');
    expect(classId).toBeGreaterThan(0);
    await createClass('admin', 'Admin Class', false);

    const contestant = await api('POST', '/api/admin/classes', 'alice', { name: 'Nope' });
    expect(contestant.statusCode).toBe(403);
    expect(errorCode(contestant.json())).toBe('FORBIDDEN');

    const tooShort = await api('POST', '/api/admin/classes', 'manager', { name: 'A' });
    expect(tooShort.statusCode).toBe(400);
    expect(errorCode(tooShort.json())).toBe('TEAM_NAME_INVALID');

    const missing = await api('POST', '/api/admin/classes', 'manager', {});
    expect(missing.statusCode).toBe(400);
    expect(errorCode(missing.json())).toBe('TEAM_NAME_INVALID');

    const badSwitch = await api('POST', '/api/admin/classes', 'manager', {
      name: 'Bad Switch',
      allowContest: 'yes',
    });
    expect(badSwitch.statusCode).toBe(400);
    expect(errorCode(badSwitch.json())).toBe('BAD_REQUEST');

    const duplicate = await api('POST', '/api/admin/classes', 'manager', { name: 'Class A' });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate.json())).toBe('TEAM_NAME_TAKEN');
  });

  it('lists only the current user classes, separately from teams', async () => {
    const classId = await createClass('manager', 'Listed');

    const managerClasses = await api('GET', '/api/classes', 'manager');
    expect(managerClasses.statusCode).toBe(200);
    expect((managerClasses.json() as ClassListBody).data).toContainEqual(
      expect.objectContaining({
        id: classId,
        name: 'Listed',
        kind: 'class',
        allowContest: true,
        role: 'coach',
        memberCount: 1,
      }),
    );
    expect((managerClasses.json() as ClassListBody).data.every((g) => g.kind === 'class')).toBe(
      true,
    );

    const managerTeams = await api('GET', '/api/teams', 'manager');
    expect((managerTeams.json() as { data: unknown[] }).data).toEqual([]);

    const student = await api('GET', '/api/classes', 'bob');
    expect((student.json() as ClassListBody).data).toEqual([]);
  });

  it('shows class details to members and admins but hides the roster from outsiders', async () => {
    const classId = await createClass('manager', 'Visible');
    await api('POST', `/api/classes/${classId}/coaches`, 'manager', { username: 'alice' });

    const asCoach = await api('GET', `/api/classes/${classId}`, 'alice');
    expect(asCoach.statusCode).toBe(200);
    const coachBody = asCoach.json() as ClassDetailBody;
    expect(coachBody.data).toMatchObject({
      id: classId,
      name: 'Visible',
      kind: 'class',
      allowContest: true,
      ownerId: ids.manager,
    });
    expect(coachBody.data.viewerRole).toBe('coach');
    expect(
      coachBody.data.members?.map((member) => member.username).sort(),
    ).toEqual(['alice', 'manager']);

    const asAdmin = await api('GET', `/api/classes/${classId}`, 'admin');
    expect(asAdmin.statusCode).toBe(200);
    expect((asAdmin.json() as ClassDetailBody).data.members).toHaveLength(2);

    const asOutsider = await api('GET', `/api/classes/${classId}`, 'bob');
    expect(asOutsider.statusCode).toBe(200);
    const outsiderBody = asOutsider.json() as ClassDetailBody;
    expect(outsiderBody.data.viewerRole).toBeNull();
    expect(outsiderBody.data.members).toBeUndefined();

    // Classes are not reachable through the legacy team endpoints.
    const viaTeams = await api('GET', `/api/teams/${classId}`, 'manager');
    expect(viaTeams.statusCode).toBe(404);
    expect(errorCode(viaTeams.json())).toBe('TEAM_NOT_FOUND');

    const bagOfTeams = await api('POST', '/api/admin/classes', 'manager', { name: 'Team Route' });
    const teamId = (bagOfTeams.json() as { data: { id: number } }).data.id;
    await api('POST', '/api/teams', 'bob', { name: 'Ordinary Team' });
    const teamList = await api('GET', '/api/teams', 'bob');
    const names = (teamList.json() as { data: Array<{ name: string }> }).data.map((t) => t.name);
    expect(names).toEqual(['Ordinary Team']);
    expect(teamId).toBeGreaterThan(0);

    const missing = await api('GET', '/api/classes/999999', 'manager');
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing.json())).toBe('CLASS_NOT_FOUND');
  });

  it('lets coaches manage students while only the owner manages coaches', async () => {
    const classId = await createClass('manager', 'Roster');
    const addCoach = await api('POST', `/api/classes/${classId}/coaches`, 'manager', {
      username: 'alice',
    });
    expect(addCoach.statusCode).toBe(201);

    const addStudent = await api('POST', `/api/classes/${classId}/members`, 'alice', {
      username: 'bob',
    });
    expect(addStudent.statusCode).toBe(201);
    const addAssistant = await api('POST', `/api/classes/${classId}/members`, 'alice', {
      username: 'carol',
      role: 'assistant',
    });
    expect(addAssistant.statusCode).toBe(201);

    const coachCannotPromote = await api('POST', `/api/classes/${classId}/coaches`, 'alice', {
      username: 'carol',
    });
    expect(coachCannotPromote.statusCode).toBe(403);
    expect(errorCode(coachCannotPromote.json())).toBe('CLASS_FORBIDDEN');

    const duplicate = await api('POST', `/api/classes/${classId}/members`, 'alice', {
      username: 'bob',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate.json())).toBe('CLASS_MEMBER_EXISTS');

    const invalidRole = await api('POST', `/api/classes/${classId}/members`, 'alice', {
      username: 'carol',
      role: 'captain',
    });
    expect(invalidRole.statusCode).toBe(400);
    expect(errorCode(invalidRole.json())).toBe('CLASS_ROLE_INVALID');

    const detail = await api('GET', `/api/classes/${classId}`, 'manager');
    expect(
      (detail.json() as ClassDetailBody).data.members?.map((member) => [member.username, member.role])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual([
      ['alice', 'coach'],
      ['bob', 'member'],
      ['carol', 'assistant'],
      ['manager', 'coach'],
    ]);

    const removed = await api('DELETE', `/api/classes/${classId}/members/${ids.bob}`, 'alice');
    expect(removed.statusCode).toBe(200);
    const removedAgain = await api(
      'DELETE',
      `/api/classes/${classId}/members/${ids.bob}`,
      'alice',
    );
    expect(removedAgain.statusCode).toBe(404);
    expect(errorCode(removedAgain.json())).toBe('CLASS_MEMBER_NOT_FOUND');

    const removeCoach = await api('DELETE', `/api/classes/${classId}/coaches/${ids.alice}`, 'manager');
    expect(removeCoach.statusCode).toBe(200);
    const ownerProtected = await api(
      'DELETE',
      `/api/classes/${classId}/coaches/${ids.manager}`,
      'manager',
    );
    expect(ownerProtected.statusCode).toBe(409);
    expect(errorCode(ownerProtected.json())).toBe('CLASS_OWNER_PROTECTED');

    const coachGone = await api('DELETE', `/api/classes/${classId}/coaches/${ids.alice}`, 'manager');
    expect(coachGone.statusCode).toBe(404);
    expect(errorCode(coachGone.json())).toBe('CLASS_NOT_COACH');
  });

  it('lets the owner and admins edit class settings and validates the payload', async () => {
    const classId = await createClass('manager', 'Settings Class');
    await api('POST', `/api/classes/${classId}/coaches`, 'manager', { username: 'alice' });

    const forbidden = await api('PATCH', `/api/classes/${classId}`, 'alice', {
      name: 'Coach Renamed',
    });
    expect(forbidden.statusCode).toBe(403);
    expect(errorCode(forbidden.json())).toBe('CLASS_FORBIDDEN');

    const renamed = await api('PATCH', `/api/classes/${classId}`, 'manager', {
      name: 'Renamed Class',
      allowContest: false,
    });
    expect(renamed.statusCode, renamed.body).toBe(200);

    const detail = await api('GET', `/api/classes/${classId}`, 'manager');
    expect((detail.json() as ClassDetailBody).data).toMatchObject({
      name: 'Renamed Class',
      allowContest: false,
    });

    // An admin may flip the switch without owning the class.
    const byAdmin = await api('PATCH', `/api/classes/${classId}`, 'admin', {
      allowContest: true,
    });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    const afterAdmin = await api('GET', `/api/classes/${classId}`, 'manager');
    expect((afterAdmin.json() as ClassDetailBody).data.allowContest).toBe(true);

    const tooShort = await api('PATCH', `/api/classes/${classId}`, 'manager', { name: 'A' });
    expect(tooShort.statusCode).toBe(400);
    expect(errorCode(tooShort.json())).toBe('TEAM_NAME_INVALID');

    const badSwitch = await api('PATCH', `/api/classes/${classId}`, 'manager', {
      allowContest: 'yes',
    });
    expect(badSwitch.statusCode).toBe(400);
    expect(errorCode(badSwitch.json())).toBe('BAD_REQUEST');

    const empty = await api('PATCH', `/api/classes/${classId}`, 'manager', {});
    expect(empty.statusCode).toBe(400);
    expect(errorCode(empty.json())).toBe('BAD_REQUEST');

    await createClass('manager', 'Taken Name Class');
    const duplicate = await api('PATCH', `/api/classes/${classId}`, 'manager', {
      name: 'Taken Name Class',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate.json())).toBe('TEAM_NAME_TAKEN');

    // Ordinary teams are not reachable through the class routes.
    const teamResponse = await api('POST', '/api/teams', 'bob', { name: 'Patch Team' });
    expect(teamResponse.statusCode).toBe(201);
    const teamId = (teamResponse.json() as { data: { id: number } }).data.id;
    const teamPatch = await api('PATCH', `/api/classes/${teamId}`, 'admin', {
      name: 'Team Renamed',
    });
    expect(teamPatch.statusCode).toBe(404);
    expect(errorCode(teamPatch.json())).toBe('CLASS_NOT_FOUND');

    const missing = await api('PATCH', '/api/classes/999999', 'admin', { name: 'Ghost Class' });
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing.json())).toBe('CLASS_NOT_FOUND');
  });

  it('deletes a class for the owner or an admin and writes an audit record', async () => {
    const classId = await createClass('manager', 'Delete Class');
    await api('POST', `/api/classes/${classId}/coaches`, 'manager', { username: 'alice' });

    const forbidden = await api('DELETE', `/api/classes/${classId}`, 'alice');
    expect(forbidden.statusCode).toBe(403);
    expect(errorCode(forbidden.json())).toBe('CLASS_FORBIDDEN');
    const stillThere = await api('GET', `/api/classes/${classId}`, 'manager');
    expect(stillThere.statusCode).toBe(200);

    const deleted = await api('DELETE', `/api/classes/${classId}`, 'manager');
    expect(deleted.statusCode, deleted.body).toBe(200);
    const gone = await api('GET', `/api/classes/${classId}`, 'manager');
    expect(gone.statusCode).toBe(404);
    expect(errorCode(gone.json())).toBe('CLASS_NOT_FOUND');

    const audit = db
      .prepare(
        "SELECT actor_id, action, target_type, target_id FROM audit_logs WHERE action = 'class.dissolve' AND target_id = ?",
      )
      .get(String(classId)) as
      | { actor_id: number; action: string; target_type: string; target_id: string }
      | undefined;
    expect(audit).toMatchObject({
      actor_id: ids.manager,
      action: 'class.dissolve',
      target_type: 'class',
      target_id: String(classId),
    });

    // An admin may delete any class.
    const adminClass = await createClass('manager', 'Admin Delete Class');
    const adminDeleted = await api('DELETE', `/api/classes/${adminClass}`, 'admin');
    expect(adminDeleted.statusCode, adminDeleted.body).toBe(200);

    // Ordinary teams are not reachable through the class routes.
    const teamResponse = await api('POST', '/api/teams', 'bob', { name: 'Delete Team' });
    expect(teamResponse.statusCode).toBe(201);
    const teamId = (teamResponse.json() as { data: { id: number } }).data.id;
    const teamDelete = await api('DELETE', `/api/classes/${teamId}`, 'admin');
    expect(teamDelete.statusCode).toBe(404);
    expect(errorCode(teamDelete.json())).toBe('CLASS_NOT_FOUND');

    const missing = await api('DELETE', '/api/classes/999999', 'admin');
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing.json())).toBe('CLASS_NOT_FOUND');
  });
});
