// Authentication service: login / current user / logout.
import type { DatabaseSync } from 'node:sqlite';
import type { UserDto } from '@oij/shared';
import type { Config } from '../config.js';
import { verifyPassword } from '../security/password.js';
import { signSession } from '../security/session.js';
import { permissionsForRole } from '../security/auth.js';
import {
  bumpSessionVersion,
  getUserById,
  getUserByUsername,
  type UserRow,
} from '../storage/repos/users.js';

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
