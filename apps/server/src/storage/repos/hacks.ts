import type { DatabaseSync } from 'node:sqlite';

export interface ContestLockRow {
  contest_id: number;
  user_id: number;
  problem_id: number;
  locked_at: number;
}

export interface ContestHackRow {
  id: number;
  contest_id: number;
  problem_id: number;
  hacker_id: number;
  target_submission_id: number;
  input_path: string;
  status: string;
  verdict: string | null;
  message: string;
  created_at: number;
  judged_at: number | null;
}

export function lockProblem(
  db: DatabaseSync,
  contestId: number,
  userId: number,
  problemId: number,
): void {
  db.prepare(
    'INSERT OR IGNORE INTO contest_problem_locks(contest_id, user_id, problem_id, locked_at) VALUES (?, ?, ?, ?)',
  ).run(contestId, userId, problemId, Date.now());
}

export function getLock(
  db: DatabaseSync,
  contestId: number,
  userId: number,
  problemId: number,
): ContestLockRow | null {
  return (
    (db
      .prepare(
        'SELECT * FROM contest_problem_locks WHERE contest_id = ? AND user_id = ? AND problem_id = ?',
      )
      .get(contestId, userId, problemId) as unknown as ContestLockRow) ?? null
  );
}

export function unlockProblem(
  db: DatabaseSync,
  contestId: number,
  userId: number,
  problemId: number,
): void {
  db.prepare(
    'DELETE FROM contest_problem_locks WHERE contest_id = ? AND user_id = ? AND problem_id = ?',
  ).run(contestId, userId, problemId);
}

export function listLocks(db: DatabaseSync, contestId: number) {
  return db
    .prepare(
      `SELECT l.contest_id, l.user_id, l.problem_id, l.locked_at,
              u.username, u.real_name, p.title AS problem_title
       FROM contest_problem_locks l
       JOIN users u ON u.id = l.user_id
       JOIN problems p ON p.id = l.problem_id
       WHERE l.contest_id = ? ORDER BY l.locked_at DESC`,
    )
    .all(contestId) as unknown as Array<{
    contest_id: number;
    user_id: number;
    problem_id: number;
    locked_at: number;
    username: string;
    real_name: string | null;
    problem_title: string;
  }>;
}

export function createHack(
  db: DatabaseSync,
  input: {
    contestId: number;
    problemId: number;
    hackerId: number;
    targetSubmissionId: number;
    inputPath: string;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO contest_hacks
         (contest_id, problem_id, hacker_id, target_submission_id, input_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.contestId,
      input.problemId,
      input.hackerId,
      input.targetSubmissionId,
      input.inputPath,
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

export function getHack(db: DatabaseSync, id: number): ContestHackRow | null {
  return (
    (db.prepare('SELECT * FROM contest_hacks WHERE id = ?').get(id) as unknown as ContestHackRow) ??
    null
  );
}

export function updateHack(
  db: DatabaseSync,
  id: number,
  patch: { status: string; verdict?: string | null; message?: string },
): void {
  db.prepare(
    'UPDATE contest_hacks SET status = ?, verdict = ?, message = ?, judged_at = ? WHERE id = ?',
  ).run(patch.status, patch.verdict ?? null, patch.message ?? '', Date.now(), id);
}

export function countRecentHacks(
  db: DatabaseSync,
  contestId: number,
  hackerId: number,
  since: number,
): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM contest_hacks WHERE contest_id = ? AND hacker_id = ? AND created_at >= ?',
    )
    .get(contestId, hackerId, since) as { n: number };
  return Number(row.n);
}

export function listHackAudit(db: DatabaseSync, contestId: number) {
  return db
    .prepare(
      `SELECT h.id, h.contest_id, h.problem_id, h.hacker_id, h.target_submission_id,
              h.status, h.verdict, h.message, h.created_at, h.judged_at,
              hu.username AS hacker_username,
              tu.username AS target_username, tu.real_name AS target_real_name,
              p.title AS problem_title,
              s.verdict AS target_verdict, s.score AS target_score
       FROM contest_hacks h
       JOIN users hu ON hu.id = h.hacker_id
       JOIN submissions s ON s.id = h.target_submission_id
       JOIN users tu ON tu.id = s.user_id
       JOIN problems p ON p.id = h.problem_id
       WHERE h.contest_id = ? ORDER BY h.id DESC`,
    )
    .all(contestId) as unknown as Array<{
    id: number;
    contest_id: number;
    problem_id: number;
    hacker_id: number;
    target_submission_id: number;
    status: string;
    verdict: string | null;
    message: string;
    created_at: number;
    judged_at: number | null;
    hacker_username: string;
    target_username: string;
    target_real_name: string | null;
    problem_title: string;
    target_verdict: string | null;
    target_score: number;
  }>;
}

export function listHacks(  db: DatabaseSync,
  contestId: number,
  problemId?: number,
): ContestHackRow[] {
  if (problemId !== undefined) {
    return db
      .prepare('SELECT * FROM contest_hacks WHERE contest_id = ? AND problem_id = ? ORDER BY id DESC')
      .all(contestId, problemId) as unknown as ContestHackRow[];
  }
  return db
    .prepare('SELECT * FROM contest_hacks WHERE contest_id = ? ORDER BY id DESC')
    .all(contestId) as unknown as ContestHackRow[];
}
