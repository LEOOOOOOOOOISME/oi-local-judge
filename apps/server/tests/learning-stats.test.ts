import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import {
  addClassCoach,
  addClassMember,
  createClass,
  createTeam,
} from '../src/services/teams.js';
import {
  getClassLearningStats,
  getStudentStats,
  getStudentWrongProblems,
  LearningStatsError,
  rebuildAllStats,
  rebuildStudentStats,
} from '../src/services/learning-stats.js';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  dbs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'oij-learning-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  dbs.push(db);
  migrate(db);
  const admin = createUser(db, { username: 'admin', passwordHash: 'x', role: 'admin' });
  const manager = createUser(db, {
    username: 'manager',
    passwordHash: 'x',
    role: 'contestmanager',
  });
  const alice = createUser(db, { username: 'alice', passwordHash: 'x' });
  const bob = createUser(db, { username: 'bob', passwordHash: 'x' });
  const carol = createUser(db, { username: 'carol', passwordHash: 'x' });
  const dave = createUser(db, { username: 'dave', passwordHash: 'x' });
  const erin = createUser(db, { username: 'erin', passwordHash: 'x' });
  return { db, admin, manager, alice, bob, carol, dave, erin };
}

function makeProblem(
  db: DatabaseSync,
  input: { title: string; tags?: string[]; visibility?: 'public' | 'hidden' },
): number {
  return createProblem(db, {
    title: input.title,
    type: 'standard',
    difficulty: 2,
    tags: input.tags ?? [],
    visibility: input.visibility ?? 'public',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });
}

let submissionSeq = 0;

function addSubmission(
  db: DatabaseSync,
  input: {
    userId: number;
    problemId: number;
    verdict: string | null;
    score?: number;
    createdAt: number;
    contestId?: number | null;
    status?: string;
    hacked?: boolean;
  },
): void {
  submissionSeq += 1;
  db.prepare(
    `INSERT INTO submissions(contest_id, problem_id, user_id, language, source_path,
       source_hash, status, verdict, score, created_at, judged_at, hacked_at, phase)
     VALUES (?, ?, ?, 'cpp17', ?, 'hash', ?, ?, ?, ?, ?, ?, 'contest')`,
  ).run(
    input.contestId ?? null,
    input.problemId,
    input.userId,
    `submissions/${submissionSeq}/main.cpp`,
    input.status ?? 'finished',
    input.verdict,
    input.score ?? 0,
    input.createdAt,
    input.createdAt,
    input.hacked ? input.createdAt + 1 : null,
  );
}

function expectLearningError(fn: () => unknown, code: string, status: number): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(LearningStatsError);
  const error = caught as LearningStatsError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
}

const DAY = 86_400_000;

describe('student learning stats', () => {
  it('creates the stats tables through migration', () => {
    const { db } = setup();
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'student_problem_stats',
        'student_tag_stats',
        'student_daily_stats',
      ]),
    );
  });

  it('returns an empty, well-shaped snapshot for a student without submissions', () => {
    const { db, alice } = setup();
    const stats = getStudentStats(db, alice, { userId: alice });
    expect(stats).toMatchObject({
      userId: alice,
      username: 'alice',
      includeContest: true,
      summary: {
        attemptedProblems: 0,
        solvedProblems: 0,
        totalSubmissions: 0,
        acSubmissions: 0,
        wrongSubmissions: 0,
        firstAcAt: null,
        lastActiveAt: null,
      },
    });
    expect(stats.problems).toEqual([]);
    expect(stats.tags).toEqual([]);
    expect(stats.daily).toEqual([]);
    expect(getStudentWrongProblems(db, alice, { userId: alice })).toMatchObject({
      userId: alice,
      mode: 'never-ac',
      problems: [],
    });
    expect(rebuildStudentStats(db, alice)).toEqual({ problems: 0, tags: 0, days: 0 });
  });

  it('aggregates per-problem attempts, best score and first AC', () => {
    const { db, alice } = setup();
    const p1 = makeProblem(db, { title: 'Never AC', tags: ['dp', 'greedy'] });
    const p2 = makeProblem(db, { title: 'AC then WA', tags: ['dp'] });
    const p3 = makeProblem(db, { title: 'Solved', tags: [] });
    addSubmission(db, { userId: alice, problemId: p1, verdict: 'WA', createdAt: 1_000 });
    addSubmission(db, { userId: alice, problemId: p1, verdict: 'WA', createdAt: 2_000 });
    addSubmission(db, {
      userId: alice,
      problemId: p2,
      verdict: 'WA',
      score: 0,
      createdAt: 3_000,
    });
    addSubmission(db, {
      userId: alice,
      problemId: p2,
      verdict: 'AC',
      score: 100,
      createdAt: 4_000,
    });
    addSubmission(db, {
      userId: alice,
      problemId: p2,
      verdict: 'WA',
      score: 20,
      createdAt: 5_000,
    });
    addSubmission(db, {
      userId: alice,
      problemId: p3,
      verdict: 'AC',
      score: 100,
      createdAt: 6_000,
    });
    addSubmission(db, {
      userId: alice,
      problemId: p3,
      verdict: 'AC',
      score: 100,
      createdAt: 7_000,
    });

    const stats = getStudentStats(db, alice, { userId: alice });
    expect(stats.summary).toEqual({
      attemptedProblems: 3,
      solvedProblems: 2,
      totalSubmissions: 7,
      acSubmissions: 3,
      wrongSubmissions: 4,
      firstAcAt: 4_000,
      lastActiveAt: 7_000,
    });
    // Newest activity first.
    expect(stats.problems.map((problem) => problem.problemId)).toEqual([p3, p2, p1]);
    const byId = new Map(stats.problems.map((problem) => [problem.problemId, problem]));
    expect(byId.get(p1)).toMatchObject({
      title: 'Never AC',
      tags: ['dp', 'greedy'],
      attempts: 2,
      wrongAttempts: 2,
      bestScore: 0,
      bestVerdict: 'WA',
      firstAcAt: null,
      lastSubmitAt: 2_000,
    });
    expect(byId.get(p2)).toMatchObject({
      attempts: 3,
      wrongAttempts: 2,
      bestScore: 100,
      bestVerdict: 'AC',
      firstAcAt: 4_000,
      lastSubmitAt: 5_000,
    });
    expect(byId.get(p3)).toMatchObject({
      attempts: 2,
      wrongAttempts: 0,
      bestScore: 100,
      bestVerdict: 'AC',
      firstAcAt: 6_000,
    });
  });

  it('lists never-AC problems by default and latest-wrong problems on request', () => {
    const { db, alice } = setup();
    const neverAc = makeProblem(db, { title: 'Never AC' });
    const latestWrong = makeProblem(db, { title: 'AC then WA' });
    const solved = makeProblem(db, { title: 'Solved' });
    addSubmission(db, { userId: alice, problemId: neverAc, verdict: 'WA', createdAt: 1_000 });
    addSubmission(db, {
      userId: alice,
      problemId: latestWrong,
      verdict: 'AC',
      score: 100,
      createdAt: 2_000,
    });
    addSubmission(db, {
      userId: alice,
      problemId: latestWrong,
      verdict: 'WA',
      score: 0,
      createdAt: 3_000,
    });
    addSubmission(db, {
      userId: alice,
      problemId: solved,
      verdict: 'AC',
      score: 100,
      createdAt: 4_000,
    });

    const never = getStudentWrongProblems(db, alice, { userId: alice }, { mode: 'never-ac' });
    expect(never.problems.map((problem) => problem.problemId)).toEqual([neverAc]);
    expect(never.problems[0]).toMatchObject({ lastVerdict: 'WA', firstAcAt: null });

    const latest = getStudentWrongProblems(
      db,
      alice,
      { userId: alice },
      { mode: 'latest-wrong' },
    );
    expect(latest.problems.map((problem) => problem.problemId)).toEqual([
      latestWrong,
      neverAc,
    ]);
    expect(latest.problems[0]).toMatchObject({
      lastVerdict: 'WA',
      firstAcAt: 2_000,
      lastSubmitAt: 3_000,
    });
  });

  it('aggregates tag attempts and solves across problems', () => {
    const { db, alice } = setup();
    const p1 = makeProblem(db, { title: 'A', tags: ['dp', 'greedy'] });
    const p2 = makeProblem(db, { title: 'B', tags: ['dp'] });
    addSubmission(db, { userId: alice, problemId: p1, verdict: 'WA', createdAt: 1_000 });
    addSubmission(db, { userId: alice, problemId: p1, verdict: 'WA', createdAt: 2_000 });
    addSubmission(db, {
      userId: alice,
      problemId: p2,
      verdict: 'AC',
      score: 100,
      createdAt: 3_000,
    });
    addSubmission(db, {
      userId: alice,
      problemId: p2,
      verdict: 'AC',
      score: 100,
      createdAt: 4_000,
    });

    const stats = getStudentStats(db, alice, { userId: alice });
    expect(stats.tags).toEqual([
      { tag: 'dp', attempts: 4, solved: 1, totalProblems: 2, lastAttemptAt: 4_000 },
      { tag: 'greedy', attempts: 2, solved: 0, totalProblems: 1, lastAttemptAt: 2_000 },
    ]);
  });

  it('counts only finished, non-hacked submissions', () => {
    const { db, alice } = setup();
    const problem = makeProblem(db, { title: 'Counting' });
    addSubmission(db, {
      userId: alice,
      problemId: problem,
      verdict: 'WA',
      createdAt: 1_000,
    });
    addSubmission(db, {
      userId: alice,
      problemId: problem,
      verdict: 'AC',
      score: 100,
      createdAt: 2_000,
      status: 'queued',
    });
    addSubmission(db, {
      userId: alice,
      problemId: problem,
      verdict: 'AC',
      score: 100,
      createdAt: 3_000,
      hacked: true,
    });
    addSubmission(db, {
      userId: alice,
      problemId: problem,
      verdict: 'AC',
      score: 100,
      createdAt: 4_000,
      status: 'failed',
    });

    const stats = getStudentStats(db, alice, { userId: alice });
    expect(stats.summary).toMatchObject({
      totalSubmissions: 1,
      acSubmissions: 0,
      wrongSubmissions: 1,
      solvedProblems: 0,
    });
  });

  it('excludes hidden problems from stats, wrong lists and snapshots', () => {
    const { db, alice } = setup();
    const shown = makeProblem(db, { title: 'Shown' });
    const hidden = makeProblem(db, { title: 'Hidden', visibility: 'hidden' });
    addSubmission(db, { userId: alice, problemId: shown, verdict: 'WA', createdAt: 1_000 });
    addSubmission(db, {
      userId: alice,
      problemId: hidden,
      verdict: 'AC',
      score: 100,
      createdAt: 2_000,
    });

    const stats = getStudentStats(db, alice, { userId: alice });
    expect(stats.problems.map((problem) => problem.problemId)).toEqual([shown]);
    expect(stats.summary.totalSubmissions).toBe(1);
    expect(
      getStudentWrongProblems(db, alice, { userId: alice }).problems.map((p) => p.problemId),
    ).toEqual([shown]);

    rebuildStudentStats(db, alice);
    const rows = db
      .prepare('SELECT problem_id FROM student_problem_stats WHERE user_id = ? ORDER BY problem_id')
      .all(alice) as Array<{ problem_id: number }>;
    expect(rows.map((row) => row.problem_id)).toEqual([shown]);
  });

  it('filters contest submissions while always keeping practice', () => {
    const { db, alice } = setup();
    const problem = makeProblem(db, { title: 'Mixed' });
    addSubmission(db, {
      userId: alice,
      problemId: problem,
      verdict: 'WA',
      createdAt: 1_000,
      contestId: null,
    });
    addSubmission(db, {
      userId: alice,
      problemId: problem,
      verdict: 'AC',
      score: 100,
      createdAt: 2_000,
      contestId: 7,
    });

    const all = getStudentStats(db, alice, { userId: alice });
    expect(all.summary).toMatchObject({
      totalSubmissions: 2,
      solvedProblems: 1,
      firstAcAt: 2_000,
    });
    const practiceOnly = getStudentStats(
      db,
      alice,
      { userId: alice },
      { includeContest: false },
    );
    expect(practiceOnly.includeContest).toBe(false);
    expect(practiceOnly.summary).toMatchObject({
      totalSubmissions: 1,
      solvedProblems: 0,
      firstAcAt: null,
    });
    expect(
      getStudentWrongProblems(
        db,
        alice,
        { userId: alice },
        { mode: 'never-ac', includeContest: false },
      ).problems.map((p) => p.problemId),
    ).toEqual([problem]);
  });

  it('groups submissions into daily activity buckets', () => {
    const { db, alice } = setup();
    const problem = makeProblem(db, { title: 'Daily' });
    const day1 = Date.UTC(2026, 0, 1, 8, 0, 0);
    addSubmission(db, { userId: alice, problemId: problem, verdict: 'WA', createdAt: day1 });
    addSubmission(db, {
      userId: alice,
      problemId: problem,
      verdict: 'WA',
      createdAt: day1 + 60_000,
    });
    addSubmission(db, {
      userId: alice,
      problemId: problem,
      verdict: 'AC',
      score: 100,
      createdAt: day1 + DAY,
    });

    const stats = getStudentStats(db, alice, { userId: alice });
    expect(stats.daily).toEqual([
      { date: '2026-01-01', submissions: 2, acCount: 0, points: 0, activeSeconds: 0 },
      { date: '2026-01-02', submissions: 1, acCount: 1, points: 100, activeSeconds: 0 },
    ]);
  });

  it('rebuilds cached problem, tag and daily snapshots', () => {
    const { db, alice, bob } = setup();
    const problem = makeProblem(db, { title: 'Cached', tags: ['math'] });
    addSubmission(db, {
      userId: alice,
      problemId: problem,
      verdict: 'WA',
      score: 10,
      createdAt: 1_000,
    });
    addSubmission(db, {
      userId: alice,
      problemId: problem,
      verdict: 'AC',
      score: 100,
      createdAt: 2_000,
    });
    addSubmission(db, {
      userId: bob,
      problemId: problem,
      verdict: 'WA',
      createdAt: 3_000,
    });

    const result = rebuildStudentStats(db, alice);
    expect(result).toEqual({ problems: 1, tags: 1, days: 1 });
    expect(
      db
        .prepare(
          `SELECT attempts, best_score, best_verdict, first_ac_at, last_submit_at,
                  wrong_attempts, tags_json
           FROM student_problem_stats WHERE user_id = ? AND problem_id = ?`,
        )
        .get(alice, problem),
    ).toMatchObject({
      attempts: 2,
      best_score: 100,
      best_verdict: 'AC',
      first_ac_at: 2_000,
      last_submit_at: 2_000,
      wrong_attempts: 1,
      tags_json: '["math"]',
    });
    expect(
      db
        .prepare(
          'SELECT attempts, solved, last_attempt_at FROM student_tag_stats WHERE user_id = ? AND tag = ?',
        )
        .get(alice, 'math'),
    ).toMatchObject({ attempts: 2, solved: 1, last_attempt_at: 2_000 });
    expect(
      db
        .prepare(
          'SELECT submissions, ac_count, points FROM student_daily_stats WHERE user_id = ?',
        )
        .get(alice),
    ).toMatchObject({ submissions: 2, ac_count: 1, points: 100 });

    expect(rebuildAllStats(db)).toBe(2);
    const cached = db
      .prepare('SELECT user_id FROM student_problem_stats ORDER BY user_id')
      .all() as Array<{ user_id: number }>;
    expect(cached.map((row) => row.user_id)).toEqual([alice, bob]);
  });
});

describe('learning stats permissions', () => {
  function classSetup() {
    const ctx = setup();
    const { db, admin, manager, alice, bob, carol, dave } = ctx;
    const classA = createClass(db, {
      name: 'Class A',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    addClassCoach(db, { classId: classA, actorId: manager, username: 'alice' });
    addClassMember(db, { classId: classA, actorId: manager, username: 'bob' });
    addClassMember(db, { classId: classA, actorId: manager, username: 'carol' });
    addClassMember(db, { classId: classA, actorId: manager, username: 'erin' });
    const classB = createClass(db, {
      name: 'Class B',
      ownerId: dave,
      actorRole: 'contestmanager',
    });
    addClassMember(db, { classId: classB, actorId: dave, username: 'bob' });
    const problem = makeProblem(db, { title: 'Shared', tags: ['dp'] });
    addSubmission(db, {
      userId: bob,
      problemId: problem,
      verdict: 'AC',
      score: 100,
      createdAt: 1_000,
    });
    return { ...ctx, classA, classB, problem };
  }

  it('lets self, admins, class coaches and team captains read a student', () => {
    const ctx = classSetup();
    const { db, admin, manager, alice, bob, carol } = ctx;
    expect(getStudentStats(db, bob, { userId: bob }).userId).toBe(bob);
    expect(
      getStudentStats(db, bob, { userId: admin, isAdmin: true }).summary.solvedProblems,
    ).toBe(1);
    expect(getStudentStats(db, bob, { userId: manager }).userId).toBe(bob);
    expect(getStudentStats(db, bob, { userId: alice }).userId).toBe(bob);
    expect(getStudentStats(db, bob, { userId: alice }, { classId: ctx.classA }).userId).toBe(
      bob,
    );

    expectLearningError(
      () => getStudentStats(db, bob, { userId: carol }),
      'STUDENT_FORBIDDEN',
      403,
    );
    expectLearningError(
      () =>
        getStudentStats(db, bob, { userId: alice }, { classId: ctx.classB }),
      'STUDENT_FORBIDDEN',
      403,
    );
    expectLearningError(
      () => getStudentStats(db, 999_999, { userId: bob }),
      'STUDENT_NOT_FOUND',
      404,
    );
    expectLearningError(
      () => getStudentStats(db, bob, { userId: alice }, { classId: 999_999 }),
      'CLASS_NOT_FOUND',
      404,
    );
  });

  it('lets a team captain read their team members and a class coach cannot read a non-member', () => {
    const { db, bob, carol, dave, erin } = classSetup();
    createTeam(db, { name: 'Team One', ownerId: bob });
    const team = db
      .prepare("SELECT id FROM teams WHERE name = 'Team One'")
      .get() as { id: number };
    db.prepare(
      "INSERT INTO team_members(team_id, user_id, role, joined_at) VALUES (?, ?, 'member', 1)",
    ).run(team.id, carol);

    const stats = getStudentStats(db, carol, { userId: bob });
    expect(stats.userId).toBe(carol);

    // dave coaches class B but erin is only in class A.
    expectLearningError(
      () => getStudentStats(db, erin, { userId: dave }),
      'STUDENT_FORBIDDEN',
      403,
    );
  });
});

describe('class learning stats', () => {
  function seedClass() {
    const ctx = setup();
    const { db, manager, alice, bob, carol, erin } = ctx;
    const classId = createClass(db, {
      name: 'Class A',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    addClassCoach(db, { classId, actorId: manager, username: 'alice' });
    addClassMember(db, { classId, actorId: manager, username: 'bob' });
    addClassMember(db, { classId, actorId: manager, username: 'carol' });
    addClassMember(db, { classId, actorId: manager, username: 'erin' });
    const p1 = makeProblem(db, { title: 'Wrong one', tags: ['dp'] });
    const p2 = makeProblem(db, { title: 'Solved one', tags: ['dp'] });
    const p3 = makeProblem(db, { title: 'Wrong twice', tags: ['greedy'] });
    const now = Date.UTC(2026, 5, 1);
    addSubmission(db, {
      userId: bob,
      problemId: p1,
      verdict: 'WA',
      createdAt: now - 2 * DAY,
    });
    addSubmission(db, {
      userId: bob,
      problemId: p2,
      verdict: 'AC',
      score: 100,
      createdAt: now - 2 * DAY + 1_000,
    });
    addSubmission(db, {
      userId: carol,
      problemId: p3,
      verdict: 'WA',
      createdAt: now - DAY,
    });
    addSubmission(db, {
      userId: carol,
      problemId: p3,
      verdict: 'WA',
      createdAt: now - DAY + 1_000,
    });
    return { ...ctx, classId, p1, p2, p3, now };
  }

  it('summarises completed problems, weak tags, inactive members and top wrong problems', () => {
    const { db, manager, alice, bob, carol, classId, p1, p3, now } = seedClass();
    const stats = getClassLearningStats(db, classId, { userId: manager }, { now });
    expect(stats).toMatchObject({
      classId,
      className: 'Class A',
      studentCount: 3,
      activeStudentCount: 2,
      completedProblems: 1,
      attemptedProblems: 3,
      totalSubmissions: 4,
    });
    expect(stats.students.map((student) => student.username)).toEqual([
      'bob',
      'carol',
      'erin',
    ]);
    expect(stats.students.find((student) => student.username === 'bob')).toMatchObject({
      solvedProblems: 1,
      attemptedProblems: 2,
      totalSubmissions: 2,
    });
    expect(stats.weakTags).toEqual([
      { tag: 'greedy', attempts: 2, solved: 0, solveRate: 0 },
      { tag: 'dp', attempts: 2, solved: 1, solveRate: 0.5 },
    ]);
    expect(stats.inactiveMembers.map((member) => member.username)).toEqual(['erin']);
    expect(stats.topWrongProblems.map((problem) => problem.problemId)).toEqual([p3, p1]);
    expect(stats.topWrongProblems[0]).toMatchObject({ studentCount: 1, attempts: 2 });

    // Coaches and admins may read it; students and outsiders may not.
    expect(getClassLearningStats(db, classId, { userId: alice }, { now }).classId).toBe(classId);
    expect(
      getClassLearningStats(db, classId, { userId: manager, isAdmin: true }, { now }).classId,
    ).toBe(classId);
    expectLearningError(
      () => getClassLearningStats(db, classId, { userId: bob }, { now }),
      'CLASS_FORBIDDEN',
      403,
    );
    expectLearningError(
      () => getClassLearningStats(db, classId, { userId: carol }, { now }),
      'CLASS_FORBIDDEN',
      403,
    );
    expectLearningError(
      () => getClassLearningStats(db, 999_999, { userId: manager }, { now }),
      'CLASS_NOT_FOUND',
      404,
    );
    expectLearningError(
      () => getClassLearningStats(db, 999_999, { userId: 999_999, isAdmin: true }, { now }),
      'CLASS_NOT_FOUND',
      404,
    );
  });

  it('honours the contest filter for class aggregates', () => {
    const { db, manager, classId, now } = seedClass();
    const practiceOnly = getClassLearningStats(
      db,
      classId,
      { userId: manager },
      { now, includeContest: false },
    );
    expect(practiceOnly.includeContest).toBe(false);
    expect(practiceOnly.totalSubmissions).toBe(4);
  });
});
