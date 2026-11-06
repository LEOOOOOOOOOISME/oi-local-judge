import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { ClassMember } from '../api/types';
import {
  addableClassRoles,
  canManageClassCoaches,
  canManageClassSettings,
  canManageClassStudents,
  classRoleLabel,
  countClassMembers,
  describeClassError,
  isClassOwner,
} from './classes';

function member(userId: number, role: ClassMember['role'], username = `u${userId}`): ClassMember {
  return {
    userId,
    username,
    realName: null,
    className: null,
    role,
    joinedAt: 0,
  };
}

describe('classRoleLabel', () => {
  it('labels coach, assistant and student roles', () => {
    expect(classRoleLabel('coach')).toBe('教练');
    expect(classRoleLabel('assistant')).toBe('助教');
    expect(classRoleLabel('member')).toBe('学生');
  });
});

describe('addableClassRoles', () => {
  it('lets owners and admins grant the coach role', () => {
    expect(addableClassRoles(true)).toEqual(['member', 'assistant', 'coach']);
  });

  it('limits coaches to students and assistants', () => {
    expect(addableClassRoles(false)).toEqual(['member', 'assistant']);
  });
});

describe('countClassMembers', () => {
  it('counts every role separately', () => {
    const members = [
      member(1, 'coach'),
      member(2, 'coach'),
      member(3, 'assistant'),
      member(4, 'member'),
      member(5, 'member'),
    ];
    expect(countClassMembers(members)).toEqual({
      memberCount: 5,
      coachCount: 2,
      assistantCount: 1,
      studentCount: 2,
    });
  });

  it('returns zeroed counts for an empty roster', () => {
    expect(countClassMembers([])).toEqual({
      memberCount: 0,
      coachCount: 0,
      assistantCount: 0,
      studentCount: 0,
    });
  });
});

describe('isClassOwner', () => {
  it('only matches the current user id', () => {
    expect(isClassOwner({ viewerRole: 'coach', ownerId: 7, currentUserId: 7 })).toBe(true);
    expect(isClassOwner({ viewerRole: 'coach', ownerId: 7, currentUserId: 8 })).toBe(false);
    expect(isClassOwner({ viewerRole: null, ownerId: 7 })).toBe(false);
    expect(isClassOwner({ viewerRole: null, ownerId: 7, currentUserId: null })).toBe(false);
  });
});

describe('canManageClassStudents', () => {
  it('always allows admins', () => {
    expect(
      canManageClassStudents({ viewerRole: null, ownerId: 7, currentUserId: 9, isAdmin: true }),
    ).toBe(true);
  });

  it('allows the class owner even without a coach role flag', () => {
    expect(
      canManageClassStudents({ viewerRole: 'coach', ownerId: 7, currentUserId: 7 }),
    ).toBe(true);
    expect(
      canManageClassStudents({ viewerRole: null, ownerId: 7, currentUserId: 7 }),
    ).toBe(true);
  });

  it('allows coaches, but not assistants, students or outsiders', () => {
    expect(
      canManageClassStudents({ viewerRole: 'coach', ownerId: 7, currentUserId: 8 }),
    ).toBe(true);
    expect(
      canManageClassStudents({ viewerRole: 'assistant', ownerId: 7, currentUserId: 8 }),
    ).toBe(false);
    expect(
      canManageClassStudents({ viewerRole: 'member', ownerId: 7, currentUserId: 8 }),
    ).toBe(false);
    expect(
      canManageClassStudents({ viewerRole: null, ownerId: 7, currentUserId: 8 }),
    ).toBe(false);
  });
});

describe('canManageClassCoaches', () => {
  it('allows admins and the class owner', () => {
    expect(
      canManageClassCoaches({ viewerRole: 'coach', ownerId: 7, currentUserId: 9, isAdmin: true }),
    ).toBe(true);
    expect(
      canManageClassCoaches({ viewerRole: 'coach', ownerId: 7, currentUserId: 7 }),
    ).toBe(true);
  });

  it('rejects non-owner coaches, assistants and students', () => {
    expect(
      canManageClassCoaches({ viewerRole: 'coach', ownerId: 7, currentUserId: 8 }),
    ).toBe(false);
    expect(
      canManageClassCoaches({ viewerRole: 'assistant', ownerId: 7, currentUserId: 8 }),
    ).toBe(false);
    expect(
      canManageClassCoaches({ viewerRole: 'member', ownerId: 7, currentUserId: 8 }),
    ).toBe(false);
  });
});

describe('canManageClassSettings', () => {
  it('allows admins and the class owner', () => {
    expect(
      canManageClassSettings({ viewerRole: null, ownerId: 7, currentUserId: 9, isAdmin: true }),
    ).toBe(true);
    expect(
      canManageClassSettings({ viewerRole: 'coach', ownerId: 7, currentUserId: 7 }),
    ).toBe(true);
  });

  it('rejects other coaches, assistants and students', () => {
    expect(
      canManageClassSettings({ viewerRole: 'coach', ownerId: 7, currentUserId: 8 }),
    ).toBe(false);
    expect(
      canManageClassSettings({ viewerRole: 'assistant', ownerId: 7, currentUserId: 8 }),
    ).toBe(false);
    expect(
      canManageClassSettings({ viewerRole: 'member', ownerId: 7, currentUserId: 8 }),
    ).toBe(false);
    expect(
      canManageClassSettings({ viewerRole: null, ownerId: 7, currentUserId: 8 }),
    ).toBe(false);
  });
});

describe('describeClassError', () => {
  it('translates known class error codes', () => {
    expect(describeClassError(new ApiError(404, 'class not found', 'CLASS_NOT_FOUND'), 'x')).toBe(
      '班级不存在或已被解散',
    );
    expect(describeClassError(new ApiError(403, 'forbidden', 'CLASS_FORBIDDEN'), 'x')).toBe(
      '没有权限执行该操作',
    );
    expect(describeClassError(new ApiError(409, 'exists', 'CLASS_MEMBER_EXISTS'), 'x')).toBe(
      '该用户已经是班级成员',
    );
    expect(describeClassError(new ApiError(409, 'owner', 'CLASS_OWNER_PROTECTED'), 'x')).toBe(
      '班级创建者不能被移出',
    );
    expect(describeClassError(new ApiError(404, 'user', 'USER_NOT_FOUND'), 'x')).toBe(
      '用户名不存在',
    );
    expect(describeClassError(new ApiError(400, 'name', 'TEAM_NAME_INVALID'), 'x')).toBe(
      '班级名称需为 2~40 个字符',
    );
  });

  it('falls back to the server message for unknown codes', () => {
    expect(describeClassError(new ApiError(500, '服务器内部错误', 'BOOM'), 'x')).toBe(
      '服务器内部错误',
    );
  });

  it('handles plain errors and non-errors', () => {
    expect(describeClassError(new Error('网络连接失败'), 'fallback')).toBe('网络连接失败');
    expect(describeClassError('bad', 'fallback')).toBe('fallback');
  });
});
