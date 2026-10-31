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
  created_at: number;
  judged_at: number | null;
}

export interface CreateSubmissionInput {
  contestId?: number | null;
  problemId: number;
  userId: number;
  language: string;
  sourcePath: string;
  sourceHash: string;
}

export function createSubmission(db: DatabaseSync, input: CreateSubmissionInput): number {
  const result = db
    .prepare(
      `INSERT INTO submissions(contest_id, problem_id, user_id, language, source_path,
         source_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.contestId ?? null,
      input.problemId,
      input.userId,
      input.language,
      input.sourcePath,
      input.sourceHash,
      Date.now(),
    );
  return Number(result.lastInsertRowid);
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

export function finishSubmission(
  db: DatabaseSync,
  submissionId: number,
  result: {
    status: 'finished' | 'failed';
    verdict: string | null;
    score: number;
    timeMs: number;
    memoryKb: number;
  },
): void {
  db.prepare(
    `UPDATE submissions SET status = ?, verdict = ?, score = ?, time_ms = ?, memory_kb = ?,
     judged_at = ? WHERE id = ?`,
  ).run(
    result.status,
    result.verdict,
    result.score,
    result.timeMs,
    result.memoryKb,
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
