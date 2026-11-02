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
import { seedOfficialScoresFromSubmissions } from '../storage/repos/official-scores.js';
import { getUserById } from '../storage/repos/users.js';
import { getOfficialRanking } from './official-ranking.js';

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
    tags: string[];
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
        tags: JSON.parse(problem.tags_json) as string[],
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
  db.prepare('UPDATE contests SET freeze_at = ? WHERE id = ? AND freeze_at IS NULL').run(
    Date.now(),
    contestId,
  );
}

export function unfreezeContest(db: DatabaseSync, contestId: number): void {
  setContestStatus(db, contestId, 'running');
  db.prepare('UPDATE contests SET unfreeze_at = ? WHERE id = ?').run(Date.now(), contestId);
  const contest = getContest(db, contestId);
  if (contest?.mode === 'oi') {
    seedOfficialScoresFromSubmissions(db, contestId);
  }
}

export function endContest(db: DatabaseSync, contestId: number): void {
  setContestStatus(db, contestId, 'ended');
}

export interface ClassStatRow {
  className: string;
  participants: number;
  totalScore: number;
  averageScore: number;
  acParticipants: number;
  bestRank: number;
}

export async function getClassStats(
  db: DatabaseSync,
  contestId: number,
  dataDir = process.cwd(),
): Promise<ClassStatRow[] | null> {
  const ranking = await getOfficialRanking(db, contestId, dataDir);
  if (!ranking) return null;
  const groups = new Map<string, { scores: number[]; ac: number; best: number }>();
  for (const row of ranking.rows) {
    const key = row.className?.trim() || '未分班';
    const group = groups.get(key) ?? { scores: [], ac: 0, best: Number.MAX_SAFE_INTEGER };
    group.scores.push(row.totalScore);
    if (row.solved > 0) group.ac += 1;
    group.best = Math.min(group.best, row.rank);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([className, group]) => ({
      className,
      participants: group.scores.length,
      totalScore: group.scores.reduce((sum, value) => sum + value, 0),
      averageScore:
        Math.round(
          (group.scores.reduce((sum, value) => sum + value, 0) / group.scores.length) * 10,
        ) / 10,
      acParticipants: group.ac,
      bestRank: group.best,
    }))
    .sort((a, b) => b.averageScore - a.averageScore || a.className.localeCompare(b.className));
}
