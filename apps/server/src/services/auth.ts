// Authentication service: login / current user / logout.
import type { DatabaseSync } from 'node:sqlite';
import type { UserDto } from '@oij/shared';
import type { Config } from '../config.js';
import { verifyPassword, hashPassword } from '../security/password.js';
import { signSession } from '../security/session.js';
import { permissionsForRole } from '../security/auth.js';
import {
  bumpSessionVersion,
  createUser,
  getUserById,
  getUserByUsername,
  setUserPasswordAndClearFlag,
  type UserRow,
} from '../storage/repos/users.js';
import { LEGACY_ADMIN_PASSWORD } from './bootstrap.js';

export interface RegisterResult {
  user: UserDto;
  token: string;
  permissions: string[];
}

export class AuthInputError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'AuthInputError';
    this.code = code;
    this.status = status;
  }
}

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;

export function register(
  db: DatabaseSync,
  config: Config,
  input: { username: string; password: string },
): RegisterResult {
  const username = input.username.trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw new AuthInputError(
      'INVALID_USERNAME',
      400,
      'username must be 3-32 letters, digits, dot, underscore or hyphen',
    );
  }
  if (input.password.length < 8 || input.password.length > 72) {
    throw new AuthInputError('INVALID_PASSWORD', 400, 'password must be 8-72 characters');
  }
  if (getUserByUsername(db, username)) {
    throw new AuthInputError('USERNAME_TAKEN', 409, 'username is already taken');
  }
  const userId = createUser(db, {
    username,
    passwordHash: hashPassword(input.password),
    role: 'contestant',
  });
  const user = getUserById(db, userId)!;
  const token = signSession(
    { userId: user.id, version: user.session_version },
    config.sessionSecret,
    config.sessionTtlSec,
  );
  return {
    user: toUserDto(user),
    token,
    permissions: permissionsForRole(user.role),
  };
}

export interface LoginResult {
  user: UserDto;
  token: string;
  permissions: string[];
  /** True until the bootstrap/admin-reset password has been replaced. */
  mustChangePassword: boolean;
}

export interface MeResult {
  user: UserDto;
  permissions: string[];
  mustChangePassword: boolean;
}

export function toUserDto(user: UserRow): UserDto {
  return {
    id: user.id,
    username: user.username,
    realName: user.real_name,
    className: user.class_name,
    role: user.role,
  };
}

export function login(
  db: DatabaseSync,
  config: Config,
  username: string,
  password: string,
): LoginResult | null {
  const user = getUserByUsername(db, username.trim());
  if (!user || user.status !== 'active') {
    return null;
  }
  if (!verifyPassword(password, user.password_hash)) {
    return null;
  }

  const token = signSession(
    { userId: user.id, version: user.session_version },
    config.sessionSecret,
    config.sessionTtlSec,
  );
  return {
    user: toUserDto(user),
    token,
    permissions: permissionsForRole(user.role),
    mustChangePassword: user.must_change_password === 1,
  };
}

export function me(db: DatabaseSync, userId: number): MeResult | null {
  const user = getUserById(db, userId);
  if (!user || user.status !== 'active') {
    return null;
  }
  return {
    user: toUserDto(user),
    permissions: permissionsForRole(user.role),
    mustChangePassword: user.must_change_password === 1,
  };
}

/** Minimum length mirrors account registration. */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordResult extends LoginResult {
  mustChangePassword: false;
}

/**
 * Self-service password change. Used both for the forced first-login change and
 * for voluntary changes; the old session is invalidated by the version bump and
 * a fresh token is returned so the user stays signed in.
 */
export function changePassword(
  db: DatabaseSync,
  config: Config,
  userId: number,
  input: ChangePasswordInput,
): ChangePasswordResult {
  const user = getUserById(db, userId);
  if (!user || user.status !== 'active') {
    throw new AuthInputError('UNAUTHORIZED', 401, 'authentication required');
  }
  if (!verifyPassword(input.currentPassword, user.password_hash)) {
    throw new AuthInputError('INVALID_CREDENTIALS', 401, 'current password is incorrect');
  }
  const next = input.newPassword;
  if (next.length < MIN_PASSWORD_LENGTH || next.length > MAX_PASSWORD_LENGTH) {
    throw new AuthInputError(
      'WEAK_PASSWORD',
      400,
      `password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`,
    );
  }
  if (
    next === input.currentPassword ||
    next === LEGACY_ADMIN_PASSWORD ||
    next.toLowerCase() === user.username.toLowerCase()
  ) {
    throw new AuthInputError('WEAK_PASSWORD', 400, 'choose a different, non-default password');
  }

  setUserPasswordAndClearFlag(db, user.id, hashPassword(next));
  const updated = getUserById(db, user.id)!;
  const token = signSession(
    { userId: updated.id, version: updated.session_version },
    config.sessionSecret,
    config.sessionTtlSec,
  );
  return {
    user: toUserDto(updated),
    token,
    permissions: permissionsForRole(updated.role),
    mustChangePassword: false,
  };
}

export function logout(db: DatabaseSync, userId: number): void {
  bumpSessionVersion(db, userId);
}
