import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { hashPassword } from '../security/password.js';
import { createUser, getUserByUsername } from '../storage/repos/users.js';

/** Creates the initial administrator when the user table is empty. */
export function ensureAdmin(db: DatabaseSync, config: Config): number | null {
  const existing = getUserByUsername(db, config.adminUsername);
  if (existing) return null;
  return createUser(db, {
    username: config.adminUsername,
    passwordHash: hashPassword(config.adminPassword),
    realName: 'Administrator',
    role: 'admin',
  });
}
