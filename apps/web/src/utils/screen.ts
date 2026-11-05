import type { Contest } from '../api/types';
import { contestPhase } from './status';

/** 大屏模式：实时榜 / ICPC 滚榜。 */
export type ScreenMode = 'live' | 'roll';

export interface CountdownParts {
  remainingMs: number;
  text: string;
  urgent: boolean;
}

export type ScreenCountdownKind = 'start' | 'freeze' | 'end' | 'frozen' | 'ended';

export interface ScreenCountdown {
  kind: ScreenCountdownKind;
  label: string;
  parts: CountdownParts | null;
}

/** 倒计时进入红色警告的阈值：严格小于 5 分钟。 */
export const SCREEN_URGENT_MS = 5 * 60 * 1000;

/** 滚榜基准间隔；0.5x / 1x / 2x 按此换算。 */
export const ROLL_BASE_INTERVAL_MS = 1200;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 大屏倒计时：剩余不足一小时用 mm:ss，否则 hh:mm:ss。
 * 目标为空/非法返回 null；已过时间收敛到 00:00。
 */
export function formatScreenCountdown(target: number | null, now: number): CountdownParts | null {
  if (target === null || !Number.isFinite(target)) return null;
  const remainingMs = Math.max(0, target - now);
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const text =
    hours > 0
      ? `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
      : `${pad2(minutes)}:${pad2(seconds)}`;
  return {
    remainingMs,
    text,
    urgent: remainingMs > 0 && remainingMs < SCREEN_URGENT_MS,
  };
}

/** 滚榜揭示顺序：最后一名在前（从榜尾往上）。返回副本，不修改入参。 */
export function rollRevealOrder<T>(rows: readonly T[]): T[] {
  return rows.slice().reverse();
}

/** 下一次揭晓后的行数：增加 step，并收敛到 [0, total]。 */
export function rollRevealCount(total: number, revealed: number, step: number): number {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  const safeRevealed = Number.isFinite(revealed)
    ? Math.min(safeTotal, Math.max(0, Math.trunc(revealed)))
    : 0;
  const safeStep = Number.isFinite(step) ? Math.max(0, Math.trunc(step)) : 0;
  return Math.min(safeTotal, safeRevealed + safeStep);
}

/** 滚榜速度映射：base 1200ms，倍速越高间隔越短。 */
export function rollIntervalMs(speed: 0.5 | 1 | 2): number {
  return ROLL_BASE_INTERVAL_MS / speed;
}

/**
 * OI 倒计时状态：距开始 / 距封榜 / 已封榜 · 距结束 / 距结束 / 已结束。
 * 封榜时间已过但 status 仍为 running 时，同样按已封榜展示。
 */
export function screenCountdown(
  contest: Pick<Contest, 'start_at' | 'end_at' | 'freeze_at' | 'status'>,
  now: number,
): ScreenCountdown {
  const phase = contestPhase(contest, now);
  if (phase === 'ended') {
    return { kind: 'ended', label: '已结束', parts: null };
  }
  if (phase === 'upcoming') {
    return {
      kind: 'start',
      label: '距开始',
      parts: formatScreenCountdown(contest.start_at, now),
    };
  }
  const freezeAt = contest.freeze_at;
  if (phase === 'frozen' || (freezeAt !== null && now >= freezeAt)) {
    return {
      kind: 'frozen',
      label: '已封榜 · 距结束',
      parts: formatScreenCountdown(contest.end_at, now),
    };
  }
  if (freezeAt !== null && now < freezeAt) {
    return {
      kind: 'freeze',
      label: '距封榜',
      parts: formatScreenCountdown(freezeAt, now),
    };
  }
  if (contest.end_at === null) {
    return { kind: 'end', label: '进行中', parts: null };
  }
  return {
    kind: 'end',
    label: '距结束',
    parts: formatScreenCountdown(contest.end_at, now),
  };
}
