// Session cookie helpers, authentication guards and the role -> permission map.
//
// Guards are preHandler factories so callers pass the database/config once:
//   app.get('/api/me', { preHandler: requireAuth({ db, config }) }, handler)
// No third-party cookie/plugin dependency is used.
import type { FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { getUserById, type Role, type UserRow } from '../storage/repos/users.js';
import {
  verifySession,
  type SessionIdentity,
} from './session.js';

export const SESSION_COOKIE = 'oij.sid';

export interface AuthGuardOptions {
  db: DatabaseSync;
  config: Config;
}

export interface AuthenticatedRequest {
  user: UserRow;
  session: SessionIdentity;
}

export interface SessionCookieOptions {
  /** Set the Secure attribute (HTTPS deployments). */
  secure?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
    session?: SessionIdentity;
  }
}

export const ALL_PERMISSIONS = [
  'user.view',
  'user.create',
  'user.import',
  'user.reset_password',
  'user.disable',
  'user.kick',
  'problem.create',
  'problem.edit',
  'problem.delete',
  'problem.view_data',
  'problem.export',
  'problem.import',
  'problem.publish',
  'problem.clone',
  'problem.view_std',
  'data.upload',
  'data.validate',
  'data.generate',
  'data.stress_test',
  'contest.create',
  'contest.edit',
  'contest.start',
  'contest.extend',
  'contest.pause',
  'contest.end',
  'contest.freeze',
  'contest.unfreeze',
  'contest.edit_problems',
  'contest.export',
  'judge.submit',
  'judge.rejudge_self',
  'judge.rejudge_any',
  'judge.cancel',
  'judge.view_detail',
  'community.post',
  'community.reply',
  'community.solution',
  'community.clarify',
  'community.dm',
  'community.attachment',
  'community.moderate',
  'stats.export',
  'stats.view',
  'stats.export_code',
  'system.settings',
  'system.backup',
  'system.restore',
  'system.audit',
  'system.roles',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

const SETTER_PERMISSIONS: readonly Permission[] = [
  'problem.create',
  'problem.edit',
  'problem.delete',
  'problem.view_data',
  'problem.export',
  'problem.import',
  'problem.publish',
  'problem.clone',
  'problem.view_std',
  'data.upload',
  'data.validate',
  'data.generate',
  'data.stress_test',
  'judge.submit',
  'judge.rejudge_self',
  'judge.rejudge_any',
  'judge.view_detail',
  'stats.view',
];

const CONTEST_MANAGER_PERMISSIONS: readonly Permission[] = [
  'user.view',
  'user.reset_password',
  'user.disable',
  'user.kick',
  'contest.create',
  'contest.edit',
  'contest.start',
  'contest.extend',
  'contest.pause',
  'contest.end',
  'contest.freeze',
  'contest.unfreeze',
  'contest.edit_problems',
  'contest.export',
  'judge.submit',
  'judge.rejudge_self',
  'judge.rejudge_any',
  'judge.cancel',
  'judge.view_detail',
  'community.clarify',
  'stats.view',
  'stats.export',
];

const CONTESTANT_PERMISSIONS: readonly Permission[] = [
  'judge.submit',
  'judge.rejudge_self',
  'judge.view_detail',
  'community.post',
  'community.reply',
  'community.solution',
  'community.clarify',
  'community.dm',
  'community.attachment',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: ALL_PERMISSIONS,
  setter: SETTER_PERMISSIONS,
  contestmanager: CONTEST_MANAGER_PERMISSIONS,
  contestant: CONTESTANT_PERMISSIONS,
};

export function permissionsForRole(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name === '' || name in cookies) {
      continue;
    }
    cookies[name] = part.slice(separator + 1).trim();
  }
  return cookies;
}

export function readSessionToken(request: {
  headers: { cookie?: string | string[] };
}): string | null {
  const raw = request.headers.cookie;
  const header = Array.isArray(raw) ? raw.join('; ') : raw;
  const token = parseCookieHeader(header)[SESSION_COOKIE];
  return token && token.length > 0 ? token : null;
}

export function serializeSessionCookie(
  token: string,
  ttlSec: number,
  options: SessionCookieOptions = {},
): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(ttlSec))}`,
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function serializeClearedSessionCookie(options: SessionCookieOptions = {}): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Reads the cookie token, verifies signature/expiry, loads the user and checks
 * `users.session_version` so logout/role changes invalidate older tokens.
 */
export function authenticateRequest(
  request: { headers: { cookie?: string | string[] } },
  options: AuthGuardOptions,
): AuthenticatedRequest | null {
  const token = readSessionToken(request);
  if (!token) {
    return null;
  }
  const session = verifySession(token, options.config.sessionSecret);
  if (!session) {
    return null;
  }
  const user = getUserById(options.db, session.userId);
  if (!user || user.status !== 'active' || user.session_version !== session.version) {
    return null;
  }
  return { user, session };
}

/**
 * Endpoints a user must still be able to reach while the forced password
 * change is pending. Everything else is blocked by the guards below.
 */
const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  '/api/auth/change-password',
  '/api/auth/logout',
  '/api/me',
]);

function passwordChangePending(user: UserRow, url: string): boolean {
  if (user.must_change_password !== 1) return false;
  return !PASSWORD_CHANGE_ALLOWED_PATHS.has(url.split('?')[0]);
}

function rejectPasswordChangeRequired(reply: FastifyReply): unknown {
  return reply.code(403).send({
    ok: false,
    error: {
      code: 'PASSWORD_CHANGE_REQUIRED',
      message: 'password change required before using this API',
    },
  });
}

export function requireAuth(options: AuthGuardOptions): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const authenticated = authenticateRequest(request, options);
    if (!authenticated) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'authentication required' },
      });
    }
    if (passwordChangePending(authenticated.user, request.url)) {
      return rejectPasswordChangeRequired(reply);
    }
    request.user = authenticated.user;
    request.session = authenticated.session;
  };
}

export function requireRole(
  role: Role | Role[],
  options: AuthGuardOptions,
): preHandlerAsyncHookHandler {
  const allowed = new Set<Role>(Array.isArray(role) ? role : [role]);
  return async (request, reply) => {
    const authenticated = authenticateRequest(request, options);
    if (!authenticated) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'authentication required' },
      });
    }
    if (passwordChangePending(authenticated.user, request.url)) {
      return rejectPasswordChangeRequired(reply);
    }
    if (!allowed.has(authenticated.user.role)) {
      return reply.code(403).send({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'insufficient role' },
      });
    }
    request.user = authenticated.user;
    request.session = authenticated.session;
  };
}
