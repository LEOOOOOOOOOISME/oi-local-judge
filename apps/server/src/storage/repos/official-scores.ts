import type { DatabaseSync } from 'node:sqlite';

export interface OfficialScoreRow {
  contest_id: number;
  user_id: number;
  problem_id: number;
  score: number;
  verdict: string;
  source: 'online' | 'batch';
  batch_id: number | null;
  submission_id: number | null;
  batch_score: number | null;
  batch_verdict: string | null;
  updated_at: number;
}

export function getOfficialScore(
  db: DatabaseSync,
  contestId: number,
  userId: number,
  problemId: number,
): OfficialScoreRow | null {
  return (
    (db
      .prepare(
        `SELECT contest_id, user_id, problem_id, score, verdict, source, batch_id,
                submission_id, batch_score, batch_verdict, updated_at
         FROM contest_official_scores
         WHERE contest_id = ? AND user_id = ? AND problem_id = ?`,
      )
      .get(contestId, userId, problemId) as unknown as OfficialScoreRow) ?? null
  );
}

export function listOfficialScores(db: DatabaseSync, contestId: number): OfficialScoreRow[] {
  return db
    .prepare(
      `SELECT contest_id, user_id, problem_id, score, verdict, source, batch_id,
              submission_id, batch_score, batch_verdict, updated_at
       FROM contest_official_scores WHERE contest_id = ?`,
    )
    .all(contestId) as unknown as OfficialScoreRow[];
}

export function upsertOfficialScore(
  db: DatabaseSync,
  input: {
    contestId: number;
    userId: number;
    problemId: number;
    score: number;
    verdict: string;
    source: 'online' | 'batch';
    batchId?: number | null;
    submissionId?: number | null;
    batchScore?: number | null;
    batchVerdict?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO contest_official_scores
       (contest_id, user_id, problem_id, score, verdict, source, batch_id,
        submission_id, batch_score, batch_verdict, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(contest_id, user_id, problem_id) DO UPDATE SET
       score = excluded.score,
       verdict = excluded.verdict,
       source = excluded.source,
       batch_id = excluded.batch_id,
       submission_id = excluded.submission_id,
       batch_score = COALESCE(excluded.batch_score, contest_official_scores.batch_score),
       batch_verdict = COALESCE(excluded.batch_verdict, contest_official_scores.batch_verdict),
       updated_at = excluded.updated_at`,
  ).run(
    input.contestId,
    input.userId,
    input.problemId,
    input.score,
    input.verdict,
    input.source,
    input.batchId ?? null,
    input.submissionId ?? null,
    input.batchScore ?? null,
    input.batchVerdict ?? null,
    Date.now(),
  );
}

/**
 * Builds OI official cells from finished contest submissions. The highest score
 * wins; AC is preferred when scores tie. Safe to run repeatedly.
 */
export function seedOfficialScoresFromSubmissions(db: DatabaseSync, contestId: number): number {
  const rows = db
    .prepare(
      `SELECT user_id, problem_id, score, verdict
       FROM submissions
       WHERE contest_id = ? AND phase = 'contest' AND status = 'finished'
         AND hacked_at IS NULL
       ORDER BY score DESC, created_at ASC`,
    )
    .all(contestId) as unknown as Array<{
    user_id: number;
    problem_id: number;
    score: number;
    verdict: string | null;
  }>;
  const cells = new Map<string, { userId: number; problemId: number; score: number; verdict: string }>();
  for (const row of rows) {
    const key = `${row.user_id}:${row.problem_id}`;
    const existing = cells.get(key);
    const verdict = row.verdict ?? 'WA';
    if (!existing) {
      cells.set(key, {
        userId: row.user_id,
        problemId: row.problem_id,
        score: row.score,
        verdict,
      });
      continue;
    }
    if (row.score > existing.score || (row.score === existing.score && verdict === 'AC')) {
      existing.score = row.score;
      existing.verdict = verdict;
    }
  }
  let written = 0;
  for (const cell of cells.values()) {
    const current = getOfficialScore(db, contestId, cell.userId, cell.problemId);
    if (
      current &&
      (current.score > cell.score ||
        (current.score === cell.score && current.verdict === 'AC'))
    ) {
      continue;
    }
    upsertOfficialScore(db, {
      contestId,
      userId: cell.userId,
      problemId: cell.problemId,
      score: cell.score,
      verdict: cell.verdict,
      source: 'online',
    });
    written += 1;
  }
  return written;
}
