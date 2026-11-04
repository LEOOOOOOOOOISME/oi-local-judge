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
  searchTeams as searchTeamRows,
  updateTeamMemberRole,
  updateTeamOwner,
  type TeamDetail,
  type TeamDto,
  type TeamRow,
} from '../storage/repos/teams.js';
import { getUserById, getUserByUsername, type Role } from '../storage/repos/users.js';
import {
  syncMemberJoinedTeam,
  syncMemberLeftTeam,
  type TeamMemberContestSync,
} from './contest-teams.js';

export type {
  TeamDetail,
  TeamDto,
  TeamKind,
  TeamMemberDto,
  TeamRole,
} from '../storage/repos/teams.js';

/** 管理员团队搜索返回项：与当前用户是否在团队中无关。 */
export interface AdminTeamDto {
  id: number;
  name: string;
  ownerId: number;
  kind: 'team' | 'class';
  allowContest: boolean;
  memberCount: number;
  createdAt: number;
}

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

/** Loads a group (team or class) that must be of `kind`. */
function requireGroupOfKind(
  db: DatabaseSync,
  teamId: number,
  kind: 'team' | 'class',
): TeamRow {
  const team = getTeamRow(db, teamId);
  if (!team || team.kind !== kind) {
    if (kind === 'class') {
      throw new TeamError('CLASS_NOT_FOUND', 404, 'class not found');
    }
    throw new TeamError('TEAM_NOT_FOUND', 404, 'team not found');
  }
  return team;
}

function requireClass(db: DatabaseSync, classId: number): TeamRow {
  return requireGroupOfKind(db, classId, 'class');
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

function findActiveUser(db: DatabaseSync, rawUsername: string) {
  const username = rawUsername.trim();
  const target = username ? getUserByUsername(db, username) : null;
  if (!target) {
    throw new TeamError('USER_NOT_FOUND', 404, 'user not found');
  }
  if (target.status !== 'active') {
    throw new TeamError('USER_INACTIVE', 403, 'user is not active');
  }
  return target;
}

function requireClassPermission(
  db: DatabaseSync,
  classId: number,
  actorId: number,
  isAdmin: boolean,
  permission: 'manage' | 'coaches',
): void {
  const allowed =
    permission === 'coaches'
      ? canManageCoaches(db, classId, actorId, isAdmin)
      : canManageGroup(db, classId, actorId, isAdmin);
  if (!allowed) {
    throw new TeamError('CLASS_FORBIDDEN', 403, 'you cannot manage this class');
  }
}

/**
 * Whether the actor may manage a group's roster.
 *
 * - admins: always;
 * - the group owner: always;
 * - a class coach: may manage students and assistants;
 * - a team captain: may manage team members.
 *
 * Class coaches may not add or remove other coaches; use
 * {@link canManageCoaches} for that.
 */
export function canManageGroup(
  db: DatabaseSync,
  teamId: number,
  userId: number,
  isAdmin = false,
): boolean {
  if (isAdmin) return true;
  const team = getTeamRow(db, teamId);
  if (!team) return false;
  if (team.owner_id === userId) return true;
  const member = getTeamMember(db, teamId, userId);
  if (!member) return false;
  return team.kind === 'class' ? member.role === 'coach' : member.role === 'captain';
}

/**
 * Whether the actor teaches the group and may therefore inspect its students'
 * source code. Teams: the captain. Classes: any coach (the owner is always one).
 */
export function canTeachGroup(
  db: DatabaseSync,
  teamId: number,
  userId: number,
  isAdmin = false,
): boolean {
  if (isAdmin) return true;
  const team = getTeamRow(db, teamId);
  if (!team) return false;
  const member = getTeamMember(db, teamId, userId);
  if (!member) return false;
  return team.kind === 'class' ? member.role === 'coach' : member.role === 'captain';
}

/** Whether the actor may add or remove coaches. Only admins and the owner may. */
export function canManageCoaches(
  db: DatabaseSync,
  teamId: number,
  userId: number,
  isAdmin = false,
): boolean {
  if (isAdmin) return true;
  const team = getTeamRow(db, teamId);
  return team !== null && team.owner_id === userId;
}

function isUniqueConstraintError(err: unknown, columns: string): boolean {
  return err instanceof Error && err.message.includes(`UNIQUE constraint failed: ${columns}`);
}

export function createTeam(
  db: DatabaseSync,
  input: {
    name: string;
    ownerId: number;
    kind?: 'team' | 'class';
    allowContest?: boolean;
    now?: number;
  },
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
  const kind = input.kind ?? 'team';
  // Teams stay self-service (owner is the captain). Classes are created by
  // staff and their owner is the first coach; there is no captain semantics.
  const ownerRole = kind === 'class' ? 'coach' : 'captain';
  return transaction(db, () => {
    let teamId: number;
    try {
      teamId = insertTeam(db, {
        name,
        ownerId: input.ownerId,
        createdAt: now,
        kind,
        allowContest: input.allowContest,
      });
    } catch (err) {
      if (isUniqueConstraintError(err, 'teams.name')) {
        throw new TeamError('TEAM_NAME_TAKEN', 409, 'team name is already taken');
      }
      throw err;
    }
    insertTeamMember(db, {
      teamId,
      userId: input.ownerId,
      role: ownerRole,
      joinedAt: now,
    });
    return teamId;
  });
}

/**
 * Creates a teaching class. Only administrators and contest managers may do
 * this; the creator becomes the owner and therefore the first `coach`.
 */
export function createClass(
  db: DatabaseSync,
  input: {
    name: string;
    ownerId: number;
    actorRole: Role;
    allowContest?: boolean;
    now?: number;
  },
): number {
  if (input.actorRole !== 'admin' && input.actorRole !== 'contestmanager') {
    throw new TeamError(
      'CLASS_FORBIDDEN',
      403,
      'only an admin or contest manager can create a class',
    );
  }
  return createTeam(db, {
    name: input.name,
    ownerId: input.ownerId,
    kind: 'class',
    allowContest: input.allowContest,
    now: input.now,
  });
}

export function listTeamsForUser(db: DatabaseSync, userId: number): TeamDto[] {
  return listTeamRowsForUser(db, userId, 'team');
}

/** Classes the user belongs to (as a coach, assistant or student). */
export function listClassesForUser(db: DatabaseSync, userId: number): TeamDto[] {
  return listTeamRowsForUser(db, userId, 'class');
}

/**
 * 管理员/比赛管理员的全量团队搜索。
 *
 * 与 {@link listTeamsForUser} 的“只返回我加入的团队”语义完全隔离；
 * `query` 按团队名模糊匹配，`limit` 默认 20、最大 100。
 */
export function searchTeams(
  db: DatabaseSync,
  filter: { query?: string; limit?: number } = {},
): AdminTeamDto[] {
  return searchTeamRows(db, filter).map((row) => ({
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    kind: row.kind,
    allowContest: row.allow_contest === 1,
    memberCount: Number(row.member_count),
    createdAt: row.created_at,
  }));
}

export function getTeam(db: DatabaseSync, teamId: number): TeamDetail | null {
  const team = getTeamRow(db, teamId);
  if (!team) return null;
  return {
    id: team.id,
    name: team.name,
    ownerId: team.owner_id,
    kind: team.kind,
    allowContest: team.allow_contest === 1,
    createdAt: team.created_at,
    members: listTeamMembers(db, teamId),
  };
}

/** Class detail, or null when the id is unknown or names a plain team. */
export function getClass(db: DatabaseSync, classId: number): TeamDetail | null {
  const detail = getTeam(db, classId);
  return detail?.kind === 'class' ? detail : null;
}

/**
 * Adds a user to a team.
 *
 * Membership is also propagated to contest participation: for every contest the
 * team is already registered for, the new member becomes an accepted
 * participant tagged `source = 'team'`. The membership insert and the
 * participation sync run in one transaction. If the user already represents
 * another registered team in one of those contests, that contest is skipped
 * and reported instead of creating a conflicting affiliation.
 */
export function addTeamMember(
  db: DatabaseSync,
  input: { teamId: number; actorId: number; username: string; now?: number; isAdmin?: boolean },
): TeamMemberContestSync {
  requireGroupOfKind(db, input.teamId, 'team');
  requireCaptainOrAdmin(db, input.teamId, input.actorId, input.isAdmin ?? false);
  const target = findActiveUser(db, input.username);
  if (getTeamMember(db, input.teamId, target.id)) {
    throw new TeamError('TEAM_MEMBER_EXISTS', 409, 'user is already a team member');
  }
  const joinedAt = input.now ?? Date.now();
  return transaction(db, () => {
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
    return syncMemberJoinedTeam(db, {
      teamId: input.teamId,
      userId: target.id,
      now: joinedAt,
    });
  });
}

/**
 * Removes a member from a team and revokes the contest participation the team
 * granted. Only `source = 'team'` participant rows are deleted; administrator
 * imports and self-registrations are preserved, as is participation justified
 * by another registered team.
 */
export function removeTeamMember(
  db: DatabaseSync,
  input: { teamId: number; actorId: number; userId: number; now?: number; isAdmin?: boolean },
): void {
  requireGroupOfKind(db, input.teamId, 'team');
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
    syncMemberLeftTeam(db, { teamId: input.teamId, userId: input.userId });
  });
}

/**
 * Lets an ordinary member leave a team. Team-derived contest participation is
 * revoked in the same transaction, while administrator imports,
 * self-registrations and participation kept alive by another registered team
 * are preserved.
 */
export function leaveTeam(db: DatabaseSync, teamId: number, userId: number): void {
  requireGroupOfKind(db, teamId, 'team');
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
    syncMemberLeftTeam(db, { teamId, userId });
  });
}

export function transferCaptain(
  db: DatabaseSync,
  input: { teamId: number; actorId: number; userId: number; isAdmin?: boolean },
): void {
  const group = requireTeam(db, input.teamId);
  if (group.kind === 'class') {
    throw new TeamError('CLASS_NO_CAPTAIN', 409, 'a class has coaches, not a captain');
  }
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

/**
 * Dissolves a team and everything the membership granted.
 *
 * Inside one transaction this writes the audit record, removes every team
 * membership together with the contest participation it granted, drops the
 * contest registrations and finally deletes the team.
 *
 * Revocation reuses {@link syncMemberLeftTeam}: each membership row is deleted
 * first so the dissolving team no longer counts as a registered team for its
 * member, then the sync removes only `source = 'team'` participant rows that no
 * other registered team justifies. Administrator imports (`manual`) and
 * self-registrations (`self`) are never touched.
 */
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
    // Snapshot the roster before deleting any membership row: the contest sync
    // can only revoke participation while the members are still known.
    const memberIds = listTeamMembers(db, input.teamId).map((member) => member.userId);
    for (const userId of memberIds) {
      // Delete first so `syncMemberLeftTeam` no longer sees this team as a
      // standing affiliation; otherwise it would keep every `team` row.
      removeTeamMemberRow(db, input.teamId, userId);
      syncMemberLeftTeam(db, { teamId: input.teamId, userId });
    }
    // Also drops contest_teams registrations, then any leftover members and
    // the team itself.
    deleteTeamWithMembers(db, input.teamId);
  });
}

export type ClassMemberRole = 'coach' | 'assistant' | 'member';

/**
 * Adds a student, assistant or (owner/admin only) another coach to a class.
 *
 * Class coaches may manage students and assistants; adding a coach requires
 * {@link canManageCoaches}. Only students (`member`) join the class's contest
 * participation when it is already registered for a contest.
 */
export function addClassMember(
  db: DatabaseSync,
  input: {
    classId: number;
    actorId: number;
    username: string;
    role?: string;
    isAdmin?: boolean;
    now?: number;
  },
): TeamMemberContestSync {
  requireClass(db, input.classId);
  const rawRole = input.role ?? 'member';
  if (rawRole !== 'coach' && rawRole !== 'assistant' && rawRole !== 'member') {
    throw new TeamError('CLASS_ROLE_INVALID', 400, 'role must be coach, assistant or member');
  }
  const role: ClassMemberRole = rawRole;
  requireClassPermission(
    db,
    input.classId,
    input.actorId,
    input.isAdmin ?? false,
    role === 'coach' ? 'coaches' : 'manage',
  );
  const target = findActiveUser(db, input.username);
  if (getTeamMember(db, input.classId, target.id)) {
    throw new TeamError('CLASS_MEMBER_EXISTS', 409, 'user is already a class member');
  }
  const joinedAt = input.now ?? Date.now();
  return transaction(db, () => {
    try {
      insertTeamMember(db, {
        teamId: input.classId,
        userId: target.id,
        role,
        joinedAt,
      });
    } catch (err) {
      if (isUniqueConstraintError(err, 'team_members.team_id, team_members.user_id')) {
        throw new TeamError('CLASS_MEMBER_EXISTS', 409, 'user is already a class member');
      }
      throw err;
    }
    if (role !== 'member') {
      return { linkedContestIds: [], skipped: [] };
    }
    // A student added after the class was registered for a contest becomes an
    // accepted participant, exactly like joining a registered team.
    return syncMemberJoinedTeam(db, {
      teamId: input.classId,
      userId: target.id,
      now: joinedAt,
    });
  });
}

/** Removes a student or assistant; removing a coach requires coach authority. */
export function removeClassMember(
  db: DatabaseSync,
  input: { classId: number; actorId: number; userId: number; isAdmin?: boolean },
): void {
  const group = requireClass(db, input.classId);
  const target = getTeamMember(db, input.classId, input.userId);
  if (!target) {
    throw new TeamError('CLASS_MEMBER_NOT_FOUND', 404, 'class member not found');
  }
  if (target.role === 'coach') {
    requireClassPermission(db, input.classId, input.actorId, input.isAdmin ?? false, 'coaches');
  } else {
    requireClassPermission(db, input.classId, input.actorId, input.isAdmin ?? false, 'manage');
  }
  if (target.user_id === group.owner_id) {
    throw new TeamError('CLASS_OWNER_PROTECTED', 409, 'the class owner cannot be removed');
  }
  transaction(db, () => {
    removeTeamMemberRow(db, input.classId, input.userId);
    syncMemberLeftTeam(db, { teamId: input.classId, userId: input.userId });
  });
}

/** Adds a coach (or promotes an existing student/assistant to coach). */
export function addClassCoach(
  db: DatabaseSync,
  input: {
    classId: number;
    actorId: number;
    username: string;
    isAdmin?: boolean;
    now?: number;
  },
): void {
  const group = requireClass(db, input.classId);
  requireClassPermission(db, input.classId, input.actorId, input.isAdmin ?? false, 'coaches');
  const target = findActiveUser(db, input.username);
  const existing = getTeamMember(db, input.classId, target.id);
  if (existing) {
    if (existing.role === 'coach' || target.id === group.owner_id) {
      throw new TeamError('CLASS_COACH_EXISTS', 409, 'user is already a class coach');
    }
    updateTeamMemberRole(db, input.classId, target.id, 'coach');
    return;
  }
  insertTeamMember(db, {
    teamId: input.classId,
    userId: target.id,
    role: 'coach',
    joinedAt: input.now ?? Date.now(),
  });
}

/**
 * Removes a coach from a class. The owner is always its first coach and cannot
 * be removed; use class dissolution for that.
 */
export function removeClassCoach(
  db: DatabaseSync,
  input: { classId: number; actorId: number; userId: number; isAdmin?: boolean },
): void {
  const group = requireClass(db, input.classId);
  requireClassPermission(db, input.classId, input.actorId, input.isAdmin ?? false, 'coaches');
  const target = getTeamMember(db, input.classId, input.userId);
  if (!target || target.role !== 'coach') {
    throw new TeamError('CLASS_NOT_COACH', 404, 'class coach not found');
  }
  if (input.userId === group.owner_id) {
    throw new TeamError('CLASS_OWNER_PROTECTED', 409, 'the class owner cannot be removed');
  }
  transaction(db, () => {
    removeTeamMemberRow(db, input.classId, input.userId);
    syncMemberLeftTeam(db, { teamId: input.classId, userId: input.userId });
  });
}
