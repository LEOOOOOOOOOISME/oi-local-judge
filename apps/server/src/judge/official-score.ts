import type { DatabaseSync } from 'node:sqlite';
import { getContest } from '../storage/repos/contests.js';
import { getOfficialScore, upsertOfficialScore } from '../storage/repos/official-scores.js';
import { getSubmission } from '../storage/repos/submissions.js';

/**
 * Mirrors a finished in-contest online submission into the OI official cell.
 * Draft batch submissions, corrections, archived contests and the freeze
 * window are ignored. Batch-published cells are only raised by a later online
 * submission, never lowered.
 */
export function syncOnlineOfficialScore(db: DatabaseSync, submissionId: number): void {
  const submission = getSubmission(db, submissionId);
  if (!submission || submission.status !== 'finished' || !submission.contest_id) return;
  if (submission.phase !== 'contest') return;
  const contest = getContest(db, submission.contest_id);
  if (!contest || contest.mode !== 'oi') return;
  if (contest.archived_at !== null || contest.status === 'frozen') return;
  if (contest.end_at !== null && submission.created_at > contest.end_at) return;

  const current = getOfficialScore(
    db,
    contest.id,
    submission.user_id,
    submission.problem_id,
  );
  const nextScore = submission.score;
  const nextVerdict = submission.verdict ?? 'WA';
  const shouldUpdate =
    !current ||
    nextScore > current.score ||
    (nextScore === current.score && nextVerdict === 'AC' && current.verdict !== 'AC');
  if (!shouldUpdate) return;
  upsertOfficialScore(db, {
    contestId: contest.id,
    userId: submission.user_id,
    problemId: submission.problem_id,
    score: nextScore,
    verdict: nextVerdict,
    source: 'online',
    batchId: null,
  });
}
