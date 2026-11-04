// Student learning analytics: per-problem, per-tag and per-day aggregates.
//
// Aggregates are computed live from `submissions` (the cache tables are written
// by the `rebuild*` helpers and can be refreshed at any time). Only finished,
// non-hacked submissions count, and problems with `visibility = 'hidden'` are
// never exposed — not even their problem id.
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../storage/db.js';
import {
  getTeamMember,
  getTeamRow,
  listTeamMembers,
  listTeamsForUser,
} from '../storage/repos/teams.js';
import { getUserById, type UserRow } from '../storage/repos/users.js';
import { listSubmissions } from '../storage/repos/submissions.js';
import {
  canTeachGroup,
  canViewStudentSource,
  type StudentSourceViewer,
} from './teams.js';

export const WRONG_PROBLEM_MODES = ['never-ac', 'latest-wrong'] as const;
export type WrongProblemMode = (typeof WRONG_PROBLEM_MODES)[number];

export class LearningStatsError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'LearningStatsError';
    this.code = code;
    this.status = status;
  }
}

export interface LearningStatsActor extends StudentSourceViewer {
  userId: number;
  isAdmin?: boolean;
}

/** One row of a student's submission history; never contains source code. */
export interface StudentSubmissionSummary {
  id: number;
  problemId: number;
  contestId: number | null;
  status: string;
  verdict: string | null;
  score: number;
  createdAt: string;
}

export interface StudentSubmissionsOptions {
  limit?: number;
  beforeId?: number;
}

export interface StudentProblemStat {
  problemId: number;
  title: string;
  difficulty: number | null;
  tags: string[];
  attempts: number;
  wrongAttempts: number;
  bestScore: number;
  bestVerdict: string | null;
  firstAcAt: number | null;
  lastSubmitAt: number;
}

export interface StudentWrongProblem extends StudentProblemStat {
  /** Verdict of the newest counted submission. */
  lastVerdict: string | null;
}

export interface StudentTagStat {
  tag: string;
  attempts: number;
  solved: number;
  totalProblems: number;
  lastAttemptAt: number;
}

export interface StudentDailyStat {
  date: string;
  submissions: number;
  acCount: number;
  points: number;
  /**
   * Seconds of activity. No client heartbeat exists today, so the value is a
   * reserved field and rebuilds write 0.
   */
  activeSeconds: number;
}

export interface StudentStats {
  userId: number;
  username: string;
  generatedAt: number;
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
  problems: StudentProblemStat[];
  tags: StudentTagStat[];
  daily: StudentDailyStat[];
}

export interface StudentWrongProblems {
  userId: number;
  mode: WrongProblemMode;
  generatedAt: number;
  includeContest: boolean;
  problems: StudentWrongProblem[];
}

export interface ClassStudentSummary {
  userId: number;
  username: string;
  attemptedProblems: number;
  solvedProblems: number;
  totalSubmissions: number;
  lastActiveAt: number | null;
}

export interface ClassWeakTag {
  tag: string;
  attempts: number;
  solved: number;
  solveRate: number;
}

export interface ClassInactiveMember {
  userId: number;
  username: string;
  lastActiveAt: number | null;
}

export interface ClassWrongProblem {
  problemId: number;
  title: string;
  studentCount: number;
  attempts: number;
}

export interface ClassLearningStats {
  classId: number;
  className: string;
  generatedAt: number;
  includeContest: boolean;
  studentCount: number;
  activeStudentCount: number;
  completedProblems: number;
  attemptedProblems: number;
  totalSubmissions: number;
  students: ClassStudentSummary[];
  weakTags: ClassWeakTag[];
  inactiveMembers: ClassInactiveMember[];
  topWrongProblems: ClassWrongProblem[];
}

export interface StudentStatsOptions {
  /** Restrict the permission check to one class the target student belongs to. */
  classId?: number;
  /** Include contest submissions; practice submissions are always included. */
  includeContest?: boolean;
}

export interface WrongProblemsOptions {
  mode?: WrongProblemMode;
  includeContest?: boolean;
  classId?: number;
}

export interface ClassLearningStatsOptions {
  includeContest?: boolean;
  /** Reference time for the "inactive" window (tests pass a fixed value). */
  now?: number;
}

/** A student whose newest counted submission is older than this is inactive. */
export const INACTIVE_DAYS = 14;
const INACTIVE_MS = INACTIVE_DAYS * 24 * 60 * 60 * 1000;
const WEAK_TAG_LIMIT = 10;
const TOP_WRONG_LIMIT = 10;

interface SubmissionFactRow {
  problem_id: number;
  verdict: string | null;
  score: number;
  created_at: number;
  title: string;
  difficulty: number | null;
  tags_json: string;
}

function isWrongProblemMode(value: unknown): value is WrongProblemMode {
  return typeof value === 'string' && (WRONG_PROBLEM_MODES as readonly string[]).includes(value);
}

function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Counted submissions for one student, oldest first. */
function loadSubmissionFacts(
  db: DatabaseSync,
  userId: number,
  includeContest: boolean,
): SubmissionFactRow[] {
  const contestClause = includeContest ? '' : 'AND s.contest_id IS NULL';
  return db
    .prepare(
      `SELECT s.problem_id, s.verdict, s.score, s.created_at,
              p.title, p.difficulty, p.tags_json
       FROM submissions s
       JOIN problems p ON p.id = s.problem_id
       WHERE s.user_id = ?
         AND s.status = 'finished'
         AND s.hacked_at IS NULL
         AND p.visibility != 'hidden'
         ${contestClause}
       ORDER BY s.created_at ASC, s.id ASC`,
    )
    .all(userId) as unknown as SubmissionFactRow[];
}

interface ProblemAccumulator {
  problemId: number;
  title: string;
  difficulty: number | null;
  tags: string[];
  attempts: number;
  wrongAttempts: number;
  bestScore: number;
  bestVerdict: string | null;
  firstAcAt: number | null;
  lastSubmitAt: number;
  lastVerdict: string | null;
}

interface DailyAccumulator {
  submissions: number;
  acCount: number;
  /** Highest score per problem that day; summed into `points` at the end. */
  bestScores: Map<number, number>;
}

interface ComputedStudentStats {
  stats: Omit<StudentStats, 'username' | 'generatedAt'>;
  /** Newest verdict per problem, used by the wrong-problem views. */
  lastVerdicts: Map<number, string | null>;
}

function computeStudentStats(
  db: DatabaseSync,
  userId: number,
  includeContest: boolean,
): ComputedStudentStats {
  const facts = loadSubmissionFacts(db, userId, includeContest);
  const byProblem = new Map<number, ProblemAccumulator>();
  const byDay = new Map<string, DailyAccumulator>();
  let acSubmissions = 0;

  for (const fact of facts) {
    let problem = byProblem.get(fact.problem_id);
    if (!problem) {
      problem = {
        problemId: fact.problem_id,
        title: fact.title,
        difficulty: fact.difficulty,
        tags: parseTags(fact.tags_json),
        attempts: 0,
        wrongAttempts: 0,
        bestScore: 0,
        bestVerdict: null,
        firstAcAt: null,
        lastSubmitAt: fact.created_at,
        lastVerdict: null,
      };
      byProblem.set(fact.problem_id, problem);
    }
    problem.attempts += 1;
    if (fact.verdict !== 'AC') problem.wrongAttempts += 1;
    if (
      fact.score > problem.bestScore ||
      (fact.score === problem.bestScore && problem.bestVerdict === null)
    ) {
      problem.bestScore = fact.score;
      problem.bestVerdict = fact.verdict;
    } else if (
      fact.score === problem.bestScore &&
      fact.verdict === 'AC' &&
      problem.bestVerdict !== 'AC'
    ) {
      problem.bestVerdict = 'AC';
    }
    if (fact.verdict === 'AC') {
      acSubmissions += 1;
      if (problem.firstAcAt === null) problem.firstAcAt = fact.created_at;
    }
    problem.lastSubmitAt = fact.created_at;
    problem.lastVerdict = fact.verdict;

    const key = dayKey(fact.created_at);
    let day = byDay.get(key);
    if (!day) {
      day = { submissions: 0, acCount: 0, bestScores: new Map() };
      byDay.set(key, day);
    }
    day.submissions += 1;
    if (fact.verdict === 'AC') day.acCount += 1;
    const previousBest = day.bestScores.get(fact.problem_id) ?? 0;
    if (fact.score > previousBest) day.bestScores.set(fact.problem_id, fact.score);
  }

  const problems: StudentProblemStat[] = [...byProblem.values()]
    .map((problem) => ({
      problemId: problem.problemId,
      title: problem.title,
      difficulty: problem.difficulty,
      tags: problem.tags,
      attempts: problem.attempts,
      wrongAttempts: problem.wrongAttempts,
      bestScore: problem.bestScore,
      bestVerdict: problem.bestVerdict,
      firstAcAt: problem.firstAcAt,
      lastSubmitAt: problem.lastSubmitAt,
    }))
    .sort((a, b) => b.lastSubmitAt - a.lastSubmitAt || b.problemId - a.problemId);

  const tagAcc = new Map<string, StudentTagStat>();
  for (const problem of byProblem.values()) {
    for (const tag of problem.tags) {
      let entry = tagAcc.get(tag);
      if (!entry) {
        entry = { tag, attempts: 0, solved: 0, totalProblems: 0, lastAttemptAt: 0 };
        tagAcc.set(tag, entry);
      }
      entry.attempts += problem.attempts;
      entry.totalProblems += 1;
      if (problem.firstAcAt !== null) entry.solved += 1;
      if (problem.lastSubmitAt > entry.lastAttemptAt) entry.lastAttemptAt = problem.lastSubmitAt;
    }
  }
  const tags = [...tagAcc.values()].sort(
    (a, b) => b.attempts - a.attempts || a.tag.localeCompare(b.tag),
  );

  const daily: StudentDailyStat[] = [...byDay.entries()]
    .map(([date, day]) => ({
      date,
      submissions: day.submissions,
      acCount: day.acCount,
      points: [...day.bestScores.values()].reduce((sum, score) => sum + score, 0),
      activeSeconds: 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  let firstAcAt: number | null = null;
  let lastActiveAt: number | null = null;
  let solvedProblems = 0;
  for (const problem of problems) {
    if (problem.firstAcAt !== null) {
      solvedProblems += 1;
      if (firstAcAt === null || problem.firstAcAt < firstAcAt) firstAcAt = problem.firstAcAt;
    }
    if (lastActiveAt === null || problem.lastSubmitAt > lastActiveAt) {
      lastActiveAt = problem.lastSubmitAt;
    }
  }

  return {
    stats: {
      userId,
      includeContest,
      summary: {
        attemptedProblems: problems.length,
        solvedProblems,
        totalSubmissions: facts.length,
        acSubmissions,
        wrongSubmissions: facts.length - acSubmissions,
        firstAcAt,
        lastActiveAt,
      },
      problems,
      tags,
      daily,
    },
    lastVerdicts: new Map(
      [...byProblem.values()].map((problem) => [problem.problemId, problem.lastVerdict]),
    ),
  };
}

function requireStudent(db: DatabaseSync, userId: number): UserRow {
  const user = getUserById(db, userId);
  if (!user) {
    throw new LearningStatsError('STUDENT_NOT_FOUND', 404, 'student not found');
  }
  return user;
}

function requireClassRow(db: DatabaseSync, classId: number) {
  const group = getTeamRow(db, classId);
  if (!group || group.kind !== 'class') {
    throw new LearningStatsError('CLASS_NOT_FOUND', 404, 'class not found');
  }
  return group;
}

/**
 * Whether the actor teaches the target student in any class or team.
 *
 * Classes are taught by their coaches, teams by their captain, reusing the
 * existing team permission helper. Assistants and ordinary members teach
 * nobody and may only read their own stats.
 */
function teachesTarget(db: DatabaseSync, actorId: number, targetUserId: number): boolean {
  for (const kind of ['class', 'team'] as const) {
    for (const group of listTeamsForUser(db, actorId, kind)) {
      const teaches = kind === 'class' ? group.role === 'coach' : group.role === 'captain';
      if (!teaches) continue;
      if (getTeamMember(db, group.id, targetUserId)) {
        return true;
      }
    }
  }
  return false;
}

function assertCanViewStudent(
  db: DatabaseSync,
  actor: LearningStatsActor,
  targetUserId: number,
  classId?: number,
): UserRow {
  const target = requireStudent(db, targetUserId);
  if (classId !== undefined) {
    requireClassRow(db, classId);
    if (actor.isAdmin) return target;
    if (actor.userId === targetUserId) return target;
    if (!canTeachGroup(db, classId, actor.userId)) {
      throw new LearningStatsError(
        'STUDENT_FORBIDDEN',
        403,
        'you cannot view this student',
      );
    }
    if (!getTeamMember(db, classId, targetUserId)) {
      throw new LearningStatsError(
        'STUDENT_NOT_IN_CLASS',
        404,
        'student is not a member of this class',
      );
    }
    return target;
  }
  if (actor.isAdmin || actor.userId === targetUserId) return target;
  if (teachesTarget(db, actor.userId, targetUserId)) return target;
  throw new LearningStatsError('STUDENT_FORBIDDEN', 403, 'you cannot view this student');
}

/**
 * Lists a student's submissions (newest first) for students themself, staff and
 * the coaches/captains who teach them. Only summary fields are returned; source
 * code stays behind `GET /api/submissions/:id`, which audits every coach view.
 */
export function listStudentSubmissions(
  db: DatabaseSync,
  targetUserId: number,
  actor: LearningStatsActor,
  options: StudentSubmissionsOptions = {},
): StudentSubmissionSummary[] {
  requireStudent(db, targetUserId);
  if (!canViewStudentSource(db, actor, targetUserId)) {
    throw new LearningStatsError('STUDENT_FORBIDDEN', 403, 'you cannot view this student');
  }
  const limit = options.limit ?? 20;
  return listSubmissions(db, {
    userId: targetUserId,
    beforeId: options.beforeId,
    limit,
  }).map((row) => ({
    id: row.id,
    problemId: row.problem_id,
    contestId: row.contest_id,
    status: row.status,
    verdict: row.verdict,
    score: row.score,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export function getStudentStats(
  db: DatabaseSync,
  userId: number,
  actor: LearningStatsActor,
  options: StudentStatsOptions = {},
): StudentStats {
  const includeContest = options.includeContest ?? true;
  const user = assertCanViewStudent(db, actor, userId, options.classId);
  const { stats } = computeStudentStats(db, userId, includeContest);
  return {
    ...stats,
    username: user.username,
    generatedAt: Date.now(),
  };
}

export function getStudentWrongProblems(
  db: DatabaseSync,
  userId: number,
  actor: LearningStatsActor,
  options: WrongProblemsOptions = {},
): StudentWrongProblems {
  const mode = options.mode ?? 'never-ac';
  if (!isWrongProblemMode(mode)) {
    throw new LearningStatsError(
      'BAD_REQUEST',
      400,
      'mode must be never-ac or latest-wrong',
    );
  }
  const includeContest = options.includeContest ?? true;
  assertCanViewStudent(db, actor, userId, options.classId);
  const { stats, lastVerdicts } = computeStudentStats(db, userId, includeContest);

  const problems: StudentWrongProblem[] = stats.problems
    .map((problem) => ({
      ...problem,
      lastVerdict: lastVerdicts.get(problem.problemId) ?? null,
    }))
    .filter((problem) =>
      mode === 'never-ac'
        ? problem.firstAcAt === null
        : problem.lastVerdict !== 'AC',
    );

  return {
    userId,
    mode,
    generatedAt: Date.now(),
    includeContest,
    problems,
  };
}

export function getClassLearningStats(
  db: DatabaseSync,
  classId: number,
  actor: LearningStatsActor,
  options: ClassLearningStatsOptions = {},
): ClassLearningStats {
  const group = requireClassRow(db, classId);
  if (!actor.isAdmin && !canTeachGroup(db, classId, actor.userId)) {
    throw new LearningStatsError('CLASS_FORBIDDEN', 403, 'you cannot view this class');
  }
  const includeContest = options.includeContest ?? true;
  const now = options.now ?? Date.now();
  // Only students (`member`) are counted; assistants and coaches are staff.
  const students = listTeamMembers(db, classId).filter((member) => member.role === 'member');

  const summaries: ClassStudentSummary[] = [];
  const weakTags = new Map<string, { attempts: number; solved: number }>();
  const wrongProblems = new Map<number, { title: string; studentCount: number; attempts: number }>();
  const inactiveMembers: ClassInactiveMember[] = [];
  let completedProblems = 0;
  let attemptedProblems = 0;
  let totalSubmissions = 0;

  for (const student of students) {
    const { stats: computed } = computeStudentStats(db, student.userId, includeContest);
    summaries.push({
      userId: student.userId,
      username: student.username,
      attemptedProblems: computed.summary.attemptedProblems,
      solvedProblems: computed.summary.solvedProblems,
      totalSubmissions: computed.summary.totalSubmissions,
      lastActiveAt: computed.summary.lastActiveAt,
    });
    completedProblems += computed.summary.solvedProblems;
    attemptedProblems += computed.summary.attemptedProblems;
    totalSubmissions += computed.summary.totalSubmissions;

    if (computed.summary.lastActiveAt === null || now - computed.summary.lastActiveAt > INACTIVE_MS) {
      inactiveMembers.push({
        userId: student.userId,
        username: student.username,
        lastActiveAt: computed.summary.lastActiveAt,
      });
    }

    for (const tag of computed.tags) {
      const entry = weakTags.get(tag.tag) ?? { attempts: 0, solved: 0 };
      entry.attempts += tag.attempts;
      entry.solved += tag.solved;
      weakTags.set(tag.tag, entry);
    }

    for (const problem of computed.problems) {
      if (problem.firstAcAt !== null) continue;
      const entry = wrongProblems.get(problem.problemId) ?? {
        title: problem.title,
        studentCount: 0,
        attempts: 0,
      };
      entry.studentCount += 1;
      entry.attempts += problem.attempts;
      wrongProblems.set(problem.problemId, entry);
    }
  }

  const weakTagList: ClassWeakTag[] = [...weakTags.entries()]
    .map(([tag, entry]) => ({
      tag,
      attempts: entry.attempts,
      solved: entry.solved,
      solveRate: entry.attempts === 0 ? 0 : entry.solved / entry.attempts,
    }))
    .sort(
      (a, b) =>
        a.solveRate - b.solveRate ||
        b.attempts - a.attempts ||
        a.tag.localeCompare(b.tag),
    )
    .slice(0, WEAK_TAG_LIMIT);

  const topWrongProblems: ClassWrongProblem[] = [...wrongProblems.entries()]
    .map(([problemId, entry]) => ({ problemId, ...entry }))
    .sort(
      (a, b) =>
        b.studentCount - a.studentCount ||
        b.attempts - a.attempts ||
        a.problemId - b.problemId,
    )
    .slice(0, TOP_WRONG_LIMIT);

  // Never-submitted students first, then the longest-absent.
  inactiveMembers.sort(
    (a, b) =>
      Number(a.lastActiveAt !== null) - Number(b.lastActiveAt !== null) ||
      (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0) ||
      a.username.localeCompare(b.username),
  );

  return {
    classId,
    className: group.name,
    generatedAt: Date.now(),
    includeContest,
    studentCount: students.length,
    activeStudentCount: students.length - inactiveMembers.length,
    completedProblems,
    attemptedProblems,
    totalSubmissions,
    students: summaries,
    weakTags: weakTagList,
    inactiveMembers,
    topWrongProblems,
  };
}

/**
 * Rewrites the cache/snapshot tables for one student from live submissions.
 * Returns how many rows were written to each table.
 */
export function rebuildStudentStats(
  db: DatabaseSync,
  userId: number,
  options: { includeContest?: boolean } = {},
): { problems: number; tags: number; days: number } {
  const includeContest = options.includeContest ?? true;
  requireStudent(db, userId);
  const { stats } = computeStudentStats(db, userId, includeContest);
  const now = Date.now();

  transaction(db, () => {
    db.prepare('DELETE FROM student_problem_stats WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM student_tag_stats WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM student_daily_stats WHERE user_id = ?').run(userId);

    const insertProblem = db.prepare(
      `INSERT INTO student_problem_stats(user_id, problem_id, attempts, best_score,
         best_verdict, first_ac_at, last_submit_at, wrong_attempts, tags_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const problem of stats.problems) {
      insertProblem.run(
        userId,
        problem.problemId,
        problem.attempts,
        problem.bestScore,
        problem.bestVerdict,
        problem.firstAcAt,
        problem.lastSubmitAt,
        problem.wrongAttempts,
        JSON.stringify(problem.tags),
        now,
      );
    }

    const insertTag = db.prepare(
      `INSERT INTO student_tag_stats(user_id, tag, attempts, solved, last_attempt_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const tag of stats.tags) {
      insertTag.run(userId, tag.tag, tag.attempts, tag.solved, tag.lastAttemptAt);
    }

    const insertDay = db.prepare(
      `INSERT INTO student_daily_stats(user_id, date, submissions, ac_count, points,
         active_seconds) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const day of stats.daily) {
      insertDay.run(
        userId,
        day.date,
        day.submissions,
        day.acCount,
        day.points,
        day.activeSeconds,
      );
    }
  });

  return {
    problems: stats.problems.length,
    tags: stats.tags.length,
    days: stats.daily.length,
  };
}

export interface LearningStatsRebuildSummary {
  /** Number of students whose cache was rebuilt. */
  users: number;
  /** Rows written to `student_problem_stats`. */
  problems: number;
  /** Rows written to `student_tag_stats`. */
  tags: number;
  /** Rows written to `student_daily_stats`. */
  days: number;
  durationMs: number;
}

/**
 * Runs `rebuildAllStats` and reports how many rows each cache table received.
 * Counts are read back from the cache tables so they match what was written;
 * the aggregate rules themselves are untouched.
 */
export function rebuildAllStatsWithSummary(db: DatabaseSync): LearningStatsRebuildSummary {
  const startedAt = Date.now();
  const users = rebuildAllStats(db);
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM student_problem_stats) AS problems,
         (SELECT COUNT(*) FROM student_tag_stats) AS tags,
         (SELECT COUNT(*) FROM student_daily_stats) AS days`,
    )
    .get() as { problems: number; tags: number; days: number };
  return {
    users,
    problems: counts.problems,
    tags: counts.tags,
    days: counts.days,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Rebuilds the cache for every student that has any counted submission.
 * Stale rows for students who no longer qualify are dropped first.
 */
export function rebuildAllStats(db: DatabaseSync): number {
  const users = db
    .prepare(
      `SELECT DISTINCT s.user_id
       FROM submissions s
       JOIN problems p ON p.id = s.problem_id
       WHERE s.status = 'finished' AND s.hacked_at IS NULL AND p.visibility != 'hidden'
       ORDER BY s.user_id`,
    )
    .all() as Array<{ user_id: number }>;
  db.exec('DELETE FROM student_problem_stats');
  db.exec('DELETE FROM student_tag_stats');
  db.exec('DELETE FROM student_daily_stats');
  let rebuilt = 0;
  for (const row of users) {
    rebuildStudentStats(db, row.user_id);
    rebuilt += 1;
  }
  return rebuilt;
}
