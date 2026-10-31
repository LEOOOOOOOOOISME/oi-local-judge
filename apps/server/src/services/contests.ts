import type { DatabaseSync } from 'node:sqlite';
import { computeOiRanking, type RankingRow, type Verdict } from '@oij/shared';
import {
  getContest,
  getContestProblemEntries,
  getContestProblemIds,
  getParticipants,
  listContests,
  setContestStatus,
  type ContestRow,
} from '../storage/repos/contests.js';
import { getProblem } from '../storage/repos/problems.js';
import { listContestSubmissions } from '../storage/repos/submissions.js';
import { getUserById } from '../storage/repos/users.js';

export interface ContestRankingRow extends RankingRow {
  username: string;
  realName: string | null;
  className: string | null;
}

export interface ContestDetail {
  contest: ContestRow;
  problems: Array<{
    problemId: number;
    ordinal: number;
    points: number;
    title: string;
    type: string;
    difficulty: number | null;
    timeMs: number;
    memoryMb: number;
  }>;
  participantCount: number;
}

export function getContestDetail(db: DatabaseSync, contestId: number): ContestDetail | null {
  const contest = getContest(db, contestId);
  if (!contest) return null;
  const problems = getContestProblemEntries(db, contestId)
    .map((entry) => {
      const problem = getProblem(db, entry.problem_id);
      if (!problem) return null;
      return {
        problemId: problem.id,
        ordinal: entry.ordinal,
        points: entry.points,
        title: problem.title,
        type: problem.type,
        difficulty: problem.difficulty,
        timeMs: problem.time_ms,
        memoryMb: problem.memory_mb,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return { contest, problems, participantCount: getParticipants(db, contestId).length };
}

export function getContestRanking(
  db: DatabaseSync,
  contestId: number,
): { contest: ContestRow; rows: ContestRankingRow[] } | null {
  const contest = getContest(db, contestId);
  if (!contest) return null;

  const problemIds = getContestProblemIds(db, contestId);
  const userIds = getParticipants(db, contestId);
  const submissions = listContestSubmissions(db, contestId).map((submission) => ({
    userId: submission.user_id,
    problemId: submission.problem_id,
    verdict: (submission.verdict ?? 'UKE') as Verdict,
    score: submission.score,
    createdAt: submission.created_at,
  }));

  const rows = computeOiRanking({
    problemIds,
    userIds,
    submissions,
    freezeAt: contest.freeze_at,
  }) as unknown as ContestRankingRow[];

  for (const row of rows) {
    const user = getUserById(db, row.userId);
    row.username = user?.username ?? `user-${row.userId}`;
    row.realName = user?.real_name ?? null;
    row.className = user?.class_name ?? null;
  }
  return { contest, rows };
}

export function listContestDtos(db: DatabaseSync): ContestRow[] {
  return listContests(db);
}

export function startContest(db: DatabaseSync, contestId: number): void {
  setContestStatus(db, contestId, 'running');
}

export function freezeContest(db: DatabaseSync, contestId: number): void {
  setContestStatus(db, contestId, 'frozen');
}

export function endContest(db: DatabaseSync, contestId: number): void {
  setContestStatus(db, contestId, 'ended');
}
