import { describe, expect, it } from 'vitest';
import type { ProblemSetItem, ProblemSetSummary } from '../api/types';
import { ApiError } from '../api/client';
import {
  describeProblemSetError,
  filterProblemSets,
  isProblemSetOrderDirty,
  moveProblemSetItem,
  problemIdsOf,
} from './problemSets';

function makeSet(overrides: Partial<ProblemSetSummary>): ProblemSetSummary {
  return {
    id: 1,
    title: 'Test',
    description: '',
    ownerType: 'user',
    ownerId: 1,
    visibility: 'private',
    createdBy: 1,
    createdAt: 0,
    updatedAt: 0,
    itemCount: 0,
    canEdit: true,
    canManage: true,
    ...overrides,
  };
}

function makeItem(problemId: number): ProblemSetItem {
  return {
    problemId,
    ordinal: 0,
    addedAt: 0,
    title: `P${problemId}`,
    type: 'standard',
    difficulty: null,
    tags: [],
    timeMs: 1000,
    memoryMb: 256,
  };
}

const sets = [
  makeSet({ id: 1, title: 'personal-private', ownerType: 'user', visibility: 'private' }),
  makeSet({ id: 2, title: 'personal-public', ownerType: 'user', visibility: 'public' }),
  makeSet({ id: 3, title: 'team-private', ownerType: 'team', ownerId: 9, visibility: 'private' }),
  makeSet({ id: 4, title: 'team-public', ownerType: 'team', ownerId: 9, visibility: 'public' }),
];

describe('filterProblemSets', () => {
  it('returns every visible set for the all filter', () => {
    expect(filterProblemSets(sets, 'all').map((set) => set.id)).toEqual([1, 2, 3, 4]);
  });

  it('keeps only personal sets', () => {
    expect(filterProblemSets(sets, 'personal').map((set) => set.id)).toEqual([1, 2]);
  });

  it('keeps only team sets', () => {
    expect(filterProblemSets(sets, 'team').map((set) => set.id)).toEqual([3, 4]);
  });

  it('keeps only public sets', () => {
    expect(filterProblemSets(sets, 'public').map((set) => set.id)).toEqual([2, 4]);
  });
});

describe('moveProblemSetItem', () => {
  const items = [makeItem(10), makeItem(20), makeItem(30)];

  it('moves an item up by swapping neighbours', () => {
    expect(problemIdsOf(moveProblemSetItem(items, 1, -1))).toEqual([20, 10, 30]);
  });

  it('moves an item down by swapping neighbours', () => {
    expect(problemIdsOf(moveProblemSetItem(items, 1, 1))).toEqual([10, 30, 20]);
  });

  it('ignores out-of-range moves and keeps the original order', () => {
    expect(problemIdsOf(moveProblemSetItem(items, 0, -1))).toEqual([10, 20, 30]);
    expect(problemIdsOf(moveProblemSetItem(items, 2, 1))).toEqual([10, 20, 30]);
  });
});

describe('isProblemSetOrderDirty', () => {
  it('is false for an unchanged order', () => {
    expect(isProblemSetOrderDirty([1, 2, 3], [1, 2, 3])).toBe(false);
  });

  it('is true when order or membership changes', () => {
    expect(isProblemSetOrderDirty([1, 2, 3], [2, 1, 3])).toBe(true);
    expect(isProblemSetOrderDirty([1, 2], [1, 2, 3])).toBe(true);
  });
});

describe('describeProblemSetError', () => {
  it('maps known API error codes to Chinese hints', () => {
    expect(describeProblemSetError(new ApiError(403, 'raw', 'SET_FORBIDDEN'), 'fallback')).toBe(
      '没有权限执行该操作',
    );
    expect(describeProblemSetError(new ApiError(409, 'raw', 'SET_ITEM_EXISTS'), 'fallback')).toBe(
      '该题目已在题单中',
    );
    expect(describeProblemSetError(new ApiError(400, 'raw', 'SET_TITLE_INVALID'), 'fallback')).toBe(
      '标题需为 1~100 个字符',
    );
  });

  it('falls back to the server message for unknown codes', () => {
    expect(describeProblemSetError(new ApiError(500, 'boom', 'OTHER'), 'fallback')).toBe('boom');
  });

  it('falls back to the provided text for non-API errors', () => {
    expect(describeProblemSetError(new Error(''), 'fallback')).toBe('fallback');
    expect(describeProblemSetError('nope', 'fallback')).toBe('fallback');
  });
});
