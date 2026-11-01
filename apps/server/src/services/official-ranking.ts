import type { DatabaseSync } from 'node:sqlite';
import {
  computeRanking,
  type RankingConfig,
  type RankingPreset,
  type RankingRowResult,
} from '@oij/shared';
import {
  getContest,
  getContestProblemEntries,
  getVisibleParticipants,
  type ContestRow,
} from '../storage/repos/contests.js';
import {
  listOfficialScores,
  seedOfficialScoresFromSubmissions,
} from '../storage/repos/official-scores.js';
import { listContestSubmissions } from '../storage/repos/submissions.js';
import { getProblem } from '../storage/repos/problems.js';
import { getUserById } from '../storage/repos/users.js';

export interface OfficialRankingRow extends RankingRowResult {
  username: string;
  realName: string | null;
  className: string | null;
}

export interface OfficialRankingResult {
  contest: ContestRow;
  problems: Array<{ id: number; ordinal: number; points: number; title: string }>;
  rows: OfficialRankingRow[];
  config: RankingConfig;
  archived: boolean;
  preset: RankingPreset;
}

function parseConfig(contest: ContestRow): RankingConfig {
  let stored: Partial<RankingConfig> = {};
  try {
    stored = JSON.parse(contest.ranking_rule_json || '{}') as Partial<RankingConfig>;
  } catch {
    stored = {};
  }
  const fallback: RankingPreset =
    contest.mode === 'acm' ? 'acm' : contest.mode === 'ioi' ? 'ioi' : 'oi';
  return {
    preset: stored.preset ?? fallback,
    tie: 'same-rank',
    cfLike: stored.cfLike,
    freezeAt: contest.status === 'frozen' ? contest.freeze_at : null,
  };
}

export function getOfficialRanking(
  db: DatabaseSync,
  contestId: number,
): OfficialRankingResult | null {
  const contest = getContest(db, contestId);
  if (!contest) return null;

  const entries = getContestProblemEntries(db, contestId);
  const problems = entries.map((entry) => ({
    id: entry.problem_id,
    ordinal: entry.ordinal,
    points: entry.points,
    title: getProblem(db, entry.problem_id)?.title ?? `#${entry.problem_id}`,
  }));
  const problemIds = problems.map((problem) => problem.id);
  const userIds = getVisibleParticipants(db, contestId);
  const preset = parseConfig(contest).preset;

  if (preset === 'oi' && listOfficialScores(db, contestId).length === 0) {
    seedOfficialScoresFromSubmissions(db, contestId);
  }

  const submissions = listContestSubmissions(db, contestId)
    .filter((submission) => submission.phase !== 'batch_draft')
    .map((submission) => ({
      userId: submission.user_id,
      problemId: submission.problem_id,
      verdict: submission.verdict ?? 'WA',
      score: submission.score,
      createdAt: submission.created_at,
    }));
  const officialScores =
    preset === 'oi'
      ? listOfficialScores(db, contestId).map((row) => ({
          userId: row.user_id,
          problemId: row.problem_id,
          score: row.score,
          verdict: row.verdict,
        }))
      : undefined;
  const problemPoints = Object.fromEntries(
    problems.map((problem) => [problem.id, problem.points]),
  );

  const rows = computeRanking({
    config: parseConfig(contest),
    problemIds,
    userIds,
    submissions,
    officialScores,
    problemPoints,
    contestStartAt: contest.start_at,
    contestEndAt: contest.end_at,
  }) as OfficialRankingRow[];

  for (const row of rows) {
    const user = getUserById(db, row.userId);
    row.username = user?.username ?? `user-${row.userId}`;
    row.realName = user?.real_name ?? null;
    row.className = user?.class_name ?? null;
  }

  return {
    contest,
    problems,
    rows,
    config: parseConfig(contest),
    archived: contest.archived_at !== null,
    preset,
  };
}
