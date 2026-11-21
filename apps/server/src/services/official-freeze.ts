import type { DatabaseSync } from 'node:sqlite';
import { getContest } from '../storage/repos/contests.js';
import { invalidateOfficialRanking } from './official-ranking.js';

/**
 * After a successful hack the official table is frozen for a configurable
 * review window (minutes) so admins can inspect the hack without further
 * online score changes. A value <= 0 disables the freeze.
 */
export function freezeOfficialAfterHack(
  db: DatabaseSync,
  contestId: number,
  now = Date.now(),
): number | null {
  const contest = getContest(db, contestId);
  if (!contest) return null;
  let minutes = 0;
  try {
    const config = JSON.parse(contest.ranking_rule_json || '{}') as {
      officialFreezeMinutesAfterHack?: number;
    };
    minutes = Math.max(0, Number(config.officialFreezeMinutesAfterHack ?? 0));
  } catch {
    minutes = 0;
  }
  if (minutes <= 0) return contest.official_frozen_until ?? null;
  const until = Math.max(contest.official_frozen_until ?? 0, now + minutes * 60_000);
  db.prepare('UPDATE contests SET official_frozen_until = ? WHERE id = ?').run(until, contestId);
  // The freeze deadline is part of the ranking response.
  invalidateOfficialRanking(db, contestId);
  return until;
}

export function isOfficialFrozen(contest: { official_frozen_until: number | null }, now = Date.now()): boolean {
  return contest.official_frozen_until !== null && contest.official_frozen_until > now;
}

/**
 * Freeze cutoff for legacy/team boards. `freeze_at` is a historical timestamp,
 * so it must stop applying once the contest is unfrozen or ended; simply
 * checking `freeze_at !== null` would hide every post-freeze submission
 * forever.
 */
export function effectiveFreezeAt(
  contest: { freeze_at: number | null; unfreeze_at: number | null; status: string },
  now = Date.now(),
): number | null {
  if (contest.freeze_at === null) return null;
  if (contest.status === 'ended') return null;
  if (contest.unfreeze_at !== null && now >= contest.unfreeze_at) return null;
  return contest.freeze_at;
}
