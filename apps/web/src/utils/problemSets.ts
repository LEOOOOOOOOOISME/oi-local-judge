import type { ProblemSetItem, ProblemSetSummary, ProblemSetVisibility } from '../api/types';
import { ApiError } from '../api/client';

/** 题单列表筛选：全部 / 个人 / 团队 / 公开。 */
export type ProblemSetFilter = 'all' | 'personal' | 'team' | 'public';

export const PROBLEM_SET_FILTER_OPTIONS: Array<{ value: ProblemSetFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'personal', label: '个人' },
  { value: 'team', label: '团队' },
  { value: 'public', label: '公开' },
];

export const PROBLEM_SET_VISIBILITY_LABEL: Record<ProblemSetVisibility, string> = {
  private: '私有',
  public: '公开',
};

export function filterProblemSets(
  sets: ProblemSetSummary[],
  filter: ProblemSetFilter,
): ProblemSetSummary[] {
  switch (filter) {
    case 'personal':
      return sets.filter((set) => set.ownerType === 'user');
    case 'team':
      return sets.filter((set) => set.ownerType === 'team');
    case 'public':
      return sets.filter((set) => set.visibility === 'public');
    default:
      return sets;
  }
}

export function problemIdsOf(items: Array<Pick<ProblemSetItem, 'problemId'>>): number[] {
  return items.map((item) => item.problemId);
}

/** 上移/下移一项；越界时返回原顺序（新数组，便于直接 setState）。 */
export function moveProblemSetItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) {
    return items.slice();
  }
  const next = items.slice();
  const current = next[index];
  next[index] = next[target];
  next[target] = current;
  return next;
}

export function isProblemSetOrderDirty(originalIds: number[], currentIds: number[]): boolean {
  return (
    originalIds.length !== currentIds.length ||
    originalIds.some((problemId, index) => problemId !== currentIds[index])
  );
}

/** 题单接口错误码 → 中文提示。 */
export function describeProblemSetError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'SET_NOT_FOUND':
        return '题单不存在或无权访问';
      case 'SET_FORBIDDEN':
        return '没有权限执行该操作';
      case 'SET_TITLE_INVALID':
        return '标题需为 1~100 个字符';
      case 'SET_DESCRIPTION_INVALID':
        return '描述格式无效';
      case 'SET_OWNER_INVALID':
        return '归属无效：团队不存在，或你不是该团队队长';
      case 'SET_VISIBILITY_INVALID':
        return '可见性只能是私有或公开';
      case 'SET_ITEM_EXISTS':
        return '该题目已在题单中';
      case 'SET_ITEM_NOT_FOUND':
        return '题目不存在，或不在题单中';
      case 'SET_ITEM_INVALID':
        return '题目参数无效';
      case 'SET_SHARE_INVALID':
        return '分享对象或权限无效';
      default:
        return error.message || fallback;
    }
  }
  if (error instanceof Error) {
    return error.message || fallback;
  }
  return fallback;
}
