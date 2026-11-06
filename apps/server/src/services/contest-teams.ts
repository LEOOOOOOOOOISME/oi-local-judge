import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../storage/db.js';
import {
  addParticipantIfAbsent,
  getContest,
  type ContestRow,
} from '../storage/repos/contests.js';
import {
  deleteRegistrationRow,
  getRegistrationRow,
} from '../storage/repos/contest-registrations.js';
import {
  deleteContestTeamRegistration,
  findContestTeamMemberConflict,
  getContestTeamRegistration,
  insertContestTeamRegistration,
  listContestIdsForTeam,
  listContestTeamRegistrations,
  listRegisteredTeamIdsForUser,
  type TeamRegistrationDto,
} from '../storage/repos/contest-teams.js';
import { getTeamMember, getTeamRow, listTeamMembers } from '../storage/repos/teams.js';

export type { ContestTeamMemberDto, TeamRegistrationDto } from '../storage/repos/contest-teams.js';

export class ContestTeamError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ContestTeamError';
    this.code = code;
    this.status = status;
  }
}

function requireContest(db: DatabaseSync, contestId: number): ContestRow {
  const contest = getContest(db, contestId);
  if (!contest) {
    throw new ContestTeamError('CONTEST_NOT_FOUND', 404, 'contest not found');
  }
  return contest;
}

function requireRegistration(
  db: DatabaseSync,
  contestId: number,
  teamId: number,
): void {
  if (!getContestTeamRegistration(db, contestId, teamId)) {
    throw new ContestTeamError(
      'TEAM_NOT_REGISTERED',
      404,
      'team is not registered for this contest',
    );
  }
}

function isUniqueConstraintError(err: unknown, columns: string): boolean {
  return err instanceof Error && err.message.includes(`UNIQUE constraint failed: ${columns}`);
}

/**
 * Registers a team for a contest. The actor must be the team captain, or an
 * administrator/contest manager (`isAdmin`). The contest must accept teams and
 * no team member may already represent another team in the same contest; for a
 * class only its students count, so a coach or assistant shared by two classes
 * never blocks a registration.
 *
 * Registration also grants every current team member `accepted` contest
 * participation, so members pass the contest access check and can submit. Rows
 * that already exist are kept as-is (existing individual registration wins).
 * A class only enrolls its students; coaches and assistants stay staff.
 */
export function registerTeamForContest(
  db: DatabaseSync,
  input: {
    contestId: number;
    teamId: number;
    actorId: number;
    isAdmin: boolean;
    now?: number;
  },
): void {
  const contest = requireContest(db, input.contestId);
  if (contest.archived_at !== null || contest.status === 'archived') {
    throw new ContestTeamError('CONTEST_ARCHIVED', 409, 'contest is archived');
  }
  if (contest.team_mode === 'individual') {
    throw new ContestTeamError(
      'TEAM_MODE_DISABLED',
      409,
      'this contest does not accept team registration',
    );
  }
  const team = getTeamRow(db, input.teamId);
  if (!team) {
    throw new ContestTeamError('TEAM_NOT_FOUND', 404, 'team not found');
  }
  if (team.kind === 'class' && team.allow_contest !== 1) {
    throw new ContestTeamError(
      'CLASS_NOT_ALLOWED_IN_CONTEST',
      409,
      'this class is not allowed to participate in contests',
    );
  }
  if (!input.isAdmin) {
    const member = getTeamMember(db, input.teamId, input.actorId);
    const requiredRole = team.kind === 'class' ? 'coach' : 'captain';
    if (!member || member.role !== requiredRole) {
      throw new ContestTeamError(
        'TEAM_FORBIDDEN',
        403,
        team.kind === 'class'
          ? 'only a class coach or an admin can register the class'
          : 'only the team captain or an admin can register the team',
      );
    }
  }
  if (getContestTeamRegistration(db, input.contestId, input.teamId)) {
    throw new ContestTeamError(
      'TEAM_ALREADY_REGISTERED',
      409,
      'team is already registered for this contest',
    );
  }
  const conflict = findContestTeamMemberConflict(db, input.contestId, input.teamId);
  if (conflict) {
    throw new ContestTeamError(
      'TEAM_MEMBER_CONFLICT',
      409,
      `team member ${conflict.username} already represents ${conflict.teamName} in this contest`,
    );
  }
  const registeredAt = input.now ?? Date.now();
  transaction(db, () => {
    try {
      insertContestTeamRegistration(db, {
        contestId: input.contestId,
        teamId: input.teamId,
        registeredBy: input.actorId,
        registeredAt,
      });
    } catch (err) {
      if (
        isUniqueConstraintError(
          err,
          'contest_teams.contest_id, contest_teams.team_id',
        )
      ) {
        throw new ContestTeamError(
          'TEAM_ALREADY_REGISTERED',
          409,
          'team is already registered for this contest',
        );
      }
      throw err;
    }
    // Every member of the team becomes an accepted contest participant in the
    // same transaction. An existing participant row (individual import, pending
    // or rejected registration) is preserved untouched. New rows are tagged
    // `source = 'team'` so membership changes can revoke exactly those rows.
    // A class only enrolls its students: coaches and assistants are staff, not
    // contestants.
    for (const member of listTeamMembers(db, input.teamId)) {
      if (team.kind === 'class' && member.role !== 'member') continue;
      addParticipantIfAbsent(db, input.contestId, member.userId, registeredAt, 'team');
    }
  });
}

/**
 * Removes a team registration. Only administrators/contest managers can do
 * this. Existing submissions keep their `team_id` attribution.
 *
 * Participant rows are intentionally retained, including `source = 'team'`
 * rows: revoking participation is a separate administrator action, and the
 * rows may predate the registration or be backed by submissions. In `team`
 * mode a member of the removed team therefore still needs a currently
 * registered team to submit (`TEAM_REQUIRED`); in `both` mode the retained row
 * keeps individual submission eligibility.
 */
export function removeTeamFromContest(
  db: DatabaseSync,
  input: {
    contestId: number;
    teamId: number;
    actorId: number;
    isAdmin: boolean;
  },
): void {
  requireContest(db, input.contestId);
  if (!input.isAdmin) {
    throw new ContestTeamError(
      'TEAM_FORBIDDEN',
      403,
      'only an admin or contest manager can remove a team registration',
    );
  }
  requireRegistration(db, input.contestId, input.teamId);
  deleteContestTeamRegistration(db, input.contestId, input.teamId);
}

export function listContestTeams(db: DatabaseSync, contestId: number): TeamRegistrationDto[] {
  requireContest(db, contestId);
  return listContestTeamRegistrations(db, contestId);
}

/** Team id the user currently represents in the contest, or null. */
export function getRegisteredTeamForUser(
  db: DatabaseSync,
  contestId: number,
  userId: number,
): number | null {
  return listRegisteredTeamIdsForUser(db, contestId, userId)[0] ?? null;
}

/** Outcome of propagating a team membership change to contest participation. */
export interface TeamMemberContestSync {
  /** Contests that received a new `source = 'team'` participant row. */
  linkedContestIds: number[];
  /**
   * Contests where the row was left untouched because the user already
   * represents another registered team for the same contest.
   */
  skipped: Array<{ contestId: number; teamId: number; teamName: string }>;
}

/**
 * Grants participation in every contest the team is already registered for.
 *
 * Called after a new `team_members` row was inserted, inside the caller's
 * transaction. A user whose only missing piece is participation becomes an
 * accepted participant with `source = 'team'`.
 *
 * Joining a team must never create a second team affiliation for one contest.
 * When the user already represents another registered team there, the
 * participant row is left alone and the conflict is reported back to the
 * caller rather than silently overwritten.
 */
export function syncMemberJoinedTeam(
  db: DatabaseSync,
  input: { teamId: number; userId: number; now?: number },
): TeamMemberContestSync {
  const now = input.now ?? Date.now();
  const sync: TeamMemberContestSync = { linkedContestIds: [], skipped: [] };
  for (const contestId of listContestIdsForTeam(db, input.teamId)) {
    const otherTeamId = listRegisteredTeamIdsForUser(db, contestId, input.userId).find(
      (teamId) => teamId !== input.teamId,
    );
    if (otherTeamId !== undefined) {
      sync.skipped.push({
        contestId,
        teamId: otherTeamId,
        teamName: getTeamRow(db, otherTeamId)?.name ?? '',
      });
      continue;
    }
    // An existing row (admin import, self-registration, pending review) wins.
    if (getRegistrationRow(db, contestId, input.userId)) continue;
    addParticipantIfAbsent(db, contestId, input.userId, now, 'team');
    sync.linkedContestIds.push(contestId);
  }
  return sync;
}

/**
 * Revokes team-derived participation after the user left a team.
 *
 * Called after the `team_members` row was deleted, inside the caller's
 * transaction. Only `source = 'team'` rows are removed: administrator imports
 * (`manual`) and self-registrations (`self`) are never touched. A user who is
 * still a member of another registered team for the same contest keeps the row.
 *
 * @returns contest ids whose participant row was deleted.
 */
export function syncMemberLeftTeam(
  db: DatabaseSync,
  input: { teamId: number; userId: number },
): number[] {
  const removedContestIds: number[] = [];
  for (const contestId of listContestIdsForTeam(db, input.teamId)) {
    const row = getRegistrationRow(db, contestId, input.userId);
    if (!row || row.source !== 'team') continue;
    // Another registered team still justifies the participation row.
    if (listRegisteredTeamIdsForUser(db, contestId, input.userId).length > 0) continue;
    deleteRegistrationRow(db, contestId, input.userId);
    removedContestIds.push(contestId);
  }
  return removedContestIds;
}

/**
 * Resolves which team a submission belongs to.
 *
 * - `individual` contests never attribute a team.
 * - `team` contests require the user to represent a registered team.
 * - `both` contests attribute the user's registered team when there is one and
 *   fall back to an individual submission otherwise.
 *
 * An explicit `requestedTeamId` must be registered for the contest and the user
 * must be one of its members.
 */
export function resolveSubmissionTeam(
  db: DatabaseSync,
  input: {
    contestId: number;
    userId: number;
    requestedTeamId?: number | null;
  },
): number | null {
  const contest = requireContest(db, input.contestId);
  if (contest.team_mode === 'individual') return null;

  const requested = input.requestedTeamId;
  if (requested !== undefined && requested !== null) {
    if (!Number.isInteger(requested) || requested <= 0) {
      throw new ContestTeamError('TEAM_INVALID', 400, 'teamId is invalid');
    }
    if (!getContestTeamRegistration(db, input.contestId, requested)) {
      throw new ContestTeamError(
        'TEAM_NOT_REGISTERED',
        403,
        'requested team is not registered for this contest',
      );
    }
    if (!getTeamMember(db, requested, input.userId)) {
      throw new ContestTeamError(
        'TEAM_MEMBER_REQUIRED',
        403,
        'you are not a member of the requested team',
      );
    }
    return requested;
  }

  const registered = listRegisteredTeamIdsForUser(db, input.contestId, input.userId);
  if (registered.length === 0) {
    if (contest.team_mode === 'team') {
      throw new ContestTeamError(
        'TEAM_REQUIRED',
        403,
        'you must register a team before submitting to this contest',
      );
    }
    return null;
  }
  if (registered.length > 1) {
    throw new ContestTeamError(
      'TEAM_AMBIGUOUS',
      409,
      'you represent multiple registered teams; pass teamId explicitly',
    );
  }
  return registered[0] ?? null;
}
