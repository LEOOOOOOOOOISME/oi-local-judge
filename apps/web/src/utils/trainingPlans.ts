import { ApiError } from '../api/client';
import type {
  AdminGroupSummary,
  ClassSummary,
  Role,
  TeamSummary,
  TrainingPlanGroupKind,
  TrainingPlanItem,
  TrainingPlanItemProgress,
  TrainingPlanItemStatus,
  TrainingPlanProgressSummary,
  TrainingPlanSummary,
} from '../api/types';

/** 训练计划列表筛选：全部 / 进行中 / 已完成。 */
export type TrainingPlanFilter = 'all' | 'active' | 'completed';

export const TRAINING_PLAN_FILTER_OPTIONS: Array<{ value: TrainingPlanFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '进行中' },
  { value: 'completed', label: '已完成' },
];

export const TRAINING_PLAN_GROUP_KIND_LABEL: Record<TrainingPlanGroupKind, string> = {
  class: '班级',
  team: '团队',
};

export const TRAINING_PLAN_ITEM_STATUS_LABEL: Record<TrainingPlanItemStatus, string> = {
  completed: '已完成',
  pending: '进行中',
  overdue: '已逾期',
};

export const TRAINING_PLAN_ITEM_STATUS_COLOR: Record<TrainingPlanItemStatus, string> = {
  completed: 'green',
  pending: 'blue',
  overdue: 'red',
};

/** 计划整体时间状态（由起止时间推导，与完成度无关）。 */
export type TrainingPlanTimeStatus = 'unscheduled' | 'upcoming' | 'ongoing' | 'ended';

export const TRAINING_PLAN_TIME_STATUS_LABEL: Record<TrainingPlanTimeStatus, string> = {
  unscheduled: '未设置时间',
  upcoming: '未开始',
  ongoing: '进行中',
  ended: '已结束',
};

export const TRAINING_PLAN_TIME_STATUS_COLOR: Record<TrainingPlanTimeStatus, string> = {
  unscheduled: 'default',
  upcoming: 'blue',
  ongoing: 'green',
  ended: 'default',
};

/** 成员在班级/团队中的身份（成员进度的 role 字段为后端原始字符串）。 */
export const TRAINING_PLAN_MEMBER_ROLE_LABEL: Record<string, string> = {
  captain: '队长',
  coach: '教练',
  assistant: '助教',
  member: '成员',
};

export interface TrainingPlanGroupOption {
  id: number;
  name: string;
  kind: TrainingPlanGroupKind;
  label: string;
}

/**
 * 当前用户可管理的班级/团队。
 *
 * 与后端 `canManageGroup` 对齐：管理员可管理全部；班级看 coach（或创建者），
 * 团队看 captain（或所有者）。只使用 `/api/classes` 与 `/api/teams` 返回的
 * “我加入的组”，不会把当前用户不可管理的组放进创建弹窗。
 */
export function manageableGroups(
  classes: ClassSummary[],
  teams: TeamSummary[],
  options: { currentUserId?: number | null; isAdmin?: boolean } = {},
): TrainingPlanGroupOption[] {
  const currentUserId = options.currentUserId ?? null;
  const isAdmin = options.isAdmin ?? false;
  const isOwner = (ownerId: number) => currentUserId !== null && ownerId === currentUserId;

  const classGroups = classes
    .filter((item) => isAdmin || item.role === 'coach' || isOwner(item.ownerId))
    .map((item) => ({
      id: item.id,
      name: item.name,
      kind: 'class' as const,
      label: `${TRAINING_PLAN_GROUP_KIND_LABEL.class} · ${item.name}`,
    }));
  const teamGroups = teams
    .filter((item) => isAdmin || item.role === 'captain' || isOwner(item.ownerId))
    .map((item) => ({
      id: item.id,
      name: item.name,
      kind: 'team' as const,
      label: `${TRAINING_PLAN_GROUP_KIND_LABEL.team} · ${item.name}`,
    }));
  return [...classGroups, ...teamGroups];
}

/**
 * 管理员/比赛管理员可搜索全量班级与团队。
 *
 * 与后端 `GET /api/admin/groups` 的守卫保持一致；普通教练/队长仍然只使用
 * `/api/classes` 与 `/api/teams` 返回的“我可管理的组”。
 */
export function canSearchAllGroups(role: Role | undefined | null): boolean {
  return role === 'admin' || role === 'contestmanager';
}

/** 全量组搜索结果的展示标签，例如“班级 · 高一(1)班”。 */
export function adminGroupOptionLabel(
  group: Pick<AdminGroupSummary, 'kind' | 'name'>,
): string {
  return `${TRAINING_PLAN_GROUP_KIND_LABEL[group.kind]} · ${group.name}`;
}

/** 构造 `GET /api/admin/groups` 的路径；`query` 会做 URL 编码。 */
export function adminGroupsPath(params: {
  kind?: TrainingPlanGroupKind;
  query?: string;
  limit?: number;
}): string {
  const search = new URLSearchParams();
  if (params.kind !== undefined) search.set('kind', params.kind);
  const query = params.query?.trim() ?? '';
  if (query !== '') search.set('query', query);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  const suffix = search.toString();
  return suffix === '' ? '/api/admin/groups' : `/api/admin/groups?${suffix}`;
}

/** 完成度百分比（0~100，四舍五入）；没有题目时为 0。 */
export function progressPercent(
  summary: Pick<TrainingPlanProgressSummary, 'itemCount' | 'completedCount'>,
): number {
  if (summary.itemCount <= 0) return 0;
  const percent = (summary.completedCount / summary.itemCount) * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** 由起止时间推导计划的时间状态；两端都可空。 */
export function planTimeStatus(
  plan: Pick<TrainingPlanSummary, 'startsAt' | 'endsAt'>,
  now = Date.now(),
): TrainingPlanTimeStatus {
  if (plan.startsAt === null && plan.endsAt === null) return 'unscheduled';
  if (plan.startsAt !== null && now < plan.startsAt) return 'upcoming';
  if (plan.endsAt !== null && now > plan.endsAt) return 'ended';
  return 'ongoing';
}

export function filterTrainingPlans(
  plans: TrainingPlanSummary[],
  filter: TrainingPlanFilter,
  now = Date.now(),
): TrainingPlanSummary[] {
  switch (filter) {
    case 'active':
      return plans.filter((plan) => planTimeStatus(plan, now) !== 'ended');
    case 'completed':
      return plans.filter(
        (plan) => plan.myProgress.itemCount > 0 && plan.myProgress.allCompleted,
      );
    default:
      return plans;
  }
}

/** itemId → 我的进度；供题目表按 itemId 对齐展示。 */
export function buildItemProgressMap(
  items: TrainingPlanItemProgress[],
): Map<number, TrainingPlanItemProgress> {
  return new Map(items.map((item) => [item.itemId, item]));
}

/** 上移/下移一项；越界时返回原顺序（新数组，便于直接 setState）。 */
export function moveTrainingPlanItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
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

export function trainingPlanItemIds(items: Array<Pick<TrainingPlanItem, 'id'>>): number[] {
  return items.map((item) => item.id);
}

export function isTrainingPlanOrderDirty(
  originalIds: number[],
  currentIds: number[],
): boolean {
  return (
    originalIds.length !== currentIds.length ||
    originalIds.some((itemId, index) => itemId !== currentIds[index])
  );
}

/** 训练计划接口错误码 → 中文提示。 */
export function describeTrainingPlanError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'TRAINING_PLAN_NOT_FOUND':
        return '训练计划不存在或无权访问';
      case 'TRAINING_PLAN_FORBIDDEN':
        return '没有权限管理该训练计划';
      case 'TRAINING_PLAN_GROUP_INVALID':
        return '请选择班级或团队';
      case 'TRAINING_PLAN_GROUP_NOT_FOUND':
        return '班级或团队不存在';
      case 'TRAINING_PLAN_TITLE_INVALID':
        return '标题需为 1~200 个字符';
      case 'TRAINING_PLAN_DESCRIPTION_INVALID':
        return '描述格式无效';
      case 'TRAINING_PLAN_TIME_INVALID':
        return '时间设置无效：截止时间不能早于开始时间';
      case 'TRAINING_PLAN_ITEM_INVALID':
        return '题目参数无效：请检查题目 ID、目标分与截止时间';
      case 'TRAINING_PLAN_ITEM_NOT_FOUND':
        return '题目不存在，或不在该训练计划中';
      case 'TRAINING_PLAN_ITEM_EXISTS':
        return '该题目已在训练计划中';
      default:
        return error.message || fallback;
    }
  }
  if (error instanceof Error) {
    return error.message || fallback;
  }
  return fallback;
}
