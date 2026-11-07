import { randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { hashPassword, verifyPassword } from '../security/password.js';
import {
  createUser,
  getUserByUsername,
  setMustChangePassword,
  type UserRow,
} from '../storage/repos/users.js';

/** The historical hard-coded administrator password; flagged on upgrade. */
export const LEGACY_ADMIN_PASSWORD = 'admin123';

export type InitialAdminReason = 'created' | 'legacy-default';

/**
 * One-time bootstrap information. `password` is set only when this process
 * generated it; it is never stored anywhere except the password hash, so it can
 * be displayed exactly once.
 */
export interface InitialAdmin {
  username: string;
  password: string | null;
  reason: InitialAdminReason;
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Ambiguous-character-free random password suitable for reading off a dialog. */
export function generateInitialPassword(length = 20): string {
  let password = '';
  for (let i = 0; i < length; i += 1) {
    password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
}

function adminCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as {
    n: number;
  };
  return row.n;
}

/**
 * Ensures an administrator exists without ever using a well-known password.
 *
 * - Fresh database: create the administrator with a random one-time password
 *   (or the explicit OIJ_ADMIN_PASSWORD) and mark it `must_change_password`.
 * - Existing admin still using `admin123`: force a password change and bump the
 *   session version so already-issued cookies stop working.
 *
 * The returned record is only produced when the caller must notify the user.
 */
export function ensureAdmin(db: DatabaseSync, config: Config): InitialAdmin | null {
  const existing: UserRow | null = getUserByUsername(db, config.adminUsername);

  if (existing) {
    if (existing.role === 'admin' && existing.must_change_password !== 1) {
      if (verifyPassword(LEGACY_ADMIN_PASSWORD, existing.password_hash)) {
        setMustChangePassword(db, existing.id, true);
        // Invalidate sessions created with the known default password.
        db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(
          existing.id,
        );
        return { username: existing.username, password: null, reason: 'legacy-default' };
      }
    }
    return null;
  }

  // A different administrator already exists: never create a second bootstrap
  // account, because the configured username may belong to another person.
  if (adminCount(db) > 0) return null;

  const explicitPassword =
    typeof config.adminPassword === 'string' && config.adminPassword.length > 0
      ? config.adminPassword
      : null;
  const password = explicitPassword ?? generateInitialPassword();
  createUser(db, {
    username: config.adminUsername,
    passwordHash: hashPassword(password),
    realName: 'Administrator',
    role: 'admin',
    // A randomly generated password is one-time and must be replaced. An
    // explicit OIJ_ADMIN_PASSWORD is an operator decision (automation/CI).
    mustChangePassword: explicitPassword === null,
  });
  return {
    username: config.adminUsername,
    password: explicitPassword ? null : password,
    reason: 'created',
  };
}
