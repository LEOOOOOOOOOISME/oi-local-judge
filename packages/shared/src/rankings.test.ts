import { describe, expect, it } from 'vitest';
import {
  computeRanking,
  type RankingConfig,
  type RankingRowResult,
  type RankingSubmissionInput,
} from './rankings.js';

const MIN = 60_000;

const OI: RankingConfig = { preset: 'oi', tie: 'same-rank' };

function submission(
  userId: number,
  problemId: number,
  verdict: string,
  score: number,
  createdAt: number,
): RankingSubmissionInput {
  return { userId, problemId, verdict, score, createdAt };
}

function byUser(rows: RankingRowResult[]): Map<number, RankingRowResult> {
  return new Map(rows.map((row) => [row.userId, row]));
}

function cell(row: RankingRowResult, problemId: number) {
  const found = row.cells.find((item) => item.problemId === problemId);
  if (!found) throw new Error(`missing cell for problem ${problemId}`);
  return found;
}

describe('computeRanking OI', () => {
  it('gives tied totals the same rank and skips the next rank (1, 1, 3)', () => {
    const rows = computeRanking({
      config: OI,
      problemIds: [1],
      userIds: [1, 2, 3],
      submissions: [
        submission(1, 1, 'AC', 100, 100),
        submission(2, 1, 'AC', 100, 200),
        submission(3, 1, 'AC', 50, 300),
      ],
    });

    expect(rows.map((row) => row.userId)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.rank)).toEqual([1, 1, 3]);
  });

  it('uses officialScores cells as authoritative over submissions', () => {
    const rows = computeRanking({
      config: OI,
      problemIds: [1],
      userIds: [1, 2],
      submissions: [
        submission(1, 1, 'PC', 40, 100),
        submission(2, 1, 'AC', 100, 200),
      ],
      officialScores: [
        { userId: 1, problemId: 1, score: 100, verdict: 'AC' },
        { userId: 2, problemId: 1, score: 0, verdict: 'WA' },
      ],
    });

    const rowsByUser = byUser(rows);
    expect(rowsByUser.get(1)!.totalScore).toBe(100);
    expect(cell(rowsByUser.get(1)!, 1)).toMatchObject({ score: 100, verdict: 'AC' });
    expect(rowsByUser.get(2)!.totalScore).toBe(0);
    expect(cell(rowsByUser.get(2)!, 1)).toMatchObject({ score: 0, verdict: 'WA' });
    expect(rows.map((row) => row.rank)).toEqual([1, 2]);
  });

  it('excludes submissions created after freezeAt, keeping the boundary inclusive', () => {
    const rows = computeRanking({
      config: { ...OI, freezeAt: 1000 },
      problemIds: [1],
      userIds: [1, 2],
      submissions: [
        submission(1, 1, 'WA', 0, 900),
        submission(1, 1, 'AC', 100, 1100),
        submission(2, 1, 'AC', 100, 1000),
      ],
    });

    const rowsByUser = byUser(rows);
    expect(rowsByUser.get(1)!.totalScore).toBe(0);
    expect(cell(rowsByUser.get(1)!, 1)).toMatchObject({
      score: 0,
      verdict: 'WA',
      attempts: 1,
      firstAcAt: null,
    });
    expect(rowsByUser.get(2)!.totalScore).toBe(100);
    expect(rows.map((row) => row.rank)).toEqual([1, 2]);
  });
});

describe('computeRanking IOI', () => {
  it('ranks tied totals as the same rank', () => {
    const rows = computeRanking({
      config: { preset: 'ioi', tie: 'same-rank' },
      problemIds: [1, 2],
      userIds: [1, 2, 3],
      submissions: [
        submission(1, 1, 'AC', 60, 100),
        submission(1, 2, 'PC', 40, 200),
        submission(2, 1, 'AC', 100, 300),
        submission(3, 1, 'AC', 70, 400),
      ],
    });

    expect(rows.map((row) => row.userId)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.rank)).toEqual([1, 1, 3]);
    expect(rows[0].totalScore).toBe(100);
    expect(rows[1].totalScore).toBe(100);
    expect(rows[2].totalScore).toBe(70);
  });
});

describe('computeRanking ACM', () => {
  it('sorts by solved desc then penalty asc and counts wrong attempts before AC', () => {
    const rows = computeRanking({
      config: { preset: 'acm', tie: 'same-rank' },
      problemIds: [1, 2],
      userIds: [1, 2, 3, 4, 5],
      contestStartAt: 0,
      contestEndAt: 60 * MIN,
      submissions: [
        // user1: 10 minutes to AC + one WA before it; later WA must not count.
        submission(1, 1, 'WA', 0, 5 * MIN),
        submission(1, 1, 'AC', 100, 10 * MIN),
        submission(1, 1, 'WA', 0, 11 * MIN),
        submission(1, 2, 'WA', 0, 1 * MIN),
        // user2: 20 minute penalty.
        submission(2, 1, 'AC', 100, 20 * MIN),
        // user3: two solves, penalty 30 + 40.
        submission(3, 1, 'AC', 100, 30 * MIN),
        submission(3, 2, 'AC', 100, 40 * MIN),
        // user4: no AC.
        submission(4, 1, 'WA', 0, 5 * MIN),
        // user5: identical solved/penalty/lastAc tuple to user2.
        submission(5, 1, 'AC', 100, 20 * MIN),
      ],
    });

    expect(rows.map((row) => row.userId)).toEqual([3, 2, 5, 1, 4]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 2, 4, 5]);

    const rowsByUser = byUser(rows);
    expect(rowsByUser.get(3)!.solved).toBe(2);
    expect(rowsByUser.get(3)!.totalScore).toBe(2);
    expect(rowsByUser.get(3)!.penalty).toBe(70);
    expect(rowsByUser.get(3)!.lastAcAt).toBe(40 * MIN);
    expect(rowsByUser.get(2)!.penalty).toBe(20);
    expect(rowsByUser.get(1)!.penalty).toBe(30);
    expect(rowsByUser.get(1)!.lastAcAt).toBe(10 * MIN);
    expect(cell(rowsByUser.get(1)!, 1).attempts).toBe(3);
    expect(cell(rowsByUser.get(1)!, 2).attempts).toBe(1);
    expect(rowsByUser.get(4)!.solved).toBe(0);
    expect(rowsByUser.get(4)!.penalty).toBe(0);
  });
});

describe('computeRanking CF-like', () => {
  const CF: RankingConfig = { preset: 'cf-like', tie: 'same-rank' };

  it('gives an earlier first AC a higher score and only counts the first AC', () => {
    const rows = computeRanking({
      config: CF,
      problemIds: [1],
      userIds: [1, 2, 3],
      contestStartAt: 0,
      contestEndAt: 100 * MIN,
      submissions: [
        submission(1, 1, 'AC', 100, 0),
        // A later AC for the same user must not change the cell.
        submission(1, 1, 'AC', 100, 80 * MIN),
        submission(2, 1, 'AC', 100, 50 * MIN),
        submission(3, 1, 'AC', 100, 100 * MIN),
      ],
    });

    expect(rows.map((row) => row.userId)).toEqual([1, 2, 3]);
    expect(rows.map((row) => cell(row, 1).score)).toEqual([100, 75, 50]);
    expect(rows.map((row) => row.totalScore)).toEqual([100, 75, 50]);
    expect(cell(rows[0], 1).firstAcAt).toBe(0);
    expect(cell(rows[0], 1).attempts).toBe(2);
  });

  it('uses authoritative problemPoints when provided', () => {
    const rows = computeRanking({
      config: CF,
      problemIds: [1],
      userIds: [1, 2],
      problemPoints: { 1: 200 },
      contestStartAt: 0,
      contestEndAt: 100 * MIN,
      submissions: [
        submission(1, 1, 'AC', 100, 0),
        submission(2, 1, 'AC', 100, 50 * MIN),
      ],
    });
    expect(rows.map((row) => cell(row, 1).score)).toEqual([200, 150]);
  });

  it('honors cfLike.decay and clamps negative raw scores to zero', () => {
    const slowerDecay = computeRanking({
      config: { ...CF, cfLike: { decay: 0.2 } },
      problemIds: [1],
      userIds: [2],
      contestStartAt: 0,
      contestEndAt: 100 * MIN,
      submissions: [submission(2, 1, 'AC', 100, 50 * MIN)],
    });
    expect(cell(slowerDecay[0], 1).score).toBe(90);

    const clamped = computeRanking({
      config: { ...CF, cfLike: { decay: 2 } },
      problemIds: [1],
      userIds: [3],
      contestStartAt: 0,
      contestEndAt: 100 * MIN,
      submissions: [submission(3, 1, 'AC', 100, 100 * MIN)],
    });
    expect(cell(clamped[0], 1).score).toBe(0);
  });
});

describe('computeRanking cells', () => {
  it('reports attempts, firstAcAt, and prefers the AC verdict', () => {
    const rows = computeRanking({
      config: OI,
      problemIds: [1, 2],
      userIds: [1],
      submissions: [
        submission(1, 1, 'WA', 0, 100),
        submission(1, 1, 'PC', 30, 200),
        submission(1, 1, 'AC', 100, 300),
        submission(1, 1, 'WA', 0, 400),
        submission(1, 2, 'WA', 0, 100),
        submission(1, 2, 'TLE', 0, 200),
      ],
    });

    expect(rows[0].cells.map((item) => item.problemId)).toEqual([1, 2]);
    expect(cell(rows[0], 1)).toMatchObject({
      score: 100,
      verdict: 'AC',
      attempts: 4,
      firstAcAt: 300,
    });
    expect(cell(rows[0], 2)).toMatchObject({
      score: 0,
      verdict: 'WA',
      attempts: 2,
      firstAcAt: null,
    });
  });
});
