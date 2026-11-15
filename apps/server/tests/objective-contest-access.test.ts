import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { addTeamMember, createTeam } from '../src/services/teams.js';
import { addParticipant, createContest } from '../src/storage/repos/contests.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(tmpdir(), 'oij-objective-contest-access-'));
const db = openDatabase(join(root, 'test.db'));
const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;

const ids: Record<'admin' | 'manager' | 'setter' | 'alice' | 'bob' | 'carol', number> = {
  admin: 0,
  manager: 0,
  setter: 0,
  alice: 0,
  bob: 0,
  carol: 0,
};
const cookies: Record<string, string> = {};

let programmingId = 0;
let publicObjectiveId = 0;
let teamObjectiveId = 0;
let teamId = 0;

/** Two questions: 20 + 30 = 50 points in total. */
const objective = {
  questions: [
    {
      id: 1,
      kind: 'single' as const,
      stem: '1+1=?',
      options: [
        { key: 'A', text: '1' },
        { key: 'B', text: '2' },
      ],
      answers: ['B'],
      points: 20,
    },
    {
      id: 2,
      kind: 'multiple' as const,
      stem: '哪些是偶数？',
      options: [
        { key: 'A', text: '2' },
        { key: 'B', text: '3' },
        { key: 'C', text: '4' },
      ],
      answers: ['A', 'C'],
      points: 30,
      partial: true,
    },
  ],
};

interface ApiErrorBody {
  ok: false;
  error: { code: string; message?: string };
}

interface ProblemDetailBody {
  data: {
    id: number;
    objective?: { questions: Array<Record<string, unknown>> };
  };
}

interface AdminProblemDetailBody {
  data: {
    objective?: { questions: Array<{ answers?: string[] }> };
  };
}

interface ContestDetailBody {
  data: {
    problems: Array<{
      problemId: number;
      ordinal: number;
      points: number;
      type: string;
      objectivePoints?: number | null;
    }>;
  };
}

interface PickerBody {
  data: Array<{ id: number; displayId: string; title: string; type: string; kind: string }>;
}

function seedUser(
  username: string,
  role: 'admin' | 'setter' | 'contestmanager' | 'contestant',
): number {
  return createUser(db, {
    username,
    passwordHash: hashPassword(`${username}123`),
    role,
  });
}

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
  return (body as ApiErrorBody).error.code;
}

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  ids.admin = seedUser('admin', 'admin');
  ids.manager = seedUser('manager', 'contestmanager');
  ids.setter = seedUser('setter', 'setter');
  ids.alice = seedUser('alice', 'contestant');
  ids.bob = seedUser('bob', 'contestant');
  ids.carol = seedUser('carol', 'contestant');
  for (const [name, id] of Object.entries(ids)) {
    cookies[name] = `oij.sid=${signSession({ userId: id, version: 0 }, config.sessionSecret, 3600)}`;
  }

  teamId = createTeam(db, { name: 'Objective ACL team', ownerId: ids.alice });
  addTeamMember(db, { teamId, actorId: ids.alice, username: 'bob' });

  programmingId = createProblem(db, {
    title: '编程题 A',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    displayId: 'P3001',
    testcases: [],
  });
  publicObjectiveId = createProblem(db, {
    title: '客观题 公共',
    type: 'objective',
    timeMs: 1000,
    memoryMb: 64,
    displayId: 'P3002',
    objective,
    testcases: [],
  });
  teamObjectiveId = createProblem(db, {
    title: '客观题 团队',
    type: 'objective',
    timeMs: 1000,
    memoryMb: 64,
    displayId: 'P3003',
    visibility: 'hidden',
    ownerType: 'team',
    ownerId: teamId,
    objective,
    testcases: [],
  });

  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('objective answer stripping', () => {
  it('strips answers from public problem detail but keeps the question body', async () => {
    const response = await api('GET', `/api/problems/${publicObjectiveId}`, null);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as ProblemDetailBody;
    expect(body.data.objective?.questions).toHaveLength(2);
    expect(body.data.objective?.questions[0]).toMatchObject({ id: 1, stem: '1+1=?' });
    expect(body.data.objective?.questions[0]).not.toHaveProperty('answers');
    expect(body.data.objective?.questions[1]).not.toHaveProperty('answers');
    expect(response.body).not.toContain('"answers"');
  });

  it('never includes objective answers in problem lists or contest details', async () => {
    const list = await api('GET', '/api/problems', null);
    expect(list.statusCode, list.body).toBe(200);
    const summaries = (list.json() as { data: Array<Record<string, unknown>> }).data;
    expect(summaries.some((problem) => problem.type === 'objective')).toBe(true);
    expect(summaries.every((problem) => !('objective' in problem))).toBe(true);
    expect(list.body).not.toContain('"answers"');
    expect(list.body).not.toContain('"questions"');

    const contestId = createContest(db, {
      name: 'Answers hidden',
      startAt: 1000,
      endAt: 2000,
      problemIds: [programmingId, publicObjectiveId],
    });
    const detail = await api('GET', `/api/contests/${contestId}`, null);
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json() as ContestDetailBody;
    expect(body.data.problems.map((problem) => problem.problemId)).toEqual([
      programmingId,
      publicObjectiveId,
    ]);
    expect(
      body.data.problems.every((problem) => !('objective' in problem)),
    ).toBe(true);
    expect(detail.body).not.toContain('"answers"');
    expect(detail.body).not.toContain('"questions"');
  });

  it('keeps the answer key only on the admin/setter authoring endpoint', async () => {
    const admin = await api('GET', `/api/admin/problems/${publicObjectiveId}`, 'admin');
    expect(admin.statusCode, admin.body).toBe(200);
    expect(
      (admin.json() as AdminProblemDetailBody).data.objective?.questions[0].answers,
    ).toEqual(['B']);

    const setter = await api('GET', `/api/admin/problems/${publicObjectiveId}`, 'setter');
    expect(setter.statusCode, setter.body).toBe(200);
    expect(
      (setter.json() as AdminProblemDetailBody).data.objective?.questions[0].answers,
    ).toEqual(['B']);

    // Contest managers run contests, not the problem authoring surface.
    const manager = await api('GET', `/api/admin/problems/${publicObjectiveId}`, 'manager');
    expect(manager.statusCode).toBe(403);
    expect(errorCode(manager.json())).toBe('FORBIDDEN');

    // Even staff only get the stripped copy from the public read route.
    const publicAsAdmin = await api('GET', `/api/problems/${publicObjectiveId}`, 'admin');
    expect(publicAsAdmin.statusCode, publicAsAdmin.body).toBe(200);
    expect(publicAsAdmin.body).not.toContain('"answers"');
  });
});

describe('team-owned objective ACL', () => {
  it('shows a hidden team objective only to team members and staff', async () => {
    for (const username of [null, 'carol'] as const) {
      const denied = await api('GET', `/api/problems/${teamObjectiveId}`, username);
      expect(denied.statusCode, `${username ?? 'anonymous'}: ${denied.body}`).toBe(404);
      expect(errorCode(denied.json())).toBe('NOT_FOUND');
    }

    for (const username of ['alice', 'bob'] as const) {
      const allowed = await api('GET', `/api/problems/${teamObjectiveId}`, username);
      expect(allowed.statusCode, `${username}: ${allowed.body}`).toBe(200);
      expect(allowed.body).not.toContain('"answers"');
      expect(
        (allowed.json() as ProblemDetailBody).data.objective?.questions,
      ).toHaveLength(2);
    }

    const adminPublic = await api('GET', `/api/problems/${teamObjectiveId}`, 'admin');
    expect(adminPublic.statusCode).toBe(200);
    expect(adminPublic.body).not.toContain('"answers"');

    const adminAuthoring = await api('GET', `/api/admin/problems/${teamObjectiveId}`, 'admin');
    expect(adminAuthoring.statusCode).toBe(200);
    expect(
      (adminAuthoring.json() as AdminProblemDetailBody).data.objective?.questions[0].answers,
    ).toEqual(['B']);

    const list = await api('GET', '/api/problems', 'bob');
    const listIds = (list.json() as { data: Array<{ id: number }> }).data.map(
      (problem) => problem.id,
    );
    expect(listIds).toContain(teamObjectiveId);
    const outsiderList = await api('GET', '/api/problems', 'carol');
    expect(
      (outsiderList.json() as { data: Array<{ id: number }> }).data.map(
        (problem) => problem.id,
      ),
    ).not.toContain(teamObjectiveId);
  });
});

describe('objective contest access', () => {
  it('rejects anonymous and non-participant objective submissions', async () => {
    const now = Date.now();
    const contestId = createContest(db, {
      name: 'Objective access',
      startAt: now - 60_000,
      endAt: now + 3_600_000,
      problemIds: [publicObjectiveId, programmingId],
    });
    db.prepare("UPDATE contests SET status = 'running' WHERE id = ?").run(contestId);
    addParticipant(db, contestId, ids.alice);

    const answers = JSON.stringify({
      answers: [
        { questionId: 1, value: ['B'] },
        { questionId: 2, value: ['A', 'C'] },
      ],
    });

    const anonymous = await api('POST', '/api/submissions', null, {
      problemId: publicObjectiveId,
      language: 'objective',
      code: answers,
      contestId,
    });
    expect(anonymous.statusCode).toBe(401);

    const stranger = await api('POST', '/api/submissions', 'carol', {
      problemId: publicObjectiveId,
      language: 'objective',
      code: answers,
      contestId,
    });
    expect(stranger.statusCode).toBe(403);
    expect(errorCode(stranger.json())).toBe('NOT_PARTICIPANT');

    const participant = await api('POST', '/api/submissions', 'alice', {
      problemId: publicObjectiveId,
      language: 'objective',
      code: answers,
      contestId,
    });
    expect(participant.statusCode, participant.body).toBe(201);
    const submissionId = (participant.json() as { data: { id: number } }).data.id;
    const row = db
      .prepare('SELECT language, phase, team_id FROM submissions WHERE id = ?')
      .get(submissionId) as unknown as {
      language: string;
      phase: string;
      team_id: number | null;
    };
    expect(row).toEqual({ language: 'objective', phase: 'contest', team_id: null });
  });
});

describe('mixed programming and objective contests', () => {
  it('preserves order and saves points without changing the payload contract', async () => {
    const created = await api('POST', '/api/admin/contests', 'manager', {
      name: 'Mixed contest',
      mode: 'oi',
      teamMode: 'individual',
      registrationMode: 'manual',
      startAt: 1000,
      endAt: 2000,
      problemIds: [programmingId, publicObjectiveId, teamObjectiveId],
    });
    expect(created.statusCode, created.body).toBe(201);
    const contestId = (created.json() as { data: { id: number } }).data.id;

    const detail = await api('GET', `/api/contests/${contestId}`, null);
    expect(detail.statusCode, detail.body).toBe(200);
    const beforeSave = detail.json() as ContestDetailBody;
    expect(beforeSave.data.problems.map((problem) => problem.problemId)).toEqual([
      programmingId,
      publicObjectiveId,
      teamObjectiveId,
    ]);
    expect(beforeSave.data.problems.map((problem) => problem.ordinal)).toEqual([1, 2, 3]);
    expect(beforeSave.data.problems.map((problem) => problem.type)).toEqual([
      'standard',
      'objective',
      'objective',
    ]);
    // The objective's effective maximum comes from its questions, not the
    // contest-level default, and is exposed without the answer key.
    expect(beforeSave.data.problems[0].objectivePoints).toBeNull();
    expect(beforeSave.data.problems[1].objectivePoints).toBe(50);
    expect(beforeSave.data.problems[2].objectivePoints).toBe(50);
    expect(detail.body).not.toContain('"answers"');

    const saved = await api('PUT', `/api/admin/contests/${contestId}`, 'manager', {
      problems: [
        { problemId: programmingId, points: 100 },
        { problemId: publicObjectiveId, points: 40 },
        { problemId: teamObjectiveId, points: 60 },
      ],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const afterSave = await api('GET', `/api/contests/${contestId}`, null);
    expect(
      (afterSave.json() as ContestDetailBody).data.problems.map((problem) => problem.points),
    ).toEqual([100, 40, 60]);
    expect(
      (afterSave.json() as ContestDetailBody).data.problems.map((problem) => problem.ordinal),
    ).toEqual([1, 2, 3]);
  });

  it('lets contest managers use the picker but keeps problem authoring admin/setter-only', async () => {
    const picker = await api(
      'GET',
      '/api/admin/problems/picker?scope=all&limit=500',
      'manager',
    );
    expect(picker.statusCode, picker.body).toBe(200);
    const items = (picker.json() as PickerBody).data;
    expect(items.some((item) => item.id === publicObjectiveId && item.type === 'objective')).toBe(
      true,
    );
    expect(items.some((item) => item.id === programmingId && item.type === 'standard')).toBe(true);
    const objectiveItem = items.find((item) => item.id === publicObjectiveId)!;
    expect(objectiveItem.displayId).toBe('P3002');
    expect(objectiveItem.kind).toBe('objective');

    const broadList = await api('GET', '/api/admin/problems', 'manager');
    expect(broadList.statusCode).toBe(403);

    const setterContest = await api('POST', '/api/admin/contests', 'setter', {
      name: 'Setter contest',
      problemIds: [],
    });
    expect(setterContest.statusCode).toBe(403);
  });
});
