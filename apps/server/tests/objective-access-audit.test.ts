import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createContest } from '../src/storage/repos/contests.js';
import { createProblem, getProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { addProblemShare } from '../src/services/problem-acl.js';
import { addTeamMember, createTeam } from '../src/services/teams.js';

const PUBLIC_SECRET = 'SECRET-ANSWER-PUBLIC-9f3a';
const HIDDEN_SECRET = 'SECRET-ANSWER-HIDDEN-7b1c';
const TEAM_SECRET = 'SECRET-ANSWER-TEAM-4d2e';
const CONTEST_SECRET = 'SECRET-ANSWER-CONTEST-1a5f';

const root = mkdtempSync(join(tmpdir(), 'oij-objective-audit-'));
const dataDir = root;
let db: DatabaseSync;
let config: Config;
let app: Awaited<ReturnType<typeof buildApp>>;

let aliceId = 0;
let bobId = 0;
let carolId = 0;
let publicObjectiveId = 0;
let hiddenObjectiveId = 0;
let teamObjectiveId = 0;
let contestObjectiveId = 0;
let publicDisplayId = '';
let hiddenDisplayId = '';
let teamDisplayId = '';
let contestId = 0;

const cookies: Record<'alice' | 'bob' | 'carol' | 'setter' | 'admin' | 'manager', string> = {
  alice: '',
  bob: '',
  carol: '',
  setter: '',
  admin: '',
  manager: '',
};

function objectiveWith(secret: string) {
  return {
    questions: [
      {
        id: 1,
        kind: 'single' as const,
        stem: '客观题',
        options: [
          { key: 'A', text: 'A' },
          { key: 'B', text: 'B' },
        ],
        answers: [secret],
        points: 100,
      },
    ],
  };
}

/** True when a nested payload contains an `answers` property. */
function hasAnswersKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasAnswersKey);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, child]) => key === 'answers' || hasAnswersKey(child),
    );
  }
  return false;
}

function expectNoAnswers(payload: unknown) {
  expect(hasAnswersKey(payload)).toBe(false);
  const serialized = JSON.stringify(payload);
  for (const secret of [PUBLIC_SECRET, HIDDEN_SECRET, TEAM_SECRET, CONTEST_SECRET]) {
    expect(serialized).not.toContain(secret);
  }
}

function sign(userId: number): string {
  return `oij.sid=${signSession({ userId, version: 0 }, config.sessionSecret, 3600)}`;
}

function cookieFor(name: keyof typeof cookies): { cookie: string } {
  return { cookie: cookies[name] };
}

beforeAll(async () => {
  ensureDataDirs(dataDir);
  db = openDatabase(join(dataDir, 'audit.db'));
  migrate(db);
  config = {
    ...loadConfig({
      ...process.env,
      OIJ_SESSION_SECRET: 'objective-audit-session-secret-0123456789',
      OIJ_DATA_DIR: dataDir,
    }),
    dataDir,
  };

  aliceId = createUser(db, {
    username: 'audit-alice',
    passwordHash: hashPassword('secret'),
    role: 'contestant',
  });
  bobId = createUser(db, {
    username: 'audit-bob',
    passwordHash: hashPassword('secret'),
    role: 'contestant',
  });
  carolId = createUser(db, {
    username: 'audit-carol',
    passwordHash: hashPassword('secret'),
    role: 'contestant',
  });
  const setterId = createUser(db, {
    username: 'audit-setter',
    passwordHash: hashPassword('secret'),
    role: 'setter',
  });
  const adminId = createUser(db, {
    username: 'audit-admin',
    passwordHash: hashPassword('secret'),
    role: 'admin',
  });
  const managerId = createUser(db, {
    username: 'audit-manager',
    passwordHash: hashPassword('secret'),
    role: 'contestmanager',
  });

  cookies.alice = sign(aliceId);
  cookies.bob = sign(bobId);
  cookies.carol = sign(carolId);
  cookies.setter = sign(setterId);
  cookies.admin = sign(adminId);
  cookies.manager = sign(managerId);

  const teamId = createTeam(db, { name: 'Objective Team', ownerId: aliceId });
  addTeamMember(db, { teamId, actorId: aliceId, username: 'audit-carol' });

  publicObjectiveId = createProblem(db, {
    title: 'Public objective',
    type: 'objective',
    timeMs: 1000,
    memoryMb: 64,
    objective: objectiveWith(PUBLIC_SECRET),
    visibility: 'public',
    testcases: [],
  });
  hiddenObjectiveId = createProblem(db, {
    title: 'Alice hidden objective',
    type: 'objective',
    timeMs: 1000,
    memoryMb: 64,
    objective: objectiveWith(HIDDEN_SECRET),
    visibility: 'hidden',
    ownerType: 'user',
    ownerId: aliceId,
    testcases: [],
  });
  teamObjectiveId = createProblem(db, {
    title: 'Team hidden objective',
    type: 'objective',
    timeMs: 1000,
    memoryMb: 64,
    objective: objectiveWith(TEAM_SECRET),
    visibility: 'hidden',
    ownerType: 'team',
    ownerId: teamId,
    testcases: [],
  });
  contestObjectiveId = createProblem(db, {
    title: 'Contest objective',
    type: 'objective',
    timeMs: 1000,
    memoryMb: 64,
    objective: objectiveWith(CONTEST_SECRET),
    visibility: 'public',
    testcases: [],
  });
  publicDisplayId = getProblem(db, publicObjectiveId)!.display_id!;
  hiddenDisplayId = getProblem(db, hiddenObjectiveId)!.display_id!;
  teamDisplayId = getProblem(db, teamObjectiveId)!.display_id!;

  contestId = createContest(db, { name: 'Objective Contest', problemIds: [contestObjectiveId] });

  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('objective problem access audit', () => {
  it('numbers objective problems in the Y sequence and resolves Y ids publicly', async () => {
    expect(publicDisplayId).toMatch(/^Y1\d{3}$/);
    expect(hiddenDisplayId).toMatch(/^Y1\d{3}$/);
    expect(teamDisplayId).toMatch(/^Y1\d{3}$/);
    expect(new Set([publicDisplayId, hiddenDisplayId, teamDisplayId]).size).toBe(3);

    const byDisplay = await app.inject({
      method: 'GET',
      url: `/api/problems/${publicDisplayId}`,
    });
    expect(byDisplay.statusCode).toBe(200);
    expect((byDisplay.json() as { data: { id: number } }).data.id).toBe(publicObjectiveId);
  });

  it('assigns Y numbers to objective problems created through the admin API', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/problems',
      headers: cookieFor('admin'),
      payload: {
        title: 'Admin objective',
        type: 'objective',
        timeMs: 1000,
        memoryMb: 64,
        objective: objectiveWith(PUBLIC_SECRET),
      },
    });
    expect(created.statusCode).toBe(201);
    const { id, displayId } = (
      created.json() as { data: { id: number; displayId: string } }
    ).data;
    expect(displayId).toMatch(/^Y1\d{3}$/);
    expect([publicDisplayId, hiddenDisplayId, teamDisplayId]).not.toContain(displayId);
    expect(getProblem(db, id)?.display_id).toBe(displayId);

    const detail = await app.inject({ method: 'GET', url: `/api/problems/${id}` });
    expect(detail.statusCode).toBe(200);
    expectNoAnswers(detail.json());
  });

  it('strips answers from a public objective detail for anonymous and logged-in readers', async () => {
    for (const headers of [{}, cookieFor('bob'), cookieFor('alice')]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/problems/${publicObjectiveId}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: { objective?: { questions: Array<Record<string, unknown>> } };
      };
      expect(body.data.objective?.questions).toHaveLength(1);
      expect(body.data.objective?.questions[0].stem).toBe('客观题');
      expect(body.data.objective?.questions[0].answers).toBeUndefined();
      expectNoAnswers(body.data);
    }
  });

  it('does not expose answers through the public problem list', async () => {
    for (const headers of [{}, cookieFor('bob')]) {
      const response = await app.inject({ method: 'GET', url: '/api/problems', headers });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: Array<{ id: number; displayId: string }> };
      expect(body.data.some((row) => row.id === publicObjectiveId)).toBe(true);
      expectNoAnswers(body.data);
    }
  });

  it('denies a hidden user-owned objective to unrelated users but allows the owner', async () => {
    for (const headers of [{}, cookieFor('bob'), cookieFor('carol')]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/problems/${hiddenObjectiveId}`,
        headers,
      });
      expect(response.statusCode).toBe(404);
      expectNoAnswers(response.json());
    }

    const owner = await app.inject({
      method: 'GET',
      url: `/api/problems/${hiddenObjectiveId}`,
      headers: cookieFor('alice'),
    });
    expect(owner.statusCode).toBe(200);
    expectNoAnswers(owner.json());

    // An explicit read share grants access, still without answers.
    addProblemShare(db, {
      problemId: hiddenObjectiveId,
      granteeType: 'user',
      granteeId: bobId,
      permission: 'read',
      actorId: aliceId,
    });
    const shared = await app.inject({
      method: 'GET',
      url: `/api/problems/${hiddenObjectiveId}`,
      headers: cookieFor('bob'),
    });
    expect(shared.statusCode).toBe(200);
    expectNoAnswers(shared.json());
  });

  it('shows a hidden team-owned objective only to team members and admins', async () => {
    for (const headers of [{}, cookieFor('bob')]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/problems/${teamObjectiveId}`,
        headers,
      });
      expect(response.statusCode).toBe(404);
      expectNoAnswers(response.json());
    }

    const member = await app.inject({
      method: 'GET',
      url: `/api/problems/${teamObjectiveId}`,
      headers: cookieFor('carol'),
    });
    expect(member.statusCode).toBe(200);
    expectNoAnswers(member.json());

    const admin = await app.inject({
      method: 'GET',
      url: `/api/problems/${teamObjectiveId}`,
      headers: cookieFor('admin'),
    });
    expect(admin.statusCode).toBe(200);
    expectNoAnswers(admin.json());

    // The hidden team problem does not appear in an outsider's list.
    const outsiderList = await app.inject({
      method: 'GET',
      url: '/api/problems',
      headers: cookieFor('bob'),
    });
    const outsiderIds = (outsiderList.json() as { data: Array<{ id: number }> }).data.map(
      (row) => row.id,
    );
    expect(outsiderIds).not.toContain(teamObjectiveId);
    expect(outsiderIds).toContain(publicObjectiveId);

    // Anonymous readers see only the public objective; the hidden user problem
    // is not listed for them either.
    const anonymousList = await app.inject({ method: 'GET', url: '/api/problems' });
    const anonymousIds = (anonymousList.json() as { data: Array<{ id: number }> }).data.map(
      (row) => row.id,
    );
    expect(anonymousIds).toContain(publicObjectiveId);
    expect(anonymousIds).not.toContain(teamObjectiveId);
    expect(anonymousIds).not.toContain(hiddenObjectiveId);
  });

  it('does not leak answers from contest detail or contest problem lists', async () => {
    const detail = await app.inject({ method: 'GET', url: `/api/contests/${contestId}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      data: {
        contest: { id: number };
        problems: Array<Record<string, unknown>>;
      };
    };
    expect(body.data.contest.id).toBe(contestId);
    expect(body.data.problems).toHaveLength(1);
    expect(body.data.problems[0]).toMatchObject({
      problemId: contestObjectiveId,
      type: 'objective',
    });
    expect(body.data.problems[0].objective).toBeUndefined();
    expectNoAnswers(body.data);

    const list = await app.inject({ method: 'GET', url: '/api/contests' });
    expect(list.statusCode).toBe(200);
    expectNoAnswers(list.json());
  });

  it('never serves answer files for objective problems', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/problems/${publicObjectiveId}/answer-files`,
      headers: cookieFor('alice'),
    });
    expect(response.statusCode).toBe(404);
    expectNoAnswers(response.json());
  });

  it('keeps authoring endpoints on the admin/setter boundary', async () => {
    // Authoring needs the answer key: admin and setter can read it.
    for (const name of ['admin', 'setter'] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/problems/${teamObjectiveId}`,
        headers: cookieFor(name),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: { objective?: { questions: Array<{ answers?: string[] }> } };
      };
      expect(body.data.objective?.questions[0].answers).toEqual([TEAM_SECRET]);
    }

    // Contest managers and contestants are outside the authoring guard.
    for (const name of ['manager', 'bob'] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/problems/${teamObjectiveId}`,
        headers: cookieFor(name),
      });
      expect(response.statusCode).toBe(403);
      expectNoAnswers(response.json());
    }

    // The contest-manager problem picker (batch mapping) stays metadata-only.
    const picker = await app.inject({
      method: 'GET',
      url: '/api/admin/problems/picker',
      headers: cookieFor('manager'),
    });
    expect(picker.statusCode).toBe(200);
    expectNoAnswers(picker.json());

    // The admin problem list is metadata-only as well.
    const adminList = await app.inject({
      method: 'GET',
      url: '/api/admin/problems',
      headers: cookieFor('admin'),
    });
    expect(adminList.statusCode).toBe(200);
    expectNoAnswers(adminList.json());
  });
});
