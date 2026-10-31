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
  created_at: number;
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  realName?: string | null;
  className?: string | null;
  role?: Role;
}

export function createUser(db: DatabaseSync, input: CreateUserInput): number {
  const result = db
    .prepare(
      `INSERT INTO users(username, password_hash, real_name, class_name, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.username,
      input.passwordHash,
      input.realName ?? null,
      input.className ?? null,
      input.role ?? 'contestant',
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

export function bumpSessionVersion(db: DatabaseSync, userId: number): void {
  db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(userId);
}
