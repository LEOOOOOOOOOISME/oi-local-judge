import type { DatabaseSync } from 'node:sqlite';
import type { ParticipantSource } from './contests.js';

export const REGISTRATION_STATUSES = ['accepted', 'pending', 'rejected'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export function isRegistrationStatus(value: unknown): value is RegistrationStatus {
  return (
    typeof value === 'string' && (REGISTRATION_STATUSES as readonly string[]).includes(value)
  );
}

export interface RegistrationRow {
  contest_id: number;
  user_id: number;
  status: string;
  extra_time: number;
  hidden_at: number | null;
  registered_at: number | null;
  checked_in_at: number | null;
  reviewed_at: number | null;
  reviewed_by: number | null;
  /** Provenance: `manual` (admin), `self` (self-registration) or `team`. */
  source: string;
}

export interface RegistrationWithUserRow extends RegistrationRow {
  username: string;
  real_name: string | null;
  class_name: string | null;
  submission_count: number;
  last_submission_at: number | null;
}

const REGISTRATION_COLUMNS = `
  p.contest_id, p.user_id, p.status, p.extra_time, p.hidden_at,
  p.registered_at, p.checked_in_at, p.reviewed_at, p.reviewed_by,
  u.username, u.real_name, u.class_name,
  (SELECT COUNT(*) FROM submissions s
     WHERE s.contest_id = p.contest_id AND s.user_id = p.user_id) AS submission_count,
  (SELECT MAX(s.created_at) FROM submissions s
     WHERE s.contest_id = p.contest_id AND s.user_id = p.user_id) AS last_submission_at`;

export function getRegistrationRow(
  db: DatabaseSync,
  contestId: number,
  userId: number,
): RegistrationRow | null {
  return (
    (db
      .prepare('SELECT * FROM contest_participants WHERE contest_id = ? AND user_id = ?')
      .get(contestId, userId) as unknown as RegistrationRow | undefined) ?? null
  );
}

export function getRegistrationWithUser(
  db: DatabaseSync,
  contestId: number,
  userId: number,
): RegistrationWithUserRow | null {
  return (
    (db
      .prepare(
        `SELECT ${REGISTRATION_COLUMNS}
         FROM contest_participants p JOIN users u ON u.id = p.user_id
         WHERE p.contest_id = ? AND p.user_id = ?`,
      )
      .get(contestId, userId) as unknown as RegistrationWithUserRow | undefined) ?? null
  );
}

export function listRegistrationsWithStats(
  db: DatabaseSync,
  contestId: number,
): RegistrationWithUserRow[] {
  return db
    .prepare(
      `SELECT ${REGISTRATION_COLUMNS}
       FROM contest_participants p JOIN users u ON u.id = p.user_id
       WHERE p.contest_id = ?
       ORDER BY u.class_name, u.username`,
    )
    .all(contestId) as unknown as RegistrationWithUserRow[];
}

export function insertRegistration(
  db: DatabaseSync,
  input: {
    contestId: number;
    userId: number;
    status: RegistrationStatus;
    now: number;
    source?: ParticipantSource;
  },
): void {
  db.prepare(
    `INSERT INTO contest_participants(contest_id, user_id, status, registered_at, source)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.contestId, input.userId, input.status, input.now, input.source ?? 'self');
}

export interface RegistrationPatch {
  status?: RegistrationStatus;
  registeredAt?: number | null;
  checkedInAt?: number | null;
  reviewedAt?: number | null;
  reviewedBy?: number | null;
  source?: ParticipantSource;
}

export function updateRegistration(
  db: DatabaseSync,
  contestId: number,
  userId: number,
  patch: RegistrationPatch,
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const add = (column: string, value: string | number | null | undefined) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    values.push(value);
  };
  add('status', patch.status);
  add('registered_at', patch.registeredAt);
  add('checked_in_at', patch.checkedInAt);
  add('reviewed_at', patch.reviewedAt);
  add('reviewed_by', patch.reviewedBy);
  add('source', patch.source);
  if (sets.length === 0) return;
  db.prepare(
    `UPDATE contest_participants SET ${sets.join(', ')} WHERE contest_id = ? AND user_id = ?`,
  ).run(...values, contestId, userId);
}

export function deleteRegistrationRow(
  db: DatabaseSync,
  contestId: number,
  userId: number,
): void {
  db.prepare('DELETE FROM contest_participants WHERE contest_id = ? AND user_id = ?').run(
    contestId,
    userId,
  );
}
