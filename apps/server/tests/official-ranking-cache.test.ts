import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const { computeMock } = vi.hoisted(() => ({ computeMock: vi.fn() }));

// The plugin count is the observation point for "computed only once": every
// cache miss reaches loadRankingPlugin and calls this compute exactly once.
vi.mock('../src/services/ranking-plugins.js', () => ({
  loadRankingPlugin: vi.fn(async () => ({ apiVersion: 1, compute: computeMock })),
}));

import {
  DEFAULT_RANKING_CACHE_TTL_MS,
  getOfficialRanking,
  invalidateOfficialRanking,
} from '../src/services/official-ranking.js';
import { createContest } from '../src/storage/repos/contests.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'official-ranking-cache-'));
const db = openDatabase(join(root, 'test.db'));
migrate(db);
const problemId = createProblem(db, {
  title: 'Cache Problem',
  type: 'standard',
  timeMs: 1000,
  memoryMb: 64,
  testcases: [],
});
const userId = createUser(db, { username: 'cache-user', passwordHash: 'x' });

function makeContest(name: string, rankingRule?: Record<string, unknown>): number {
  const contestId = createContest(db, { name, mode: 'oi', problemIds: [problemId] });
  db.prepare(
    "INSERT INTO contest_participants(contest_id, user_id, status) VALUES (?, ?, 'accepted')",
  ).run(contestId, userId);
  if (rankingRule) {
    db.prepare('UPDATE contests SET ranking_rule_json = ? WHERE id = ?').run(
      JSON.stringify(rankingRule),
      contestId,
    );
  }
  return contestId;
}

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('official ranking cache', () => {
  it('reuses the same promise and result for the same contest', async () => {
    const contestId = makeContest('cache-reuse');
    const now = 1_000_000;

    const first = getOfficialRanking(db, contestId, root, now);
    const second = getOfficialRanking(db, contestId, root, now);
    expect(second).toBe(first);

    const data = await first;
    expect(data?.contest.id).toBe(contestId);
    await expect(
      getOfficialRanking(db, contestId, root, now + DEFAULT_RANKING_CACHE_TTL_MS - 1),
    ).resolves.toBe(data);
  });

  it('keeps different contests isolated', async () => {
    const firstId = makeContest('cache-isolation-a');
    const secondId = makeContest('cache-isolation-b');
    const now = 2_000_000;

    const first = getOfficialRanking(db, firstId, root, now);
    const second = getOfficialRanking(db, secondId, root, now);
    expect(second).not.toBe(first);

    const [firstData, secondData] = await Promise.all([first, second]);
    expect(firstData?.contest.id).toBe(firstId);
    expect(secondData?.contest.id).toBe(secondId);
    expect(firstData).not.toBe(secondData);
  });

  it('recomputes after invalidating one contest', async () => {
    const contestId = makeContest('cache-invalidate-one');
    const now = 3_000_000;

    const first = await getOfficialRanking(db, contestId, root, now);
    invalidateOfficialRanking(db, contestId);
    const second = await getOfficialRanking(db, contestId, root, now);
    expect(second).not.toBe(first);
    expect(second?.contest.id).toBe(contestId);
  });

  it('recomputes after invalidating the whole database', async () => {
    const firstId = makeContest('cache-invalidate-all-a');
    const secondId = makeContest('cache-invalidate-all-b');
    const now = 3_500_000;

    const first = await getOfficialRanking(db, firstId, root, now);
    const second = await getOfficialRanking(db, secondId, root, now);
    invalidateOfficialRanking(db);
    expect(await getOfficialRanking(db, firstId, root, now)).not.toBe(first);
    expect(await getOfficialRanking(db, secondId, root, now)).not.toBe(second);
  });

  it('expires entries after the TTL', async () => {
    const contestId = makeContest('cache-ttl');
    const now = 4_000_000;

    const first = await getOfficialRanking(db, contestId, root, now);
    const beforeExpiry = await getOfficialRanking(
      db,
      contestId,
      root,
      now + DEFAULT_RANKING_CACHE_TTL_MS - 1,
    );
    expect(beforeExpiry).toBe(first);

    const afterExpiry = await getOfficialRanking(
      db,
      contestId,
      root,
      now + DEFAULT_RANKING_CACHE_TTL_MS,
    );
    expect(afterExpiry).not.toBe(first);
    expect(afterExpiry?.contest.id).toBe(contestId);
  });

  it('honors OIJ_RANKING_CACHE_MS=0 as a disabled cache', async () => {
    const contestId = makeContest('cache-env-disabled');
    const now = 5_000_000;
    vi.stubEnv('OIJ_RANKING_CACHE_MS', '0');
    try {
      const first = await getOfficialRanking(db, contestId, root, now);
      const second = await getOfficialRanking(db, contestId, root, now);
      expect(second).not.toBe(first);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('computes concurrently requested rankings only once', async () => {
    computeMock.mockReset();
    computeMock.mockReturnValue([]);
    const contestId = makeContest('cache-concurrency', { preset: 'plugin:counting' });
    const now = 6_000_000;

    const first = getOfficialRanking(db, contestId, root, now);
    const second = getOfficialRanking(db, contestId, root, now);
    expect(second).toBe(first);

    const [firstData, secondData] = await Promise.all([first, second]);
    expect(secondData).toBe(firstData);
    expect(computeMock).toHaveBeenCalledTimes(1);
  });

  it('does not keep a rejected computation in the cache', async () => {
    const rejectRoot = mkdtempSync(
      join(process.cwd(), 'native/runner/out', 'official-ranking-cache-reject-'),
    );
    const rejectDb = openDatabase(join(rejectRoot, 'reject.db'));
    migrate(rejectDb);
    rejectDb.close();
    const now = 7_000_000;
    try {
      const first = getOfficialRanking(rejectDb, 1, root, now);
      await expect(first).rejects.toThrow();

      // A cached rejection would hand the same promise back; a fresh one proves
      // the entry was dropped.
      const second = getOfficialRanking(rejectDb, 1, root, now);
      expect(second).not.toBe(first);
      await expect(second).rejects.toThrow();
    } finally {
      rmSync(rejectRoot, { recursive: true, force: true });
    }
  });
});
