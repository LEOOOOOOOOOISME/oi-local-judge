import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { judgeSubmission } from '../src/judge/pipeline.js';
import {
  diffOfficialRanking,
  getOfficialRanking,
  invalidateOfficialRanking,
  type OfficialRankingResult,
  type OfficialRankingRow,
  type RankingDelta,
} from '../src/services/official-ranking.js';
import {
  addParticipant,
  createContest,
  type ContestRow,
} from '../src/storage/repos/contests.js';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission, getSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { WS_EVENTS } from '@oij/shared';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'ranking-delta-'));
const db = openDatabase(join(root, 'test.db'));
migrate(db);

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

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

function makeRanking(
  rows: OfficialRankingRow[],
  version = 0,
  contestId = 7,
): OfficialRankingResult {
  return {
    contest: { id: contestId } as ContestRow,
    problems: [],
    rows,
    config: { preset: 'oi', tie: 'same-rank' },
    archived: false,
    preset: 'oi',
    version,
    officialFrozenUntil: null,
  };
}

describe('diffOfficialRanking', () => {
  it('returns null when the board did not change', () => {
    const prev = makeRanking([makeRow(1, 1, 100), makeRow(2, 2, 50)], 0);
    const next = makeRanking([makeRow(1, 1, 100), makeRow(2, 2, 50)], 1);
    expect(diffOfficialRanking(prev, next)).toBeNull();
  });

  it('reports a changed row with the full row and all ranks', () => {
    const prev = makeRanking([makeRow(1, 1, 100), makeRow(2, 2, 50)], 0);
    const next = makeRanking([makeRow(1, 1, 100), makeRow(2, 2, 80)], 1);

    const delta = diffOfficialRanking(prev, next);
    expect(delta).not.toBeNull();
    expect(delta?.contestId).toBe(7);
    expect(delta?.version).toBe(1);
    expect(delta?.changed).toEqual([makeRow(2, 2, 80)]);
    expect(delta?.changed[0]).toEqual(next.rows[1]);
    expect(delta?.ranks).toEqual([
      { userId: 1, rank: 1 },
      { userId: 2, rank: 2 },
    ]);
    expect(delta?.removed).toEqual([]);
  });

  it('reports rank movement even when row ordering changes', () => {
    const prev = makeRanking([makeRow(1, 1, 100), makeRow(2, 2, 90)], 0);
    const next = makeRanking([makeRow(2, 1, 120), makeRow(1, 2, 100)], 3);

    const delta = diffOfficialRanking(prev, next);
    expect(delta?.version).toBe(3);
    // Both rows changed: user 2 gained score, user 1 only moved from rank 1 to 2.
    expect(delta?.changed.map((row) => row.userId).sort()).toEqual([1, 2]);
    expect(delta?.ranks).toEqual([
      { userId: 2, rank: 1 },
      { userId: 1, rank: 2 },
    ]);
  });

  it('reports removed users and keeps only current ranks', () => {
    const prev = makeRanking([makeRow(1, 1, 100), makeRow(2, 2, 50)], 0);
    const next = makeRanking([makeRow(1, 1, 100)], 2);

    const delta = diffOfficialRanking(prev, next);
    expect(delta?.removed).toEqual([2]);
    expect(delta?.changed).toEqual([]);
    expect(delta?.ranks).toEqual([{ userId: 1, rank: 1 }]);
  });

  it('treats a newly visible user as a changed row', () => {
    const prev = makeRanking([makeRow(1, 1, 100)], 0);
    const next = makeRanking([makeRow(1, 1, 100), makeRow(3, 2, 10)], 1);

    const delta = diffOfficialRanking(prev, next);
    expect(delta?.changed.map((row) => row.userId)).toEqual([3]);
    expect(delta?.ranks).toContainEqual({ userId: 3, rank: 2 });
  });
});

describe('official ranking versions', () => {
  function makeContestWithParticipant(name: string): { contestId: number; userId: number } {
    const problemId = createProblem(db, {
      title: `Version ${name}`,
      type: 'standard',
      timeMs: 1000,
      memoryMb: 64,
      testcases: [],
    });
    const contestId = createContest(db, {
      name,
      mode: 'oi',
      problemIds: [problemId],
    });
    const userId = createUser(db, { username: `version-${name}`, passwordHash: 'x' });
    addParticipant(db, contestId, userId);
    return { contestId, userId };
  }

  it('stamps snapshots with the current version and bumps on invalidation', async () => {
    const { contestId } = makeContestWithParticipant('bump');

    const first = await getOfficialRanking(db, contestId, root);
    expect(first?.version).toBe(0);

    // A cache hit keeps the same version and object.
    const cached = await getOfficialRanking(db, contestId, root);
    expect(cached).toBe(first);
    expect(cached?.version).toBe(0);

    expect(invalidateOfficialRanking(db, contestId)).toBe(1);
    const second = await getOfficialRanking(db, contestId, root);
    expect(second).not.toBe(first);
    expect(second?.version).toBe(1);

    expect(invalidateOfficialRanking(db, contestId)).toBe(2);
    expect((await getOfficialRanking(db, contestId, root))?.version).toBe(2);
  });

  it('bumps every known contest on a database-wide invalidation', async () => {
    const a = makeContestWithParticipant('bump-all-a');
    const b = makeContestWithParticipant('bump-all-b');
    const firstA = await getOfficialRanking(db, a.contestId, root);
    const firstB = await getOfficialRanking(db, b.contestId, root);

    // Each known contest is bumped independently; the call reports the highest
    // new version (other contests touched earlier in this file may be ahead).
    const highest = invalidateOfficialRanking(db);
    expect(highest).toBeGreaterThanOrEqual((firstA?.version ?? 0) + 1);
    expect((await getOfficialRanking(db, a.contestId, root))?.version).toBe(
      (firstA?.version ?? 0) + 1,
    );
    expect((await getOfficialRanking(db, b.contestId, root))?.version).toBe(
      (firstB?.version ?? 0) + 1,
    );
  });
});

describe('judgeSubmission ranking delta', () => {
  const objective = {
    questions: [
      {
        id: 1,
        kind: 'single' as const,
        stem: '1+1=?',
        options: [
          { key: 'A', text: '1' },
          { key: 'B', text: '2' },
        ],
        answers: ['B'],
        points: 100,
      },
    ],
  };

  it('publishes one ranking.delta to the contest room and no duplicate update', async () => {
    ensureDataDirs(root);
    let config: Config;
    try {
      config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
    } catch {
      config = { dataDir: root } as Config;
    }

    const problemId = createProblem(db, {
      title: 'Delta Objective',
      type: 'objective',
      timeMs: 1000,
      memoryMb: 64,
      objective,
      testcases: [],
    });
    const contestId = createContest(db, {
      name: 'delta-contest',
      mode: 'oi',
      problemIds: [problemId],
    });
    const userId = createUser(db, { username: 'delta-user', passwordHash: 'x' });
    addParticipant(db, contestId, userId);

    mkdirSync(join(root, 'submissions'), { recursive: true });
    const sourcePath = join(root, 'submissions', 'delta-answer.json');
    writeFileSync(
      sourcePath,
      JSON.stringify({ answers: [{ questionId: 1, value: ['B'] }] }),
      'utf8',
    );
    const submissionId = createSubmission(db, {
      contestId,
      problemId,
      userId,
      language: 'objective',
      sourcePath,
      sourceHash: 'ranking-delta-test',
    });

    const published: Array<{ type: string; data: unknown; room?: string }> = [];
    await judgeSubmission({
      db,
      config,
      submissionId,
      events: { publish: (event) => published.push(event) },
    });

    expect(getSubmission(db, submissionId)?.status).toBe('finished');

    const deltas = published.filter((event) => event.type === WS_EVENTS.rankingDelta);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].room).toBe(`contest:${contestId}`);

    const delta = deltas[0].data as RankingDelta;
    expect(delta.contestId).toBe(contestId);
    expect(delta.version).toBe(1);
    expect(delta.removed).toEqual([]);
    expect(delta.ranks).toEqual([{ userId, rank: 1 }]);
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0].userId).toBe(userId);
    expect(delta.changed[0].rank).toBe(1);
    expect(delta.changed[0].totalScore).toBe(100);

    // The wrapper must not add another submission.updated (contest room + user room).
    const updates = published.filter((event) => event.type === WS_EVENTS.submissionUpdated);
    expect(updates).toHaveLength(2);
    expect(new Set(updates.map((event) => event.room))).toEqual(
      new Set([`contest:${contestId}`, `user:${userId}`]),
    );
  }, 30_000);
});
