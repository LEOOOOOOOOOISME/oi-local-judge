// In-process daily automatic backup scheduler.
//
// The first check runs `OIJ_BACKUP_INITIAL_DELAY_MS` (default 5 minutes) after
// startup so it does not compete with boot work; every later check runs
// `OIJ_BACKUP_INTERVAL_MS` (default 1 hour). `runAutoBackup` already rate-limits
// itself to one backup per 24 hours, so the hourly tick is cheap on skipped
// runs. Backups are synchronous directory copies (see system-ops): a slow copy
// blocks the event loop, which is reported as a warning instead of being queued.
import type { DatabaseSync } from 'node:sqlite';

import type { Config } from '../config.js';
import { runAutoBackup, type AutoBackupResult } from './system-ops.js';

/** Wait before the first check: startup is busier than steady state. */
export const DEFAULT_BACKUP_INITIAL_DELAY_MS = 5 * 60 * 1000;
/** Check hourly; runAutoBackup skips unless 24 hours have passed. */
export const DEFAULT_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
/** A synchronous backup slower than this blocks the event loop noticeably. */
export const SLOW_BACKUP_WARN_MS = 2_000;

export interface BackupSchedulerOptions {
  db: DatabaseSync;
  config: Config;
  /** Overrides `OIJ_BACKUP_INITIAL_DELAY_MS` (default 5 minutes). */
  initialDelayMs?: number;
  /** Overrides `OIJ_BACKUP_INTERVAL_MS` (default 1 hour). */
  intervalMs?: number;
  /** Clock used by the scheduler; tests inject a fixed clock if needed. */
  now?: () => number;
  /** Environment source; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Failure sink; defaults to `console.error`. Never rethrows. */
  onError?: (error: unknown) => void;
  /** Slow-run sink; defaults to `console.warn`. */
  onSlow?: (elapsedMs: number) => void;
  /** Called after every successful run (created or skipped). */
  onRun?: (result: AutoBackupResult) => void;
}

export interface BackupSchedulerHandle {
  /** True unless automatic backups are disabled through `OIJ_AUTO_BACKUP=0`. */
  readonly enabled: boolean;
  stop(): void;
}

/** `OIJ_AUTO_BACKUP=0` (also `false`/`off`/`no`) turns automatic backups off. */
export function isAutoBackupDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OIJ_AUTO_BACKUP?.trim().toLowerCase();
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
 * Starts the automatic backup loop. The returned handle's `stop()` clears the
 * pending timer; there is no in-flight asynchronous work to await because the
 * backup itself is synchronous. Errors are reported through `onError` and never
 * escape the timer callback, so a failing backup cannot crash the server.
 */
export function startBackupScheduler(options: BackupSchedulerOptions): BackupSchedulerHandle {
  const env = options.env ?? process.env;
  if (isAutoBackupDisabled(env)) {
    return { enabled: false, stop() {} };
  }

  const { db, config } = options;
  const now = options.now ?? Date.now;
  const initialDelayMs = Math.max(
    0,
    options.initialDelayMs ??
      positiveMs(env.OIJ_BACKUP_INITIAL_DELAY_MS, DEFAULT_BACKUP_INITIAL_DELAY_MS),
  );
  const intervalMs = Math.max(
    1,
    options.intervalMs ?? positiveMs(env.OIJ_BACKUP_INTERVAL_MS, DEFAULT_BACKUP_INTERVAL_MS),
  );
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(`[backup] 自动备份失败：${describeError(error)}`);
    });
  const onSlow =
    options.onSlow ??
    ((elapsedMs: number) => {
      console.warn(`[backup] 自动备份耗时 ${elapsedMs} ms，期间事件循环被阻塞`);
    });

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      tick();
    }, delayMs);
    // Never keep the process alive only for the backup timer.
    timer.unref?.();
  };

  const tick = (): void => {
    if (stopped) return;
    const startedAt = Date.now();
    try {
      const result = runAutoBackup(db, config, now());
      options.onRun?.(result);
    } catch (error) {
      onError(error);
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= SLOW_BACKUP_WARN_MS) onSlow(elapsedMs);
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
