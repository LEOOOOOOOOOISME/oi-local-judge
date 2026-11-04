import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { StudentTagStat } from '../api/types';
import {
  canViewClassLearning,
  describeInactive,
  describeLearningError,
  formatPercent,
  inactiveDays,
  parseClassId,
  sortTagsByMastery,
  studentLearningPath,
  studentStatsPath,
  studentWrongProblemsPath,
  tagMasteryRate,
  trainingPlansPath,
} from './learning';

function tag(
  name: string,
  solved: number,
  totalProblems: number,
  attempts = totalProblems,
): StudentTagStat {
  return { tag: name, solved, totalProblems, attempts, lastAttemptAt: 0 };
}

describe('parseClassId', () => {
  it('accepts positive integers only', () => {
    expect(parseClassId('12')).toBe(12);
    expect(parseClassId('0')).toBeUndefined();
    expect(parseClassId('-3')).toBeUndefined();
    expect(parseClassId('1.5')).toBeUndefined();
    expect(parseClassId('abc')).toBeUndefined();
    expect(parseClassId(null)).toBeUndefined();
    expect(parseClassId(undefined)).toBeUndefined();
    expect(parseClassId('')).toBeUndefined();
  });
});

describe('path builders', () => {
  it('builds student stats paths with and without a class scope', () => {
    expect(studentStatsPath(7, { includeContest: true })).toBe(
      '/api/students/7/stats?includeContest=true',
    );
    expect(studentStatsPath(7, { includeContest: false, classId: 3 })).toBe(
      '/api/students/7/stats?includeContest=false&classId=3',
    );
  });

  it('builds wrong-problem paths with the mode and scope', () => {
    expect(
      studentWrongProblemsPath(7, { mode: 'never-ac', includeContest: true }),
    ).toBe('/api/students/7/wrong-problems?mode=never-ac&includeContest=true');
    expect(
      studentWrongProblemsPath(7, {
        mode: 'latest-wrong',
        includeContest: false,
        classId: 3,
      }),
    ).toBe('/api/students/7/wrong-problems?mode=latest-wrong&includeContest=false&classId=3');
  });

  it('builds the learning page and training plan paths', () => {
    expect(studentLearningPath(7)).toBe('/students/7/learning');
    expect(studentLearningPath(7, 3)).toBe('/students/7/learning?classId=3');
    expect(studentLearningPath(7, null)).toBe('/students/7/learning');
    expect(trainingPlansPath(3)).toBe('/training-plans?classId=3');
  });
});

describe('tagMasteryRate', () => {
  it('computes solved over practiced problems', () => {
    expect(tagMasteryRate({ solved: 2, totalProblems: 4 })).toBe(0.5);
    expect(tagMasteryRate({ solved: 0, totalProblems: 5 })).toBe(0);
    expect(tagMasteryRate({ solved: 5, totalProblems: 5 })).toBe(1);
  });

  it('returns zero for empty or invalid totals', () => {
    expect(tagMasteryRate({ solved: 0, totalProblems: 0 })).toBe(0);
    expect(tagMasteryRate({ solved: 1, totalProblems: -1 })).toBe(0);
    expect(tagMasteryRate({ solved: 1, totalProblems: Number.NaN })).toBe(0);
  });
});

describe('formatPercent', () => {
  it('formats and clamps ratios', () => {
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(0.333, 1)).toBe('33.3%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(1.5)).toBe('100%');
    expect(formatPercent(-1)).toBe('0%');
  });

  it('renders invalid values as a dash', () => {
    expect(formatPercent(Number.NaN)).toBe('—');
  });
});

describe('inactiveDays / describeInactive', () => {
  const now = Date.UTC(2026, 0, 20, 12, 0, 0);
  const day = 24 * 60 * 60 * 1000;

  it('counts whole days since the last submission', () => {
    expect(inactiveDays(now, now)).toBe(0);
    expect(inactiveDays(now - day, now)).toBe(1);
    expect(inactiveDays(now - 15 * day, now)).toBe(15);
    expect(inactiveDays(null, now)).toBeNull();
  });

  it('describes never-submitted and recently active members', () => {
    expect(describeInactive(null, now)).toBe('从未提交');
    expect(describeInactive(now, now)).toBe('今天活跃');
    expect(describeInactive(now - 3 * day, now)).toBe('3 天未提交');
    expect(describeInactive(now - 20 * day, now)).toBe('20 天未提交');
  });
});

describe('canViewClassLearning', () => {
  it('allows admins and class coaches only', () => {
    expect(canViewClassLearning({ viewerRole: null, isAdmin: true })).toBe(true);
    expect(canViewClassLearning({ viewerRole: 'coach' })).toBe(true);
    expect(canViewClassLearning({ viewerRole: 'assistant' })).toBe(false);
    expect(canViewClassLearning({ viewerRole: 'member' })).toBe(false);
    expect(canViewClassLearning({ viewerRole: null })).toBe(false);
  });
});

describe('sortTagsByMastery', () => {
  it('puts the weakest tags first, then the most attempted', () => {
    const sorted = sortTagsByMastery([
      tag('dp', 3, 4),
      tag('graph', 0, 2),
      tag('greedy', 1, 4),
      tag('math', 1, 4, 9),
    ]);
    expect(sorted.map((entry) => entry.tag)).toEqual(['graph', 'math', 'greedy', 'dp']);
  });

  it('does not mutate the input array', () => {
    const input = [tag('b', 1, 2), tag('a', 0, 1)];
    const copy = [...input];
    sortTagsByMastery(input);
    expect(input).toEqual(copy);
  });
});

describe('describeLearningError', () => {
  it('translates known learning-stat codes', () => {
    expect(describeLearningError(new ApiError(403, 'forbidden', 'STUDENT_FORBIDDEN'), 'x')).toBe(
      '只有学生本人、班级教练或管理员可以查看学习统计',
    );
    expect(describeLearningError(new ApiError(403, 'forbidden', 'CLASS_FORBIDDEN'), 'x')).toBe(
      '只有班级教练或管理员可以查看班级学习统计',
    );
    expect(describeLearningError(new ApiError(404, 'gone', 'STUDENT_NOT_IN_CLASS'), 'x')).toBe(
      '该学生不在当前班级中',
    );
    expect(describeLearningError(new ApiError(404, 'gone', 'CLASS_NOT_FOUND'), 'x')).toBe(
      '班级不存在或已被解散',
    );
    expect(describeLearningError(new ApiError(404, 'gone', 'STUDENT_NOT_FOUND'), 'x')).toBe(
      '学生不存在',
    );
    expect(describeLearningError(new ApiError(400, 'bad', 'BAD_REQUEST'), 'x')).toBe(
      '查询参数有误',
    );
  });

  it('falls back to the server message or the provided fallback', () => {
    expect(describeLearningError(new ApiError(500, '服务器内部错误', 'BOOM'), 'x')).toBe(
      '服务器内部错误',
    );
    expect(describeLearningError(new Error('网络连接失败'), 'fallback')).toBe('网络连接失败');
    expect(describeLearningError('bad', 'fallback')).toBe('fallback');
  });
});
