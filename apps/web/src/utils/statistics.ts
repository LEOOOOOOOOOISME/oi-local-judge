import type {
  ContestStatistics,
  ContestStatisticsDistributionBin,
  ContestStatisticsCumulativePoint,
  ContestStatisticsMode,
  OfficialRankingRow,
} from '../api/types';

/** Above this row count the dashboard table stops rendering every row. */
export const RESULTS_SERVER_PAGING_THRESHOLD = 5000;

/** Prefix rendered when a contest exceeds the virtual-scroll threshold. */
export const RESULTS_TABLE_PREVIEW_LIMIT = 2000;

export interface StatisticsKpiItem {
  key: string;
  label: string;
  value: string;
  /** Optional suffix such as `分` or `题`. */
  unit?: string;
}

export function statisticsModeLabel(mode: ContestStatisticsMode): string {
  return mode === 'solved' ? '通过题数' : '分数';
}

export function unitForMode(mode: ContestStatisticsMode): string {
  return mode === 'solved' ? '题' : '分';
}

/** Formats a possibly missing metric; null/undefined renders an em dash. */
export function formatMetric(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function distributionLabel(bin: ContestStatisticsDistributionBin): string {
  return bin.from === bin.to ? String(bin.from) : `${bin.from}–${bin.to}`;
}

export interface RingDatum {
  name: string;
  value: number;
  ratio: number;
}

/**
 * Pie/ring data for the score-band chart. Empty buckets are dropped so the
 * ring never paints meaningless wedges.
 */
export function buildRingData(distribution: ContestStatisticsDistributionBin[]): RingDatum[] {
  const total = distribution.reduce((sum, bin) => sum + bin.count, 0);
  if (total <= 0) return [];
  return distribution
    .filter((bin) => bin.count > 0)
    .map((bin) => ({
      name: distributionLabel(bin),
      value: bin.count,
      ratio: Math.round((bin.count / total) * 10_000) / 10_000,
    }));
}

/**
 * Cumulative share at or above each histogram bucket's lower bound, aligned to
 * the bucket labels so bars and the cumulative line share one category axis.
 */
export function distributionCumulativeRatios(
  distribution: ContestStatisticsDistributionBin[],
): number[] {
  const total = distribution.reduce((sum, bin) => sum + bin.count, 0);
  if (total <= 0) return [];
  let before = 0;
  return distribution.map((bin) => {
    const ratio = (total - before) / total;
    before += bin.count;
    return Math.round(ratio * 10_000) / 10_000;
  });
}

export function cumulativeChartData(cumulative: ContestStatisticsCumulativePoint[]): {
  scores: number[];
  counts: number[];
  ratios: number[];
} {
  return {
    scores: cumulative.map((point) => point.score),
    counts: cumulative.map((point) => point.count),
    ratios: cumulative.map((point) => point.ratio),
  };
}

/** KPI descriptors shared by the on-screen dashboard and the analysis print. */
export function buildKpiItems(stats: ContestStatistics): StatisticsKpiItem[] {
  const { summary, mode } = stats;
  const solved = mode === 'solved';
  const items: StatisticsKpiItem[] = [
    { key: 'participants', label: '参赛人数', value: String(summary.participants) },
    { key: 'submissions', label: '提交数', value: String(summary.submissions) },
    {
      key: 'avgScore',
      label: solved ? '平均通过题数' : '平均分',
      value: formatMetric(summary.avgScore),
      unit: unitForMode(mode),
    },
    {
      key: 'medianScore',
      label: solved ? '中位数（通过题数）' : '中位数',
      value: formatMetric(summary.medianScore),
      unit: unitForMode(mode),
    },
    {
      key: 'stddev',
      label: solved ? '标准差（通过题数）' : '标准差',
      value: formatMetric(summary.stddev),
      unit: unitForMode(mode),
    },
    {
      key: 'fullScoreCount',
      label: solved ? '全题通过人数' : '满分人数',
      value: String(summary.fullScoreCount),
    },
    {
      key: 'zeroScoreCount',
      label: solved ? '0 题人数' : '0 分人数',
      value: String(summary.zeroScoreCount),
    },
  ];
  if (solved) {
    items.push({
      key: 'avgPenalty',
      label: '平均罚时（分钟）',
      value: formatMetric(summary.avgPenalty),
    });
  }
  return items;
}

/**
 * Case-insensitive search over a ranking row's username, real name and class.
 * An empty query returns the original array untouched (keeps memo identity).
 */
export function searchRankingRows(
  rows: OfficialRankingRow[],
  query: string,
): OfficialRankingRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return rows;
  return rows.filter((row) => {
    return (
      row.username.toLowerCase().includes(needle) ||
      (row.realName ?? '').toLowerCase().includes(needle) ||
      (row.className ?? '').toLowerCase().includes(needle)
    );
  });
}

export interface ResultsPlan {
  rows: OfficialRankingRow[];
  /** Rows matching the current search. */
  total: number;
  /** True when the contest is too large for the virtual-scroll table. */
  serverPaging: boolean;
  /** True when only a prefix of the rows is rendered. */
  truncated: boolean;
}

/**
 * Plans the results table payload: 1505-row contests stay fully virtual, while
 * 5000+ rows render only a bounded prefix with an explicit paging notice.
 */
export function planResultsRows(rows: OfficialRankingRow[], query: string): ResultsPlan {
  const filtered = searchRankingRows(rows, query);
  const serverPaging = filtered.length >= RESULTS_SERVER_PAGING_THRESHOLD;
  return {
    rows: serverPaging ? filtered.slice(0, RESULTS_TABLE_PREVIEW_LIMIT) : filtered,
    total: filtered.length,
    serverPaging,
    truncated: serverPaging,
  };
}

/** Drops blank auto-analysis lines before they reach the list or the PDF. */
export function cleanInsights(insights: string[]): string[] {
  return insights.map((insight) => insight.trim()).filter((insight) => insight !== '');
}
