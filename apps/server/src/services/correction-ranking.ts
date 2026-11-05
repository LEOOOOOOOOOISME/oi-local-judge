import type { DatabaseSync } from 'node:sqlite';
import {
  getContest,
  getContestProblemEntries,
  getVisibleParticipants,
  type ContestRow,
} from '../storage/repos/contests.js';
import { listOfficialScores, seedOfficialScoresFromSubmissions } from '../storage/repos/official-scores.js';
import { listContestSubmissions } from '../storage/repos/submissions.js';
import { getProblem } from '../storage/repos/problems.js';
import { getUserById } from '../storage/repos/users.js';
import { invalidateOfficialRanking } from './official-ranking.js';

export interface CorrectionCell {
  problemId: number;
  officialScore: number;
  officialVerdict: string | null;
  correctionScore: number;
  correctionVerdict: string | null;
  correctedScore: number;
  correctedVerdict: string | null;
}

export interface CorrectionRankingRow {
  rank: number;
  userId: number;
  username: string;
  realName: string | null;
  className: string | null;
  officialTotal: number;
  correctedTotal: number;
  officialSolved: number;
  correctedSolved: number;
  cells: CorrectionCell[];
}

export interface CorrectionRankingResult {
  contest: ContestRow;
  problems: Array<{ id: number; ordinal: number; points: number; title: string }>;
  rows: CorrectionRankingRow[];
  correctionsOpen: boolean;
  archived: boolean;
}

export function getCorrectionRanking(
  db: DatabaseSync,
  contestId: number,
  now = Date.now(),
): CorrectionRankingResult | null {
  const contest = getContest(db, contestId);
  if (!contest) return null;
  const problems = getContestProblemEntries(db, contestId).map((entry) => ({
    id: entry.problem_id,
    ordinal: entry.ordinal,
    points: entry.points,
    title: getProblem(db, entry.problem_id)?.title ?? `#${entry.problem_id}`,
  }));
  const userIds = getVisibleParticipants(db, contestId);
  if (listOfficialScores(db, contestId).length === 0) {
    // Seeding writes official cells, so the cached official ranking is stale.
    if (seedOfficialScoresFromSubmissions(db, contestId) > 0) {
      invalidateOfficialRanking(db, contestId);
    }
  }
  const official = new Map(
    listOfficialScores(db, contestId).map((row) => [
      `${row.user_id}:${row.problem_id}`,
      row,
    ]),
  );

  const corrections = new Map<string, { score: number; verdict: string }>();
  for (const submission of listContestSubmissions(db, contestId)) {
    if (submission.phase !== 'correction' || submission.status !== 'finished') continue;
    const key = `${submission.user_id}:${submission.problem_id}`;
    const existing = corrections.get(key);
    const verdict = submission.verdict ?? 'WA';
    if (
      !existing ||
      submission.score > existing.score ||
      (submission.score === existing.score && verdict === 'AC')
    ) {
      corrections.set(key, { score: submission.score, verdict });
    }
  }

  const rows: CorrectionRankingRow[] = userIds.map((userId) => {
    const user = getUserById(db, userId);
    let officialTotal = 0;
    let correctedTotal = 0;
    let officialSolved = 0;
    let correctedSolved = 0;
    const cells = problems.map((problem) => {
      const officialCell = official.get(`${userId}:${problem.id}`);
      const correctionCell = corrections.get(`${userId}:${problem.id}`);
      const officialScore = officialCell?.score ?? 0;
      const correctionScore = correctionCell?.score ?? 0;
      const correctedScore = Math.max(officialScore, correctionScore);
      const officialVerdict = officialCell?.verdict ?? null;
      const correctionVerdict = correctionCell?.verdict ?? null;
      const correctedVerdict =
        correctedScore === 0
          ? null
          : correctedScore === problem.points
            ? 'AC'
            : correctionScore >= officialScore && correctionVerdict
              ? correctionVerdict
              : officialVerdict;
      officialTotal += officialScore;
      correctedTotal += correctedScore;
      if (officialVerdict === 'AC') officialSolved += 1;
      if (correctedScore === problem.points) correctedSolved += 1;
      return {
        problemId: problem.id,
        officialScore,
        officialVerdict,
        correctionScore,
        correctionVerdict,
        correctedScore,
        correctedVerdict,
      };
    });
    return {
      rank: 0,
      userId,
      username: user?.username ?? `user-${userId}`,
      realName: user?.real_name ?? null,
      className: user?.class_name ?? null,
      officialTotal,
      correctedTotal,
      officialSolved,
      correctedSolved,
      cells,
    };
  });

  rows.sort((a, b) => b.correctedTotal - a.correctedTotal || a.userId - b.userId);
  rows.forEach((row, index) => {
    if (index === 0) {
      row.rank = 1;
      return;
    }
    row.rank = rows[index - 1].correctedTotal === row.correctedTotal ? rows[index - 1].rank : index + 1;
  });

  const endedBySchedule =
    contest.end_at !== null && now >= contest.end_at && contest.status !== 'draft';

  return {
    contest,
    problems,
    rows,
    correctionsOpen:
      contest.status === 'ended' ||
      contest.status === 'archived' ||
      endedBySchedule,
    archived: contest.archived_at !== null,
  };
}
