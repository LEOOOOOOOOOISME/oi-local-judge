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
import { loadRankingPlugin } from './ranking-plugins.js';

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
  preset: string;
  pluginError?: string;
}

function parseConfig(contest: ContestRow): {
  config: RankingConfig;
  rawPreset: string;
  pluginName: string | null;
} {
  let stored: Partial<RankingConfig> & { preset?: string } = {};
  try {
    stored = JSON.parse(contest.ranking_rule_json || '{}') as typeof stored;
  } catch {
    stored = {};
  }
  const fallback: RankingPreset =
    contest.mode === 'acm' ? 'acm' : contest.mode === 'ioi' ? 'ioi' : 'oi';
  const rawPreset = stored.preset ?? fallback;
  const pluginName = rawPreset.startsWith('plugin:') ? rawPreset.slice('plugin:'.length) : null;
  const builtinPreset: RankingPreset = pluginName
    ? 'oi'
    : rawPreset === 'oi' || rawPreset === 'ioi' || rawPreset === 'acm' || rawPreset === 'cf-like'
      ? rawPreset
      : fallback;
  return {
    rawPreset,
    pluginName,
    config: {
      preset: builtinPreset,
      tie: stored.tie === 'none' ? 'none' : 'same-rank',
      cfLike: stored.cfLike,
      freezeAt: contest.status === 'frozen' ? contest.freeze_at : null,
    },
  };
}

export async function getOfficialRanking(
  db: DatabaseSync,
  contestId: number,
  dataDir = process.cwd(),
): Promise<OfficialRankingResult | null> {
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
  const parsed = parseConfig(contest);

  if (!parsed.pluginName && parsed.config.preset === 'oi' && listOfficialScores(db, contestId).length === 0) {
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
    parsed.config.preset === 'oi'
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

  let rows: RankingRowResult[];
  let pluginError: string | undefined;
  if (parsed.pluginName) {
    try {
      const plugin = await loadRankingPlugin(db, dataDir, parsed.pluginName);
      if (!plugin) throw new Error(`plugin ${parsed.pluginName} is missing or disabled`);
      rows = plugin.compute({
        problemIds,
        userIds,
        submissions,
        officialScores,
        problemPoints,
        contestStartAt: contest.start_at,
        contestEndAt: contest.end_at,
        config: JSON.parse(contest.ranking_rule_json || '{}') as Record<string, unknown>,
      });
      if (!Array.isArray(rows)) throw new Error('plugin compute() did not return an array');
    } catch (err) {
      pluginError = err instanceof Error ? err.message : String(err);
      rows = computeRanking({
        config: { ...parsed.config, preset: 'oi' },
        problemIds,
        userIds,
        submissions,
        officialScores,
        problemPoints,
        contestStartAt: contest.start_at,
        contestEndAt: contest.end_at,
      });
    }
  } else {
    rows = computeRanking({
      config: parsed.config,
      problemIds,
      userIds,
      submissions,
      officialScores,
      problemPoints,
      contestStartAt: contest.start_at,
      contestEndAt: contest.end_at,
    });
  }

  const output = rows as OfficialRankingRow[];
  for (const row of output) {
    const user = getUserById(db, row.userId);
    row.username = user?.username ?? `user-${row.userId}`;
    row.realName = user?.real_name ?? null;
    row.className = user?.class_name ?? null;
  }

  return {
    contest,
    problems,
    rows: output,
    config: parsed.config,
    archived: contest.archived_at !== null,
    preset: parsed.rawPreset,
    ...(pluginError ? { pluginError } : {}),
  };
}
