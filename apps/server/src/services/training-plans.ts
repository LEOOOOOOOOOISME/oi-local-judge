import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../storage/db.js';
import { getProblem } from '../storage/repos/problems.js';
import { getTeamMember, getTeamRow } from '../storage/repos/teams.js';
import {
  compactTrainingPlanOrdinals,
  deleteTrainingPlanGraph,
  deleteTrainingPlanItemRow,
  getProblemFullScore,
  getTrainingPlanItemByProblem,
  getTrainingPlanItemRow,
  getTrainingPlanRow,
  insertTrainingPlan,
  insertTrainingPlanItem,
  listAllTrainingPlanRows,
  listTrainingPlanItemIds,
  listTrainingPlanItemRows,
  listTrainingPlanMembers,
  listTrainingPlanProgressSubmissions,
  listTrainingPlanRowsForUser,
  nextTrainingPlanOrdinal,
  touchTrainingPlan,
  updateTrainingPlanItemOrdinal,
  updateTrainingPlanRow,
  type TrainingPlanItemInput,
  type TrainingPlanItemViewRow,
  type TrainingPlanMemberRow,
  type TrainingPlanSubmissionRow,
  type TrainingPlanViewRow,
} from '../storage/repos/training-plans.js';
import { canManageGroup } from './teams.js';

export const TRAINING_PLAN_TITLE_MAX = 200;

export type TrainingPlanItemStatus = 'completed' | 'pending' | 'overdue';

export interface TrainingPlanItemProgress {
  itemId: number;
  problemId: number;
  ordinal: number;
  targetScore: number;
  dueAt: number | null;
  /** Highest score over finished, unhacked practice/contest submissions. */
  bestScore: number | null;
  /** Whether any such submission was AC. */
  accepted: boolean;
  completed: boolean;
  /** When the item was first completed, or null while incomplete. */
  completedAt: number | null;
  /** Completed after its due date; still counts as completed. */
  late: boolean;
  status: TrainingPlanItemStatus;
}

export interface TrainingPlanProgressSummary {
  itemCount: number;
  completedCount: number;
  lateCount: number;
  overdueCount: number;
  allCompleted: boolean;
}

export interface TrainingPlanItemDto {
  id: number;
  problemId: number;
  ordinal: number;
  targetScore: number;
  dueAt: number | null;
  createdAt: number;
  title: string;
  type: string;
  difficulty: number | null;
  tags: string[];
  timeMs: number;
  memoryMb: number;
}

export interface TrainingPlanSummary {
  id: number;
  groupId: number;
  groupName: string;
  groupKind: 'team' | 'class';
  /** Number of members in the target group. */
  memberCount: number;
  title: string;
  description: string;
  startsAt: number | null;
  endsAt: number | null;
  createdBy: number;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
  canManage: boolean;
  myProgress: TrainingPlanProgressSummary;
}

export interface TrainingPlanMemberProgress extends TrainingPlanProgressSummary {
  userId: number;
  username: string;
  realName: string | null;
  className: string | null;
  role: string;
  items: TrainingPlanItemProgress[];
}

export interface TrainingPlanDetail extends TrainingPlanSummary {
  items: TrainingPlanItemDto[];
  myItems: TrainingPlanItemProgress[];
  /** Every member's progress; present only for group managers and platform managers. */
  memberProgress?: TrainingPlanMemberProgress[];
}

export interface TrainingPlanProgress {
  planId: number;
  title: string;
  items: TrainingPlanItemDto[];
  members: TrainingPlanMemberProgress[];
}

export class TrainingPlanError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'TrainingPlanError';
    this.code = code;
    this.status = status;
  }
}

function normalizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new TrainingPlanError('TRAINING_PLAN_TITLE_INVALID', 400, 'title must be a string');
  }
  const title = raw.trim();
  const length = Array.from(title).length;
  if (length < 1 || length > TRAINING_PLAN_TITLE_MAX) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_TITLE_INVALID',
      400,
      `title must be 1-${TRAINING_PLAN_TITLE_MAX} characters`,
    );
  }
  return title;
}

function normalizeDescription(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new TrainingPlanError(
      'TRAINING_PLAN_DESCRIPTION_INVALID',
      400,
      'description must be a string',
    );
  }
  return raw;
}

function normalizeTimestamp(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_TIME_INVALID',
      400,
      `${field} must be a non-negative integer timestamp or null`,
    );
  }
  return raw;
}

function normalizeTargetScore(raw: unknown): number | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_ITEM_INVALID',
      400,
      'targetScore must be a non-negative integer',
    );
  }
  return raw;
}

function assertPlanWindow(startsAt: number | null, endsAt: number | null): void {
  if (startsAt !== null && endsAt !== null && endsAt < startsAt) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_TIME_INVALID',
      400,
      'endsAt must not be earlier than startsAt',
    );
  }
}

function requirePlan(db: DatabaseSync, planId: number): TrainingPlanViewRow {
  const plan = getTrainingPlanRow(db, planId);
  if (!plan) {
    throw new TrainingPlanError('TRAINING_PLAN_NOT_FOUND', 404, 'training plan not found');
  }
  return plan;
}

function requireGroup(db: DatabaseSync, groupId: number) {
  const group = getTeamRow(db, groupId);
  if (!group) {
    throw new TrainingPlanError('TRAINING_PLAN_GROUP_NOT_FOUND', 404, 'group not found');
  }
  return group;
}

/**
 * Only the group owner, its coach/captain and platform managers (admins and
 * contest managers) may manage a plan. `canManageAnyGroup` is the caller's
 * platform-wide flag; every other actor is checked against the target group.
 */
function assertCanManage(
  db: DatabaseSync,
  plan: TrainingPlanViewRow,
  actorId: number,
  canManageAnyGroup: boolean,
): void {
  if (!canManageGroup(db, plan.group_id, actorId, canManageAnyGroup)) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_FORBIDDEN',
      403,
      'you do not have permission to manage this training plan',
    );
  }
}

/** Members of the target group and platform managers may read a plan. */
function canViewPlan(
  db: DatabaseSync,
  plan: TrainingPlanViewRow,
  userId: number,
  canManageAnyGroup: boolean,
): boolean {
  if (canManageAnyGroup) return true;
  if (getTeamMember(db, plan.group_id, userId)) return true;
  return canManageGroup(db, plan.group_id, userId, false);
}

function itemToDto(row: TrainingPlanItemViewRow): TrainingPlanItemDto {
  return {
    id: row.id,
    problemId: row.problem_id,
    ordinal: row.ordinal,
    targetScore: row.target_score,
    dueAt: row.due_at,
    createdAt: row.created_at,
    title: row.title,
    type: row.type,
    difficulty: row.difficulty,
    tags: JSON.parse(row.tags_json) as string[],
    timeMs: row.time_ms,
    memoryMb: row.memory_mb,
  };
}

/**
 * Resolves the raw items of a create request. `targetScore` defaults to the
 * problem's full score (the sum of its enabled testcase points), so a plain
 * "add problem" item means "get full marks".
 */
function resolveItemInputs(
  db: DatabaseSync,
  rawItems: unknown,
): TrainingPlanItemInput[] {
  if (rawItems === undefined || rawItems === null) return [];
  if (!Array.isArray(rawItems)) {
    throw new TrainingPlanError('TRAINING_PLAN_ITEM_INVALID', 400, 'items must be an array');
  }
  const seen = new Set<number>();
  return rawItems.map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new TrainingPlanError('TRAINING_PLAN_ITEM_INVALID', 400, 'item must be an object');
    }
    const item = raw as Record<string, unknown>;
    const problemId = item.problemId;
    if (typeof problemId !== 'number' || !Number.isInteger(problemId) || problemId <= 0) {
      throw new TrainingPlanError(
        'TRAINING_PLAN_ITEM_INVALID',
        400,
        'problemId must be a positive integer',
      );
    }
    if (!getProblem(db, problemId)) {
      throw new TrainingPlanError(
        'TRAINING_PLAN_ITEM_NOT_FOUND',
        404,
        `problem not found: ${problemId}`,
      );
    }
    if (seen.has(problemId)) {
      throw new TrainingPlanError(
        'TRAINING_PLAN_ITEM_EXISTS',
        409,
        `problem is already in this training plan: ${problemId}`,
      );
    }
    seen.add(problemId);
    const targetScore = normalizeTargetScore(item.targetScore) ?? getProblemFullScore(db, problemId);
    const dueAt = normalizeTimestamp(item.dueAt, 'dueAt');
    return { problemId, targetScore, dueAt };
  });
}

export interface CreateTrainingPlanInput {
  groupId: number;
  title: unknown;
  description?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  items?: unknown;
  actorId: number;
  canManageAnyGroup: boolean;
  now?: number;
}

export function createTrainingPlan(db: DatabaseSync, input: CreateTrainingPlanInput): number {
  requireGroup(db, input.groupId);
  if (!canManageGroup(db, input.groupId, input.actorId, input.canManageAnyGroup)) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_FORBIDDEN',
      403,
      'you do not have permission to manage this training plan',
    );
  }
  const title = normalizeTitle(input.title);
  const description = normalizeDescription(input.description ?? '');
  const startsAt = normalizeTimestamp(input.startsAt, 'startsAt');
  const endsAt = normalizeTimestamp(input.endsAt, 'endsAt');
  assertPlanWindow(startsAt, endsAt);
  const items = resolveItemInputs(db, input.items);

  const now = input.now ?? Date.now();
  return transaction(db, () => {
    const planId = insertTrainingPlan(db, {
      groupId: input.groupId,
      title,
      description,
      startsAt,
      endsAt,
      createdBy: input.actorId,
      createdAt: now,
    });
    items.forEach((item, index) => {
      insertTrainingPlanItem(db, {
        planId,
        problemId: item.problemId,
        ordinal: index + 1,
        targetScore: item.targetScore,
        dueAt: item.dueAt,
        createdAt: now,
      });
    });
    return planId;
  });
}

function computeItemProgress(
  item: TrainingPlanItemViewRow,
  rows: TrainingPlanSubmissionRow[],
  now: number,
): TrainingPlanItemProgress {
  let bestScore: number | null = null;
  let accepted = false;
  let completedAt: number | null = null;
  for (const row of rows) {
    if (bestScore === null || row.score > bestScore) bestScore = row.score;
    if (row.verdict === 'AC') accepted = true;
    if (completedAt === null && (row.verdict === 'AC' || row.score >= item.target_score)) {
      completedAt = row.created_at;
    }
  }
  const completed = accepted || (bestScore !== null && bestScore >= item.target_score);
  const late = completed && item.due_at !== null && completedAt !== null && completedAt > item.due_at;
  const status: TrainingPlanItemStatus = completed
    ? 'completed'
    : item.due_at !== null && now > item.due_at
      ? 'overdue'
      : 'pending';
  return {
    itemId: item.id,
    problemId: item.problem_id,
    ordinal: item.ordinal,
    targetScore: item.target_score,
    dueAt: item.due_at,
    bestScore,
    accepted,
    completed,
    completedAt,
    late,
    status,
  };
}

function summarize(items: TrainingPlanItemProgress[]): TrainingPlanProgressSummary {
  const completedCount = items.filter((item) => item.completed).length;
  return {
    itemCount: items.length,
    completedCount,
    lateCount: items.filter((item) => item.completed && item.late).length,
    overdueCount: items.filter((item) => item.status === 'overdue').length,
    allCompleted: completedCount === items.length,
  };
}

function indexSubmissions(
  rows: TrainingPlanSubmissionRow[],
): Map<string, TrainingPlanSubmissionRow[]> {
  const map = new Map<string, TrainingPlanSubmissionRow[]>();
  for (const row of rows) {
    const key = `${row.user_id}:${row.problem_id}`;
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function progressForUser(
  db: DatabaseSync,
  plan: TrainingPlanViewRow,
  items: TrainingPlanItemViewRow[],
  userId: number,
  now: number,
): TrainingPlanItemProgress[] {
  const rows = listTrainingPlanProgressSubmissions(db, {
    userIds: [userId],
    problemIds: items.map((item) => item.problem_id),
  });
  const byKey = indexSubmissions(rows);
  return items.map((item) =>
    computeItemProgress(item, byKey.get(`${userId}:${item.problem_id}`) ?? [], now),
  );
}

function progressForMembers(
  db: DatabaseSync,
  items: TrainingPlanItemViewRow[],
  members: TrainingPlanMemberRow[],
  now: number,
): TrainingPlanMemberProgress[] {
  const rows = listTrainingPlanProgressSubmissions(db, {
    userIds: members.map((member) => member.user_id),
    problemIds: items.map((item) => item.problem_id),
  });
  const byKey = indexSubmissions(rows);
  return members.map((member) => {
    const itemProgress = items.map((item) =>
      computeItemProgress(
        item,
        byKey.get(`${member.user_id}:${item.problem_id}`) ?? [],
        now,
      ),
    );
    return {
      userId: member.user_id,
      username: member.username,
      realName: member.real_name,
      className: member.class_name,
      role: member.role,
      ...summarize(itemProgress),
      items: itemProgress,
    };
  });
}

function toSummary(
  db: DatabaseSync,
  plan: TrainingPlanViewRow,
  userId: number,
  canManageAnyGroup: boolean,
  itemCount: number,
  myProgress: TrainingPlanProgressSummary,
): TrainingPlanSummary {
  return {
    id: plan.id,
    groupId: plan.group_id,
    groupName: plan.group_name,
    groupKind: plan.group_kind,
    memberCount: Number(plan.member_count),
    title: plan.title,
    description: plan.description,
    startsAt: plan.starts_at,
    endsAt: plan.ends_at,
    createdBy: plan.created_by,
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
    itemCount,
    canManage: canManageGroup(db, plan.group_id, userId, canManageAnyGroup),
    myProgress,
  };
}

/** `mine` limits the list to the caller's groups; `all` is platform-manager only. */
export type TrainingPlanListScope = 'mine' | 'all';

export function listTrainingPlans(
  db: DatabaseSync,
  input: {
    userId: number;
    canManageAnyGroup?: boolean;
    scope?: TrainingPlanListScope;
    now?: number;
  },
): TrainingPlanSummary[] {
  const now = input.now ?? Date.now();
  const canManageAnyGroup = input.canManageAnyGroup ?? false;
  // Managers default to the platform-wide list; everyone else only sees their groups.
  const scope = input.scope ?? (canManageAnyGroup ? 'all' : 'mine');
  if (scope === 'all' && !canManageAnyGroup) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_SCOPE_FORBIDDEN',
      403,
      'only platform managers may list every training plan',
    );
  }
  const rows =
    scope === 'all'
      ? listAllTrainingPlanRows(db)
      : listTrainingPlanRowsForUser(db, input.userId);
  return rows.map((plan) => {
    const items = listTrainingPlanItemRows(db, plan.id);
    const myItems = progressForUser(db, plan, items, input.userId, now);
    return toSummary(
      db,
      plan,
      input.userId,
      canManageAnyGroup,
      items.length,
      summarize(myItems),
    );
  });
}

export function getTrainingPlan(
  db: DatabaseSync,
  input: { planId: number; userId: number; canManageAnyGroup: boolean; now?: number },
): TrainingPlanDetail | null {
  const plan = getTrainingPlanRow(db, input.planId);
  if (!plan) return null;
  if (!canViewPlan(db, plan, input.userId, input.canManageAnyGroup)) return null;
  const now = input.now ?? Date.now();
  const itemRows = listTrainingPlanItemRows(db, plan.id);
  const myItems = progressForUser(db, plan, itemRows, input.userId, now);
  const canManage = canManageGroup(db, plan.group_id, input.userId, input.canManageAnyGroup);
  const detail: TrainingPlanDetail = {
    ...toSummary(
      db,
      plan,
      input.userId,
      input.canManageAnyGroup,
      itemRows.length,
      summarize(myItems),
    ),
    items: itemRows.map(itemToDto),
    myItems,
  };
  if (canManage) {
    detail.memberProgress = progressForMembers(
      db,
      itemRows,
      listTrainingPlanMembers(db, plan.id),
      now,
    );
  }
  return detail;
}

export interface UpdateTrainingPlanPatch {
  title?: unknown;
  description?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
}

export function updateTrainingPlan(
  db: DatabaseSync,
  input: {
    planId: number;
    actorId: number;
    canManageAnyGroup: boolean;
    patch: UpdateTrainingPlanPatch;
    now?: number;
  },
): void {
  const plan = requirePlan(db, input.planId);
  assertCanManage(db, plan, input.actorId, input.canManageAnyGroup);

  const patch: {
    title?: string;
    description?: string;
    startsAt?: number | null;
    endsAt?: number | null;
  } = {};
  if (input.patch.title !== undefined) patch.title = normalizeTitle(input.patch.title);
  if (input.patch.description !== undefined) {
    patch.description = normalizeDescription(input.patch.description);
  }
  if (input.patch.startsAt !== undefined) {
    patch.startsAt = normalizeTimestamp(input.patch.startsAt, 'startsAt');
  }
  if (input.patch.endsAt !== undefined) {
    patch.endsAt = normalizeTimestamp(input.patch.endsAt, 'endsAt');
  }
  if (Object.keys(patch).length === 0) return;

  const startsAt = patch.startsAt !== undefined ? patch.startsAt : plan.starts_at;
  const endsAt = patch.endsAt !== undefined ? patch.endsAt : plan.ends_at;
  assertPlanWindow(startsAt, endsAt);

  transaction(db, () => {
    updateTrainingPlanRow(db, input.planId, patch, input.now ?? Date.now());
  });
}

export function deleteTrainingPlan(
  db: DatabaseSync,
  input: { planId: number; actorId: number; canManageAnyGroup: boolean },
): void {
  const plan = requirePlan(db, input.planId);
  assertCanManage(db, plan, input.actorId, input.canManageAnyGroup);
  transaction(db, () => {
    deleteTrainingPlanGraph(db, input.planId);
  });
}

export function addTrainingPlanItem(
  db: DatabaseSync,
  input: {
    planId: number;
    actorId: number;
    canManageAnyGroup: boolean;
    problemId: unknown;
    targetScore?: unknown;
    dueAt?: unknown;
    now?: number;
  },
): number {
  const plan = requirePlan(db, input.planId);
  assertCanManage(db, plan, input.actorId, input.canManageAnyGroup);

  const problemId = input.problemId;
  if (typeof problemId !== 'number' || !Number.isInteger(problemId) || problemId <= 0) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_ITEM_INVALID',
      400,
      'problemId must be a positive integer',
    );
  }
  if (!getProblem(db, problemId)) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_ITEM_NOT_FOUND',
      404,
      `problem not found: ${problemId}`,
    );
  }
  if (getTrainingPlanItemByProblem(db, input.planId, problemId)) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_ITEM_EXISTS',
      409,
      'problem is already in this training plan',
    );
  }
  const targetScore = normalizeTargetScore(input.targetScore) ?? getProblemFullScore(db, problemId);
  const dueAt = normalizeTimestamp(input.dueAt, 'dueAt');
  const now = input.now ?? Date.now();
  return transaction(db, () => {
    const itemId = insertTrainingPlanItem(db, {
      planId: input.planId,
      problemId,
      ordinal: nextTrainingPlanOrdinal(db, input.planId),
      targetScore,
      dueAt,
      createdAt: now,
    });
    touchTrainingPlan(db, input.planId, now);
    return itemId;
  });
}

export function removeTrainingPlanItem(
  db: DatabaseSync,
  input: {
    planId: number;
    itemId: number;
    actorId: number;
    canManageAnyGroup: boolean;
    now?: number;
  },
): void {
  const plan = requirePlan(db, input.planId);
  assertCanManage(db, plan, input.actorId, input.canManageAnyGroup);
  if (!getTrainingPlanItemRow(db, input.planId, input.itemId)) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_ITEM_NOT_FOUND',
      404,
      'item not found in this training plan',
    );
  }
  transaction(db, () => {
    deleteTrainingPlanItemRow(db, input.planId, input.itemId);
    compactTrainingPlanOrdinals(db, input.planId);
    touchTrainingPlan(db, input.planId, input.now ?? Date.now());
  });
}

export function reorderTrainingPlanItems(
  db: DatabaseSync,
  input: {
    planId: number;
    itemIds: unknown;
    actorId: number;
    canManageAnyGroup: boolean;
    now?: number;
  },
): void {
  const plan = requirePlan(db, input.planId);
  assertCanManage(db, plan, input.actorId, input.canManageAnyGroup);

  if (!Array.isArray(input.itemIds)) {
    throw new TrainingPlanError('TRAINING_PLAN_ITEM_INVALID', 400, 'itemIds must be an array');
  }
  const itemIds = input.itemIds;
  if (itemIds.some((itemId) => typeof itemId !== 'number' || !Number.isInteger(itemId) || itemId <= 0)) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_ITEM_INVALID',
      400,
      'itemIds must contain positive integers',
    );
  }
  if (new Set(itemIds).size !== itemIds.length) {
    throw new TrainingPlanError('TRAINING_PLAN_ITEM_INVALID', 400, 'itemIds contains duplicates');
  }

  const existing = listTrainingPlanItemIds(db, input.planId);
  const existingSet = new Set(existing);
  const unknown = itemIds.filter((itemId) => !existingSet.has(itemId));
  if (unknown.length > 0) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_ITEM_NOT_FOUND',
      404,
      `item is not in this training plan: ${unknown.join(', ')}`,
    );
  }
  if (itemIds.length !== existing.length) {
    throw new TrainingPlanError(
      'TRAINING_PLAN_ITEM_INVALID',
      400,
      'itemIds must include every item in the training plan',
    );
  }

  transaction(db, () => {
    itemIds.forEach((itemId, index) => {
      updateTrainingPlanItemOrdinal(db, input.planId, itemId, index + 1);
    });
    touchTrainingPlan(db, input.planId, input.now ?? Date.now());
  });
}

export function getTrainingPlanProgress(
  db: DatabaseSync,
  input: { planId: number; actorId: number; canManageAnyGroup: boolean; now?: number },
): TrainingPlanProgress {
  const plan = requirePlan(db, input.planId);
  assertCanManage(db, plan, input.actorId, input.canManageAnyGroup);
  const itemRows = listTrainingPlanItemRows(db, plan.id);
  const members = progressForMembers(
    db,
    itemRows,
    listTrainingPlanMembers(db, plan.id),
    input.now ?? Date.now(),
  );
  return {
    planId: plan.id,
    title: plan.title,
    items: itemRows.map(itemToDto),
    members,
  };
}
