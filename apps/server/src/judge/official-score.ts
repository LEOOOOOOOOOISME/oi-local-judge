import type { DatabaseSync } from 'node:sqlite';
import { getContest } from '../storage/repos/contests.js';
import { getOfficialScore, upsertOfficialScore } from '../storage/repos/official-scores.js';
import { getSubmission } from '../storage/repos/submissions.js';
import { isOfficialFrozen } from '../services/official-freeze.js';

/**
 * Mirrors the best finished in-contest online submission into the OI official
 * cell. Draft batch submissions, corrections, archived contests and the freeze
 * window are ignored. The cell is recomputed (not only raised) so rejudging the
 * selected submission cannot leave a stale AC score behind.
 */
export function syncOnlineOfficialScore(db: DatabaseSync, submissionId: number): void {
  const submission = getSubmission(db, submissionId);
  if (!submission || submission.status !== 'finished' || !submission.contest_id) return;
  // A hacked submission never contributes to the official table.
  if (submission.hacked_at !== null) return;
  if (submission.phase !== 'contest') return;
  const contest = getContest(db, submission.contest_id);
  if (!contest || contest.mode !== 'oi') return;
  if (contest.archived_at !== null || contest.status === 'frozen') return;
  if (isOfficialFrozen(contest)) return;
  if (contest.end_at !== null && submission.created_at > contest.end_at) return;

  const best = db
    .prepare(
      `SELECT id, score, verdict
       FROM submissions
       WHERE contest_id = ? AND user_id = ? AND problem_id = ?
         AND phase = 'contest' AND status = 'finished' AND hacked_at IS NULL
         AND (? IS NULL OR created_at <= ?)
       ORDER BY score DESC, CASE WHEN verdict = 'AC' THEN 0 ELSE 1 END ASC, created_at ASC
       LIMIT 1`,
    )
    .get(
      contest.id,
      submission.user_id,
      submission.problem_id,
      contest.end_at,
      contest.end_at,
    ) as unknown as { id: number; score: number; verdict: string | null } | undefined;
  if (!best) return;

  const current = getOfficialScore(
    db,
    contest.id,
    submission.user_id,
    submission.problem_id,
  );
  // A batch-published cell is an operator decision: online work may raise it,
  // never lower it. Online cells are always recomputed from the best run.
  if (current?.source === 'batch' && current.score > best.score) return;
  if (
    current &&
    current.source === 'online' &&
    current.score === best.score &&
    current.verdict === best.verdict
  ) {
    return;
  }
  upsertOfficialScore(db, {
    contestId: contest.id,
    userId: submission.user_id,
    problemId: submission.problem_id,
    score: best.score,
    verdict: best.verdict ?? 'WA',
    source: 'online',
    submissionId: best.id,
    batchId: null,
  });
}
