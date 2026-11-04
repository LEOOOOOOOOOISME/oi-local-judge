import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../storage/db.js';
import {
  deleteProblemShareRow,
  getEffectiveProblemShare,
  getProblemShareRow,
  listProblemShareRows,
  upsertProblemShare,
  type ProblemGranteeType,
  type ProblemSharePermission,
} from '../storage/repos/problem-shares.js';
import { getProblem, listAllProblems, type ProblemRow } from '../storage/repos/problems.js';
import { getTeamMember, getTeamRow, type TeamRole } from '../storage/repos/teams.js';
import { getUserById } from '../storage/repos/users.js';

export type { ProblemGranteeType, ProblemSharePermission };

export interface ProblemActor {
  userId?: number;
  isAdmin?: boolean;
}

export interface ProblemShareDto {
  granteeType: ProblemGranteeType;
  granteeId: number;
  permission: ProblemSharePermission;
  createdBy: number;
  createdAt: number;
}

export class ProblemAclError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ProblemAclError';
    this.code = code;
    this.status = status;
  }
}

function requireProblem(db: DatabaseSync, problemId: number): ProblemRow {
  const problem = getProblem(db, problemId);
  if (!problem) {
    throw new ProblemAclError('PROBLEM_NOT_FOUND', 404, 'problem not found');
  }
  return problem;
}

/** Team role of the actor on the problem's owning team, if any. */
function ownershipTeamRole(
  db: DatabaseSync,
  problem: ProblemRow,
  userId: number,
): TeamRole | null {
  if (problem.owner_type !== 'team' || problem.owner_id === null) return null;
  return getTeamMember(db, problem.owner_id, userId)?.role ?? null;
}

function isOwner(problem: ProblemRow, userId: number | undefined): boolean {
  return (
    userId !== undefined &&
    problem.owner_type === 'user' &&
    problem.owner_id !== null &&
    problem.owner_id === userId
  );
}

/**
 * A problem is readable when it is public, the actor owns it (directly or as a
 * team member), it was shared with the actor (directly or through a team), or
 * the actor is an admin. System-owned hidden problems are admin-only.
 */
export function canViewProblem(
  db: DatabaseSync,
  problem: ProblemRow,
  actor: ProblemActor,
): boolean {
  if (actor.isAdmin) return true;
  const userId = actor.userId;
  if (userId === undefined) return problem.visibility === 'public';
  if (problem.owner_type === 'system') return problem.visibility === 'public';
  if (isOwner(problem, userId)) return true;
  if (ownershipTeamRole(db, problem, userId) !== null) return true;
  if (problem.visibility === 'public') return true;
  return getEffectiveProblemShare(db, problem.id, userId) !== null;
}

export function canEditProblem(
  db: DatabaseSync,
  problem: ProblemRow,
  actor: ProblemActor,
): boolean {
  if (actor.isAdmin) return true;
  // Only admins may edit system-owned problems; shares never elevate them.
  if (problem.owner_type === 'system') return false;
  const userId = actor.userId;
  if (userId === undefined) return false;
  if (isOwner(problem, userId)) return true;
  if (ownershipTeamRole(db, problem, userId) === 'captain') return true;
  return getEffectiveProblemShare(db, problem.id, userId) === 'edit';
}

/**
 * Only the personal owner, the captain of the owning team or an admin may
 * manage shares. An `edit` share can change problem content but not sharing.
 */
export function canManageProblemShares(
  db: DatabaseSync,
  problem: ProblemRow,
  actor: ProblemActor,
): boolean {
  if (actor.isAdmin) return true;
  const userId = actor.userId;
  if (userId === undefined) return false;
  if (isOwner(problem, userId)) return true;
  return ownershipTeamRole(db, problem, userId) === 'captain';
}

/**
 * Problems the actor may read, newest first. Ownership/team/share visibility is
 * combined in one scan so every problem appears at most once.
 */
export function listVisibleProblems(db: DatabaseSync, actor: ProblemActor): ProblemRow[] {
  return listAllProblems(db).filter((problem) => canViewProblem(db, problem, actor));
}

function assertGranteeType(value: string): asserts value is ProblemGranteeType {
  if (value !== 'user' && value !== 'team') {
    throw new ProblemAclError(
      'PROBLEM_SHARE_INVALID',
      400,
      'granteeType must be user or team',
    );
  }
}

function assertSharePermission(value: string): asserts value is ProblemSharePermission {
  if (value !== 'read' && value !== 'edit') {
    throw new ProblemAclError(
      'PROBLEM_SHARE_INVALID',
      400,
      'permission must be read or edit',
    );
  }
}

export interface AddProblemShareInput {
  problemId: number;
  granteeType: ProblemGranteeType;
  granteeId: number;
  permission: ProblemSharePermission;
  actorId: number;
  isAdmin?: boolean;
  now?: number;
}

export function addProblemShare(db: DatabaseSync, input: AddProblemShareInput): void {
  const problem = requireProblem(db, input.problemId);
  if (
    !canManageProblemShares(db, problem, { userId: input.actorId, isAdmin: input.isAdmin })
  ) {
    throw new ProblemAclError(
      'PROBLEM_FORBIDDEN',
      403,
      'only the owner, team captain or an admin can manage problem shares',
    );
  }
  assertGranteeType(input.granteeType);
  assertSharePermission(input.permission);

  if (problem.owner_type === input.granteeType && problem.owner_id === input.granteeId) {
    throw new ProblemAclError(
      'PROBLEM_SHARE_INVALID',
      400,
      'cannot share a problem with its own owner',
    );
  }
  if (input.granteeType === 'user') {
    if (!getUserById(db, input.granteeId)) {
      throw new ProblemAclError('PROBLEM_SHARE_INVALID', 400, 'grantee user not found');
    }
  } else if (!getTeamRow(db, input.granteeId)) {
    throw new ProblemAclError('PROBLEM_SHARE_INVALID', 400, 'grantee team not found');
  }

  transaction(db, () => {
    upsertProblemShare(db, {
      problemId: input.problemId,
      granteeType: input.granteeType,
      granteeId: input.granteeId,
      permission: input.permission,
      createdBy: input.actorId,
      createdAt: input.now ?? Date.now(),
    });
  });
}

export interface RemoveProblemShareInput {
  problemId: number;
  granteeType: ProblemGranteeType;
  granteeId: number;
  actorId: number;
  isAdmin?: boolean;
}

export function removeProblemShare(db: DatabaseSync, input: RemoveProblemShareInput): void {
  const problem = requireProblem(db, input.problemId);
  if (
    !canManageProblemShares(db, problem, { userId: input.actorId, isAdmin: input.isAdmin })
  ) {
    throw new ProblemAclError(
      'PROBLEM_FORBIDDEN',
      403,
      'only the owner, team captain or an admin can manage problem shares',
    );
  }
  assertGranteeType(input.granteeType);
  if (!getProblemShareRow(db, input.problemId, input.granteeType, input.granteeId)) {
    throw new ProblemAclError('PROBLEM_SHARE_INVALID', 400, 'share not found');
  }

  transaction(db, () => {
    deleteProblemShareRow(db, input.problemId, input.granteeType, input.granteeId);
  });
}

export function listProblemShares(db: DatabaseSync, problemId: number): ProblemShareDto[] {
  return listProblemShareRows(db, problemId).map((row) => ({
    granteeType: row.grantee_type,
    granteeId: row.grantee_id,
    permission: row.permission,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}
