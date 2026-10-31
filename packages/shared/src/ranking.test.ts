import { describe, expect, it } from 'vitest';
import { computeOiRanking } from './ranking.js';

describe('computeOiRanking', () => {
  it('keeps the best score per problem and ranks by total', () => {
    const rows = computeOiRanking({
      problemIds: [1, 2],
      userIds: [10, 20],
      submissions: [
        { userId: 10, problemId: 1, verdict: 'WA', score: 20, createdAt: 100 },
        { userId: 10, problemId: 1, verdict: 'AC', score: 100, createdAt: 200 },
        { userId: 10, problemId: 2, verdict: 'AC', score: 100, createdAt: 300 },
        { userId: 20, problemId: 1, verdict: 'AC', score: 100, createdAt: 150 },
      ],
    });
    expect(rows.map((r) => r.userId)).toEqual([10, 20]);
    expect(rows[0].totalScore).toBe(200);
    expect(rows[0].solved).toBe(2);
    expect(rows[1].totalScore).toBe(100);
  });

  it('ties on total score by earlier last AC', () => {
    const rows = computeOiRanking({
      problemIds: [1],
      userIds: [1, 2],
      submissions: [
        { userId: 1, problemId: 1, verdict: 'AC', score: 100, createdAt: 500 },
        { userId: 2, problemId: 1, verdict: 'AC', score: 100, createdAt: 300 },
      ],
    });
    expect(rows.map((r) => r.userId)).toEqual([2, 1]);
  });

  it('freezes submissions after the cutoff', () => {
    const rows = computeOiRanking({
      problemIds: [1],
      userIds: [1],
      freezeAt: 1000,
      submissions: [
        { userId: 1, problemId: 1, verdict: 'WA', score: 0, createdAt: 900 },
        { userId: 1, problemId: 1, verdict: 'AC', score: 100, createdAt: 1100 },
      ],
    });
    expect(rows[0].totalScore).toBe(0);
    expect(rows[0].problems[0].verdict).toBe('WA');
  });
});
