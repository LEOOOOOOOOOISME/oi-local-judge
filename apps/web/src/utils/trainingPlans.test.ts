import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type {
  AdminGroupSummary,
  ClassSummary,
  TeamSummary,
  TrainingPlanItemProgress,
  TrainingPlanSummary,
} from '../api/types';
import {
  adminGroupOptionLabel,
  adminGroupsPath,
  buildItemProgressMap,
  canSearchAllGroups,
  describeTrainingPlanError,
  filterTrainingPlans,
  isTrainingPlanOrderDirty,
  manageableGroups,
  moveTrainingPlanItem,
  planTimeStatus,
  progressPercent,
  trainingPlanItemIds,
} from './trainingPlans';

function makeClass(overrides: Partial<ClassSummary>): ClassSummary {
  return {
    id: 1,
    name: 'Class A',
    ownerId: 1,
    kind: 'class',
    allowContest: true,
    createdAt: 0,
    memberCount: 1,
    role: 'member',
    ...overrides,
  };
}

function makeTeam(overrides: Partial<TeamSummary>): TeamSummary {
  return {
    id: 10,
    name: 'Team A',
    ownerId: 1,
    createdAt: 0,
    memberCount: 1,
    role: 'member',
    ...overrides,
  };
}

function makeAdminGroup(overrides: Partial<AdminGroupSummary>): AdminGroupSummary {
  return {
    id: 1,
    name: 'Class A',
    kind: 'class',
    ownerId: 1,
    allowContest: true,
    memberCount: 1,
    createdAt: 0,
    ...overrides,
  };
}

function makePlan(overrides: Partial<TrainingPlanSummary>): TrainingPlanSummary {
  return {
    id: 1,
    groupId: 1,
    groupName: 'Class A',
    groupKind: 'class',
    memberCount: 2,
    title: 'Plan',
    description: '',
    startsAt: null,
    endsAt: null,
    createdBy: 1,
    createdAt: 0,
    updatedAt: 0,
    itemCount: 0,
    canManage: false,
    myProgress: {
      itemCount: 0,
      completedCount: 0,
      lateCount: 0,
      overdueCount: 0,
      allCompleted: true,
    },
    ...overrides,
  };
}

function makeProgress(overrides: Partial<TrainingPlanItemProgress>): TrainingPlanItemProgress {
  return {
    itemId: 1,
    problemId: 100,
    ordinal: 1,
    targetScore: 100,
    dueAt: null,
    bestScore: null,
    accepted: false,
    completed: false,
    completedAt: null,
    late: false,
    status: 'pending',
    ...overrides,
  };
}

describe('manageableGroups', () => {
  it('keeps classes the user coaches and teams the user captains', () => {
    const groups = manageableGroups(
      [
        makeClass({ id: 1, name: ' coached ', role: 'coach' }),
        makeClass({ id: 2, name: 'student class', role: 'member' }),
        makeClass({ id: 3, name: 'assistant class', role: 'assistant' }),
      ],
      [
        makeTeam({ id: 10, name: 'captained', role: 'captain' }),
        makeTeam({ id: 11, name: 'joined', role: 'member' }),
      ],
      { currentUserId: 5 },
    );

    expect(groups.map((group) => `${group.kind}:${group.id}`)).toEqual([
      'class:1',
      'team:10',
    ]);
    expect(groups[0]?.label).toMatch(/^班级/);
    expect(groups[1]?.label).toMatch(/^团队/);
  });

  it('keeps groups owned by the user even when the role is stale', () => {
    const groups = manageableGroups(
      [makeClass({ id: 1, ownerId: 9, role: 'member' })],
      [makeTeam({ id: 10, ownerId: 9, role: 'member' })],
      { currentUserId: 9 },
    );

    expect(groups.map((group) => group.id)).toEqual([1, 10]);
  });

  it('lets admins manage every listed group', () => {
    const groups = manageableGroups(
      [makeClass({ id: 1, role: 'member' })],
      [makeTeam({ id: 10, role: 'member' })],
      { currentUserId: 3, isAdmin: true },
    );

    expect(groups.map((group) => group.id)).toEqual([1, 10]);
  });
});

describe('canSearchAllGroups', () => {
  it('is enabled for admins and contest managers only', () => {
    expect(canSearchAllGroups('admin')).toBe(true);
    expect(canSearchAllGroups('contestmanager')).toBe(true);
    expect(canSearchAllGroups('setter')).toBe(false);
    expect(canSearchAllGroups('contestant')).toBe(false);
    expect(canSearchAllGroups(undefined)).toBe(false);
    expect(canSearchAllGroups(null)).toBe(false);
  });
});

describe('adminGroupOptionLabel', () => {
  it('prefixes the group kind', () => {
    expect(adminGroupOptionLabel(makeAdminGroup({ kind: 'class', name: '高一(1)班' }))).toBe(
      '班级 · 高一(1)班',
    );
    expect(adminGroupOptionLabel(makeAdminGroup({ kind: 'team', name: 'Alpha' }))).toBe(
      '团队 · Alpha',
    );
  });
});

describe('adminGroupsPath', () => {
  it('builds the search path with encoded query and optional kind/limit', () => {
    expect(adminGroupsPath({})).toBe('/api/admin/groups');
    expect(adminGroupsPath({ kind: 'class', query: ' alpha ', limit: 20 })).toBe(
      '/api/admin/groups?kind=class&query=alpha&limit=20',
    );
    expect(adminGroupsPath({ query: 'a&b' })).toBe('/api/admin/groups?query=a%26b');
    expect(adminGroupsPath({ query: '  ' })).toBe('/api/admin/groups');
  });
});

describe('progressPercent', () => {
  it('returns 0 for plans without items', () => {
    expect(progressPercent({ itemCount: 0, completedCount: 0 })).toBe(0);
  });

  it('rounds the completed ratio', () => {
    expect(progressPercent({ itemCount: 3, completedCount: 1 })).toBe(33);
    expect(progressPercent({ itemCount: 3, completedCount: 2 })).toBe(67);
  });

  it('caps the percentage at 100', () => {
    expect(progressPercent({ itemCount: 2, completedCount: 5 })).toBe(100);
  });
});

describe('planTimeStatus', () => {
  const now = 1_000_000;

  it('detects unscheduled plans', () => {
    expect(planTimeStatus({ startsAt: null, endsAt: null }, now)).toBe('unscheduled');
  });

  it('detects upcoming plans', () => {
    expect(planTimeStatus({ startsAt: now + 1, endsAt: null }, now)).toBe('upcoming');
  });

  it('detects ongoing plans', () => {
    expect(planTimeStatus({ startsAt: now - 1, endsAt: now + 1 }, now)).toBe('ongoing');
    expect(planTimeStatus({ startsAt: null, endsAt: now + 1 }, now)).toBe('ongoing');
  });

  it('detects ended plans', () => {
    expect(planTimeStatus({ startsAt: now - 2, endsAt: now - 1 }, now)).toBe('ended');
    expect(planTimeStatus({ startsAt: null, endsAt: now - 1 }, now)).toBe('ended');
  });
});

describe('filterTrainingPlans', () => {
  const plans = [
    makePlan({
      id: 1,
      startsAt: 1,
      endsAt: 2,
      myProgress: { itemCount: 2, completedCount: 2, lateCount: 0, overdueCount: 0, allCompleted: true },
    }),
    makePlan({
      id: 2,
      startsAt: 1,
      endsAt: 9_999_999_999,
      myProgress: { itemCount: 2, completedCount: 1, lateCount: 0, overdueCount: 0, allCompleted: false },
    }),
    makePlan({
      id: 3,
      myProgress: { itemCount: 0, completedCount: 0, lateCount: 0, overdueCount: 0, allCompleted: true },
    }),
  ];

  it('returns every plan for the all filter', () => {
    expect(filterTrainingPlans(plans, 'all', 1_000).map((plan) => plan.id)).toEqual([1, 2, 3]);
  });

  it('filters out ended plans for active', () => {
    expect(filterTrainingPlans(plans, 'active', 1_000).map((plan) => plan.id)).toEqual([2, 3]);
  });

  it('only counts plans with items as completed', () => {
    expect(filterTrainingPlans(plans, 'completed', 1_000).map((plan) => plan.id)).toEqual([1]);
  });
});

describe('buildItemProgressMap', () => {
  it('indexes progress by item id', () => {
    const map = buildItemProgressMap([
      makeProgress({ itemId: 7 }),
      makeProgress({ itemId: 9, status: 'completed' }),
    ]);

    expect(map.get(7)?.status).toBe('pending');
    expect(map.get(9)?.status).toBe('completed');
  });
});

describe('moveTrainingPlanItem', () => {
  it('swaps neighbours', () => {
    expect(moveTrainingPlanItem([1, 2, 3], 1, -1)).toEqual([2, 1, 3]);
    expect(moveTrainingPlanItem([1, 2, 3], 1, 1)).toEqual([1, 3, 2]);
  });

  it('returns a copy for out-of-range moves', () => {
    const items = [1, 2, 3];
    const moved = moveTrainingPlanItem(items, 0, -1);
    expect(moved).toEqual([1, 2, 3]);
    expect(moved).not.toBe(items);
  });
});

describe('trainingPlanItemIds / isTrainingPlanOrderDirty', () => {
  it('extracts item ids and compares order', () => {
    const items = [{ id: 3 }, { id: 1 }, { id: 2 }];
    expect(trainingPlanItemIds(items)).toEqual([3, 1, 2]);
    expect(isTrainingPlanOrderDirty([1, 2, 3], [3, 1, 2])).toBe(true);
    expect(isTrainingPlanOrderDirty([3, 1, 2], [3, 1, 2])).toBe(false);
    expect(isTrainingPlanOrderDirty([1, 2, 3], [1, 2])).toBe(true);
  });
});

describe('describeTrainingPlanError', () => {
  it('maps known API error codes', () => {
    expect(
      describeTrainingPlanError(
        new ApiError(403, 'forbidden', 'TRAINING_PLAN_FORBIDDEN'),
        'fallback',
      ),
    ).toBe('没有权限管理该训练计划');
    expect(
      describeTrainingPlanError(
        new ApiError(409, 'exists', 'TRAINING_PLAN_ITEM_EXISTS'),
        'fallback',
      ),
    ).toBe('该题目已在训练计划中');
    expect(
      describeTrainingPlanError(
        new ApiError(400, 'bad time', 'TRAINING_PLAN_TIME_INVALID'),
        'fallback',
      ),
    ).toBe('时间设置无效：截止时间不能早于开始时间');
  });

  it('falls back to the message or fallback text', () => {
    expect(
      describeTrainingPlanError(new ApiError(500, 'boom', 'UNKNOWN'), 'fallback'),
    ).toBe('boom');
    expect(describeTrainingPlanError(new Error('oops'), 'fallback')).toBe('oops');
    expect(describeTrainingPlanError(null, 'fallback')).toBe('fallback');
  });
});
