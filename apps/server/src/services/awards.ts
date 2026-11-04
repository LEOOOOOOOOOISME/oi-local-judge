import type { DatabaseSync } from 'node:sqlite';
import { recordAudit } from '../storage/repos/audit.js';
import {
  getContest,
  setContestAwardConfig,
  type ContestRow,
} from '../storage/repos/contests.js';
import { getOfficialRanking } from './official-ranking.js';
import { getTeamRanking } from './team-ranking.js';

export interface AwardConfig {
  goldPercent: number;
  silverPercent: number;
  bronzePercent: number;
}

export type AwardLevel = 'gold' | 'silver' | 'bronze' | 'participation';

/** 有比例的奖牌等级；participation 不参与金/银/铜比例分配。 */
type MedalLevel = Exclude<AwardLevel, 'participation'>;

/** 奖项口径：个人奖按正式榜，团队奖按团队榜。 */
export type AwardScope = 'individual' | 'team';

/**
 * 奖项查询选项。`includeParticipation` 为 true 时，未获金/银/铜的正式榜行
 * 会获得 `participation` 证书；默认 false，响应与之前完全一致。
 */
export interface AwardQueryOptions {
  includeParticipation?: boolean;
}

export interface AwardRow {
  rank: number;
  userId: number;
  username: string;
  realName: string | null;
  className: string | null;
  totalScore: number;
  solved: number;
  award: AwardLevel | null;
  certificateNo: string;
}

/** 团队奖一行：团队榜中的名次与团队信息。 */
export interface TeamAwardRow {
  rank: number;
  teamId: number;
  teamName: string;
  memberCount: number;
  totalScore: number;
  solved: number;
  award: AwardLevel | null;
  certificateNo: string;
}

export interface AwardCounts {
  gold: number;
  silver: number;
  bronze: number;
  /** 参赛证书数量（仅在 includeParticipation 时为非零）。 */
  participation: number;
  /** 获奖总人数/队数（金 + 银 + 铜，不含参赛证书）。 */
  total: number;
}

export interface ContestAwards {
  contest: ContestRow;
  config: AwardConfig;
  rows: AwardRow[];
  counts: AwardCounts;
  scope: 'individual';
}

export interface TeamContestAwards {
  contest: ContestRow;
  config: AwardConfig;
  rows: TeamAwardRow[];
  counts: AwardCounts;
  scope: 'team';
}

export const DEFAULT_AWARD_CONFIG: AwardConfig = {
  goldPercent: 10,
  silverPercent: 20,
  bronzePercent: 30,
};

const PERCENT_KEYS = ['goldPercent', 'silverPercent', 'bronzePercent'] as const;

export class AwardConfigError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AwardConfigError';
  }
}

/** 请求了比赛不支持的口径（例如个人赛请求团队奖）。 */
export class AwardScopeError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AwardScopeError';
  }
}


function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * Validates a complete award config. Percentages may be fractional but must be
 * within 0..100 and sum to at most 100. Returns null for anything invalid.
 */
export function normalizeAwardConfig(input: unknown): AwardConfig | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const config = {} as AwardConfig;
  for (const key of PERCENT_KEYS) {
    const value = record[key];
    if (!isPercent(value)) return null;
    config[key] = value;
  }
  const sum = config.goldPercent + config.silverPercent + config.bronzePercent;
  if (sum > 100) return null;
  return config;
}

/**
 * Reads the persisted config for a contest. Missing, malformed or out-of-range
 * stored values fall back to the 10/20/30 default.
 */
export function getAwardConfig(contest: Pick<ContestRow, 'award_config_json'>): AwardConfig {
  let stored: unknown;
  try {
    stored = JSON.parse(contest.award_config_json || '{}');
  } catch {
    return { ...DEFAULT_AWARD_CONFIG };
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return { ...DEFAULT_AWARD_CONFIG };
  }
  const record = stored as Record<string, unknown>;
  const candidate: AwardConfig = {
    goldPercent:
      typeof record.goldPercent === 'number'
        ? record.goldPercent
        : DEFAULT_AWARD_CONFIG.goldPercent,
    silverPercent:
      typeof record.silverPercent === 'number'
        ? record.silverPercent
        : DEFAULT_AWARD_CONFIG.silverPercent,
    bronzePercent:
      typeof record.bronzePercent === 'number'
        ? record.bronzePercent
        : DEFAULT_AWARD_CONFIG.bronzePercent,
  };
  return normalizeAwardConfig(candidate) ?? { ...DEFAULT_AWARD_CONFIG };
}

/**
 * Turns percentages into rank thresholds. A non-zero percentage always awards
 * at least one place (when there is at least one ranked row), and allocations
 * are capped so the three bands never require more places than exist.
 */
export function computeAwardCounts(n: number, config: AwardConfig): AwardCounts {
  const total = Math.max(0, Math.floor(n));
  const allocate = (percent: number, remaining: number): number => {
    if (percent <= 0 || remaining <= 0) return 0;
    return Math.min(Math.max(1, Math.round((total * percent) / 100)), remaining);
  };
  const gold = allocate(config.goldPercent, total);
  const silver = allocate(config.silverPercent, total - gold);
  const bronze = allocate(config.bronzePercent, total - gold - silver);
  return { gold, silver, bronze, participation: 0, total: gold + silver + bronze };
}

/** Stable across ranking recalculations because it only depends on identity. */
export function certificateNo(contestId: number, userId: number): string {
  return `C${contestId}-${userId}`;
}

/** Team certificates use their own prefix so personal and team numbers never collide. */
export function teamCertificateNo(contestId: number, teamId: number): string {
  return `T${contestId}-${teamId}`;
}

function assignAward(
  rank: number,
  limits: { gold: number; silver: number; bronze: number },
): MedalLevel | null {
  if (rank <= limits.gold) return 'gold';
  if (rank <= limits.silver) return 'silver';
  if (rank <= limits.bronze) return 'bronze';
  return null;
}

/**
 * Builds the awards table from the official (visible) ranking. Hidden
 * participants are already excluded by getOfficialRanking. Rows keep their
 * ranking order and carry certificate data; ranks beyond the bronze threshold
 * receive `award: null` but remain in the response.
 */
export async function getContestAwards(
  db: DatabaseSync,
  contestId: number,
  dataDir = process.cwd(),
  options: AwardQueryOptions = {},
): Promise<ContestAwards | null> {
  const ranking = await getOfficialRanking(db, contestId, dataDir);
  if (!ranking) return null;

  const config = getAwardConfig(ranking.contest);
  const thresholds = computeAwardCounts(ranking.rows.length, config);
  const limits = {
    gold: thresholds.gold,
    silver: thresholds.gold + thresholds.silver,
    bronze: thresholds.gold + thresholds.silver + thresholds.bronze,
  };

  const counts: AwardCounts = { gold: 0, silver: 0, bronze: 0, participation: 0, total: 0 };
  const rows: AwardRow[] = ranking.rows.map((row) => {
    const medal = assignAward(row.rank, limits);
    let award: AwardLevel | null = medal;
    if (medal) {
      counts[medal] += 1;
      counts.total += 1;
    } else if (options.includeParticipation) {
      award = 'participation';
      counts.participation += 1;
    }
    return {
      rank: row.rank,
      userId: row.userId,
      username: row.username,
      realName: row.realName,
      className: row.className,
      totalScore: row.totalScore,
      solved: row.solved,
      award,
      certificateNo: certificateNo(contestId, row.userId),
    };
  });

  return { contest: ranking.contest, config, rows, counts, scope: 'individual' };
}

/**
 * Builds team awards from the team ranking. Only teams registered for the
 * contest appear (that is all `getTeamRanking` returns). Awards use the same
 * percentage config as individual awards, and team certificates are prefixed
 * with `T` to stay distinct from personal certificate numbers.
 */
export function getTeamContestAwards(
  db: DatabaseSync,
  contestId: number,
  options: AwardQueryOptions = {},
): TeamContestAwards | null {
  const ranking = getTeamRanking(db, contestId);
  if (!ranking) return null;
  if (ranking.contest.team_mode === 'individual') {
    throw new AwardScopeError(
      'SCOPE_NOT_TEAM',
      400,
      'this contest does not accept teams, so it has no team awards',
    );
  }

  const config = getAwardConfig(ranking.contest);
  const thresholds = computeAwardCounts(ranking.rows.length, config);
  const limits = {
    gold: thresholds.gold,
    silver: thresholds.gold + thresholds.silver,
    bronze: thresholds.gold + thresholds.silver + thresholds.bronze,
  };

  const counts: AwardCounts = { gold: 0, silver: 0, bronze: 0, participation: 0, total: 0 };
  const rows: TeamAwardRow[] = ranking.rows.map((row) => {
    const medal = assignAward(row.rank, limits);
    let award: AwardLevel | null = medal;
    if (medal) {
      counts[medal] += 1;
      counts.total += 1;
    } else if (options.includeParticipation) {
      award = 'participation';
      counts.participation += 1;
    }
    return {
      rank: row.rank,
      teamId: row.teamId,
      teamName: row.teamName,
      memberCount: row.memberCount,
      totalScore: row.totalScore,
      solved: row.solved,
      award,
      certificateNo: teamCertificateNo(contestId, row.teamId),
    };
  });

  return { contest: ranking.contest, config, rows, counts, scope: 'team' };
}

export interface SetAwardConfigOptions {
  actorId?: number | null;
  ip?: string | null;
}

/**
 * Persists a validated award config and records an audit entry. Throws
 * AwardConfigError for invalid percentages or a missing contest.
 */
export function setAwardConfig(
  db: DatabaseSync,
  contestId: number,
  config: unknown,
  options: SetAwardConfigOptions = {},
): AwardConfig {
  const normalized = normalizeAwardConfig(config);
  if (!normalized) {
    throw new AwardConfigError(
      'INVALID_AWARD_CONFIG',
      400,
      'goldPercent, silverPercent and bronzePercent must be numbers between 0 and 100 that sum to at most 100',
    );
  }
  const contest = getContest(db, contestId);
  if (!contest) {
    throw new AwardConfigError('NOT_FOUND', 404, 'contest not found');
  }
  const previous = getAwardConfig(contest);
  setContestAwardConfig(db, contestId, JSON.stringify(normalized));
  recordAudit(db, {
    actorId: options.actorId ?? null,
    action: 'contest.awards.config.update',
    targetType: 'contest',
    targetId: contestId,
    detail: { contestId, previous, config: normalized },
    ip: options.ip ?? null,
  });
  return normalized;
}
