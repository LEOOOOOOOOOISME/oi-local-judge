import type { DatabaseSync } from 'node:sqlite';
import { getContest } from '../storage/repos/contests.js';
import { listContestSubmissions } from '../storage/repos/submissions.js';
import {
  computeOfficialRanking,
  getOfficialRanking,
  getOfficialRankingVersion,
  type OfficialRankingRow,
} from './official-ranking.js';
import { getTeamRanking } from './team-ranking.js';

/** Overall scoring mode of a contest statistics dashboard. */
export type ContestStatisticsMode = 'score' | 'solved';

export interface ContestStatisticsDistributionBin {
  from: number;
  to: number;
  count: number;
}

export interface ContestStatisticsCumulativePoint {
  score: number;
  count: number;
  /** Share of participants at or above `score` (0-1). */
  ratio: number;
}

export interface ContestStatisticsSummary {
  participants: number;
  submissions: number;
  /** For `solved` mode this is the mean number of solved problems. */
  avgScore: number | null;
  medianScore: number | null;
  stddev: number | null;
  maxScore: number | null;
  minScore: number | null;
  /** Participants at the maximum achievable value (total points or all problems). */
  fullScoreCount: number;
  zeroScoreCount: number;
  /** Only for `solved` mode; null for OI/IOI. */
  avgPenalty: number | null;
  medianPenalty: number | null;
}

export interface ContestStatisticsProblem {
  problemId: number;
  ordinal: number;
  title: string;
  fullScore: number;
  avgScore: number | null;
  medianScore: number | null;
  stddev: number | null;
  /** Percentage (0-100) of participants whose official cell verdict is AC. */
  acRate: number | null;
  fullRate: number | null;
  zeroRate: number | null;
  /** OI/IOI: avgScore / fullScore. ACM/CF-like: 1 - acRate / 100. */
  difficulty: number | null;
  /** Mean score of the top 27% minus the mean score of the bottom 27%. */
  discrimination: number | null;
  distribution: ContestStatisticsDistributionBin[];
}

export interface ContestStatisticsGroup {
  name: string;
  kind: 'class' | 'team';
  participants: number;
  /** Mean primary metric: total score or solved count. */
  avgScore: number | null;
  /** Percentage of the group at the maximum achievable value. */
  fullRate: number | null;
}

export interface ContestStatistics {
  contest: {
    id: number;
    title: string;
    /** Raw contest mode (`oi` / `ioi` / `acm` / ...). */
    mode: string;
    preset: string;
    frozen: boolean;
    generatedAt: number;
  };
  /** Dashboard scoring mode; charts use this instead of guessing from the preset. */
  mode: ContestStatisticsMode;
  summary: ContestStatisticsSummary;
  distribution: ContestStatisticsDistributionBin[];
  cumulative: ContestStatisticsCumulativePoint[];
  problems: ContestStatisticsProblem[];
  groups: ContestStatisticsGroup[];
  insights: string[];
  includeHidden: boolean;
}

export interface ContestStatisticsOptions {
  /** Admins/contest managers can include hidden participants in the aggregate. */
  includeHidden?: boolean;
}

/** Default statistics cache lifetime; the design allows 1-5 seconds. */
export const DEFAULT_STATISTICS_CACHE_TTL_MS = 2000;

interface StatisticsCacheEntry {
  dataDir: string;
  version: number;
  expiresAt: number;
  promise: Promise<ContestStatistics | null>;
}

const statisticsCaches = new WeakMap<DatabaseSync, Map<string, StatisticsCacheEntry>>();

function statisticsCacheFor(db: DatabaseSync): Map<string, StatisticsCacheEntry> {
  let cache = statisticsCaches.get(db);
  if (!cache) {
    cache = new Map();
    statisticsCaches.set(db, cache);
  }
  return cache;
}

/**
 * Reads `OIJ_STATISTICS_CACHE_MS` on every call so tests can disable or extend
 * the cache. Values below zero are clamped to zero (every lookup misses).
 */
function statisticsCacheTtlMs(): number {
  const raw = process.env.OIJ_STATISTICS_CACHE_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_STATISTICS_CACHE_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_STATISTICS_CACHE_TTL_MS;
  return Math.max(0, parsed);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function round1(value: number): number {
  return round(value, 1);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
}

/** Population standard deviation; null when fewer than two samples exist. */
function stddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values) as number;
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function percentage(part: number, total: number): number | null {
  if (total <= 0) return null;
  return round1((part / total) * 100);
}

/** Stats mode follows the ranking preset the official board actually uses. */
function statisticsMode(preset: string, contestMode: string): ContestStatisticsMode {
  if (preset === 'acm' || preset === 'cf-like') return 'solved';
  if (preset.startsWith('plugin:')) return contestMode === 'acm' ? 'solved' : 'score';
  return 'score';
}

/** Nice bin width that keeps a per-problem histogram around ten buckets. */
function histogramWidth(max: number): number {
  const target = Math.max(1, max / 10);
  const width = [1, 2, 5, 10, 20, 25, 50, 100].find((candidate) => candidate >= target);
  return width ?? 100;
}

/**
 * Fixed-width buckets over `0..max`, where the last bucket ends exactly at
 * `max`. Used for the overall score histogram (width 100), which gives the
 * 0-99 / 100-199 / ... / N-N layout the dashboard ring chart expects.
 */
function buildBins(max: number, width: number): ContestStatisticsDistributionBin[] {
  if (max <= 0) return [{ from: 0, to: 0, count: 0 }];
  const count = Math.max(1, Math.ceil(max / width));
  return Array.from({ length: count }, (_unused, index) => {
    const from = index * width;
    const to = index === count - 1 ? max : (index + 1) * width - 1;
    return { from, to, count: 0 };
  });
}

function fillBins(
  bins: ContestStatisticsDistributionBin[],
  values: number[],
  width: number,
): ContestStatisticsDistributionBin[] {
  if (bins.length === 0) return bins;
  for (const value of values) {
    const index = Math.min(Math.max(0, Math.floor(value / width)), bins.length - 1);
    bins[index]!.count += 1;
  }
  return bins;
}

function scoreDistribution(
  values: number[],
  max: number,
  width = 100,
): ContestStatisticsDistributionBin[] {
  if (values.length === 0) return [];
  if (max <= 0) return [{ from: 0, to: 0, count: values.length }];
  const bins = buildBins(max, width);
  return fillBins(bins, values, width);
}

function solvedDistribution(
  rows: OfficialRankingRow[],
  problemCount: number,
): ContestStatisticsDistributionBin[] {
  if (rows.length === 0) return [];
  if (problemCount <= 0) return [{ from: 0, to: 0, count: rows.length }];
  return Array.from({ length: problemCount + 1 }, (_unused, solved) => ({
    from: solved,
    to: solved,
    count: rows.filter((row) => row.solved === solved).length,
  }));
}

/**
 * Total problem distribution for ACM/CF: one bucket for "not solved" and one
 * for "solved", because a points histogram is meaningless there.
 */
function solvedProblemDistribution(rows: OfficialRankingRow[], problemId: number) {
  let solved = 0;
  for (const row of rows) {
    if (row.cells.find((cell) => cell.problemId === problemId)?.verdict === 'AC') {
      solved += 1;
    }
  }
  return [
    { from: 0, to: 0, count: rows.length - solved },
    { from: 1, to: 1, count: solved },
  ];
}

function cumulativePoints(
  values: number[],
  max: number,
  participants: number,
): ContestStatisticsCumulativePoint[] {
  if (participants === 0) return [];
  const step = Math.max(1, Math.ceil(max / 500));
  const points: ContestStatisticsCumulativePoint[] = [];
  for (let score = 0; score <= max; score += step) {
    const count = values.filter((value) => value >= score).length;
    points.push({ score, count, ratio: round(count / participants, 4) });
  }
  return points;
}

interface ProblemValues {
  /** OI/IOI: official cell score. Solved mode: full points on AC, else 0. */
  scores: number[];
  acCount: number;
}

function problemValues(
  rows: OfficialRankingRow[],
  problemId: number,
  fullScore: number,
  mode: ContestStatisticsMode,
): ProblemValues {
  const scores: number[] = [];
  let acCount = 0;
  for (const row of rows) {
    const cell = row.cells.find((candidate) => candidate.problemId === problemId);
    const score = cell?.score ?? 0;
    if (cell?.verdict === 'AC') acCount += 1;
    scores.push(mode === 'solved' ? (cell?.verdict === 'AC' ? fullScore : 0) : score);
  }
  return { scores, acCount };
}

function buildProblemStatistics(
  rows: OfficialRankingRow[],
  problems: Array<{ id: number; ordinal: number; points: number; title: string }>,
  mode: ContestStatisticsMode,
): ContestStatisticsProblem[] {
  const participants = rows.length;
  const sortedRows = [...rows].sort((a, b) => {
    if (mode === 'solved') return b.solved - a.solved || a.penalty - b.penalty;
    return b.totalScore - a.totalScore;
  });
  const groupSize = Math.max(1, Math.round(participants * 0.27));

  return problems.map((problem) => {
    const { scores, acCount } = problemValues(rows, problem.id, problem.points, mode);
    const avg = mean(scores);
    const medianScore = median(scores);
    const deviation = stddev(scores);
    const acRate = percentage(acCount, participants);
    const fullCount = scores.filter((score) => problem.points > 0 && score >= problem.points).length;
    const zeroCount = scores.filter((score) => score === 0).length;

    let discrimination: number | null = null;
    if (participants >= 2 && sortedRows.length >= 2) {
      const scoreOf = (row: OfficialRankingRow) => {
        const cell = row.cells.find((candidate) => candidate.problemId === problem.id);
        return mode === 'solved'
          ? cell?.verdict === 'AC'
            ? problem.points
            : 0
          : (cell?.score ?? 0);
      };
      const top = sortedRows.slice(0, groupSize).map(scoreOf);
      const bottom = sortedRows.slice(-groupSize).map(scoreOf);
      const topMean = mean(top);
      const bottomMean = mean(bottom);
      if (topMean !== null && bottomMean !== null) {
        discrimination = round1(topMean - bottomMean);
      }
    }

    const difficulty =
      mode === 'solved'
        ? participants === 0
          ? null
          : round(1 - acCount / participants, 4)
        : avg !== null && problem.points > 0
          ? round(avg / problem.points, 4)
          : null;

    const distribution =
      participants === 0
        ? []
        : mode === 'solved'
          ? solvedProblemDistribution(rows, problem.id)
          : scoreDistribution(scores, problem.points, histogramWidth(problem.points));

    return {
      problemId: problem.id,
      ordinal: problem.ordinal,
      title: problem.title,
      fullScore: problem.points,
      avgScore: avg === null ? null : round1(avg),
      medianScore: medianScore === null ? null : round1(medianScore),
      stddev: deviation === null ? null : round1(deviation),
      acRate,
      fullRate: percentage(fullCount, participants),
      zeroRate: percentage(zeroCount, participants),
      difficulty,
      discrimination,
      distribution,
    };
  });
}

function classGroups(
  rows: OfficialRankingRow[],
  mode: ContestStatisticsMode,
  maxValue: number,
): ContestStatisticsGroup[] {
  const groups = new Map<string, { scores: number[]; full: number }>();
  for (const row of rows) {
    const name = row.className?.trim() || '未分班';
    const group = groups.get(name) ?? { scores: [], full: 0 };
    const value = mode === 'solved' ? row.solved : row.totalScore;
    group.scores.push(value);
    if (maxValue > 0 && value >= maxValue) group.full += 1;
    groups.set(name, group);
  }
  return [...groups.entries()]
    .map(([name, group]) => ({
      name,
      kind: 'class' as const,
      participants: group.scores.length,
      avgScore: round1(mean(group.scores) as number),
      fullRate: percentage(group.full, group.scores.length),
    }))
    .sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0) || a.name.localeCompare(b.name));
}

function teamGroups(
  db: DatabaseSync,
  contestId: number,
  mode: ContestStatisticsMode,
): ContestStatisticsGroup[] {
  const ranking = getTeamRanking(db, contestId);
  if (!ranking || ranking.rows.length === 0) return [];
  const totalProblems = ranking.problems.length;
  return ranking.rows.map((row) => ({
    name: row.teamName,
    kind: 'team' as const,
    participants: row.memberCount,
    avgScore: round1(mode === 'solved' ? row.solved : row.totalScore),
    fullRate:
      totalProblems > 0 && row.solved >= totalProblems
        ? 100
        : totalProblems > 0
          ? 0
          : null,
  }));
}

function buildInsights(
  stats: Pick<
    ContestStatistics,
    'mode' | 'summary' | 'problems' | 'groups' | 'contest'
  >,
): string[] {
  const { mode, summary, problems, groups } = stats;
  if (summary.participants === 0) return [];
  const insights: string[] = [];
  const unit = mode === 'score' ? '分' : '题';

  const covered = problems.filter(
    (problem) => problem.acRate !== null && problem.difficulty !== null,
  );
  if (covered.length > 0) {
    const weakest = covered.reduce((current, problem) =>
      (problem.difficulty as number) < (current.difficulty as number) ? problem : current,
    );
    insights.push(
      mode === 'score'
        ? `最薄弱题目：${weakest.title}（平均得分 ${weakest.avgScore} / ${weakest.fullScore}，难度 ${Math.round((weakest.difficulty as number) * 100)}%）。`
        : `最薄弱题目：${weakest.title}（通过率 ${weakest.acRate}%）。`,
    );
  }

  const scored = problems.filter((problem) => problem.discrimination !== null);
  if (scored.length >= 2) {
    const highest = Math.max(...scored.map((problem) => problem.discrimination as number));
    const lowest = Math.min(...scored.map((problem) => problem.discrimination as number));
    if (highest === lowest) {
      insights.push(`各题区分度均为 ${round1(highest)} 分。`);
    } else {
      const best = scored.find((problem) => problem.discrimination === highest);
      const worst = scored.find((problem) => problem.discrimination === lowest);
      insights.push(
        `区分度最高：${best?.title}（${best?.discrimination} 分）；最低：${worst?.title}（${worst?.discrimination} 分）。`,
      );
    }
  }

  if (mode === 'score') {
    insights.push(`满分 ${summary.fullScoreCount} 人，0 分 ${summary.zeroScoreCount} 人。`);
  } else if (summary.avgScore !== null) {
    insights.push(
      `人均通过 ${summary.avgScore.toFixed(1)} 题，${summary.zeroScoreCount} 人未通过任何题。`,
    );
  }
  if (summary.stddev !== null) {
    insights.push(`成绩标准差 ${summary.stddev} ${unit}。`);
  }

  const classes = groups.filter(
    (group) => group.kind === 'class' && group.avgScore !== null && group.participants > 0,
  );
  if (classes.length >= 2) {
    const best = classes[0] as ContestStatisticsGroup;
    const worst = classes[classes.length - 1] as ContestStatisticsGroup;
    insights.push(
      `班级平均${mode === 'score' ? '分' : '通过题数'}最高：${best.name}（${best.avgScore} ${unit}），最低：${worst.name}（${worst.avgScore} ${unit}），相差 ${round1((best.avgScore as number) - (worst.avgScore as number))} ${unit}。`,
    );
  }

  const teams = groups.filter(
    (group) => group.kind === 'team' && group.avgScore !== null && group.participants > 0,
  );
  if (teams.length >= 2) {
    const best = teams.reduce((current, group) =>
      (group.avgScore as number) > (current.avgScore as number) ? group : current,
    );
    const worst = teams.reduce((current, group) =>
      (group.avgScore as number) < (current.avgScore as number) ? group : current,
    );
    insights.push(
      `团队平均${mode === 'score' ? '分' : '通过题数'}最高：${best.name}（${best.avgScore} ${unit}），最低：${worst.name}（${worst.avgScore} ${unit}）。`,
    );
  }

  return insights;
}

/**
 * Builds the contest statistics aggregate.
 *
 * Everything is derived from the cached official ranking snapshot, so scores,
 * AC verdicts and the freeze cut-off match the public board exactly. Hidden
 * participants are excluded unless `includeHidden` is requested by a manager
 * (the HTTP layer enforces that permission). The full row list is never
 * returned: charts only receive aggregates, while the results table reuses the
 * official-ranking endpoint.
 */
export async function buildContestStatistics(
  db: DatabaseSync,
  contestId: number,
  dataDir = process.cwd(),
  options: ContestStatisticsOptions = {},
): Promise<ContestStatistics | null> {
  const contest = getContest(db, contestId);
  if (!contest) return null;

  const includeHidden = options.includeHidden === true;
  const ranking = includeHidden
    ? await computeOfficialRanking(
        db,
        contestId,
        dataDir,
        getOfficialRankingVersion(db, contestId),
        { includeHidden: true },
      )
    : await getOfficialRanking(db, contestId, dataDir);
  if (!ranking) return null;

  const mode = statisticsMode(ranking.preset, contest.mode);
  const rows = ranking.rows;
  const problems = ranking.problems;
  const participants = rows.length;
  const totalPoints = problems.reduce((sum, problem) => sum + problem.points, 0);
  const maxValue = mode === 'solved' ? problems.length : totalPoints;

  const primaryValues = rows.map((row) => (mode === 'solved' ? row.solved : row.totalScore));
  const participantIds = new Set(rows.map((row) => row.userId));
  const submissions = listContestSubmissions(db, contestId).filter(
    (submission) =>
      submission.phase === 'contest' &&
      submission.hacked_at === null &&
      participantIds.has(submission.user_id),
  );
  const penalties = rows.map((row) => row.penalty);
  const avgValue = mean(primaryValues);
  const medianValue = median(primaryValues);
  const deviation = stddev(primaryValues);

  const summary: ContestStatisticsSummary = {
    participants,
    submissions: submissions.length,
    avgScore: avgValue === null ? null : round1(avgValue),
    medianScore: medianValue === null ? null : round1(medianValue),
    stddev: deviation === null ? null : round1(deviation),
    maxScore: participants === 0 ? null : Math.max(...primaryValues),
    minScore: participants === 0 ? null : Math.min(...primaryValues),
    fullScoreCount:
      maxValue <= 0 ? 0 : primaryValues.filter((value) => value >= maxValue).length,
    zeroScoreCount: primaryValues.filter((value) => value === 0).length,
    avgPenalty:
      mode === 'solved' && participants > 0
        ? round1(mean(penalties) as number)
        : null,
    medianPenalty:
      mode === 'solved' && participants > 0
        ? round1(median(penalties) as number)
        : null,
  };

  const distribution =
    mode === 'solved'
      ? solvedDistribution(rows, problems.length)
      : scoreDistribution(primaryValues, totalPoints);
  const cumulative = cumulativePoints(primaryValues, maxValue, participants);
  const problemStatistics = buildProblemStatistics(rows, problems, mode);
  const groups = [
    ...classGroups(rows, mode, maxValue),
    ...(contest.team_mode === 'individual' ? [] : teamGroups(db, contestId, mode)),
  ];

  const stats: ContestStatistics = {
    contest: {
      id: contest.id,
      title: contest.name,
      mode: contest.mode,
      preset: ranking.preset,
      frozen: contest.status === 'frozen',
      generatedAt: Date.now(),
    },
    mode,
    summary,
    distribution,
    cumulative,
    problems: problemStatistics,
    groups,
    insights: [],
    includeHidden,
  };
  stats.insights = buildInsights(stats);
  return stats;
}

/**
 * Cached contest statistics. The cache is keyed by contest and hidden-row flag,
 * expires after `OIJ_STATISTICS_CACHE_MS` (default two seconds) and is also
 * invalidated immediately when the ranking version changes (judge results,
 * hacks, participant visibility, freeze state, ...).
 *
 * The returned object is shared between callers and must be treated as
 * read-only.
 */
export function getContestStatistics(
  db: DatabaseSync,
  contestId: number,
  dataDir = process.cwd(),
  options: ContestStatisticsOptions = {},
  now = Date.now(),
): Promise<ContestStatistics | null> {
  const includeHidden = options.includeHidden === true;
  const key = `${contestId}:${includeHidden ? 1 : 0}`;
  const cache = statisticsCacheFor(db);
  const version = getOfficialRankingVersion(db, contestId);
  const cached = cache.get(key);
  if (
    cached &&
    cached.dataDir === dataDir &&
    cached.version === version &&
    now < cached.expiresAt
  ) {
    return cached.promise;
  }

  let promise: Promise<ContestStatistics | null>;
  promise = buildContestStatistics(db, contestId, dataDir, { includeHidden }).catch(
    (err: unknown) => {
      if (cache.get(key)?.promise === promise) cache.delete(key);
      throw err;
    },
  );
  cache.set(key, {
    dataDir,
    version,
    expiresAt: now + statisticsCacheTtlMs(),
    promise,
  });
  return promise;
}
