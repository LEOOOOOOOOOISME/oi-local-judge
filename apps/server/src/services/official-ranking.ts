import type { DatabaseSync } from 'node:sqlite';
import {
  computeRanking,
  type RankingConfig,
  type RankingPreset,
  type RankingRowResult,
} from '@oij/shared';
import {
  getContest,
  getContestProblemEntries,
  getParticipants,
  getVisibleParticipants,
  type ContestRow,
} from '../storage/repos/contests.js';
import {
  listOfficialScores,
  seedOfficialScoresFromSubmissions,
} from '../storage/repos/official-scores.js';
import { listContestSubmissions } from '../storage/repos/submissions.js';
import { listHacks } from '../storage/repos/hacks.js';
import { getProblem } from '../storage/repos/problems.js';
import { getUserById } from '../storage/repos/users.js';
import { loadRankingPlugin } from './ranking-plugins.js';

export interface OfficialRankingRow extends RankingRowResult {
  username: string;
  realName: string | null;
  className: string | null;
  hackedCount: number;
  successfulHacks: number;
}

export interface OfficialRankingResult {
  contest: ContestRow;
  problems: Array<{ id: number; ordinal: number; points: number; title: string }>;
  rows: OfficialRankingRow[];
  config: RankingConfig;
  archived: boolean;
  preset: string;
  /**
   * Monotonic version of this ranking snapshot, bumped by
   * `invalidateOfficialRanking`. WebSocket deltas carry the same number so a
   * client can discard a delta that is older than the snapshot it already has.
   */
  version: number;
  pluginError?: string;
  officialFrozenUntil: number | null;
}

/**
 * Compact ranking change set: only the rows that changed, all user ids with
 * their new rank (ranks can shift for unchanged rows) and the removed users.
 */
export interface RankingDelta {
  contestId: number;
  /** Version of the `next` snapshot the delta was computed from. */
  version: number;
  changed: OfficialRankingRow[];
  ranks: Array<{ userId: number; rank: number }>;
  removed: number[];
}

/**
 * Resolves the effective ranking config of a contest: the stored
 * `ranking_rule_json` preset when it is a builtin one, otherwise a preset
 * derived from `contest.mode`. Plugin presets are reported through
 * `pluginName`; `config.preset` then falls back to `oi` for callers that can
 * only run a builtin preset. `freezeAt` reflects the contest's *official*
 * freeze status, so callers with different freeze semantics must override it.
 */
export function parseRankingConfig(contest: ContestRow): {
  config: RankingConfig;
  rawPreset: string;
  pluginName: string | null;
} {
  let stored: Partial<RankingConfig> & { preset?: string } = {};
  try {
    stored = JSON.parse(contest.ranking_rule_json || '{}') as typeof stored;
  } catch {
    stored = {};
  }
  const fallback: RankingPreset =
    contest.mode === 'acm' ? 'acm' : contest.mode === 'ioi' ? 'ioi' : 'oi';
  const rawPreset = stored.preset ?? fallback;
  const pluginName = rawPreset.startsWith('plugin:') ? rawPreset.slice('plugin:'.length) : null;
  const builtinPreset: RankingPreset = pluginName
    ? 'oi'
    : rawPreset === 'oi' || rawPreset === 'ioi' || rawPreset === 'acm' || rawPreset === 'cf-like'
      ? rawPreset
      : fallback;
  return {
    rawPreset,
    pluginName,
    config: {
      preset: builtinPreset,
      tie: stored.tie === 'none' ? 'none' : 'same-rank',
      cfLike: stored.cfLike,
      freezeAt: contest.status === 'frozen' ? contest.freeze_at : null,
    },
  };
}

/** Default lifetime of a cached official ranking. */
export const DEFAULT_RANKING_CACHE_TTL_MS = 1000;

/** Default / maximum page size of the statistics results table. */
export const OFFICIAL_RANKING_PAGE_DEFAULT_LIMIT = 100;
export const OFFICIAL_RANKING_PAGE_MAX_LIMIT = 500;

/** Query shape accepted by the paged official-ranking endpoint. */
export interface OfficialRankingPageInput {
  offset?: unknown;
  limit?: unknown;
  query?: unknown;
}

/**
 * One page of the official ranking. `total` is the number of rows matching the
 * search (the UI's pagination total), `allTotal` is the unfiltered visible row
 * count, and `items` is the requested slice in rank order.
 */
export interface OfficialRankingPage {
  items: OfficialRankingRow[];
  total: number;
  allTotal: number;
  offset: number;
  limit: number;
  query: string;
}

function normalizeOffset(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeLimit(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return OFFICIAL_RANKING_PAGE_DEFAULT_LIMIT;
  return Math.min(OFFICIAL_RANKING_PAGE_MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

/** Case-insensitive username / real name / class search used by the table. */
export function searchOfficialRankingRows(
  rows: readonly OfficialRankingRow[],
  rawQuery: unknown,
): OfficialRankingRow[] {
  const query = typeof rawQuery === 'string' ? rawQuery.trim().toLowerCase() : '';
  if (!query) return [...rows];
  return rows.filter((row) =>
    [row.username, row.realName ?? '', row.className ?? ''].some((value) =>
      value.toLowerCase().includes(query),
    ),
  );
}

/**
 * Slices a complete ranking for the statistics results table. Ranking order is
 * owned by the scoring pipeline, so this only filters and paginates — it never
 * recomputes ranks or scores.
 */
export function pageOfficialRanking(
  rows: readonly OfficialRankingRow[],
  input: OfficialRankingPageInput = {},
): OfficialRankingPage {
  const offset = normalizeOffset(input.offset);
  const limit = normalizeLimit(input.limit);
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const filtered = searchOfficialRankingRows(rows, query);
  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    allTotal: rows.length,
    offset,
    limit,
    query,
  };
}

interface OfficialRankingCacheEntry {
  dataDir: string;
  expiresAt: number;
  version: number;
  promise: Promise<OfficialRankingResult | null>;
}

const rankingCaches = new WeakMap<DatabaseSync, Map<number, OfficialRankingCacheEntry>>();

/**
 * Per-database, per-contest monotonic versions. A version starts at 0 and is
 * incremented by every invalidation, so a delta always carries a number greater
 * than the snapshot it was diffed from. Kept separate from the cache because an
 * invalidation must bump the version even when nothing is cached.
 */
const rankingVersions = new WeakMap<DatabaseSync, Map<number, number>>();

function rankingCacheFor(db: DatabaseSync): Map<number, OfficialRankingCacheEntry> {
  let cache = rankingCaches.get(db);
  if (!cache) {
    cache = new Map();
    rankingCaches.set(db, cache);
  }
  return cache;
}

function rankingVersionsFor(db: DatabaseSync): Map<number, number> {
  let versions = rankingVersions.get(db);
  if (!versions) {
    versions = new Map();
    rankingVersions.set(db, versions);
  }
  return versions;
}

/** Current version of a contest snapshot; an unseen contest starts at 0. */
function currentRankingVersion(db: DatabaseSync, contestId: number): number {
  const versions = rankingVersionsFor(db);
  const version = versions.get(contestId);
  if (version === undefined) {
    versions.set(contestId, 0);
    return 0;
  }
  return version;
}

/**
 * Reads `OIJ_RANKING_CACHE_MS` on every call so tests (and operators who set it
 * before starting the process) can tune or disable the cache. Values below zero
 * are clamped to zero, which turns every lookup into a miss.
 */
function rankingCacheTtlMs(): number {
  const raw = process.env.OIJ_RANKING_CACHE_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RANKING_CACHE_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_RANKING_CACHE_TTL_MS;
  return Math.max(0, parsed);
}

/**
 * Drops the cached official ranking for one contest, or for every contest of
 * this database when `contestId` is omitted, and bumps the contest version.
 * Call it after any mutation that can change the ranking: judge results, hacks,
 * official scores, contest status/config, participants or plugins.
 *
 * Returns the new version of the affected contest; for a database-wide
 * invalidation it returns the highest new version (each known contest is bumped
 * independently).
 */
export function invalidateOfficialRanking(db: DatabaseSync, contestId?: number): number {
  const versions = rankingVersionsFor(db);

  if (contestId === undefined) {
    let highest = 0;
    for (const [id, version] of versions) {
      const bumped = version + 1;
      versions.set(id, bumped);
      if (bumped > highest) highest = bumped;
    }
    rankingCaches.delete(db);
    return highest;
  }

  const nextVersion = (versions.get(contestId) ?? 0) + 1;
  versions.set(contestId, nextVersion);

  const cache = rankingCaches.get(db);
  if (!cache) return nextVersion;
  cache.delete(contestId);
  if (cache.size === 0) rankingCaches.delete(db);
  return nextVersion;
}

export interface ComputeOfficialRankingOptions {
  /**
   * Include participants hidden from the public board. Only statistics/report
   * callers that already checked for the manager role should set this; the
   * scoring itself is unchanged.
   */
  includeHidden?: boolean;
}

/** Current monotonic version of a contest ranking snapshot. */
export function getOfficialRankingVersion(db: DatabaseSync, contestId: number): number {
  return currentRankingVersion(db, contestId);
}

export async function computeOfficialRanking(
  db: DatabaseSync,
  contestId: number,
  dataDir = process.cwd(),
  version = currentRankingVersion(db, contestId),
  options: ComputeOfficialRankingOptions = {},
): Promise<OfficialRankingResult | null> {
  const contest = getContest(db, contestId);
  if (!contest) return null;

  const entries = getContestProblemEntries(db, contestId);
  const problems = entries.map((entry) => ({
    id: entry.problem_id,
    ordinal: entry.ordinal,
    points: entry.points,
    title: getProblem(db, entry.problem_id)?.title ?? `#${entry.problem_id}`,
  }));
  const problemIds = problems.map((problem) => problem.id);
  const userIds = options.includeHidden
    ? getParticipants(db, contestId)
    : getVisibleParticipants(db, contestId);
  const parsed = parseRankingConfig(contest);

  if (
    contest.official_frozen_until !== null &&
    contest.official_frozen_until <= Date.now()
  ) {
    seedOfficialScoresFromSubmissions(db, contestId);
    db.prepare('UPDATE contests SET official_frozen_until = NULL WHERE id = ?').run(contestId);
    contest.official_frozen_until = null;
  }

  if (!parsed.pluginName && parsed.config.preset === 'oi' && listOfficialScores(db, contestId).length === 0) {
    seedOfficialScoresFromSubmissions(db, contestId);
  }

  const submissions = listContestSubmissions(db, contestId)
    .filter((submission) => submission.phase === 'contest' && submission.hacked_at === null)
    .map((submission) => ({
      userId: submission.user_id,
      problemId: submission.problem_id,
      verdict: submission.verdict ?? 'WA',
      score: submission.score,
      createdAt: submission.created_at,
    }));
  const officialScores =
    parsed.config.preset === 'oi'
      ? listOfficialScores(db, contestId).map((row) => ({
          userId: row.user_id,
          problemId: row.problem_id,
          score: row.score,
          verdict: row.verdict,
        }))
      : undefined;
  const problemPoints = Object.fromEntries(
    problems.map((problem) => [problem.id, problem.points]),
  );
  const hacks = listHacks(db, contestId)
    .filter((hack) => hack.status === 'success' || hack.status === 'failed')
    .map((hack) => ({
      hackerId: hack.hacker_id,
      targetUserId: 0,
      problemId: hack.problem_id,
      status: hack.status as 'success' | 'failed',
      createdAt: hack.created_at,
    }));

  let rows: RankingRowResult[];
  let pluginError: string | undefined;
  if (parsed.pluginName) {
    try {
      const plugin = await loadRankingPlugin(db, dataDir, parsed.pluginName);
      if (!plugin) throw new Error(`plugin ${parsed.pluginName} is missing or disabled`);
      rows = plugin.compute({
        problemIds,
        userIds,
        submissions,
        officialScores,
        problemPoints,
        hacks,
        contestStartAt: contest.start_at,
        contestEndAt: contest.end_at,
        config: JSON.parse(contest.ranking_rule_json || '{}') as Record<string, unknown>,
      });
      if (!Array.isArray(rows)) throw new Error('plugin compute() did not return an array');
    } catch (err) {
      pluginError = err instanceof Error ? err.message : String(err);
      rows = computeRanking({
        config: { ...parsed.config, preset: 'oi' },
        problemIds,
        userIds,
        submissions,
        officialScores,
        problemPoints,
        hacks,
        contestStartAt: contest.start_at,
        contestEndAt: contest.end_at,
      });
    }
  } else {
    rows = computeRanking({
      config: parsed.config,
      problemIds,
      userIds,
      submissions,
      officialScores,
      problemPoints,
      hacks,
      contestStartAt: contest.start_at,
      contestEndAt: contest.end_at,
    });
  }

  const output = rows as OfficialRankingRow[];
  const hackedByUser = new Map<number, number>();
  for (const submission of listContestSubmissions(db, contestId)) {
    if (submission.hacked_at !== null) {
      hackedByUser.set(submission.user_id, (hackedByUser.get(submission.user_id) ?? 0) + 1);
    }
  }
  const successfulHacksByUser = new Map<number, number>();
  for (const hack of listHacks(db, contestId)) {
    if (hack.status === 'success' || hack.status === 'promoted') {
      successfulHacksByUser.set(
        hack.hacker_id,
        (successfulHacksByUser.get(hack.hacker_id) ?? 0) + 1,
      );
    }
  }
  for (const row of output) {
    const user = getUserById(db, row.userId);
    row.username = user?.username ?? `user-${row.userId}`;
    row.realName = user?.real_name ?? null;
    row.className = user?.class_name ?? null;
    row.hackedCount = hackedByUser.get(row.userId) ?? 0;
    row.successfulHacks = successfulHacksByUser.get(row.userId) ?? 0;
  }

  return {
    contest,
    problems,
    rows: output,
    config: parsed.config,
    archived: contest.archived_at !== null,
    preset: parsed.rawPreset,
    version,
    officialFrozenUntil: contest.official_frozen_until,
    ...(pluginError ? { pluginError } : {}),
  };
}

/**
 * Pure diff between two snapshots of the same contest ranking.
 *
 * `changed` holds the complete rows whose JSON changed (or which are new),
 * `ranks` maps every user of the new snapshot to its rank, and `removed` lists
 * users present before but gone now. Returns null when the board is identical;
 * a version bump alone does not produce a delta.
 */
export function diffOfficialRanking(
  prev: OfficialRankingResult,
  next: OfficialRankingResult,
): RankingDelta | null {
  const prevById = new Map<number, OfficialRankingRow>();
  for (const row of prev.rows) prevById.set(row.userId, row);
  const nextById = new Map<number, OfficialRankingRow>();
  for (const row of next.rows) nextById.set(row.userId, row);

  const changed: OfficialRankingRow[] = [];
  for (const row of next.rows) {
    const before = prevById.get(row.userId);
    // Rows are plain JSON objects produced by the same pipeline, so a stable
    // stringify is the cheapest complete "did this row change" test.
    if (!before || JSON.stringify(before) !== JSON.stringify(row)) changed.push(row);
  }

  const removed: number[] = [];
  for (const userId of prevById.keys()) {
    if (!nextById.has(userId)) removed.push(userId);
  }

  if (changed.length === 0 && removed.length === 0) return null;

  return {
    contestId: next.contest.id,
    version: next.version,
    changed,
    ranks: next.rows.map((row) => ({ userId: row.userId, rank: row.rank })),
    removed,
  };
}

/**
 * Cached official ranking. Concurrent calls for the same database, contest and
 * data directory share one in-flight computation, so a burst of page loads
 * cannot stampede the database. Entries expire after `OIJ_RANKING_CACHE_MS`
 * (default one second); explicit mutations call `invalidateOfficialRanking` for
 * immediate consistency. `now` exists so tests can move the clock without
 * timers; production callers never pass it.
 *
 * The returned object is shared between callers and must be treated as
 * read-only.
 */
export function getOfficialRanking(
  db: DatabaseSync,
  contestId: number,
  dataDir = process.cwd(),
  now = Date.now(),
): Promise<OfficialRankingResult | null> {
  const cache = rankingCacheFor(db);
  const cached = cache.get(contestId);
  if (cached && cached.dataDir === dataDir && now < cached.expiresAt) {
    return cached.promise;
  }

  const version = currentRankingVersion(db, contestId);
  let promise: Promise<OfficialRankingResult | null>;
  promise = computeOfficialRanking(db, contestId, dataDir, version).catch((err: unknown) => {
    // A rejected promise must not be cached, otherwise every retry within the
    // TTL would replay the same failure.
    if (cache.get(contestId)?.promise === promise) cache.delete(contestId);
    throw err;
  });
  cache.set(contestId, {
    dataDir,
    expiresAt: now + rankingCacheTtlMs(),
    version,
    promise,
  });
  return promise;
}
