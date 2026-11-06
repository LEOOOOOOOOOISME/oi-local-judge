// Periodic rebuild of the learning-analytics cache tables.
//
// The first rebuild runs `OIJ_STATS_INITIAL_DELAY_MS` (default 2 minutes) after
// startup, then every `OIJ_STATS_INTERVAL_MS` (default 6 hours). A rebuild is
// synchronous and can block the event loop for a while, so a slow run is
// reported as a warning. Failures are logged and the timer keeps ticking.
// `OIJ_STATS_REBUILD=0` disables the scheduler entirely.
import type { DatabaseSync } from 'node:sqlite';

import {
  rebuildAllStatsWithSummary,
  type LearningStatsRebuildSummary,
} from './learning-stats.js';

export type { LearningStatsRebuildSummary };

/** First rebuild after startup: leave boot and the judge queue some room. */
export const DEFAULT_STATS_INITIAL_DELAY_MS = 2 * 60 * 1000;
/** Rebuild every six hours; the cache is a derived snapshot, not live data. */
export const DEFAULT_STATS_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A synchronous rebuild slower than this blocks the event loop noticeably. */
export const SLOW_STATS_REBUILD_WARN_MS = 2_000;

/** Thrown when a rebuild is requested while another one is still running. */
export class LearningStatsRebuildBusyError extends Error {
  readonly code = 'REBUILD_IN_PROGRESS';
  readonly status = 409;

  constructor() {
    super('a learning stats rebuild is already running');
    this.name = 'LearningStatsRebuildBusyError';
  }
}

let rebuildRunning = false;

export function isLearningStatsRebuildRunning(): boolean {
  return rebuildRunning;
}

/**
 * Runs `task` unless another learning-stats rebuild is already running.
 * Both the scheduler and the manual admin endpoint go through this guard, so
 * overlapping requests are rejected instead of stacking rebuilds.
 */
export function runExclusiveLearningStatsRebuild<T>(task: () => T): T {
  if (rebuildRunning) throw new LearningStatsRebuildBusyError();
  rebuildRunning = true;
  try {
    return task();
  } finally {
    rebuildRunning = false;
  }
}

/** Synchronous rebuild used by the manual admin endpoint. */
export function rebuildLearningStatsNow(db: DatabaseSync): LearningStatsRebuildSummary {
  return runExclusiveLearningStatsRebuild(() => rebuildAllStatsWithSummary(db));
}

export interface LearningStatsSchedulerOptions {
  db: DatabaseSync;
  /** Overrides `OIJ_STATS_INITIAL_DELAY_MS` (default 2 minutes). */
  initialDelayMs?: number;
  /** Overrides `OIJ_STATS_INTERVAL_MS` (default 6 hours). */
  intervalMs?: number;
  /** Environment source; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Rebuild sink; defaults to `rebuildAllStatsWithSummary`. Tests inject failures. */
  rebuild?: (db: DatabaseSync) => LearningStatsRebuildSummary;
  /** Failure sink; defaults to `console.error`. Never rethrows. */
  onError?: (error: unknown) => void;
  /** Slow-run sink; defaults to `console.warn`. */
  onSlow?: (elapsedMs: number) => void;
  /** Called after every successful run. */
  onRun?: (result: LearningStatsRebuildSummary) => void;
}

export interface LearningStatsSchedulerHandle {
  /** True unless the scheduler is disabled through `OIJ_STATS_REBUILD=0`. */
  readonly enabled: boolean;
  stop(): void;
}

/** `OIJ_STATS_REBUILD=0` (also `false`/`off`/`no`) turns periodic rebuilds off. */
export function isStatsRebuildDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OIJ_STATS_REBUILD?.trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no';
}

/** Parses a positive millisecond env value; invalid/absent values use `fallback`. */
function positiveMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts the periodic rebuild loop. The returned handle's `stop()` clears the
 * pending timer; there is no in-flight asynchronous work to await because the
 * rebuild itself is synchronous. Errors are reported through `onError` and
 * never escape the timer callback, so a failing rebuild cannot crash the server.
 */
export function startLearningStatsScheduler(
  options: LearningStatsSchedulerOptions,
): LearningStatsSchedulerHandle {
  const env = options.env ?? process.env;
  if (isStatsRebuildDisabled(env)) {
    return { enabled: false, stop() {} };
  }

  const initialDelayMs = Math.max(
    0,
    options.initialDelayMs ??
      positiveMs(env.OIJ_STATS_INITIAL_DELAY_MS, DEFAULT_STATS_INITIAL_DELAY_MS),
  );
  const intervalMs = Math.max(
    1,
    options.intervalMs ?? positiveMs(env.OIJ_STATS_INTERVAL_MS, DEFAULT_STATS_INTERVAL_MS),
  );
  const rebuild = options.rebuild ?? rebuildAllStatsWithSummary;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(`[stats] 学习统计重建失败：${describeError(error)}`);
    });
  const onSlow =
    options.onSlow ??
    ((elapsedMs: number) => {
      console.warn(`[stats] 学习统计重建耗时 ${elapsedMs} ms，期间事件循环被阻塞`);
    });

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      tick();
    }, delayMs);
    // Never keep the process alive only for the rebuild timer.
    timer.unref?.();
  };

  const tick = (): void => {
    if (stopped) return;
    const startedAt = Date.now();
    try {
      // The guard also covers an injected rebuild and a manual rebuild racing
      // with this tick.
      const result = runExclusiveLearningStatsRebuild(() => rebuild(options.db));
      options.onRun?.(result);
    } catch (error) {
      onError(error);
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= SLOW_STATS_REBUILD_WARN_MS) onSlow(elapsedMs);
    schedule(intervalMs);
  };

  schedule(initialDelayMs);

  return {
    enabled: true,
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
