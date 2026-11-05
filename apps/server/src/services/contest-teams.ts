import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../storage/db.js';
import { getContest, type ContestRow } from '../storage/repos/contests.js';
import {
  deleteContestTeamRegistration,
  findContestTeamMemberConflict,
  getContestTeamRegistration,
  insertContestTeamRegistration,
  listContestTeamRegistrations,
  listRegisteredTeamIdsForUser,
  type TeamRegistrationDto,
} from '../storage/repos/contest-teams.js';
import { getTeamMember, getTeamRow } from '../storage/repos/teams.js';

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
 * no team member may already represent another team in the same contest.
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
  if (!input.isAdmin) {
    const member = getTeamMember(db, input.teamId, input.actorId);
    if (!member || member.role !== 'captain') {
      throw new ContestTeamError(
        'TEAM_FORBIDDEN',
        403,
        'only the team captain or an admin can register the team',
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
  });
}

/**
 * Removes a team registration. Only administrators/contest managers can do
 * this. Existing submissions keep their `team_id` attribution.
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
