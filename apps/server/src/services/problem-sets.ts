import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../storage/db.js';
import { getProblem } from '../storage/repos/problems.js';
import { getUserById } from '../storage/repos/users.js';
import { getTeamMember, getTeamRow } from '../storage/repos/teams.js';
import {
  countProblemSetItems,
  deleteProblemSetGraph,
  deleteProblemSetItemRow,
  deleteProblemSetShareRow,
  getEffectiveProblemSetShare,
  getProblemSetItemRow,
  getProblemSetRow,
  getProblemSetShareRow,
  insertProblemSet,
  insertProblemSetItem,
  listProblemSetItemRows,
  listProblemSetProblemIds,
  listProblemSetRowsForUser,
  listProblemSetShareRows,
  nextProblemSetOrdinal,
  touchProblemSet,
  updateProblemSetItemOrdinal,
  updateProblemSetRow,
  upsertProblemSetShare,
  type ProblemSetGranteeType,
  type ProblemSetOwnerType,
  type ProblemSetRow,
  type ProblemSetSharePermission,
  type ProblemSetVisibility,
} from '../storage/repos/problem-sets.js';

export type {
  ProblemSetGranteeType,
  ProblemSetOwnerType,
  ProblemSetSharePermission,
  ProblemSetVisibility,
};

export interface ProblemSetItemDto {
  problemId: number;
  ordinal: number;
  addedAt: number;
  title: string;
  type: string;
  difficulty: number | null;
  tags: string[];
  timeMs: number;
  memoryMb: number;
}

export interface ProblemSetShareDto {
  granteeType: ProblemSetGranteeType;
  granteeId: number;
  permission: ProblemSetSharePermission;
  createdBy: number;
  createdAt: number;
}

export interface ProblemSetSummary {
  id: number;
  title: string;
  description: string;
  ownerType: ProblemSetOwnerType;
  ownerId: number;
  visibility: ProblemSetVisibility;
  createdBy: number;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
  canEdit: boolean;
  canManage: boolean;
}

export interface ProblemSetDetail extends ProblemSetSummary {
  items: ProblemSetItemDto[];
  shares: ProblemSetShareDto[];
}

export class ProblemSetError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ProblemSetError';
    this.code = code;
    this.status = status;
  }
}

export const PROBLEM_SET_TITLE_MAX = 100;

interface ProblemSetAccess {
  canView: boolean;
  canEdit: boolean;
  canManage: boolean;
}

function normalizeTitle(raw: string): string {
  if (typeof raw !== 'string') {
    throw new ProblemSetError('SET_TITLE_INVALID', 400, 'title must be a string');
  }
  const title = raw.trim();
  const length = Array.from(title).length;
  if (length < 1 || length > PROBLEM_SET_TITLE_MAX) {
    throw new ProblemSetError(
      'SET_TITLE_INVALID',
      400,
      `title must be 1-${PROBLEM_SET_TITLE_MAX} characters`,
    );
  }
  return title;
}

function normalizeDescription(raw: string): string {
  if (typeof raw !== 'string') {
    throw new ProblemSetError('SET_DESCRIPTION_INVALID', 400, 'description must be a string');
  }
  return raw;
}

function assertOwnerType(value: string): asserts value is ProblemSetOwnerType {
  if (value !== 'user' && value !== 'team') {
    throw new ProblemSetError('SET_OWNER_INVALID', 400, 'ownerType must be user or team');
  }
}

function assertVisibility(value: string): asserts value is ProblemSetVisibility {
  if (value !== 'private' && value !== 'public') {
    throw new ProblemSetError(
      'SET_VISIBILITY_INVALID',
      400,
      'visibility must be private or public',
    );
  }
}

function assertGranteeType(value: string): asserts value is ProblemSetGranteeType {
  if (value !== 'user' && value !== 'team') {
    throw new ProblemSetError('SET_SHARE_INVALID', 400, 'granteeType must be user or team');
  }
}

function assertSharePermission(value: string): asserts value is ProblemSetSharePermission {
  if (value !== 'read' && value !== 'edit') {
    throw new ProblemSetError('SET_SHARE_INVALID', 400, 'permission must be read or edit');
  }
}

function requireProblemSet(db: DatabaseSync, setId: number): ProblemSetRow {
  const row = getProblemSetRow(db, setId);
  if (!row) {
    throw new ProblemSetError('SET_NOT_FOUND', 404, 'problem set not found');
  }
  return row;
}

/**
 * Resolves the actor's access to one set. Team-owned sets treat every member as
 * a reader and only a captain as a manager. An admin manages everything.
 */
function resolveAccess(
  db: DatabaseSync,
  set: ProblemSetRow,
  userId: number,
  isAdmin: boolean,
): ProblemSetAccess {
  if (isAdmin) {
    return { canView: true, canEdit: true, canManage: true };
  }

  let isManager = false;
  let isOwnerTeamMember = false;
  if (set.owner_type === 'user') {
    isManager = set.owner_id === userId;
  } else {
    const member = getTeamMember(db, set.owner_id, userId);
    isOwnerTeamMember = member !== null;
    isManager = member?.role === 'captain';
  }

  const share = getEffectiveProblemSetShare(db, set.id, userId);
  const canView = isManager || isOwnerTeamMember || set.visibility === 'public' || share !== null;
  return {
    canView,
    canEdit: isManager || share === 'edit',
    canManage: isManager,
  };
}

function requireEditAccess(
  db: DatabaseSync,
  set: ProblemSetRow,
  actorId: number,
  isAdmin: boolean,
): void {
  if (!resolveAccess(db, set, actorId, isAdmin).canEdit) {
    throw new ProblemSetError(
      'SET_FORBIDDEN',
      403,
      'you do not have permission to edit this problem set',
    );
  }
}

function requireManageAccess(
  db: DatabaseSync,
  set: ProblemSetRow,
  actorId: number,
  isAdmin: boolean,
): void {
  if (!resolveAccess(db, set, actorId, isAdmin).canManage) {
    throw new ProblemSetError(
      'SET_FORBIDDEN',
      403,
      'only the owner, team captain or an admin can manage this problem set',
    );
  }
}

function toSummary(
  db: DatabaseSync,
  row: ProblemSetRow,
  userId: number,
  isAdmin: boolean,
  itemCount: number,
): ProblemSetSummary {
  const access = resolveAccess(db, row, userId, isAdmin);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    visibility: row.visibility,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    itemCount,
    canEdit: access.canEdit,
    canManage: access.canManage,
  };
}

function itemToDto(row: ReturnType<typeof listProblemSetItemRows>[number]): ProblemSetItemDto {
  return {
    problemId: row.problem_id,
    ordinal: row.ordinal,
    addedAt: row.added_at,
    title: row.title,
    type: row.type,
    difficulty: row.difficulty,
    tags: JSON.parse(row.tags_json) as string[],
    timeMs: row.time_ms,
    memoryMb: row.memory_mb,
  };
}

function shareToDto(row: ReturnType<typeof listProblemSetShareRows>[number]): ProblemSetShareDto {
  return {
    granteeType: row.grantee_type,
    granteeId: row.grantee_id,
    permission: row.permission,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export interface CreateProblemSetInput {
  title: string;
  description?: string;
  ownerType: ProblemSetOwnerType;
  ownerId: number;
  visibility?: ProblemSetVisibility;
  actorId: number;
  now?: number;
}

export function createProblemSet(db: DatabaseSync, input: CreateProblemSetInput): number {
  const title = normalizeTitle(input.title);
  const description = normalizeDescription(input.description ?? '');
  assertOwnerType(input.ownerType);
  const visibility = input.visibility ?? 'private';
  assertVisibility(visibility);

  if (input.ownerType === 'user') {
    if (!getUserById(db, input.ownerId)) {
      throw new ProblemSetError('SET_OWNER_INVALID', 400, 'owner user not found');
    }
    if (input.ownerId !== input.actorId) {
      throw new ProblemSetError(
        'SET_FORBIDDEN',
        403,
        'you can only create personal problem sets for yourself',
      );
    }
  } else {
    if (!getTeamRow(db, input.ownerId)) {
      throw new ProblemSetError('SET_OWNER_INVALID', 400, 'owner team not found');
    }
    const member = getTeamMember(db, input.ownerId, input.actorId);
    if (!member || member.role !== 'captain') {
      throw new ProblemSetError(
        'SET_FORBIDDEN',
        403,
        'only the team captain can create a team problem set',
      );
    }
  }

  const now = input.now ?? Date.now();
  return transaction(db, () =>
    insertProblemSet(db, {
      title,
      description,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      visibility,
      createdBy: input.actorId,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

export function listProblemSets(
  db: DatabaseSync,
  input: { userId: number; includePublic?: boolean },
): ProblemSetSummary[] {
  const rows = listProblemSetRowsForUser(db, {
    userId: input.userId,
    includePublic: input.includePublic ?? true,
  });
  return rows.map((row) =>
    toSummary(db, row, input.userId, false, countProblemSetItems(db, row.id)),
  );
}

export function getProblemSet(
  db: DatabaseSync,
  setId: number,
  userId: number,
  isAdmin: boolean,
): ProblemSetDetail | null {
  const row = getProblemSetRow(db, setId);
  if (!row) return null;
  const access = resolveAccess(db, row, userId, isAdmin);
  if (!access.canView) return null;

  const itemRows = listProblemSetItemRows(db, setId);
  const items = itemRows.map(itemToDto);
  const shares = access.canManage
    ? listProblemSetShareRows(db, setId).map(shareToDto)
    : [];
  return {
    ...toSummary(db, row, userId, isAdmin, items.length),
    items,
    shares,
  };
}

export interface UpdateProblemSetPatch {
  title?: string;
  description?: string;
  visibility?: ProblemSetVisibility;
}

export function updateProblemSet(
  db: DatabaseSync,
  input: {
    setId: number;
    actorId: number;
    isAdmin: boolean;
    patch: UpdateProblemSetPatch;
  },
): void {
  const set = requireProblemSet(db, input.setId);
  const access = resolveAccess(db, set, input.actorId, input.isAdmin);
  if (!access.canEdit) {
    throw new ProblemSetError(
      'SET_FORBIDDEN',
      403,
      'you do not have permission to edit this problem set',
    );
  }

  const patch: { title?: string; description?: string; visibility?: ProblemSetVisibility } = {};
  if (input.patch.title !== undefined) patch.title = normalizeTitle(input.patch.title);
  if (input.patch.description !== undefined) {
    patch.description = normalizeDescription(input.patch.description);
  }
  if (input.patch.visibility !== undefined) {
    if (!access.canManage) {
      throw new ProblemSetError(
        'SET_FORBIDDEN',
        403,
        'only the owner, team captain or an admin can change visibility',
      );
    }
    assertVisibility(input.patch.visibility);
    patch.visibility = input.patch.visibility;
  }
  if (
    patch.title === undefined &&
    patch.description === undefined &&
    patch.visibility === undefined
  ) {
    return;
  }

  transaction(db, () => {
    updateProblemSetRow(db, input.setId, patch, Date.now());
  });
}

export function deleteProblemSet(
  db: DatabaseSync,
  input: { setId: number; actorId: number; isAdmin: boolean },
): void {
  const set = requireProblemSet(db, input.setId);
  requireManageAccess(db, set, input.actorId, input.isAdmin);
  transaction(db, () => {
    deleteProblemSetGraph(db, input.setId);
  });
}

export function addProblemSetItem(
  db: DatabaseSync,
  input: {
    setId: number;
    problemId: number;
    actorId: number;
    isAdmin: boolean;
    now?: number;
  },
): void {
  const set = requireProblemSet(db, input.setId);
  const access = resolveAccess(db, set, input.actorId, input.isAdmin);
  if (!access.canEdit) {
    throw new ProblemSetError(
      'SET_FORBIDDEN',
      403,
      'you do not have permission to edit this problem set',
    );
  }

  const problem = getProblem(db, input.problemId);
  if (!problem) {
    throw new ProblemSetError('SET_ITEM_NOT_FOUND', 404, 'problem not found');
  }
  if (problem.visibility === 'hidden' && !access.canManage) {
    throw new ProblemSetError(
      'SET_FORBIDDEN',
      403,
      'only the owner, team captain or an admin can add a hidden problem',
    );
  }
  if (getProblemSetItemRow(db, input.setId, input.problemId)) {
    throw new ProblemSetError(
      'SET_ITEM_EXISTS',
      409,
      'problem is already in this problem set',
    );
  }

  transaction(db, () => {
    insertProblemSetItem(db, {
      setId: input.setId,
      problemId: input.problemId,
      ordinal: nextProblemSetOrdinal(db, input.setId),
      addedAt: input.now ?? Date.now(),
    });
    touchProblemSet(db, input.setId, Date.now());
  });
}

export function removeProblemSetItem(
  db: DatabaseSync,
  input: { setId: number; problemId: number; actorId: number; isAdmin: boolean },
): void {
  const set = requireProblemSet(db, input.setId);
  requireEditAccess(db, set, input.actorId, input.isAdmin);
  if (!getProblemSetItemRow(db, input.setId, input.problemId)) {
    throw new ProblemSetError('SET_ITEM_NOT_FOUND', 404, 'problem is not in this problem set');
  }

  transaction(db, () => {
    deleteProblemSetItemRow(db, input.setId, input.problemId);
    const remaining = listProblemSetProblemIds(db, input.setId);
    remaining.forEach((problemId, index) => {
      updateProblemSetItemOrdinal(db, input.setId, problemId, index + 1);
    });
    touchProblemSet(db, input.setId, Date.now());
  });
}

export function reorderProblemSetItems(
  db: DatabaseSync,
  input: {
    setId: number;
    problemIds: number[];
    actorId: number;
    isAdmin: boolean;
  },
): void {
  const set = requireProblemSet(db, input.setId);
  requireEditAccess(db, set, input.actorId, input.isAdmin);

  if (!Array.isArray(input.problemIds)) {
    throw new ProblemSetError('SET_ITEM_INVALID', 400, 'problemIds must be an array');
  }
  if (new Set(input.problemIds).size !== input.problemIds.length) {
    throw new ProblemSetError('SET_ITEM_INVALID', 400, 'problemIds contains duplicates');
  }

  const existing = listProblemSetProblemIds(db, input.setId);
  const existingSet = new Set(existing);
  const unknown = input.problemIds.filter((problemId) => !existingSet.has(problemId));
  if (unknown.length > 0) {
    throw new ProblemSetError(
      'SET_ITEM_NOT_FOUND',
      404,
      `problem is not in this problem set: ${unknown.join(', ')}`,
    );
  }
  if (input.problemIds.length !== existing.length) {
    throw new ProblemSetError(
      'SET_ITEM_INVALID',
      400,
      'problemIds must include every item in the problem set',
    );
  }

  transaction(db, () => {
    input.problemIds.forEach((problemId, index) => {
      updateProblemSetItemOrdinal(db, input.setId, problemId, index + 1);
    });
    touchProblemSet(db, input.setId, Date.now());
  });
}

export function addProblemSetShare(
  db: DatabaseSync,
  input: {
    setId: number;
    granteeType: ProblemSetGranteeType;
    granteeId: number;
    permission: ProblemSetSharePermission;
    actorId: number;
    isAdmin: boolean;
  },
): void {
  const set = requireProblemSet(db, input.setId);
  requireManageAccess(db, set, input.actorId, input.isAdmin);
  assertGranteeType(input.granteeType);
  assertSharePermission(input.permission);

  if (set.owner_type === input.granteeType && set.owner_id === input.granteeId) {
    throw new ProblemSetError(
      'SET_SHARE_INVALID',
      400,
      'cannot share a set with its own owner',
    );
  }
  if (input.granteeType === 'user') {
    if (!getUserById(db, input.granteeId)) {
      throw new ProblemSetError('SET_SHARE_INVALID', 400, 'grantee user not found');
    }
  } else if (!getTeamRow(db, input.granteeId)) {
    throw new ProblemSetError('SET_SHARE_INVALID', 400, 'grantee team not found');
  }

  transaction(db, () => {
    upsertProblemSetShare(db, {
      setId: input.setId,
      granteeType: input.granteeType,
      granteeId: input.granteeId,
      permission: input.permission,
      createdBy: input.actorId,
      createdAt: Date.now(),
    });
    touchProblemSet(db, input.setId, Date.now());
  });
}

export function removeProblemSetShare(
  db: DatabaseSync,
  input: {
    setId: number;
    granteeType: ProblemSetGranteeType;
    granteeId: number;
    actorId: number;
    isAdmin: boolean;
  },
): void {
  const set = requireProblemSet(db, input.setId);
  requireManageAccess(db, set, input.actorId, input.isAdmin);
  assertGranteeType(input.granteeType);

  if (!getProblemSetShareRow(db, input.setId, input.granteeType, input.granteeId)) {
    throw new ProblemSetError('SET_SHARE_INVALID', 400, 'share not found');
  }

  transaction(db, () => {
    deleteProblemSetShareRow(db, input.setId, input.granteeType, input.granteeId);
    touchProblemSet(db, input.setId, Date.now());
  });
}
