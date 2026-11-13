import type { DatabaseSync } from 'node:sqlite';

export type Role = 'admin' | 'setter' | 'contestmanager' | 'contestant';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  real_name: string | null;
  class_name: string | null;
  role: Role;
  status: string;
  session_version: number;
  must_change_password: number;
  created_at: number;
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  realName?: string | null;
  className?: string | null;
  role?: Role;
  /** Set for bootstrap/reset passwords that the user must replace on first login. */
  mustChangePassword?: boolean;
}

export function createUser(db: DatabaseSync, input: CreateUserInput): number {
  const result = db
    .prepare(
      `INSERT INTO users(
         username, password_hash, real_name, class_name, role, must_change_password, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.username,
      input.passwordHash,
      input.realName ?? null,
      input.className ?? null,
      input.role ?? 'contestant',
      input.mustChangePassword ? 1 : 0,
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

export function getUserByUsername(db: DatabaseSync, username: string): UserRow | null {
  return (db.prepare('SELECT * FROM users WHERE username = ?').get(username) as unknown as UserRow) ?? null;
}

export function getUserById(db: DatabaseSync, id: number): UserRow | null {
  return (db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow) ?? null;
}

export function listAdmins(db: DatabaseSync): UserRow[] {
  return db
    .prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id")
    .all() as unknown as UserRow[];
}

export function bumpSessionVersion(db: DatabaseSync, userId: number): void {
  db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(userId);
}

/** Only marks/unmarks the forced-change flag; session invalidation is separate. */
export function setMustChangePassword(
  db: DatabaseSync,
  userId: number,
  required: boolean,
): void {
  db.prepare('UPDATE users SET must_change_password = ? WHERE id = ?').run(
    required ? 1 : 0,
    userId,
  );
}

/**
 * Replaces a password, clears the forced-change flag and increments
 * session_version so every token signed with the old password is rejected.
 */
export function setUserPasswordAndClearFlag(
  db: DatabaseSync,
  userId: number,
  passwordHash: string,
): void {
  db.prepare(
    `UPDATE users
        SET password_hash = ?, must_change_password = 0, session_version = session_version + 1
      WHERE id = ?`,
  ).run(passwordHash, userId);
}

export function listUsers(
  db: DatabaseSync,
  filter: { query?: string; className?: string; limit?: number } = {},
): UserRow[] {  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.query) {
    clauses.push('(username LIKE ? OR real_name LIKE ?)');
    params.push(`%${filter.query}%`, `%${filter.query}%`);
  }
  if (filter.className) {
    clauses.push('class_name = ?');
    params.push(filter.className);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  return db
    .prepare(`SELECT * FROM users ${where} ORDER BY class_name, username LIMIT ?`)
    .all(...params, limit) as unknown as UserRow[];
}

export function updateUserProfile(
  db: DatabaseSync,
  id: number,
  patch: {
    realName?: string | null;
    className?: string | null;
    role?: string;
    status?: string;
  },
): boolean {
  const sets: string[] = [];
  const values: Array<string | null> = [];
  if (patch.realName !== undefined) {
    sets.push('real_name = ?');
    values.push(patch.realName);
  }
  if (patch.className !== undefined) {
    sets.push('class_name = ?');
    values.push(patch.className);
  }
  if (patch.role !== undefined) {
    sets.push('role = ?');
    values.push(patch.role);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (sets.length === 0) return false;
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  bumpSessionVersion(db, id);
  return true;
}

export function setUserPasswordHash(db: DatabaseSync, id: number, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  bumpSessionVersion(db, id);
}
