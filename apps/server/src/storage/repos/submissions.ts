import type { DatabaseSync } from 'node:sqlite';

export interface SubmissionRow {
  id: number;
  contest_id: number | null;
  problem_id: number;
  user_id: number;
  language: string;
  source_path: string;
  source_hash: string;
  status: string;
  verdict: string | null;
  score: number;
  time_ms: number;
  memory_kb: number;
  message: string;
  created_at: number;
  judged_at: number | null;
  phase: string;
  batch_id: number | null;
  hacked_at: number | null;
  hacked_by: number | null;
  hack_id: number | null;
}

export interface CreateSubmissionInput {
  contestId?: number | null;
  problemId: number;
  userId: number;
  language: string;
  sourcePath: string;
  sourceHash: string;
  phase?: string;
  batchId?: number | null;
  /** Submission timestamp override (used by tests and for deterministic callers). */
  createdAt?: number;
}

export function createSubmission(db: DatabaseSync, input: CreateSubmissionInput): number {
  const result = db
    .prepare(
      `INSERT INTO submissions(contest_id, problem_id, user_id, language, source_path,
         source_hash, created_at, phase, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.contestId ?? null,
      input.problemId,
      input.userId,
      input.language,
      input.sourcePath,
      input.sourceHash,
      input.createdAt ?? Date.now(),
      input.phase ?? 'contest',
      input.batchId ?? null,
    );
  return Number(result.lastInsertRowid);
}

/**
 * Returns the newest submission timestamp for a user/problem/contest key.
 * `contestId` is part of the key; `null` (practice) is a distinct key.
 */
export function getLatestSubmissionAt(
  db: DatabaseSync,
  userId: number,
  problemId: number,
  contestId: number | null,
): number | null {
  const row = db
    .prepare(
      `SELECT MAX(created_at) AS latest FROM submissions
       WHERE user_id = ? AND problem_id = ? AND contest_id IS ?`,
    )
    .get(userId, problemId, contestId) as unknown as { latest: number | null } | undefined;
  return row?.latest ?? null;
}

export function getSubmission(db: DatabaseSync, id: number): SubmissionRow | null {
  return (
    (db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as unknown as SubmissionRow) ??
    null
  );
}

export interface ResultInput {
  testcaseId: number;
  verdict: string;
  timeMs: number;
  memoryKb: number;
  score: number;
  message: string;
}

export function replaceTestResults(
  db: DatabaseSync,
  submissionId: number,
  results: ResultInput[],
): void {
  db.prepare('DELETE FROM test_results WHERE submission_id = ?').run(submissionId);
  const insert = db.prepare(
    `INSERT INTO test_results(submission_id, testcase_id, verdict, time_ms, memory_kb, score, message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const result of results) {
    insert.run(
      submissionId,
      result.testcaseId,
      result.verdict,
      result.timeMs,
      result.memoryKb,
      result.score,
      result.message,
    );
  }
}

export function setSubmissionStatus(
  db: DatabaseSync,
  submissionId: number,
  status: string,
): void {
  db.prepare('UPDATE submissions SET status = ? WHERE id = ?').run(status, submissionId);
}

export function finishSubmission(
  db: DatabaseSync,
  submissionId: number,
  result: {
    status: 'finished' | 'failed';
    verdict: string | null;
    score: number;
    timeMs: number;
    memoryKb: number;
    message?: string;
  },
): void {
  db.prepare(
    `UPDATE submissions SET status = ?, verdict = ?, score = ?, time_ms = ?, memory_kb = ?,
     message = ?, judged_at = ? WHERE id = ?`,
  ).run(
    result.status,
    result.verdict,
    result.score,
    result.timeMs,
    result.memoryKb,
    result.message ?? '',
    Date.now(),
    submissionId,
  );
}

export function getTestResults(
  db: DatabaseSync,
  submissionId: number,
): Array<{
  testcase_id: number;
  verdict: string;
  time_ms: number;
  memory_kb: number;
  score: number;
  message: string;
}> {
  return db
    .prepare(
      `SELECT testcase_id, verdict, time_ms, memory_kb, score, message
       FROM test_results WHERE submission_id = ? ORDER BY testcase_id`,
    )
    .all(submissionId) as unknown as Array<{
    testcase_id: number;
    verdict: string;
    time_ms: number;
    memory_kb: number;
    score: number;
    message: string;
  }>;
}

export interface ListSubmissionsFilter {
  userId?: number;
  problemId?: number;
  contestId?: number;
  limit?: number;
  beforeId?: number;
}

export function listSubmissions(db: DatabaseSync, filter: ListSubmissionsFilter): SubmissionRow[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.userId !== undefined) {
    clauses.push('user_id = ?');
    params.push(filter.userId);
  }
  if (filter.problemId !== undefined) {
    clauses.push('problem_id = ?');
    params.push(filter.problemId);
  }
  if (filter.contestId !== undefined) {
    clauses.push('contest_id = ?');
    params.push(filter.contestId);
  }
  if (filter.beforeId !== undefined) {
    clauses.push('id < ?');
    params.push(filter.beforeId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
  return db
    .prepare(`SELECT * FROM submissions ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as unknown as SubmissionRow[];
}

export function markSubmissionHacked(
  db: DatabaseSync,
  submissionId: number,
  hackerId: number,
  hackId: number,
): void {
  db.prepare('UPDATE submissions SET hacked_at = ?, hacked_by = ?, hack_id = ? WHERE id = ?').run(
    Date.now(),
    hackerId,
    hackId,
    submissionId,
  );
}

export function clearSubmissionHacked(db: DatabaseSync, submissionId: number): void {
  db.prepare(
    'UPDATE submissions SET hacked_at = NULL, hacked_by = NULL, hack_id = NULL WHERE id = ?',
  ).run(submissionId);
}

export function listUnhackedContestSubmissions(
  db: DatabaseSync,
  contestId: number,
  userId: number,
  problemId: number,
): SubmissionRow[] {
  return db
    .prepare(
      `SELECT * FROM submissions
       WHERE contest_id = ? AND user_id = ? AND problem_id = ?
         AND phase = 'contest' AND status = 'finished' AND hacked_at IS NULL
       ORDER BY score DESC, id ASC`,
    )
    .all(contestId, userId, problemId) as unknown as SubmissionRow[];
}
export function listHackTargets(
  db: DatabaseSync,
  contestId: number,
  problemId: number,
  hackerId: number,
): SubmissionRow[] {
  return db
    .prepare(
      `SELECT * FROM submissions
       WHERE contest_id = ? AND problem_id = ? AND user_id <> ?
         AND phase = 'contest' AND status = 'finished' AND hacked_at IS NULL
       ORDER BY id DESC`,
    )
    .all(contestId, problemId, hackerId) as unknown as SubmissionRow[];
}

export function listContestSubmissions(
  db: DatabaseSync,
  contestId: number,
): SubmissionRow[] {
  return db
    .prepare('SELECT * FROM submissions WHERE contest_id = ? ORDER BY id')
    .all(contestId) as unknown as SubmissionRow[];
}
