import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createProblem, getProblem, type ProblemOwnerType } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';
import { addTeamMember, createTeam } from '../src/services/teams.js';

const root = mkdtempSync(join(tmpdir(), 'oij-problem-acl-http-'));
const db: DatabaseSync = openDatabase(join(root, 'test.db'));
const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;

const ids: Record<'admin' | 'setter' | 'alice' | 'bob' | 'carol' | 'dave', number> = {
  admin: 0,
  setter: 0,
  alice: 0,
  bob: 0,
  carol: 0,
  dave: 0,
};
const cookies: Record<string, string> = {};

interface ApiError {
  ok: false;
  error: { code: string; message?: string };
}

interface ProblemSummary {
  id: number;
  title: string;
}

function seedUser(username: string, role: 'admin' | 'setter' | 'contestant'): number {
  return createUser(db, {
    username,
    passwordHash: hashPassword(`${username}123`),
    role,
  });
}

function makeProblem(options: {
  title: string;
  visibility?: 'public' | 'hidden';
  ownerType?: ProblemOwnerType;
  ownerId?: number | null;
  type?: 'standard' | 'output-only';
  testcases?: Array<{ inputPath: string; outputPath: string; points: number }>;
}): number {
  return createProblem(db, {
    title: options.title,
    type: options.type ?? 'standard',
    difficulty: 2,
    tags: ['acl'],
    timeMs: 1000,
    memoryMb: 128,
    visibility: options.visibility ?? 'public',
    ownerType: options.ownerType ?? 'system',
    ownerId: options.ownerId ?? null,
    testcases: options.testcases ?? [],
  });
}

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  ids.admin = seedUser('admin', 'admin');
  ids.setter = seedUser('setter', 'setter');
  ids.alice = seedUser('alice', 'contestant');
  ids.bob = seedUser('bob', 'contestant');
  ids.carol = seedUser('carol', 'contestant');
  ids.dave = seedUser('dave', 'contestant');
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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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

function listIds(response: { json: () => unknown }): number[] {
  return (response.json() as { data: ProblemSummary[] }).data.map((problem) => problem.id);
}

describe('problem read ACL over HTTP', () => {
  it('hides hidden problems from lists and details while owners and teams can read them', async () => {
    const systemPublic = makeProblem({ title: 'System public' });
    const systemHidden = makeProblem({ title: 'System hidden', visibility: 'hidden' });
    const alicePrivate = makeProblem({
      title: 'Alice private',
      visibility: 'hidden',
      ownerType: 'user',
      ownerId: ids.alice,
    });
    const alicePublic = makeProblem({
      title: 'Alice public',
      ownerType: 'user',
      ownerId: ids.alice,
    });
    const teamId = createTeam(db, { name: 'ACL team', ownerId: ids.alice });
    addTeamMember(db, { teamId, actorId: ids.alice, username: 'bob' });
    const teamPrivate = makeProblem({
      title: 'Team private',
      visibility: 'hidden',
      ownerType: 'team',
      ownerId: teamId,
    });

    const anonymousList = await api('GET', '/api/problems', null);
    expect(anonymousList.statusCode, anonymousList.body).toBe(200);
    expect(listIds(anonymousList)).toEqual(
      expect.arrayContaining([systemPublic, alicePublic]),
    );
    expect(listIds(anonymousList)).not.toContain(systemHidden);
    expect(listIds(anonymousList)).not.toContain(alicePrivate);
    expect(listIds(anonymousList)).not.toContain(teamPrivate);

    const aliceList = await api('GET', '/api/problems', 'alice');
    expect(aliceList.statusCode, aliceList.body).toBe(200);
    expect(listIds(aliceList)).toEqual(
      expect.arrayContaining([systemPublic, alicePublic, alicePrivate, teamPrivate]),
    );
    expect(listIds(aliceList)).not.toContain(systemHidden);

    const bobList = await api('GET', '/api/problems', 'bob');
    expect(listIds(bobList)).toContain(teamPrivate);
    expect(listIds(bobList)).not.toContain(alicePrivate);

    const carolList = await api('GET', '/api/problems', 'carol');
    expect(listIds(carolList)).not.toContain(alicePrivate);
    expect(listIds(carolList)).not.toContain(teamPrivate);

    const adminList = await api('GET', '/api/problems', 'admin');
    expect(listIds(adminList)).toEqual(
      expect.arrayContaining([systemPublic, systemHidden, alicePrivate, teamPrivate]),
    );

    // An invalid session behaves like an anonymous visitor, not a 401.
    const badCookie = await app.inject({
      method: 'GET',
      url: '/api/problems',
      headers: { cookie: 'oij.sid=bogus' },
    });
    expect(badCookie.statusCode).toBe(200);
    expect(listIds(badCookie)).toContain(systemPublic);
    expect(listIds(badCookie)).not.toContain(systemHidden);

    const hiddenDetail = await api('GET', `/api/problems/${systemHidden}`, null);
    expect(hiddenDetail.statusCode).toBe(404);
    expect(errorCode(hiddenDetail.json())).toBe('NOT_FOUND');

    for (const username of ['alice', 'bob', 'carol'] as const) {
      const forbidden = await api('GET', `/api/problems/${systemHidden}`, username);
      expect(forbidden.statusCode, `${username} must not see system hidden`).toBe(404);
    }
    const adminDetail = await api('GET', `/api/problems/${systemHidden}`, 'admin');
    expect(adminDetail.statusCode, adminDetail.body).toBe(200);
    expect((adminDetail.json() as { data: { id: number } }).data.id).toBe(systemHidden);

    const ownerDetail = await api('GET', `/api/problems/${alicePrivate}`, 'alice');
    expect(ownerDetail.statusCode, ownerDetail.body).toBe(200);
    const strangerDetail = await api('GET', `/api/problems/${alicePrivate}`, 'bob');
    expect(strangerDetail.statusCode).toBe(404);
    const memberDetail = await api('GET', `/api/problems/${teamPrivate}`, 'bob');
    expect(memberDetail.statusCode, memberDetail.body).toBe(200);
    const captainDetail = await api('GET', `/api/problems/${teamPrivate}`, 'alice');
    expect(captainDetail.statusCode, captainDetail.body).toBe(200);
    const outsiderDetail = await api('GET', `/api/problems/${teamPrivate}`, 'carol');
    expect(outsiderDetail.statusCode).toBe(404);

    const publicDetail = await api('GET', `/api/problems/${alicePublic}`, null);
    expect(publicDetail.statusCode, publicDetail.body).toBe(200);

    const invalidId = await api('GET', '/api/problems/not-a-number', null);
    expect(invalidId.statusCode).toBe(404);
  });

  it('gates answer files behind visibility for both listing and downloads', async () => {
    const problemId = makeProblem({
      title: 'Alice answer files',
      type: 'output-only',
      visibility: 'hidden',
      ownerType: 'user',
      ownerId: ids.alice,
      testcases: [
        {
          inputPath: `problems/TMP/data/1.in`,
          outputPath: `problems/TMP/data/1.out`,
          points: 100,
        },
      ],
    });
    // createProblem inserted placeholder paths; point them at the real problem id.
    db.prepare('UPDATE problem_testcases SET input_path = ?, output_path = ? WHERE problem_id = ?').run(
      `problems/${problemId}/data/1.in`,
      `problems/${problemId}/data/1.out`,
      problemId,
    );
    const dataDir = join(root, 'problems', String(problemId), 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, '1.in'), '42\n', 'utf8');
    writeFileSync(join(dataDir, '1.out'), '42\n', 'utf8');
    const testcaseId = (
      db.prepare('SELECT id FROM problem_testcases WHERE problem_id = ?').get(problemId) as unknown as {
        id: number;
      }
    ).id;

    const anonymousList = await api('GET', `/api/problems/${problemId}/answer-files`, null);
    expect(anonymousList.statusCode).toBe(404);
    const strangerList = await api('GET', `/api/problems/${problemId}/answer-files`, 'bob');
    expect(strangerList.statusCode).toBe(404);

    const ownerList = await api('GET', `/api/problems/${problemId}/answer-files`, 'alice');
    expect(ownerList.statusCode, ownerList.body).toBe(200);
    expect((ownerList.json() as { data: unknown[] }).data).toHaveLength(1);

    const anonymousFile = await api(
      'GET',
      `/api/problems/${problemId}/answer-files/${testcaseId}`,
      null,
    );
    expect(anonymousFile.statusCode).toBe(404);
    const ownerFile = await api(
      'GET',
      `/api/problems/${problemId}/answer-files/${testcaseId}`,
      'alice',
    );
    expect(ownerFile.statusCode, ownerFile.body).toBe(200);
    expect(ownerFile.body.trim()).toBe('42');
  });
});

describe('problem shares over HTTP', () => {
  it('requires authentication and lets the owner or an admin manage shares', async () => {
    const problemId = makeProblem({
      title: 'Share target',
      visibility: 'hidden',
      ownerType: 'user',
      ownerId: ids.alice,
    });

    for (const [method, url, payload] of [
      ['GET', `/api/problems/${problemId}/shares`, undefined],
      ['POST', `/api/problems/${problemId}/shares`, {
        granteeType: 'user',
        granteeId: ids.bob,
        permission: 'read',
      }],
      ['DELETE', `/api/problems/${problemId}/shares/user/${ids.bob}`, undefined],
    ] as const) {
      const response = await api(method, url, null, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(errorCode(response.json())).toBe('UNAUTHORIZED');
    }

    const shared = await api('POST', `/api/problems/${problemId}/shares`, 'alice', {
      granteeType: 'user',
      granteeId: ids.bob,
      permission: 'read',
    });
    expect(shared.statusCode, shared.body).toBe(201);
    expect((await api('GET', `/api/problems/${problemId}`, 'bob')).statusCode).toBe(200);

    const ownerShares = await api('GET', `/api/problems/${problemId}/shares`, 'alice');
    expect(ownerShares.statusCode, ownerShares.body).toBe(200);
    expect((ownerShares.json() as { data: unknown[] }).data).toEqual([
      expect.objectContaining({
        granteeType: 'user',
        granteeId: ids.bob,
        permission: 'read',
        createdBy: ids.alice,
      }),
    ]);

    // A read grantee can view but cannot list or change shares.
    const granteeShares = await api('GET', `/api/problems/${problemId}/shares`, 'bob');
    expect(granteeShares.statusCode).toBe(403);
    const granteeShare = await api('POST', `/api/problems/${problemId}/shares`, 'bob', {
      granteeType: 'user',
      granteeId: ids.carol,
      permission: 'read',
    });
    expect(granteeShare.statusCode).toBe(403);

    // A stranger cannot learn that the hidden problem exists.
    const strangerShares = await api('GET', `/api/problems/${problemId}/shares`, 'carol');
    expect(strangerShares.statusCode).toBe(404);
    const strangerShare = await api('POST', `/api/problems/${problemId}/shares`, 'carol', {
      granteeType: 'user',
      granteeId: ids.carol,
      permission: 'read',
    });
    expect(strangerShare.statusCode).toBe(404);

    const adminShares = await api('GET', `/api/problems/${problemId}/shares`, 'admin');
    expect(adminShares.statusCode, adminShares.body).toBe(200);
    const adminShare = await api('POST', `/api/problems/${problemId}/shares`, 'admin', {
      granteeType: 'user',
      granteeId: ids.carol,
      permission: 'read',
    });
    expect(adminShare.statusCode, adminShare.body).toBe(201);
    expect((await api('GET', `/api/problems/${problemId}`, 'carol')).statusCode).toBe(200);

    const removed = await api(
      'DELETE',
      `/api/problems/${problemId}/shares/user/${ids.bob}`,
      'alice',
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await api('GET', `/api/problems/${problemId}`, 'bob')).statusCode).toBe(404);
    const removedAgain = await api(
      'DELETE',
      `/api/problems/${problemId}/shares/user/${ids.bob}`,
      'alice',
    );
    expect(removedAgain.statusCode).toBe(400);
    expect(errorCode(removedAgain.json())).toBe('PROBLEM_SHARE_INVALID');
  });

  it('validates share payloads and maps ACL errors', async () => {
    const problemId = makeProblem({
      title: 'Share validation',
      visibility: 'hidden',
      ownerType: 'user',
      ownerId: ids.alice,
    });
    const teamId = createTeam(db, { name: 'Share team', ownerId: ids.bob });
    addTeamMember(db, { teamId, actorId: ids.bob, username: 'dave' });

    const badType = await api('POST', `/api/problems/${problemId}/shares`, 'alice', {
      granteeType: 'group',
      granteeId: ids.bob,
      permission: 'read',
    });
    expect(badType.statusCode).toBe(400);
    expect(errorCode(badType.json())).toBe('PROBLEM_SHARE_INVALID');

    const badPermission = await api('POST', `/api/problems/${problemId}/shares`, 'alice', {
      granteeType: 'user',
      granteeId: ids.bob,
      permission: 'write',
    });
    expect(badPermission.statusCode).toBe(400);
    expect(errorCode(badPermission.json())).toBe('PROBLEM_SHARE_INVALID');

    const badGrantee = await api('POST', `/api/problems/${problemId}/shares`, 'alice', {
      granteeType: 'user',
      granteeId: 999999,
      permission: 'read',
    });
    expect(badGrantee.statusCode).toBe(400);
    expect(errorCode(badGrantee.json())).toBe('PROBLEM_SHARE_INVALID');

    const missingProblem = await api('POST', '/api/problems/999999/shares', 'alice', {
      granteeType: 'user',
      granteeId: ids.bob,
      permission: 'read',
    });
    expect(missingProblem.statusCode).toBe(404);
    expect(errorCode(missingProblem.json())).toBe('PROBLEM_NOT_FOUND');

    const badShareType = await api(
      'DELETE',
      `/api/problems/${problemId}/shares/group/${ids.bob}`,
      'alice',
    );
    expect(badShareType.statusCode).toBe(400);
    expect(errorCode(badShareType.json())).toBe('PROBLEM_SHARE_INVALID');

    const toTeam = await api('POST', `/api/problems/${problemId}/shares`, 'alice', {
      granteeType: 'team',
      granteeId: teamId,
      permission: 'edit',
    });
    expect(toTeam.statusCode, toTeam.body).toBe(201);
    expect((await api('GET', `/api/problems/${problemId}`, 'dave')).statusCode).toBe(200);

    // An edit grantee can edit content later but never manage shares.
    const editGranteeShares = await api('GET', `/api/problems/${problemId}/shares`, 'dave');
    expect(editGranteeShares.statusCode).toBe(403);
  });
});

describe('admin problem ownership over HTTP', () => {
  it('defaults new problems to the creator and accepts explicit owners', async () => {
    const forbidden = await api('POST', '/api/admin/problems', 'carol', {
      title: 'Contestant create',
      timeMs: 1000,
      memoryMb: 64,
    });
    expect(forbidden.statusCode).toBe(403);

    const createdBySetter = await api('POST', '/api/admin/problems', 'setter', {
      title: 'Setter default owner',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 64,
    });
    expect(createdBySetter.statusCode, createdBySetter.body).toBe(201);
    const setterProblemId = (createdBySetter.json() as { data: { id: number } }).data.id;
    const setterProblem = getProblem(db, setterProblemId)!;
    expect(setterProblem.owner_type).toBe('user');
    expect(setterProblem.owner_id).toBe(ids.setter);

    const createdForBob = await api('POST', '/api/admin/problems', 'admin', {
      title: 'Owned by bob',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 64,
      ownerType: 'user',
      ownerId: ids.bob,
    });
    expect(createdForBob.statusCode, createdForBob.body).toBe(201);
    const bobProblem = getProblem(
      db,
      (createdForBob.json() as { data: { id: number } }).data.id,
    )!;
    expect(bobProblem.owner_type).toBe('user');
    expect(bobProblem.owner_id).toBe(ids.bob);

    const teamId = createTeam(db, { name: 'Owner team', ownerId: ids.alice });
    const createdForTeam = await api('POST', '/api/admin/problems', 'admin', {
      title: 'Owned by team',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 64,
      ownerType: 'team',
      ownerId: teamId,
    });
    expect(createdForTeam.statusCode, createdForTeam.body).toBe(201);
    const teamProblem = getProblem(
      db,
      (createdForTeam.json() as { data: { id: number } }).data.id,
    )!;
    expect(teamProblem.owner_type).toBe('team');
    expect(teamProblem.owner_id).toBe(teamId);

    const badOwnerType = await api('POST', '/api/admin/problems', 'admin', {
      title: 'Bad owner type',
      timeMs: 1000,
      memoryMb: 64,
      ownerType: 'group',
    });
    expect(badOwnerType.statusCode).toBe(400);
    expect(errorCode(badOwnerType.json())).toBe('PROBLEM_OWNER_INVALID');

    const missingOwner = await api('POST', '/api/admin/problems', 'admin', {
      title: 'Missing owner',
      timeMs: 1000,
      memoryMb: 64,
      ownerType: 'user',
      ownerId: 999999,
    });
    expect(missingOwner.statusCode).toBe(400);
    expect(errorCode(missingOwner.json())).toBe('PROBLEM_OWNER_INVALID');

    const reassigned = await api('PUT', `/api/admin/problems/${setterProblemId}`, 'admin', {
      ownerType: 'user',
      ownerId: ids.carol,
    });
    expect(reassigned.statusCode, reassigned.body).toBe(200);
    const afterUpdate = getProblem(db, setterProblemId)!;
    expect(afterUpdate.owner_type).toBe('user');
    expect(afterUpdate.owner_id).toBe(ids.carol);

    const badUpdate = await api('PUT', `/api/admin/problems/${setterProblemId}`, 'admin', {
      ownerType: 'team',
      ownerId: 999999,
    });
    expect(badUpdate.statusCode).toBe(400);
    expect(errorCode(badUpdate.json())).toBe('PROBLEM_OWNER_INVALID');
    expect(getProblem(db, setterProblemId)!.owner_type).toBe('user');

    const setterList = await api('GET', '/api/admin/problems', 'setter');
    expect(setterList.statusCode, setterList.body).toBe(200);
    const contestantList = await api('GET', '/api/admin/problems', 'carol');
    expect(contestantList.statusCode).toBe(403);
  });
});

describe('practice submission ACL over HTTP', () => {
  it('rejects practice submissions without view access and defers contests to the contest ACL', async () => {
    const privateProblem = makeProblem({
      title: 'Private practice',
      visibility: 'hidden',
      ownerType: 'user',
      ownerId: ids.alice,
    });

    const anonymous = await api('POST', '/api/submissions', null, {
      problemId: privateProblem,
      language: 'cpp17',
      code: 'int main(){return 0;}',
    });
    expect(anonymous.statusCode).toBe(401);

    const stranger = await api('POST', '/api/submissions', 'bob', {
      problemId: privateProblem,
      language: 'cpp17',
      code: 'int main(){return 0;}',
    });
    expect(stranger.statusCode, stranger.body).toBe(403);
    expect(errorCode(stranger.json())).toBe('PROBLEM_FORBIDDEN');

    const owner = await api('POST', '/api/submissions', 'alice', {
      problemId: privateProblem,
      language: 'cpp17',
      code: 'int main(){return 0;}',
    });
    expect(owner.statusCode, owner.body).toBe(201);
    expect((owner.json() as { data: { status: string } }).data.status).toBe('queued');

    const shareGranted = await api('POST', `/api/problems/${privateProblem}/shares`, 'alice', {
      granteeType: 'user',
      granteeId: ids.bob,
      permission: 'read',
    });
    expect(shareGranted.statusCode, shareGranted.body).toBe(201);
    const sharedSubmit = await api('POST', '/api/submissions', 'bob', {
      problemId: privateProblem,
      language: 'cpp17',
      code: 'int main(){return 0;}',
    });
    expect(sharedSubmit.statusCode, sharedSubmit.body).toBe(201);

    // A contest submission is validated by the contest ACL, not the practice ACL.
    const contestAttempt = await api('POST', '/api/submissions', 'bob', {
      problemId: privateProblem,
      language: 'cpp17',
      code: 'int main(){return 0;}',
      contestId: 999999,
    });
    expect(contestAttempt.statusCode).toBe(404);
    expect(errorCode(contestAttempt.json())).toBe('CONTEST_NOT_FOUND');

    const publicProblem = makeProblem({ title: 'Public practice' });
    const publicSubmit = await api('POST', '/api/submissions', 'bob', {
      problemId: publicProblem,
      language: 'cpp17',
      code: 'int main(){return 0;}',
    });
    expect(publicSubmit.statusCode, publicSubmit.body).toBe(201);
  });
});
