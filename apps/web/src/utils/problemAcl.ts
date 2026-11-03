import { ApiError } from '../api/client';
import type {
  ProblemGranteeType,
  ProblemOwnerType,
  ProblemSharePermission,
  Role,
  TeamSummary,
} from '../api/types';

/** Problem ACL：归属类型文案。 */
export const PROBLEM_OWNER_TYPE_LABEL: Record<ProblemOwnerType, string> = {
  system: '系统',
  user: '个人',
  team: '团队',
};

/** Problem ACL：分享目标文案。 */
export const PROBLEM_GRANTEE_TYPE_LABEL: Record<ProblemGranteeType, string> = {
  user: '用户',
  team: '团队',
};

/** Problem ACL：分享权限文案。 */
export const PROBLEM_SHARE_PERMISSION_LABEL: Record<ProblemSharePermission, string> = {
  read: '只读',
  edit: '可编辑',
};

export const PROBLEM_OWNER_TYPE_OPTIONS: Array<{ value: ProblemOwnerType; label: string }> = [
  { value: 'user', label: PROBLEM_OWNER_TYPE_LABEL.user },
  { value: 'team', label: PROBLEM_OWNER_TYPE_LABEL.team },
  { value: 'system', label: PROBLEM_OWNER_TYPE_LABEL.system },
];

export const PROBLEM_SHARE_PERMISSION_OPTIONS: Array<{
  value: ProblemSharePermission;
  label: string;
}> = [
  { value: 'read', label: PROBLEM_SHARE_PERMISSION_LABEL.read },
  { value: 'edit', label: PROBLEM_SHARE_PERMISSION_LABEL.edit },
];

/** 归属标签颜色，供管理端表格与详情页复用。 */
export function problemOwnerColor(ownerType: ProblemOwnerType): string {
  switch (ownerType) {
    case 'team':
      return 'purple';
    case 'user':
      return 'blue';
    default:
      return 'default';
  }
}

/**
 * 归属展示文案。
 *
 * 团队名只有在当前用户的 `/api/teams` 结果里才能解析；管理员可能不在团队中，
 * 此时退回显示团队 ID，避免误导。
 */
export function problemOwnerLabel(
  ownerType: ProblemOwnerType,
  ownerId: number | null,
  options: { currentUserId?: number; teamNames?: Map<number, string> } = {},
): string {
  if (ownerType === 'system') return PROBLEM_OWNER_TYPE_LABEL.system;
  if (ownerType === 'team') {
    const name = ownerId === null ? undefined : options.teamNames?.get(ownerId);
    return `团队 · ${name ?? (ownerId === null ? '未指定' : `#${ownerId}`)}`;
  }
  if (ownerId === null) return '个人 · 未指定';
  return ownerId === options.currentUserId
    ? '个人 · 我'
    : `个人 · 用户 #${ownerId}`;
}

export interface ProblemShareManageInput {
  ownerType: ProblemOwnerType;
  ownerId: number | null;
  userId?: number;
  role?: Role;
  /** 当前用户所属团队（GET /api/teams），用于判断队长身份。 */
  teams?: TeamSummary[];
}

/**
 * 是否可管理分享：管理员、个人题所有者、团队题队长。
 *
 * 与后端 `canManageProblemShares` 保持一致；`read` 分享与 `edit` 分享都不能再分享。
 */
export function canManageProblemShares(input: ProblemShareManageInput): boolean {
  const { ownerType, ownerId, userId, role, teams } = input;
  if (userId === undefined) return false;
  if (role === 'admin') return true;
  if (ownerType === 'user') return ownerId === userId;
  if (ownerType === 'team') {
    return (teams ?? []).some((team) => team.id === ownerId && team.role === 'captain');
  }
  return false;
}

/** 题目 ACL 接口错误码 → 中文提示。 */
export function describeProblemAclError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PROBLEM_NOT_FOUND':
        return '题目不存在或无权访问';
      case 'PROBLEM_FORBIDDEN':
        return '没有权限执行该操作：仅题目所有者、团队队长或管理员可管理分享';
      case 'PROBLEM_SHARE_INVALID':
        return '分享对象或权限无效：用户/团队不存在，或不能分享给题目所有者';
      case 'PROBLEM_OWNER_INVALID':
        return '归属无效：用户/团队不存在，或系统题不能指定归属对象';
      case 'NO_FIELDS':
        return '没有需要保存的字段';
      default:
        return error.message || fallback;
    }
  }
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}
