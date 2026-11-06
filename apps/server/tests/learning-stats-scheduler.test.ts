import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import {
  DEFAULT_STATS_INITIAL_DELAY_MS,
  DEFAULT_STATS_INTERVAL_MS,
  isLearningStatsRebuildRunning,
  LearningStatsRebuildBusyError,
  runExclusiveLearningStatsRebuild,
  startLearningStatsScheduler,
  type LearningStatsRebuildSummary,
} from '../src/services/learning-stats-scheduler.js';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  dbs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function setup(): { db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), 'oij-stats-scheduler-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  dbs.push(db);
  migrate(db);
  const user = createUser(db, { username: 'alice', passwordHash: 'x' });
  const problem = createProblem(db, {
    title: 'Cached',
    type: 'standard',
    tags: ['dp'],
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });
  const now = Date.now();
  db.prepare(
    `INSERT INTO submissions(problem_id, user_id, language, source_path, source_hash,
       status, verdict, score, created_at, judged_at, phase)
     VALUES (?, ?, 'cpp17', 'submissions/1/main.cpp', 'hash', 'finished', 'AC', 100, ?, ?, 'contest')`,
  ).run(problem, user, now, now);
  return { db };
}

function cachedRows(db: DatabaseSync): number {
  return (
    db.prepare('SELECT COUNT(*) AS count FROM student_problem_stats').get() as { count: number }
  ).count;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('等待条件超时');
}

describe('startLearningStatsScheduler', () => {
  it('uses a two-minute initial delay and a six-hour interval by default', () => {
    expect(DEFAULT_STATS_INITIAL_DELAY_MS).toBe(2 * 60 * 1000);
    expect(DEFAULT_STATS_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('rebuilds on the configured interval and stops cleanly', async () => {
    const { db } = setup();
    const runs: LearningStatsRebuildSummary[] = [];
    const handle = startLearningStatsScheduler({
      db,
      // Short timings prove the env overrides are honoured.
      env: { OIJ_STATS_INITIAL_DELAY_MS: '5', OIJ_STATS_INTERVAL_MS: '20' },
      onRun: (result) => runs.push(result),
    });
    expect(handle.enabled).toBe(true);

    try {
      await waitFor(() => runs.length >= 2);
    } finally {
      handle.stop();
    }

    expect(runs[0]).toMatchObject({ users: 1, problems: 1, tags: 1, days: 1 });
    expect(runs[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(cachedRows(db)).toBe(1);

    const afterStop = runs.length;
    await delay(150);
    expect(runs).toHaveLength(afterStop);
  });

  it('does not run when OIJ_STATS_REBUILD=0', async () => {
    const { db } = setup();
    const runs: LearningStatsRebuildSummary[] = [];
    const handle = startLearningStatsScheduler({
      db,
      initialDelayMs: 1,
      intervalMs: 5,
      env: { OIJ_STATS_REBUILD: '0' },
      onRun: (result) => runs.push(result),
    });
    expect(handle.enabled).toBe(false);

    await delay(80);
    handle.stop();

    expect(runs).toHaveLength(0);
    expect(cachedRows(db)).toBe(0);
  });

  it('logs failures instead of throwing and keeps ticking', async () => {
    const { db } = setup();
    const errors: unknown[] = [];
    let calls = 0;
    const handle = startLearningStatsScheduler({
      db,
      initialDelayMs: 1,
      intervalMs: 20,
      env: {},
      rebuild: () => {
        calls += 1;
        throw new Error('rebuild failed');
      },
      onError: (error) => errors.push(error),
    });

    try {
      await waitFor(() => errors.length >= 2);
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(errors[0]).toBeInstanceOf(Error);
    } finally {
      handle.stop();
    }
  });
});

describe('learning stats rebuild guard', () => {
  it('rejects a second rebuild while one is already running', () => {
    let nested: unknown;
    expect(isLearningStatsRebuildRunning()).toBe(false);

    const result = runExclusiveLearningStatsRebuild(() => {
      expect(isLearningStatsRebuildRunning()).toBe(true);
      try {
        runExclusiveLearningStatsRebuild(() => 'nested');
      } catch (error) {
        nested = error;
      }
      return 'outer';
    });

    expect(result).toBe('outer');
    expect(nested).toBeInstanceOf(LearningStatsRebuildBusyError);
    expect(isLearningStatsRebuildRunning()).toBe(false);
  });
});
