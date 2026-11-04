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
