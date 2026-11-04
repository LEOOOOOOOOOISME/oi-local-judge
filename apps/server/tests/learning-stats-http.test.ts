import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(tmpdir(), 'oij-learning-http-'));
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

interface StatsBody {
  ok: true;
  data: {
    userId: number;
    username: string;
    includeContest: boolean;
    summary: {
      attemptedProblems: number;
      solvedProblems: number;
      totalSubmissions: number;
      acSubmissions: number;
      wrongSubmissions: number;
      firstAcAt: number | null;
      lastActiveAt: number | null;
    };
    problems: Array<{ problemId: number; title: string; bestVerdict: string | null }>;
    tags: Array<{ tag: string; attempts: number; solved: number }>;
    daily: Array<{ date: string; submissions: number }>;
  };
}

interface WrongBody {
  ok: true;
  data: {
    userId: number;
    mode: 'never-ac' | 'latest-wrong';
    includeContest: boolean;
    problems: Array<{ problemId: number; title: string; lastVerdict: string | null }>;
  };
}

interface ClassStatsBody {
  ok: true;
  data: {
    classId: number;
    className: string;
    studentCount: number;
    completedProblems: number;
    inactiveMembers: Array<{ userId: number; username: string }>;
    weakTags: Array<{ tag: string; solveRate: number }>;
    topWrongProblems: Array<{ problemId: number }>;
  };
}

let neverAcProblem = 0;
let solvedProblem = 0;

function seedUser(username: string, role: 'admin' | 'contestmanager' | 'contestant'): number {
  return createUser(db, {
    username,
    passwordHash: hashPassword(`${username}123`),
    role,
  });
}

function makeProblem(title: string): number {
  return createProblem(db, {
    title,
    type: 'standard',
    tags: ['dp'],
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });
}

let seq = 0;

function addSubmission(
  userId: number,
  problemId: number,
  verdict: string,
  score: number,
  createdAt: number,
): void {
  seq += 1;
  db.prepare(
    `INSERT INTO submissions(problem_id, user_id, language, source_path, source_hash, status,
       verdict, score, created_at, judged_at, phase)
     VALUES (?, ?, 'cpp17', ?, 'hash', 'finished', ?, ?, ?, ?, 'contest')`,
  ).run(problemId, userId, `submissions/${seq}/main.cpp`, verdict, score, createdAt, createdAt);
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
  neverAcProblem = makeProblem('Never AC');
  solvedProblem = makeProblem('Solved');
  const now = Date.now();
  addSubmission(ids.bob, neverAcProblem, 'WA', 0, now - 2 * 86_400_000);
  addSubmission(ids.bob, solvedProblem, 'AC', 100, now - 86_400_000);
  addSubmission(ids.bob, neverAcProblem, 'WA', 10, now - 86_400_000 + 1_000);
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function api(method: 'GET' | 'POST', url: string, username: string | null) {
  return app.inject({
    method,
    url,
    headers: username ? { cookie: cookies[username] } : {},
  });
}

function errorCode(body: unknown): string {
  return (body as ApiError).error.code;
}

let classId = 0;

beforeAll(async () => {
  // The class is created through the HTTP API so the route stack matches production.
  const created = await app.inject({
    method: 'POST',
    url: '/api/admin/classes',
    headers: { cookie: cookies.manager! },
    payload: { name: 'Analytics Class' },
  });
  expect(created.statusCode, created.body).toBe(201);
  classId = (created.json() as { data: { id: number } }).data.id;
  const coach = await app.inject({
    method: 'POST',
    url: `/api/classes/${classId}/coaches`,
    headers: { cookie: cookies.manager! },
    payload: { username: 'alice' },
  });
  expect(coach.statusCode, coach.body).toBe(201);
  const student = await app.inject({
    method: 'POST',
    url: `/api/classes/${classId}/members`,
    headers: { cookie: cookies.manager! },
    payload: { username: 'bob' },
  });
  expect(student.statusCode, student.body).toBe(201);
});

describe('learning analytics HTTP API', () => {
  it('requires authentication on every analytics route', async () => {
    const routes = [
      `/api/students/${ids.bob}/stats`,
      `/api/students/${ids.bob}/wrong-problems`,
      `/api/classes/${classId}/learning-stats`,
    ];
    for (const url of routes) {
      const response = await api('GET', url, null);
      expect(response.statusCode, url).toBe(401);
      expect(errorCode(response.json())).toBe('UNAUTHORIZED');
    }
  });

  it('lets a student read their own stats and rejects a classmate who is not a coach', async () => {
    const self = await api('GET', `/api/students/${ids.bob}/stats`, 'bob');
    expect(self.statusCode, self.body).toBe(200);
    const body = self.json() as StatsBody;
    expect(body.data).toMatchObject({
      userId: ids.bob,
      username: 'bob',
      includeContest: true,
      summary: {
        attemptedProblems: 2,
        solvedProblems: 1,
        totalSubmissions: 3,
        acSubmissions: 1,
        wrongSubmissions: 2,
      },
    });
    expect(body.data.problems.map((problem) => problem.problemId)).toEqual([
      neverAcProblem,
      solvedProblem,
    ]);
    expect(body.data.tags).toEqual([
      { tag: 'dp', attempts: 3, solved: 1, totalProblems: 2, lastAttemptAt: expect.any(Number) },
    ]);
    expect(body.data.daily.length).toBe(2);

    const mate = await api('GET', `/api/students/${ids.bob}/stats`, 'carol');
    expect(mate.statusCode).toBe(403);
    expect(errorCode(mate.json())).toBe('STUDENT_FORBIDDEN');

    const missing = await api('GET', `/api/students/999999/stats`, 'admin');
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing.json())).toBe('STUDENT_NOT_FOUND');
  });

  it('lets class coaches, the owner and admins read a student, optionally scoped to a class', async () => {
    for (const username of ['alice', 'manager', 'admin']) {
      const response = await api('GET', `/api/students/${ids.bob}/stats`, username);
      expect(response.statusCode, `${username}: ${response.body}`).toBe(200);
    }
    const scoped = await api(
      'GET',
      `/api/students/${ids.bob}/stats?classId=${classId}`,
      'alice',
    );
    expect(scoped.statusCode, scoped.body).toBe(200);
    const unknownClass = await api(
      'GET',
      `/api/students/${ids.bob}/stats?classId=999999`,
      'alice',
    );
    expect(unknownClass.statusCode).toBe(404);
    expect(errorCode(unknownClass.json())).toBe('CLASS_NOT_FOUND');
  });

  it('serves never-AC and latest-wrong views and validates query parameters', async () => {
    const never = await api('GET', `/api/students/${ids.bob}/wrong-problems`, 'bob');
    expect(never.statusCode, never.body).toBe(200);
    const neverBody = never.json() as WrongBody;
    expect(neverBody.data.mode).toBe('never-ac');
    expect(neverBody.data.problems.map((problem) => problem.problemId)).toEqual([
      neverAcProblem,
    ]);
    expect(neverBody.data.problems[0]).toMatchObject({ lastVerdict: 'WA' });

    const latest = await api(
      'GET',
      `/api/students/${ids.bob}/wrong-problems?mode=latest-wrong`,
      'bob',
    );
    expect(latest.statusCode, latest.body).toBe(200);
    expect((latest.json() as WrongBody).data.mode).toBe('latest-wrong');

    const practice = await api(
      'GET',
      `/api/students/${ids.bob}/wrong-problems?includeContest=false`,
      'bob',
    );
    expect(practice.statusCode, practice.body).toBe(200);
    expect((practice.json() as WrongBody).data.includeContest).toBe(false);

    const bogus = await api(
      'GET',
      `/api/students/${ids.bob}/wrong-problems?mode=bogus`,
      'bob',
    );
    expect(bogus.statusCode).toBe(400);
    expect(errorCode(bogus.json())).toBe('BAD_REQUEST');

    const outsider = await api('GET', `/api/students/${ids.bob}/wrong-problems`, 'carol');
    expect(outsider.statusCode).toBe(403);
    expect(errorCode(outsider.json())).toBe('STUDENT_FORBIDDEN');
  });

  it('exposes class learning stats to coaches and admins only', async () => {
    const coach = await api('GET', `/api/classes/${classId}/learning-stats`, 'alice');
    expect(coach.statusCode, coach.body).toBe(200);
    const body = coach.json() as ClassStatsBody;
    expect(body.data).toMatchObject({
      classId,
      className: 'Analytics Class',
      studentCount: 1,
      completedProblems: 1,
      inactiveMembers: [],
    });
    expect(body.data.weakTags).toEqual([{ tag: 'dp', attempts: 3, solved: 1, solveRate: 1 / 3 }]);
    expect(body.data.topWrongProblems.map((problem) => problem.problemId)).toEqual([
      neverAcProblem,
    ]);

    for (const username of ['manager', 'admin']) {
      const response = await api('GET', `/api/classes/${classId}/learning-stats`, username);
      expect(response.statusCode, `${username}: ${response.body}`).toBe(200);
    }
    const student = await api('GET', `/api/classes/${classId}/learning-stats`, 'carol');
    expect(student.statusCode).toBe(403);
    expect(errorCode(student.json())).toBe('CLASS_FORBIDDEN');
    const missing = await api('GET', '/api/classes/999999/learning-stats', 'admin');
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing.json())).toBe('CLASS_NOT_FOUND');
  });

  it('rejects malformed student and class identifiers', async () => {
    const badStudent = await api('GET', '/api/students/not-a-number/stats', 'admin');
    expect(badStudent.statusCode).toBe(404);
    expect(errorCode(badStudent.json())).toBe('STUDENT_NOT_FOUND');
    const badClass = await api('GET', '/api/classes/not-a-number/learning-stats', 'admin');
    expect(badClass.statusCode).toBe(404);
    expect(errorCode(badClass.json())).toBe('CLASS_NOT_FOUND');
  });
});
