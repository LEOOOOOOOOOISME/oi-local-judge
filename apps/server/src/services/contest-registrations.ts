import type { DatabaseSync } from 'node:sqlite';
import { getContest } from '../storage/repos/contests.js';
import {
  deleteRegistrationRow,
  getRegistrationRow,
  getRegistrationWithUser,
  insertRegistration,
  isRegistrationStatus,
  listRegistrationsWithStats,
  updateRegistration,
  type RegistrationStatus,
  type RegistrationWithUserRow,
} from '../storage/repos/contest-registrations.js';
import { recordAudit } from '../storage/repos/audit.js';

export class ContestRegistrationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ContestRegistrationError';
    this.code = code;
    this.status = status;
  }
}

export interface RegistrationDto {
  contestId: number;
  userId: number;
  username: string;
  realName: string | null;
  className: string | null;
  status: RegistrationStatus;
  registeredAt: number | null;
  checkedInAt: number | null;
  reviewedAt: number | null;
  reviewedBy: number | null;
  submissionCount: number;
  lastSubmissionAt: number | null;
}

function toDto(row: RegistrationWithUserRow): RegistrationDto {
  return {
    contestId: row.contest_id,
    userId: row.user_id,
    username: row.username,
    realName: row.real_name,
    className: row.class_name,
    status: isRegistrationStatus(row.status) ? row.status : 'accepted',
    registeredAt: row.registered_at,
    checkedInAt: row.checked_in_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    submissionCount: Number(row.submission_count ?? 0),
    lastSubmissionAt: row.last_submission_at,
  };
}

function requireContest(db: DatabaseSync, contestId: number) {
  const contest = getContest(db, contestId);
  if (!contest) {
    throw new ContestRegistrationError('CONTEST_NOT_FOUND', 404, 'contest not found');
  }
  return contest;
}

function requireRegistration(db: DatabaseSync, contestId: number, userId: number) {
  const row = getRegistrationRow(db, contestId, userId);
  if (!row) {
    throw new ContestRegistrationError('NOT_REGISTERED', 404, 'not registered for this contest');
  }
  return row;
}

/**
 * Registers a user for an open/approval contest. Open contests accept the user
 * immediately; approval contests create a pending registration. A previously
 * rejected user may register again.
 *
 * Team-only contests (`team_mode = 'team'`) never accept individual
 * self-registration: participation is granted when the team captain registers
 * the team. Administrator imports are unaffected because they do not go through
 * this function.
 */
export function registerForContest(
  db: DatabaseSync,
  input: { contestId: number; userId: number; now?: number },
): 'accepted' | 'pending' {
  const now = input.now ?? Date.now();
  const contest = requireContest(db, input.contestId);
  if (contest.team_mode === 'team') {
    throw new ContestRegistrationError(
      'TEAM_REGISTRATION_REQUIRED',
      403,
      'this contest only accepts team registration; the team captain must register the team',
    );
  }
  if (contest.registration_mode === 'manual') {
    throw new ContestRegistrationError(
      'REGISTRATION_DISABLED',
      403,
      'contest does not accept self-registration',
    );
  }
  const closed =
    contest.status === 'archived' ||
    contest.status === 'ended' ||
    (contest.end_at !== null && now >= contest.end_at);
  if (closed) {
    throw new ContestRegistrationError('REGISTRATION_CLOSED', 403, 'registration is closed');
  }
  if (contest.registration_open_at !== null && now < contest.registration_open_at) {
    throw new ContestRegistrationError(
      'REGISTRATION_NOT_OPEN',
      403,
      'registration has not opened yet',
    );
  }
  if (contest.registration_close_at !== null && now > contest.registration_close_at) {
    throw new ContestRegistrationError('REGISTRATION_CLOSED', 403, 'registration is closed');
  }

  const existing = getRegistrationRow(db, input.contestId, input.userId);
  if (existing && (existing.status === 'pending' || existing.status === 'accepted')) {
    throw new ContestRegistrationError(
      'ALREADY_REGISTERED',
      409,
      'already registered for this contest',
    );
  }

  const status: 'accepted' | 'pending' =
    contest.registration_mode === 'open' ? 'accepted' : 'pending';
  if (existing) {
    updateRegistration(db, input.contestId, input.userId, {
      status,
      registeredAt: now,
      checkedInAt: null,
      reviewedAt: null,
      reviewedBy: null,
      source: 'self',
    });
  } else {
    insertRegistration(db, {
      contestId: input.contestId,
      userId: input.userId,
      status,
      now,
      source: 'self',
    });
  }
  return status;
}

/**
 * Cancels a self-registration. Pending registrations can always be cancelled;
 * accepted participants may cancel only before the contest starts.
 */
export function cancelRegistration(
  db: DatabaseSync,
  input: { contestId: number; userId: number; now?: number },
): void {
  const now = input.now ?? Date.now();
  const contest = requireContest(db, input.contestId);
  const row = requireRegistration(db, input.contestId, input.userId);
  if (row.status === 'pending') {
    deleteRegistrationRow(db, input.contestId, input.userId);
    return;
  }
  if (row.status !== 'accepted') {
    throw new ContestRegistrationError(
      'CANNOT_CANCEL',
      409,
      'only pending or accepted registrations can be cancelled',
    );
  }
  const started =
    contest.status === 'running' ||
    contest.status === 'frozen' ||
    (contest.start_at !== null && now >= contest.start_at);
  const ended =
    contest.status === 'ended' ||
    contest.status === 'archived' ||
    contest.archived_at !== null ||
    (contest.end_at !== null && now >= contest.end_at);
  if (started || ended) {
    throw new ContestRegistrationError(
      'CANNOT_CANCEL',
      409,
      'accepted registrations cannot be cancelled after the contest starts',
    );
  }
  deleteRegistrationRow(db, input.contestId, input.userId);
}

/** Approves or rejects a pending registration and records the reviewer. */
export function reviewRegistration(
  db: DatabaseSync,
  input: {
    contestId: number;
    userId: number;
    action: 'approve' | 'reject';
    actorId: number;
    now?: number;
  },
): void {
  const now = input.now ?? Date.now();
  requireContest(db, input.contestId);
  const row = requireRegistration(db, input.contestId, input.userId);
  if (row.status !== 'pending') {
    throw new ContestRegistrationError(
      'NOT_PENDING',
      409,
      'registration is not pending review',
    );
  }
  const status: RegistrationStatus = input.action === 'approve' ? 'accepted' : 'rejected';
  updateRegistration(db, input.contestId, input.userId, {
    status,
    reviewedAt: now,
    reviewedBy: input.actorId,
  });
  recordAudit(db, {
    actorId: input.actorId,
    action: `contest.registration.${input.action}`,
    targetType: 'contest_participant',
    targetId: `${input.contestId}:${input.userId}`,
    detail: { contestId: input.contestId, userId: input.userId, status },
  });
}

/** Marks an accepted participant as checked in. Repeated calls are idempotent. */
export function checkInParticipant(
  db: DatabaseSync,
  input: { contestId: number; userId: number; actorId: number; now?: number },
): void {
  const now = input.now ?? Date.now();
  requireContest(db, input.contestId);
  const row = requireRegistration(db, input.contestId, input.userId);
  if (row.status !== 'accepted') {
    throw new ContestRegistrationError(
      'NOT_ACCEPTED',
      403,
      'only accepted participants can check in',
    );
  }
  if (row.checked_in_at !== null) return;
  updateRegistration(db, input.contestId, input.userId, { checkedInAt: now });
  recordAudit(db, {
    actorId: input.actorId,
    action: 'contest.registration.check_in',
    targetType: 'contest_participant',
    targetId: `${input.contestId}:${input.userId}`,
    detail: { contestId: input.contestId, userId: input.userId, checkedInAt: now },
  });
}

export function getMyRegistration(
  db: DatabaseSync,
  contestId: number,
  userId: number,
): RegistrationDto | null {
  const row = getRegistrationWithUser(db, contestId, userId);
  return row ? toDto(row) : null;
}

/** Admin registration list with user profile and contest submission statistics. */
export function listRegistrations(db: DatabaseSync, contestId: number): RegistrationDto[] {
  return listRegistrationsWithStats(db, contestId).map(toDto);
}
