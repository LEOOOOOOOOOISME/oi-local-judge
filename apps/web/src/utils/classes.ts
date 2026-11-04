import { ApiError } from '../api/client';
import type { ClassMember, ClassRole } from '../api/types';

/** 班级身份展示文案：教练 / 助教 / 学生（后端 role=member）。 */
export const CLASS_ROLE_LABEL: Record<ClassRole, string> = {
  coach: '教练',
  assistant: '助教',
  member: '学生',
};

export const CLASS_ROLE_TAG_COLOR: Record<ClassRole, string> = {
  coach: 'gold',
  assistant: 'purple',
  member: 'blue',
};

/** 添加成员弹窗中的身份选项；每一项最终走的接口不同（教练走 /coaches）。 */
export const CLASS_MEMBER_ROLE_OPTIONS: Array<{ value: ClassRole; label: string }> = [
  { value: 'member', label: CLASS_ROLE_LABEL.member },
  { value: 'assistant', label: CLASS_ROLE_LABEL.assistant },
  { value: 'coach', label: CLASS_ROLE_LABEL.coach },
];

export function classRoleLabel(role: ClassRole): string {
  return CLASS_ROLE_LABEL[role] ?? role;
}

/** 当前用户可授予的身份：添加教练需要班级创建者或管理员权限。 */
export function addableClassRoles(canManageCoaches: boolean): ClassRole[] {
  return canManageCoaches ? ['member', 'assistant', 'coach'] : ['member', 'assistant'];
}

export interface ClassMemberCounts {
  memberCount: number;
  coachCount: number;
  assistantCount: number;
  studentCount: number;
}

/** 教练工作台占位统计：按身份拆分班级成员（member 记为“学生”）。 */
export function countClassMembers(members: ClassMember[]): ClassMemberCounts {
  let coachCount = 0;
  let assistantCount = 0;
  let studentCount = 0;
  for (const member of members) {
    if (member.role === 'coach') {
      coachCount += 1;
    } else if (member.role === 'assistant') {
      assistantCount += 1;
    } else {
      studentCount += 1;
    }
  }
  return {
    memberCount: members.length,
    coachCount,
    assistantCount,
    studentCount,
  };
}

export interface ClassPermissionInput {
  viewerRole: ClassRole | null;
  ownerId: number;
  currentUserId?: number | null;
  isAdmin?: boolean;
}

export function isClassOwner(input: ClassPermissionInput): boolean {
  return input.currentUserId !== null && input.currentUserId !== undefined
    ? input.currentUserId === input.ownerId
    : false;
}

/**
 * 是否可管理班级学生/助教名单。
 *
 * 与后端 `canManageGroup` 对齐：管理员、班级创建者与教练可以添加/移除学生和助教；
 * 助教与学生只能查看。
 */
export function canManageClassStudents(input: ClassPermissionInput): boolean {
  if (input.isAdmin) return true;
  if (isClassOwner(input)) return true;
  return input.viewerRole === 'coach';
}

/**
 * 是否可添加/移除教练。
 *
 * 与后端 `canManageCoaches` 对齐：只有管理员与班级创建者可以；教练之间不能互相管理。
 */
export function canManageClassCoaches(input: ClassPermissionInput): boolean {
  if (input.isAdmin) return true;
  return isClassOwner(input);
}

/** 把班级接口错误码翻译成可读文案；未知错误回退到服务端 message。 */
export function describeClassError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'CLASS_NOT_FOUND':
        return '班级不存在或已被解散';
      case 'CLASS_FORBIDDEN':
      case 'FORBIDDEN':
        return '没有权限执行该操作';
      case 'CLASS_MEMBER_EXISTS':
        return '该用户已经是班级成员';
      case 'CLASS_MEMBER_NOT_FOUND':
        return '该用户不在班级中';
      case 'CLASS_NOT_COACH':
        return '该用户不是班级教练';
      case 'CLASS_OWNER_PROTECTED':
        return '班级创建者不能被移出';
      case 'CLASS_ROLE_INVALID':
        return '成员身份无效';
      case 'TEAM_NAME_TAKEN':
        return '班级名称已被占用，请换一个';
      case 'TEAM_NAME_INVALID':
        return '班级名称需为 2~40 个字符';
      case 'USER_NOT_FOUND':
        return '用户名不存在';
      case 'USER_INACTIVE':
        return '该用户已被停用，无法加入班级';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : fallback;
}
