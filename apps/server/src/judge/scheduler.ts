// In-process judge scheduler.
//
// Every `pollIntervalMs` (default 100ms) the scheduler claims queued judge
// tasks (`priority DESC, id`) and runs up to `config.judgeConcurrency` of them
// concurrently. `stop()` clears the poll timer and waits for in-flight judging
// to finish; no new tasks are claimed after stopping.
import type { DatabaseSync } from 'node:sqlite';

import type { Config } from '../config.js';
import {
  claimNextTask,
  finishJudgeTask,
  type JudgeTaskRow,
} from '../storage/repos/judge.js';
import {
  isJudgeCanceledError,
  registerCancellation,
  releaseCancellation,
} from './cancellation.js';
import { judgeSubmission, type EventPublisher } from './pipeline.js';

export interface SchedulerOptions {
  db: DatabaseSync;
  config: Config;
  /** Optional event sink (judging events are published through it). */
  events?: EventPublisher;
  /** Alias for `events`, matching the phase-1a plan's `hub` parameter name. */
  hub?: EventPublisher;
  /** Poll interval in milliseconds (default 100). */
  pollIntervalMs?: number;
  /** Worker name written to judge_tasks.worker. */
  workerId?: string;
}

export interface SchedulerHandle {
  /** Stops claiming tasks and waits for currently running tasks to settle. */
  stop(): Promise<void>;
}

export function startScheduler(options: SchedulerOptions): SchedulerHandle {
  const { db, config } = options;
  const events = options.events ?? options.hub;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 100);
  const concurrency = Math.max(1, Math.floor(config.judgeConcurrency));
  const workerId =
    options.workerId ??
    `judge-worker-${process.pid}-${Date.now().toString(36)}`;

  let stopped = false;
  let inFlight = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const running = new Set<Promise<void>>();

  const schedulePoll = (): void => {
    if (stopped || pollTimer !== null) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void pump();
    }, pollIntervalMs);
  };

  async function runTask(task: JudgeTaskRow): Promise<void> {
    const controller = registerCancellation(task.submission_id);
    let outcome: 'done' | 'failed' | 'canceled' = 'failed';
    try {
      await judgeSubmission({
        db,
        config,
        submissionId: task.submission_id,
        events,
        signal: controller.signal,
      });
      // judgeSubmission records pipeline failures itself as failed + SE, so the
      // task itself was processed successfully. An aborted signal means the run
      // stopped through the cancel service instead.
      outcome = controller.signal.aborted ? 'canceled' : 'done';
    } catch (err) {
      outcome =
        controller.signal.aborted || isJudgeCanceledError(err) ? 'canceled' : 'failed';
    } finally {
      try {
        finishJudgeTask(db, task.id, outcome);
      } catch {
        // Never let bookkeeping failure leave a dangling promise.
      }
      releaseCancellation(task.submission_id);
      inFlight -= 1;
    }
  }

  async function pump(): Promise<void> {
    if (stopped) return;
    // Claims are synchronous; judgeSubmission only starts awaiting afterwards.
    while (!stopped && inFlight < concurrency) {
      let task: JudgeTaskRow | null;
      try {
        task = claimNextTask(db, workerId);
      } catch {
        break;
      }
      if (!task) break;
      inFlight += 1;
      const job = runTask(task);
      running.add(job);
      void job
        .finally(() => {
          running.delete(job);
        })
        .catch(() => {
          // runTask settles its own failures; keep the void promise quiet.
        });
    }
    schedulePoll();
  }

  // Start immediately: the first tasks are claimed on this tick.
  void pump();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      await Promise.allSettled([...running]);
    },
  };
}
