import { describe, expect, it } from 'vitest';
import type {
  ContestStatistics,
  ContestStatisticsSummary,
  OfficialRankingRow,
} from '../api/types';
import {
  RESULTS_SERVER_PAGING_THRESHOLD,
  RESULTS_TABLE_PREVIEW_LIMIT,
  buildKpiItems,
  buildRingData,
  cleanInsights,
  cumulativeChartData,
  distributionCumulativeRatios,
  distributionLabel,
  formatMetric,
  planResultsRows,
  searchRankingRows,
  statisticsModeLabel,
  unitForMode,
} from './statistics';

function row(
  userId: number,
  username: string,
  realName: string | null,
  className: string | null,
  totalScore: number,
): OfficialRankingRow {
  return {
    rank: userId,
    userId,
    totalScore,
    solved: 0,
    penalty: 0,
    lastAcAt: null,
    cells: [],
    username,
    realName,
    className,
    hackedCount: 0,
    successfulHacks: 0,
  };
}

function summary(overrides: Partial<ContestStatisticsSummary> = {}): ContestStatisticsSummary {
  return {
    participants: 3,
    submissions: 6,
    avgScore: 100,
    medianScore: 100,
    stddev: 81.6,
    maxScore: 200,
    minScore: 0,
    fullScoreCount: 1,
    zeroScoreCount: 1,
    avgPenalty: null,
    medianPenalty: null,
    ...overrides,
  };
}

function statistics(overrides: Partial<ContestStatistics> = {}): ContestStatistics {
  return {
    contest: {
      id: 1,
      title: 'Stats Cup',
      mode: 'oi',
      preset: 'oi',
      frozen: false,
      generatedAt: 1,
    },
    mode: 'score',
    summary: summary(),
    distribution: [],
    cumulative: [],
    problems: [],
    groups: [],
    insights: [],
    includeHidden: false,
    ...overrides,
  };
}

describe('statistics display helpers', () => {
  it('labels statistics modes and units', () => {
    expect(statisticsModeLabel('score')).toBe('分数');
    expect(statisticsModeLabel('solved')).toBe('通过题数');
    expect(unitForMode('score')).toBe('分');
    expect(unitForMode('solved')).toBe('题');
  });

  it('formats possibly missing metrics', () => {
    expect(formatMetric(133.333)).toBe('133.3');
    expect(formatMetric(100)).toBe('100.0');
    expect(formatMetric(0, 0)).toBe('0');
    expect(formatMetric(null)).toBe('—');
    expect(formatMetric(undefined)).toBe('—');
  });

  it('labels distribution buckets', () => {
    expect(distributionLabel({ from: 0, to: 99, count: 1 })).toBe('0–99');
    expect(distributionLabel({ from: 100, to: 200, count: 2 })).toBe('100–200');
    expect(distributionLabel({ from: 2, to: 2, count: 1 })).toBe('2');
  });

  it('builds ring data without empty wedges and normalised ratios', () => {
    const ring = buildRingData([
      { from: 0, to: 99, count: 1 },
      { from: 100, to: 199, count: 0 },
      { from: 200, to: 400, count: 3 },
    ]);
    expect(ring).toEqual([
      { name: '0–99', value: 1, ratio: 0.25 },
      { name: '200–400', value: 3, ratio: 0.75 },
    ]);
    expect(buildRingData([])).toEqual([]);
  });

  it('derives per-bucket cumulative ratios from the histogram', () => {
    expect(
      distributionCumulativeRatios([
        { from: 0, to: 99, count: 1 },
        { from: 100, to: 199, count: 0 },
        { from: 200, to: 400, count: 3 },
      ]),
    ).toEqual([1, 0.75, 0.75]);
    expect(distributionCumulativeRatios([])).toEqual([]);
  });

  it('maps cumulative points into chart arrays', () => {
    const data = cumulativeChartData([
      { score: 0, count: 3, ratio: 1 },
      { score: 100, count: 2, ratio: 0.6667 },
    ]);
    expect(data).toEqual({
      scores: [0, 100],
      counts: [3, 2],
      ratios: [1, 0.6667],
    });
  });

  it('builds score-mode KPI items and empty-safe values', () => {
    const items = buildKpiItems(statistics());
    expect(items.map((item) => item.label)).toEqual([
      '参赛人数',
      '提交数',
      '平均分',
      '中位数',
      '标准差',
      '满分人数',
      '0 分人数',
    ]);
    expect(items[0]?.value).toBe('3');
    expect(items[2]?.value).toBe('100.0');
    expect(items[4]?.value).toBe('81.6');

    const empty = buildKpiItems(
      statistics({
        summary: summary({
          participants: 0,
          submissions: 0,
          avgScore: null,
          medianScore: null,
          stddev: null,
          maxScore: null,
          minScore: null,
          fullScoreCount: 0,
          zeroScoreCount: 0,
        }),
      }),
    );
    expect(empty[2]?.value).toBe('—');
    expect(empty[3]?.value).toBe('—');
    expect(empty[4]?.value).toBe('—');
  });

  it('builds solved-mode KPI items with penalty and solved labels', () => {
    const items = buildKpiItems(
      statistics({
        mode: 'solved',
        summary: summary({ avgScore: 1.2, medianScore: 1, stddev: 0.8, avgPenalty: 11.7 }),
      }),
    );
    expect(items.map((item) => item.label)).toContain('平均通过题数');
    expect(items.map((item) => item.label)).toContain('平均罚时（分钟）');
    expect(items.find((item) => item.key === 'avgPenalty')?.value).toBe('11.7');
    expect(items.map((item) => item.label)).toContain('全题通过人数');
    expect(items.map((item) => item.label)).toContain('0 题人数');
  });

  it('searches ranking rows by username, real name and class, ignoring case', () => {
    const rows = [
      row(1, 'alice', 'Alice', '1班', 200),
      row(2, 'bob', 'Bob', '2班', 100),
      row(3, 'carol', null, null, 0),
    ];
    expect(searchRankingRows(rows, '')).toBe(rows);
    expect(searchRankingRows(rows, '  ')).toBe(rows);
    expect(searchRankingRows(rows, 'ALI').map((item) => item.userId)).toEqual([1]);
    expect(searchRankingRows(rows, 'bob').map((item) => item.userId)).toEqual([2]);
    expect(searchRankingRows(rows, '2班').map((item) => item.userId)).toEqual([2]);
    expect(searchRankingRows(rows, 'zzz')).toEqual([]);
  });

  it('plans results rows for virtual scrolling and large contests', () => {
    const small = Array.from({ length: 1505 }, (_unused, index) =>
      row(index + 1, `user${index + 1}`, null, null, index),
    );
    const smallPlan = planResultsRows(small, '');
    expect(smallPlan.rows).toHaveLength(1505);
    expect(smallPlan.total).toBe(1505);
    expect(smallPlan.serverPaging).toBe(false);
    expect(smallPlan.truncated).toBe(false);

    const large = Array.from({ length: RESULTS_SERVER_PAGING_THRESHOLD + 1000 }, (_unused, index) =>
      row(index + 1, `user${index + 1}`, null, null, 0),
    );
    const largePlan = planResultsRows(large, '');
    expect(largePlan.serverPaging).toBe(true);
    expect(largePlan.truncated).toBe(true);
    expect(largePlan.rows).toHaveLength(RESULTS_TABLE_PREVIEW_LIMIT);
    expect(largePlan.total).toBe(6000);
  });

  it('drops blank automatic insights', () => {
    expect(cleanInsights(['a', '', '  ', 'b'])).toEqual(['a', 'b']);
  });
});
