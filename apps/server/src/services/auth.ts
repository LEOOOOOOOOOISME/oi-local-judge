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
  type UserRow,
} from '../storage/repos/users.js';

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
}

export interface MeResult {
  user: UserDto;
  permissions: string[];
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
  };
}

export function logout(db: DatabaseSync, userId: number): void {
  bumpSessionVersion(db, userId);
}
