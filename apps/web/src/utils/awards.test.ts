import { describe, expect, it } from 'vitest';
import type { AwardConfig, AwardRow, TeamAwardRow } from '../api/types';
import {
  awardColor,
  awardLabel,
  buildAwardsCsv,
  buildTeamAwardsCsv,
  computeAwardCounts,
  filterAwardRows,
  filterTeamAwardRows,
  formatCertificateDate,
  isTeamAwardRow,
  isValidAwardConfig,
  sanitizeFileName,
} from './awards';

const DEFAULT_CONFIG: AwardConfig = {
  goldPercent: 10,
  silverPercent: 20,
  bronzePercent: 30,
};

function row(overrides: Partial<AwardRow>): AwardRow {
  return {
    rank: 1,
    userId: 1,
    username: 'alice',
    realName: 'Alice',
    className: '高一(1)班',
    totalScore: 300,
    solved: 3,
    award: 'gold',
    certificateNo: 'C7-1',
    ...overrides,
  };
}

describe('computeAwardCounts', () => {
  it('默认 10/20/30 按人数四舍五入', () => {
    expect(computeAwardCounts(10, DEFAULT_CONFIG)).toEqual({
      gold: 1,
      silver: 2,
      bronze: 3,
      participation: 0,
      total: 6,
    });
    expect(computeAwardCounts(100, DEFAULT_CONFIG)).toEqual({
      gold: 10,
      silver: 20,
      bronze: 30,
      participation: 0,
      total: 60,
    });
  });

  it('非零比例至少分配 1 人', () => {
    expect(computeAwardCounts(3, DEFAULT_CONFIG)).toEqual({
      gold: 1,
      silver: 1,
      bronze: 1,
      participation: 0,
      total: 3,
    });
  });

  it('累计人数不超过总人数，先金后银再铜', () => {
    expect(computeAwardCounts(2, { goldPercent: 50, silverPercent: 50, bronzePercent: 50 })).toEqual(
      { gold: 1, silver: 1, bronze: 0, participation: 0, total: 2 },
    );
    expect(computeAwardCounts(1, DEFAULT_CONFIG)).toEqual({
      gold: 1,
      silver: 0,
      bronze: 0,
      participation: 0,
      total: 1,
    });
  });

  it('0% 不分配且总人数为 0 时全部为 0', () => {
    expect(computeAwardCounts(10, { goldPercent: 0, silverPercent: 0, bronzePercent: 0 })).toEqual({
      gold: 0,
      silver: 0,
      bronze: 0,
      participation: 0,
      total: 0,
    });
    expect(computeAwardCounts(0, DEFAULT_CONFIG)).toEqual({
      gold: 0,
      silver: 0,
      bronze: 0,
      participation: 0,
      total: 0,
    });
  });
});

describe('isValidAwardConfig', () => {
  it('接受 0..100 且总和不超过 100 的配置', () => {
    expect(isValidAwardConfig(DEFAULT_CONFIG)).toBe(true);
    expect(isValidAwardConfig({ goldPercent: 0, silverPercent: 0, bronzePercent: 0 })).toBe(true);
    expect(
      isValidAwardConfig({ goldPercent: 33.5, silverPercent: 33.5, bronzePercent: 33 }),
    ).toBe(true);
  });

  it('拒绝负数、超过 100 或总和超过 100 的配置', () => {
    expect(isValidAwardConfig({ goldPercent: -1, silverPercent: 0, bronzePercent: 0 })).toBe(false);
    expect(isValidAwardConfig({ goldPercent: 101, silverPercent: 0, bronzePercent: 0 })).toBe(false);
    expect(isValidAwardConfig({ goldPercent: 50, silverPercent: 30, bronzePercent: 30 })).toBe(false);
    expect(isValidAwardConfig({ goldPercent: Number.NaN, silverPercent: 0, bronzePercent: 0 })).toBe(
      false,
    );
  });
});

describe('filterAwardRows', () => {
  const rows = [
    row({ rank: 1, userId: 1, username: 'alice', realName: 'Alice', award: 'gold' }),
    row({
      rank: 2,
      userId: 2,
      username: 'bob',
      realName: 'Bob',
      className: '高一(2)班',
      award: 'silver',
      certificateNo: 'C7-2',
    }),
    row({
      rank: 3,
      userId: 3,
      username: 'carol',
      realName: null,
      award: null,
      certificateNo: 'C7-3',
    }),
  ];

  it('默认返回全部行且不修改原数组', () => {
    const snapshot = [...rows];
    expect(filterAwardRows(rows, {})).toHaveLength(3);
    expect(rows).toEqual(snapshot);
  });

  it('按奖项筛选，none 表示未获奖', () => {
    expect(filterAwardRows(rows, { award: 'gold' }).map((item) => item.userId)).toEqual([1]);
    expect(filterAwardRows(rows, { award: 'none' }).map((item) => item.userId)).toEqual([3]);
    expect(filterAwardRows(rows, { award: 'all' })).toHaveLength(3);
  });

  it('按关键字匹配用户名、姓名、班级与证书编号', () => {
    expect(filterAwardRows(rows, { keyword: 'ALI' }).map((item) => item.userId)).toEqual([1]);
    expect(filterAwardRows(rows, { keyword: '高一(2)' }).map((item) => item.userId)).toEqual([2]);
    expect(filterAwardRows(rows, { keyword: 'C7-3' }).map((item) => item.userId)).toEqual([3]);
    expect(filterAwardRows(rows, { keyword: '   ' })).toHaveLength(3);
  });

  it('按班级精确筛选', () => {
    expect(filterAwardRows(rows, { className: '高一(2)班' }).map((item) => item.userId)).toEqual([
      2,
    ]);
  });
});

describe('buildAwardsCsv', () => {
  it('包含表头、名次、奖项与证书编号，并带 UTF-8 BOM', () => {
    const csv = buildAwardsCsv([
      row({
        rank: 1,
        username: 'alice',
        realName: 'Alice',
        className: '高一(1)班',
        totalScore: 300,
        solved: 3,
        award: 'gold',
        certificateNo: 'C7-1',
      }),
    ]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.replace('\uFEFF', '').trimEnd().split('\r\n');
    expect(lines[0]).toBe('名次,用户名,姓名,班级,总分,解出题数,奖项,证书编号');
    expect(lines[1]).toBe('1,alice,Alice,高一(1)班,300,3,金牌,C7-1');
  });

  it('转义逗号、引号与换行，null 输出空字段', () => {
    const csv = buildAwardsCsv([
      row({
        username: 'a,b',
        realName: '他说"你好"',
        className: '第一行\n第二行',
        award: null,
        certificateNo: 'C7-9',
      }),
    ]);
    const body = csv.replace('\uFEFF', '');
    expect(body).toContain('"a,b"');
    expect(body).toContain('"他说""你好"""');
    expect(body).toContain('"第一行\n第二行"');
    expect(body).toContain(',未获奖,C7-9');
  });

  it('空列表只输出表头', () => {
    const csv = buildAwardsCsv([]).replace('\uFEFF', '').trimEnd();
    expect(csv).toBe('名次,用户名,姓名,班级,总分,解出题数,奖项,证书编号');
  });
});

describe('awardLabel / awardColor', () => {
  it('返回中文奖项名与 Tag 颜色', () => {
    expect(awardLabel('gold')).toBe('金牌');
    expect(awardLabel('silver')).toBe('银牌');
    expect(awardLabel('bronze')).toBe('铜牌');
    expect(awardLabel('participation')).toBe('参赛');
    expect(awardLabel(null)).toBe('未获奖');
    expect(awardColor('gold')).toBe('gold');
    expect(awardColor('bronze')).toBe('orange');
    expect(awardColor('participation')).toBe('blue');
    expect(awardColor(null)).toBe('default');
  });
});

describe('participation certificates', () => {
  it('按 participation 筛选个人与团队行', () => {
    const individual = [
      row({ userId: 1, award: 'gold', certificateNo: 'C7-1' }),
      row({ userId: 2, award: 'participation', certificateNo: 'C7-2' }),
    ];
    expect(filterAwardRows(individual, { award: 'participation' }).map((item) => item.userId)).toEqual([
      2,
    ]);

    const teams = [
      teamRow({ teamId: 3, award: 'gold', certificateNo: 'T7-3' }),
      teamRow({ teamId: 4, award: 'participation', certificateNo: 'T7-4' }),
    ];
    expect(
      filterTeamAwardRows(teams, { award: 'participation' }).map((item) => item.teamId),
    ).toEqual([4]);
  });

  it('CSV 用“参赛”输出 participation 行', () => {
    const individual = buildAwardsCsv([
      row({ userId: 9, username: 'dave', realName: 'Dave', award: 'participation', certificateNo: 'C7-9' }),
    ])
      .replace('\uFEFF', '')
      .trimEnd()
      .split('\r\n');
    expect(individual[1]).toBe('1,dave,Dave,高一(1)班,300,3,参赛,C7-9');

    const team = buildTeamAwardsCsv([
      teamRow({ teamId: 9, teamName: 'Omega', award: 'participation', certificateNo: 'T7-9' }),
    ])
      .replace('\uFEFF', '')
      .trimEnd()
      .split('\r\n');
    expect(team[1]).toBe('1,Omega,2,200,1,参赛,T7-9');
  });
});

describe('sanitizeFileName', () => {
  it('替换非法字符并兜底默认名', () => {
    expect(sanitizeFileName('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i');
    expect(sanitizeFileName('   ')).toBe('awards');
  });
});

describe('formatCertificateDate', () => {
  it('格式化时间戳，缺失时使用当前时间', () => {
    const timestamp = new Date(2026, 10, 3, 12).getTime();
    expect(formatCertificateDate(timestamp)).toBe('2026 年 11 月 3 日');
    expect(formatCertificateDate(null, timestamp)).toBe('2026 年 11 月 3 日');
    expect(formatCertificateDate(Number.NaN)).toBe('—');
  });
});

function teamRow(overrides: Partial<TeamAwardRow>): TeamAwardRow {
  return {
    rank: 1,
    teamId: 3,
    teamName: 'Alpha',
    memberCount: 2,
    totalScore: 200,
    solved: 1,
    award: 'gold',
    certificateNo: 'T7-3',
    ...overrides,
  };
}

describe('isTeamAwardRow', () => {
  it('区分团队奖行与个人奖行', () => {
    expect(isTeamAwardRow(teamRow({}))).toBe(true);
    expect(isTeamAwardRow(row({}))).toBe(false);
  });
});

describe('filterTeamAwardRows', () => {
  const rows = [
    teamRow({ rank: 1, teamId: 3, teamName: 'Alpha', award: 'gold' }),
    teamRow({
      rank: 2,
      teamId: 4,
      teamName: 'Beta 战队',
      award: 'silver',
      certificateNo: 'T7-4',
    }),
    teamRow({
      rank: 3,
      teamId: 5,
      teamName: 'Gamma',
      award: null,
      certificateNo: 'T7-5',
    }),
  ];

  it('默认返回全部行且不修改原数组', () => {
    const snapshot = [...rows];
    expect(filterTeamAwardRows(rows, {})).toHaveLength(3);
    expect(rows).toEqual(snapshot);
  });

  it('按奖项筛选，none 表示未获奖', () => {
    expect(filterTeamAwardRows(rows, { award: 'gold' }).map((item) => item.teamId)).toEqual([3]);
    expect(filterTeamAwardRows(rows, { award: 'none' }).map((item) => item.teamId)).toEqual([5]);
    expect(filterTeamAwardRows(rows, { award: 'all' })).toHaveLength(3);
  });

  it('按关键字匹配团队名与证书编号', () => {
    expect(filterTeamAwardRows(rows, { keyword: 'beta' }).map((item) => item.teamId)).toEqual([4]);
    expect(filterTeamAwardRows(rows, { keyword: 'T7-5' }).map((item) => item.teamId)).toEqual([5]);
    expect(filterTeamAwardRows(rows, { keyword: '   ' })).toHaveLength(3);
  });
});

describe('buildTeamAwardsCsv', () => {
  it('包含团队列、成员数、AC 与证书编号，并带 UTF-8 BOM', () => {
    const csv = buildTeamAwardsCsv([
      teamRow({ teamName: 'Alpha', memberCount: 3, totalScore: 260, solved: 2 }),
    ]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.replace('\uFEFF', '').trimEnd().split('\r\n');
    expect(lines[0]).toBe('名次,团队,成员数,总分,AC,奖项,证书编号');
    expect(lines[1]).toBe('1,Alpha,3,260,2,金牌,T7-3');
  });

  it('转义逗号、引号与换行，null 奖项输出空字段', () => {
    const csv = buildTeamAwardsCsv([
      teamRow({
        teamName: 'A,B',
        memberCount: 2,
        award: null,
        certificateNo: 'T7-9',
      }),
    ]);
    const body = csv.replace('\uFEFF', '');
    expect(body).toContain('"A,B"');
    expect(body).toContain(',未获奖,T7-9');
  });

  it('空列表只输出表头', () => {
    const csv = buildTeamAwardsCsv([]).replace('\uFEFF', '').trimEnd();
    expect(csv).toBe('名次,团队,成员数,总分,AC,奖项,证书编号');
  });
});
