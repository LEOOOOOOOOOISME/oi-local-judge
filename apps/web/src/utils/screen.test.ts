import { describe, expect, it } from 'vitest';
import {
  formatScreenCountdown,
  rollIntervalMs,
  rollRevealCount,
  rollRevealOrder,
  screenCountdown,
} from './screen';

const NOW = 1_700_000_000_000;

type CountdownContest = Parameters<typeof screenCountdown>[0];

function contest(overrides: Partial<CountdownContest>): CountdownContest {
  return {
    start_at: NOW - 60 * 60 * 1000,
    end_at: NOW + 60 * 60 * 1000,
    freeze_at: null,
    status: 'running',
    ...overrides,
  };
}

describe('formatScreenCountdown', () => {
  it('不足一小时使用 mm:ss', () => {
    expect(formatScreenCountdown(NOW + 625_000, NOW)).toEqual({
      remainingMs: 625_000,
      text: '10:25',
      urgent: false,
    });
  });

  it('超过一小时使用 hh:mm:ss', () => {
    expect(formatScreenCountdown(NOW + 3_725_000, NOW)).toEqual({
      remainingMs: 3_725_000,
      text: '01:02:05',
      urgent: false,
    });
  });

  it('向上取整剩余秒数，到点显示 00:00', () => {
    expect(formatScreenCountdown(NOW + 59_001, NOW)?.text).toBe('01:00');
    expect(formatScreenCountdown(NOW + 1, NOW)?.text).toBe('00:01');
    expect(formatScreenCountdown(NOW, NOW)).toEqual({
      remainingMs: 0,
      text: '00:00',
      urgent: false,
    });
  });

  it('目标为空或非法时返回 null', () => {
    expect(formatScreenCountdown(null, NOW)).toBeNull();
    expect(formatScreenCountdown(Number.NaN, NOW)).toBeNull();
  });

  it('已过时间按 0 处理且不标红', () => {
    expect(formatScreenCountdown(NOW - 10_000, NOW)).toEqual({
      remainingMs: 0,
      text: '00:00',
      urgent: false,
    });
  });

  it('严格小于 5 分钟才 urgent', () => {
    expect(formatScreenCountdown(NOW + 299_999, NOW)?.urgent).toBe(true);
    expect(formatScreenCountdown(NOW + 300_000, NOW)?.urgent).toBe(false);
  });
});

describe('rollRevealOrder', () => {
  it('返回从最后一名到第一名的副本且不修改原数组', () => {
    const rows = [1, 2, 3, 4];
    expect(rollRevealOrder(rows)).toEqual([4, 3, 2, 1]);
    expect(rows).toEqual([1, 2, 3, 4]);
  });

  it('空榜返回空数组', () => {
    expect(rollRevealOrder([])).toEqual([]);
  });
});

describe('rollRevealCount', () => {
  it('每次增加 step 并封顶 total', () => {
    expect(rollRevealCount(10, 0, 1)).toBe(1);
    expect(rollRevealCount(10, 4, 3)).toBe(7);
    expect(rollRevealCount(10, 9, 3)).toBe(10);
    expect(rollRevealCount(10, 10, 1)).toBe(10);
  });

  it('已揭示数越界时收敛到合法范围', () => {
    expect(rollRevealCount(10, 12, 1)).toBe(10);
    expect(rollRevealCount(10, -3, 2)).toBe(2);
    expect(rollRevealCount(0, 0, 1)).toBe(0);
    expect(rollRevealCount(10, 0, 0)).toBe(0);
  });
});

describe('rollIntervalMs', () => {
  it('按倍速换算基准 1200ms', () => {
    expect(rollIntervalMs(0.5)).toBe(2400);
    expect(rollIntervalMs(1)).toBe(1200);
    expect(rollIntervalMs(2)).toBe(600);
  });
});

describe('screenCountdown', () => {
  it('未开始显示距开始', () => {
    const result = screenCountdown(contest({ start_at: NOW + 61_000, end_at: NOW + 3_661_000 }), NOW);
    expect(result).toMatchObject({ kind: 'start', label: '距开始', parts: { text: '01:01' } });
  });

  it('进行中且未封榜显示距封榜', () => {
    const result = screenCountdown(contest({ freeze_at: NOW + 10 * 60 * 1000 }), NOW);
    expect(result).toMatchObject({ kind: 'freeze', label: '距封榜' });
    expect(result.parts?.text).toBe('10:00');
  });

  it('已封榜但未结束显示已封榜与距结束', () => {
    const result = screenCountdown(
      contest({ freeze_at: NOW - 10 * 60 * 1000, status: 'frozen' }),
      NOW,
    );
    expect(result).toMatchObject({ kind: 'frozen', label: '已封榜 · 距结束' });
    expect(result.parts?.text).toBe('01:00:00');
  });

  it('已过封榜时间即使状态仍为 running 也显示已封榜', () => {
    const result = screenCountdown(contest({ freeze_at: NOW - 1_000 }), NOW);
    expect(result.kind).toBe('frozen');
  });

  it('进行中且无封榜显示距结束', () => {
    const result = screenCountdown(contest({}), NOW);
    expect(result).toMatchObject({ kind: 'end', label: '距结束' });
  });

  it('已结束优先显示结束', () => {
    const result = screenCountdown(
      contest({ status: 'ended', freeze_at: NOW - 1_000 }),
      NOW,
    );
    expect(result).toEqual({ kind: 'ended', label: '已结束', parts: null });
    expect(screenCountdown(contest({ end_at: NOW }), NOW).kind).toBe('ended');
  });

  it('无结束时间时显示进行中且无倒计时', () => {
    const result = screenCountdown(contest({ end_at: null }), NOW);
    expect(result).toEqual({ kind: 'end', label: '进行中', parts: null });
  });
});
