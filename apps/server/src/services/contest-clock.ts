import type { DatabaseSync } from 'node:sqlite';
import { listContests, setContestStatus } from '../storage/repos/contests.js';

export interface ContestClockTransition {
  contestId: number;
  from: string;
  to: string;
  at: number;
}

export function tickContests(db: DatabaseSync, now = Date.now()): ContestClockTransition[] {
  const transitions: ContestClockTransition[] = [];
  for (const contest of listContests(db)) {
    const from = contest.status;
    let to = from;

    if (from === 'archived' || from === 'ended') continue;

    if (contest.end_at !== null && now >= contest.end_at && from !== 'draft') {
      to = 'ended';
    } else if (from === 'frozen' && contest.unfreeze_at !== null && now >= contest.unfreeze_at) {
      to = 'running';
    } else if (
      from === 'running' &&
      contest.freeze_at !== null &&
      now >= contest.freeze_at &&
      (contest.unfreeze_at === null || now < contest.unfreeze_at)
    ) {
      to = 'frozen';
    } else if (
      from === 'draft' &&
      contest.start_at !== null &&
      now >= contest.start_at &&
      (contest.end_at === null || now < contest.end_at)
    ) {
      to = 'running';
    }

    if (to !== from) {
      setContestStatus(db, contest.id, to);
      transitions.push({ contestId: contest.id, from, to, at: now });
    }
  }
  return transitions;
}

export function startContestClock(
  db: DatabaseSync,
  options: { intervalMs?: number; now?: () => number } = {},
): { stop(): void } {
  const interval = setInterval(() => {
    try {
      tickContests(db, options.now?.() ?? Date.now());
    } catch {
      // clock failures must never crash the server
    }
  }, Math.max(1000, options.intervalMs ?? 5000));
  interval.unref?.();
  return {
    stop() {
      clearInterval(interval);
    },
  };
}
