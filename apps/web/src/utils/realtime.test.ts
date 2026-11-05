import { describe, expect, it } from 'vitest';
import { contestIdFromPathname, realtimeSocketPath } from './realtime';

describe('contestIdFromPathname', () => {
  it('解析比赛主页与其子路由', () => {
    expect(contestIdFromPathname('/contest/12')).toBe(12);
    expect(contestIdFromPathname('/contest/12/')).toBe(12);
    expect(contestIdFromPathname('/contest/12/ranking')).toBe(12);
    expect(contestIdFromPathname('/contest/12/problem/7')).toBe(12);
    expect(contestIdFromPathname('/contest/12/correction')).toBe(12);
  });

  it('解析管理端比赛控制台路由', () => {
    expect(contestIdFromPathname('/admin/contests/12')).toBe(12);
    expect(contestIdFromPathname('/admin/contests/12/')).toBe(12);
    expect(contestIdFromPathname('/admin/contests/12/batch')).toBe(12);
  });

  it('非比赛页面返回 null', () => {
    expect(contestIdFromPathname('/')).toBeNull();
    expect(contestIdFromPathname('/contests')).toBeNull();
    expect(contestIdFromPathname('/admin/contests')).toBeNull();
    expect(contestIdFromPathname('/admin/contests/abc')).toBeNull();
    expect(contestIdFromPathname('/problem/12')).toBeNull();
    expect(contestIdFromPathname('')).toBeNull();
  });

  it('非法比赛 id 返回 null', () => {
    expect(contestIdFromPathname('/contest/abc')).toBeNull();
    expect(contestIdFromPathname('/contest/0')).toBeNull();
    expect(contestIdFromPathname('/contest/-1')).toBeNull();
    expect(contestIdFromPathname('/contest/12foo')).toBeNull();
    expect(contestIdFromPathname('/contest/1.5')).toBeNull();
    expect(contestIdFromPathname('/contest/999999999999999999999')).toBeNull();
  });
});

describe('realtimeSocketPath', () => {
  it('比赛页订阅比赛房间，其余连接保持原 /ws', () => {
    expect(realtimeSocketPath(12)).toBe('/ws?contestId=12');
    expect(realtimeSocketPath(null)).toBe('/ws');
  });
});
