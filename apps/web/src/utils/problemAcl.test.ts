import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { TeamSummary } from '../api/types';
import {
  canManageProblemShares,
  describeProblemAclError,
  problemOwnerLabel,
} from './problemAcl';

function team(id: number, role: TeamSummary['role']): TeamSummary {
  return {
    id,
    name: `Team ${id}`,
    ownerId: 99,
    createdAt: 0,
    memberCount: 1,
    role,
  };
}

describe('problemOwnerLabel', () => {
  it('labels system-owned problems without an owner id', () => {
    expect(problemOwnerLabel('system', null)).toBe('系统');
  });

  it('labels personal owners and resolves the current user', () => {
    expect(problemOwnerLabel('user', 7)).toBe('个人 · 用户 #7');
    expect(problemOwnerLabel('user', 7, { currentUserId: 7 })).toBe('个人 · 我');
  });

  it('uses team names when available and falls back to the team id', () => {
    const teamNames = new Map([[3, 'Alpha']]);
    expect(problemOwnerLabel('team', 3, { teamNames })).toBe('团队 · Alpha');
    expect(problemOwnerLabel('team', 4, { teamNames })).toBe('团队 · #4');
  });
});

describe('canManageProblemShares', () => {
  it('allows admins for any problem', () => {
    expect(
      canManageProblemShares({
        ownerType: 'system',
        ownerId: null,
        userId: 1,
        role: 'admin',
      }),
    ).toBe(true);
  });

  it('allows personal owners only', () => {
    expect(
      canManageProblemShares({ ownerType: 'user', ownerId: 5, userId: 5 }),
    ).toBe(true);
    expect(
      canManageProblemShares({ ownerType: 'user', ownerId: 5, userId: 6 }),
    ).toBe(false);
  });

  it('allows team captains and rejects plain members', () => {
    const teams = [team(1, 'captain'), team(2, 'member')];
    expect(
      canManageProblemShares({ ownerType: 'team', ownerId: 1, userId: 5, teams }),
    ).toBe(true);
    expect(
      canManageProblemShares({ ownerType: 'team', ownerId: 2, userId: 5, teams }),
    ).toBe(false);
    expect(
      canManageProblemShares({ ownerType: 'team', ownerId: 3, userId: 5, teams }),
    ).toBe(false);
  });

  it('rejects anonymous actors and system problems for non-admins', () => {
    expect(canManageProblemShares({ ownerType: 'user', ownerId: 5 })).toBe(false);
    expect(
      canManageProblemShares({ ownerType: 'system', ownerId: null, userId: 5 }),
    ).toBe(false);
  });
});

describe('describeProblemAclError', () => {
  it('maps known ACL error codes', () => {
    expect(
      describeProblemAclError(new ApiError(403, 'raw', 'PROBLEM_FORBIDDEN'), 'fallback'),
    ).toContain('没有权限');
    expect(
      describeProblemAclError(new ApiError(400, 'raw', 'PROBLEM_SHARE_INVALID'), 'fallback'),
    ).toContain('分享对象');
    expect(
      describeProblemAclError(new ApiError(400, 'raw', 'PROBLEM_OWNER_INVALID'), 'fallback'),
    ).toContain('归属');
  });

  it('falls back to the server message or provided text', () => {
    expect(
      describeProblemAclError(new ApiError(500, 'boom', 'OTHER'), 'fallback'),
    ).toBe('boom');
    expect(describeProblemAclError(new Error(''), 'fallback')).toBe('fallback');
    expect(describeProblemAclError('nope', 'fallback')).toBe('fallback');
  });
});
