import { describe, expect, it } from 'vitest';
import type {
  Contest,
  OfficialRanking,
  OfficialRankingRow,
  RankingDelta,
} from '../api/types';
import { mergeRankingDelta } from './rankingDelta';

function makeRow(userId: number, rank: number, totalScore: number): OfficialRankingRow {
  return {
    rank,
    userId,
    totalScore,
    solved: totalScore > 0 ? 1 : 0,
    penalty: 0,
    lastAcAt: null,
    cells: [],
    username: `user-${userId}`,
    realName: null,
    className: null,
    hackedCount: 0,
    successfulHacks: 0,
  };
}

const contest: Contest = {
  id: 9,
  name: 'Delta Contest',
  mode: 'oi',
  start_at: null,
  end_at: null,
  freeze_at: null,
  unfreeze_at: null,
  status: 'running',
  rules_json: '{}',
};

function makeRanking(rows: OfficialRankingRow[], version = 0): OfficialRanking {
  return {
    contest,
    problems: [{ id: 1, ordinal: 1, points: 100, title: 'A' }],
    rows,
    config: { preset: 'oi', tie: 'same-rank', freezeAt: null },
    archived: false,
    preset: 'oi',
    version,
    officialFrozenUntil: null,
  };
}

function makeDelta(
  overrides: Partial<RankingDelta> & Pick<RankingDelta, 'version' | 'ranks'>,
): RankingDelta {
  return {
    contestId: 9,
    changed: [],
    removed: [],
    ...overrides,
  };
}

describe('mergeRankingDelta', () => {
  it('replaces changed rows without mutating the cached object', () => {
    const cached = makeRanking([makeRow(1, 1, 100), makeRow(2, 2, 50)], 0);
    const updated = makeRow(1, 1, 100);
    updated.totalScore = 150;
    updated.solved = 2;

    const merged = mergeRankingDelta(
      cached,
      makeDelta({
        version: 1,
        changed: [updated],
        ranks: [
          { userId: 1, rank: 1 },
          { userId: 2, rank: 2 },
        ],
      }),
    );

    expect(merged).not.toBe(cached);
    expect(merged?.rows[0].totalScore).toBe(150);
    expect(merged?.rows[0].solved).toBe(2);
    expect(merged?.rows[1].totalScore).toBe(50);
    expect(merged?.version).toBe(1);
    // The input stays untouched.
    expect(cached.rows[0].totalScore).toBe(100);
    expect(cached.version).toBe(0);
  });

  it('adds a changed row the client did not have yet', () => {
    const cached = makeRanking([makeRow(1, 1, 100)], 0);
    const merged = mergeRankingDelta(
      cached,
      makeDelta({
        version: 1,
        changed: [makeRow(2, 2, 10)],
        ranks: [
          { userId: 1, rank: 1 },
          { userId: 2, rank: 2 },
        ],
      }),
    );

    expect(merged?.rows.map((row) => row.userId)).toEqual([1, 2]);
  });

  it('removes users and derives membership from ranks', () => {
    const cached = makeRanking([makeRow(1, 1, 100), makeRow(2, 2, 50), makeRow(3, 3, 10)], 0);
    const merged = mergeRankingDelta(
      cached,
      makeDelta({
        version: 1,
        removed: [2],
        // User 3 is missing from ranks even without a removed entry: drop it too.
        ranks: [{ userId: 1, rank: 1 }],
      }),
    );

    expect(merged?.rows.map((row) => row.userId)).toEqual([1]);
  });

  it('sorts rows by the ranks carried in the delta', () => {
    const cached = makeRanking([makeRow(1, 1, 100), makeRow(2, 2, 90)], 0);
    const first = makeRow(1, 2, 100);
    const second = makeRow(2, 1, 120);

    const merged = mergeRankingDelta(
      cached,
      makeDelta({
        version: 2,
        changed: [second, first],
        ranks: [
          { userId: 2, rank: 1 },
          { userId: 1, rank: 2 },
        ],
      }),
    );

    expect(merged?.rows.map((row) => row.userId)).toEqual([2, 1]);
    expect(merged?.rows.map((row) => row.rank)).toEqual([1, 2]);
  });

  it('returns null when there is no local cache to merge into', () => {
    const delta = makeDelta({ version: 1, ranks: [{ userId: 1, rank: 1 }] });
    expect(mergeRankingDelta(null, delta)).toBeNull();
    expect(mergeRankingDelta(undefined, delta)).toBeNull();
  });

  it('ignores a delta that is not newer than the cached snapshot', () => {
    const cached = makeRanking([makeRow(1, 1, 200)], 5);
    const merged = mergeRankingDelta(
      cached,
      makeDelta({
        version: 5,
        changed: [makeRow(1, 1, 10)],
        ranks: [{ userId: 1, rank: 1 }],
      }),
    );

    expect(merged).toBe(cached);
    expect(merged?.rows[0].totalScore).toBe(200);
  });

  it('keeps problems, contest and config from the cached ranking', () => {
    const cached = makeRanking([makeRow(1, 1, 100)], 0);
    const merged = mergeRankingDelta(
      cached,
      makeDelta({ version: 1, ranks: [{ userId: 1, rank: 1 }] }),
    );

    expect(merged?.contest).toBe(cached.contest);
    expect(merged?.problems).toBe(cached.problems);
    expect(merged?.config).toBe(cached.config);
  });
});
