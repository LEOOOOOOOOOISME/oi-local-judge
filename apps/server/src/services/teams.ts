import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../storage/db.js';
import {
  deleteTeamWithMembers,
  getTeamByName,
  getTeamMember,
  getTeamRow,
  insertTeam,
  insertTeamMember,
  listTeamMembers,
  listTeamsForUser as listTeamRowsForUser,
  removeTeamMemberRow,
  updateTeamMemberRole,
  updateTeamOwner,
  type TeamDetail,
  type TeamDto,
  type TeamRow,
} from '../storage/repos/teams.js';
import { getUserById, getUserByUsername } from '../storage/repos/users.js';

export type { TeamDetail, TeamDto, TeamMemberDto, TeamRole } from '../storage/repos/teams.js';

export class TeamError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'TeamError';
    this.code = code;
    this.status = status;
  }
}

const TEAM_NAME_MIN = 2;
const TEAM_NAME_MAX = 40;

function normalizeTeamName(raw: string): string {
  const name = raw.trim();
  const length = Array.from(name).length;
  if (length < TEAM_NAME_MIN || length > TEAM_NAME_MAX) {
    throw new TeamError(
      'TEAM_NAME_INVALID',
      400,
      `team name must be ${TEAM_NAME_MIN}-${TEAM_NAME_MAX} characters`,
    );
  }
  return name;
}

function requireTeam(db: DatabaseSync, teamId: number): TeamRow {
  const team = getTeamRow(db, teamId);
  if (!team) {
    throw new TeamError('TEAM_NOT_FOUND', 404, 'team not found');
  }
  return team;
}

function requireCaptainOrAdmin(
  db: DatabaseSync,
  teamId: number,
  actorId: number,
  isAdmin: boolean,
): void {
  if (isAdmin) return;
  const member = getTeamMember(db, teamId, actorId);
  if (!member || member.role !== 'captain') {
    throw new TeamError('TEAM_FORBIDDEN', 403, 'only the team captain or an admin can do that');
  }
}

function isUniqueConstraintError(err: unknown, columns: string): boolean {
  return err instanceof Error && err.message.includes(`UNIQUE constraint failed: ${columns}`);
}

export function createTeam(
  db: DatabaseSync,
  input: { name: string; ownerId: number; now?: number },
): number {
  const name = normalizeTeamName(input.name);
  const owner = getUserById(db, input.ownerId);
  if (!owner) {
    throw new TeamError('USER_NOT_FOUND', 404, 'owner not found');
  }
  if (owner.status !== 'active') {
    throw new TeamError('USER_INACTIVE', 403, 'owner is not active');
  }
  if (getTeamByName(db, name)) {
    throw new TeamError('TEAM_NAME_TAKEN', 409, 'team name is already taken');
  }
  const now = input.now ?? Date.now();
  return transaction(db, () => {
    let teamId: number;
    try {
      teamId = insertTeam(db, { name, ownerId: input.ownerId, createdAt: now });
    } catch (err) {
      if (isUniqueConstraintError(err, 'teams.name')) {
        throw new TeamError('TEAM_NAME_TAKEN', 409, 'team name is already taken');
      }
      throw err;
    }
    insertTeamMember(db, {
      teamId,
      userId: input.ownerId,
      role: 'captain',
      joinedAt: now,
    });
    return teamId;
  });
}

export function listTeamsForUser(db: DatabaseSync, userId: number): TeamDto[] {
  return listTeamRowsForUser(db, userId);
}

export function getTeam(db: DatabaseSync, teamId: number): TeamDetail | null {
  const team = getTeamRow(db, teamId);
  if (!team) return null;
  return {
    id: team.id,
    name: team.name,
    ownerId: team.owner_id,
    createdAt: team.created_at,
    members: listTeamMembers(db, teamId),
  };
}

export function addTeamMember(
  db: DatabaseSync,
  input: { teamId: number; actorId: number; username: string; now?: number; isAdmin?: boolean },
): void {
  requireTeam(db, input.teamId);
  requireCaptainOrAdmin(db, input.teamId, input.actorId, input.isAdmin ?? false);
  const username = input.username.trim();
  const target = username ? getUserByUsername(db, username) : null;
  if (!target) {
    throw new TeamError('USER_NOT_FOUND', 404, 'user not found');
  }
  if (target.status !== 'active') {
    throw new TeamError('USER_INACTIVE', 403, 'user is not active');
  }
  if (getTeamMember(db, input.teamId, target.id)) {
    throw new TeamError('TEAM_MEMBER_EXISTS', 409, 'user is already a team member');
  }
  const joinedAt = input.now ?? Date.now();
  transaction(db, () => {
    try {
      insertTeamMember(db, {
        teamId: input.teamId,
        userId: target.id,
        role: 'member',
        joinedAt,
      });
    } catch (err) {
      if (isUniqueConstraintError(err, 'team_members.team_id, team_members.user_id')) {
        throw new TeamError('TEAM_MEMBER_EXISTS', 409, 'user is already a team member');
      }
      throw err;
    }
  });
}

export function removeTeamMember(
  db: DatabaseSync,
  input: { teamId: number; actorId: number; userId: number; now?: number; isAdmin?: boolean },
): void {
  requireTeam(db, input.teamId);
  requireCaptainOrAdmin(db, input.teamId, input.actorId, input.isAdmin ?? false);
  if (input.userId === input.actorId) {
    throw new TeamError(
      'TEAM_FORBIDDEN',
      403,
      'the captain cannot remove themselves; transfer the team or dissolve it',
    );
  }
  const target = getTeamMember(db, input.teamId, input.userId);
  if (!target) {
    throw new TeamError('TEAM_MEMBER_NOT_FOUND', 404, 'team member not found');
  }
  if (target.role === 'captain') {
    throw new TeamError('TEAM_CAPTAIN_LAST', 409, 'a team must keep at least one captain');
  }
  transaction(db, () => {
    removeTeamMemberRow(db, input.teamId, input.userId);
  });
}

export function leaveTeam(db: DatabaseSync, teamId: number, userId: number): void {
  requireTeam(db, teamId);
  const member = getTeamMember(db, teamId, userId);
  if (!member) {
    throw new TeamError('TEAM_MEMBER_NOT_FOUND', 404, 'team member not found');
  }
  if (member.role === 'captain') {
    throw new TeamError(
      'TEAM_CAPTAIN_LAST',
      409,
      'the captain must transfer the team or dissolve it before leaving',
    );
  }
  transaction(db, () => {
    removeTeamMemberRow(db, teamId, userId);
  });
}

export function transferCaptain(
  db: DatabaseSync,
  input: { teamId: number; actorId: number; userId: number; isAdmin?: boolean },
): void {
  requireTeam(db, input.teamId);
  requireCaptainOrAdmin(db, input.teamId, input.actorId, input.isAdmin ?? false);
  if (input.userId === input.actorId) {
    throw new TeamError('TEAM_TRANSFER_SELF', 400, 'the captain is already the captain');
  }
  const target = getTeamMember(db, input.teamId, input.userId);
  if (!target) {
    throw new TeamError('TEAM_MEMBER_NOT_FOUND', 404, 'team member not found');
  }
  if (target.role === 'captain') {
    throw new TeamError('TEAM_ALREADY_CAPTAIN', 409, 'target is already a captain');
  }
  const currentCaptains = listTeamMembers(db, input.teamId).filter(
    (member) => member.role === 'captain',
  );
  transaction(db, () => {
    for (const captain of currentCaptains) {
      updateTeamMemberRole(db, input.teamId, captain.userId, 'member');
    }
    updateTeamMemberRole(db, input.teamId, input.userId, 'captain');
    updateTeamOwner(db, input.teamId, input.userId);
  });
}

export function dissolveTeam(
  db: DatabaseSync,
  input: { teamId: number; actorId: number; isAdmin: boolean },
): void {
  const team = requireTeam(db, input.teamId);
  if (!input.isAdmin && team.owner_id !== input.actorId) {
    throw new TeamError('TEAM_FORBIDDEN', 403, 'only the team owner or an admin can dissolve it');
  }
  transaction(db, () => {
    db.prepare(
      `INSERT INTO audit_logs(actor_id, action, target_type, target_id, detail_json, created_at)
       VALUES (?, 'team.dissolve', 'team', ?, ?, ?)`,
    ).run(
      input.actorId,
      String(input.teamId),
      JSON.stringify({ name: team.name, admin: input.isAdmin }),
      Date.now(),
    );
    deleteTeamWithMembers(db, input.teamId);
  });
}
