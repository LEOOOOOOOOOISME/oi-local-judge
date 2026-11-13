// HTTP auth routes:
//   POST /api/auth/login
//   POST /api/auth/logout
//   GET  /api/me
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import {
  requireAuth,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from '../security/auth.js';
import { AuthInputError, changePassword, login, logout, me, register } from '../services/auth.js';
import { recordAudit } from '../storage/repos/audit.js';
import { BoundedTtlMap } from './auth-rate-limit.js';

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_IP_MAX_FAILURES = 20;

// Bounded so rotating usernames/IPs cannot grow process memory without limit.
const loginFailures = new BoundedTtlMap<number>(5000, LOGIN_WINDOW_MS);
const registrationAttempts = new BoundedTtlMap<number>(5000, LOGIN_WINDOW_MS);
const REGISTRATION_MAX_ATTEMPTS = 5;

/** Test/ops helper: clear in-memory throttles without restarting the process. */
export function resetAuthRateLimits(): void {
  loginFailures.clear();
  registrationAttempts.clear();
}

function allowRegistration(key: string): boolean {
  const recent = registrationAttempts.get(key);
  if (recent.length >= REGISTRATION_MAX_ATTEMPTS) return false;
  registrationAttempts.record(key, Date.now());
  return true;
}

function tooManyFailures(key: string, max = LOGIN_MAX_FAILURES): boolean {
  return loginFailures.get(key).length >= max;
}

export interface AuthRoutesOptions {
  db: DatabaseSync;
  config: Config;
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  { db, config }: AuthRoutesOptions,
): Promise<void> {
  app.post('/api/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as LoginBody;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (username === '' || password === '') {
      return reply.code(400).send({
        ok: false,
        error: { code: 'INVALID_INPUT', message: 'username and password are required' },
      });
    }

    const userKey = `user:${request.ip}:${username.toLowerCase()}`;
    const ipKey = `ip:${request.ip}`;
    // Check the lock before verifying the password: a locked-out caller must
    // not be able to spend the password-hash cost, even with the right password.
    if (tooManyFailures(userKey) || tooManyFailures(ipKey, LOGIN_IP_MAX_FAILURES)) {
      reply.header('retry-after', '600');
      return reply.code(429).send({
        ok: false,
        error: { code: 'TOO_MANY_ATTEMPTS', message: 'too many failed logins, try again later' },
      });
    }

    const result = login(db, config, username, password);
    if (!result) {
      loginFailures.record(userKey, Date.now());
      loginFailures.record(ipKey, Date.now());
      recordAudit(db, {
        action: 'auth.login_failed',
        detail: { username },
        ip: request.ip,
      });
      return reply.code(401).send({
        ok: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'invalid username or password' },
      });
    }

    loginFailures.delete(userKey);
    loginFailures.delete(ipKey);
    recordAudit(db, {
      actorId: result.user.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: result.user.id,
      ip: request.ip,
    });

    reply.header('set-cookie', serializeSessionCookie(result.token, config.sessionTtlSec, { secure: config.secureCookies === true }));
    reply.header('cache-control', 'no-store');
    return {
      ok: true,
      data: { user: result.user, mustChangePassword: result.mustChangePassword },
    };
  });

  app.post('/api/auth/register', async (request, reply) => {
    const body = (request.body ?? {}) as LoginBody;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'INVALID_INPUT', message: 'username and password are required' },
      });
    }
    if (!allowRegistration(request.ip)) {
      reply.header('retry-after', '600');
      return reply.code(429).send({
        ok: false,
        error: {
          code: 'TOO_MANY_REGISTRATIONS',
          message: 'too many registrations, try again later',
        },
      });
    }
    try {
      const result = register(db, config, { username, password });
      recordAudit(db, {
        actorId: result.user.id,
        action: 'auth.register',
        targetType: 'user',
        targetId: result.user.id,
        detail: { username: result.user.username },
        ip: request.ip,
      });
      reply.header('set-cookie', serializeSessionCookie(result.token, config.sessionTtlSec, { secure: config.secureCookies === true }));
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        ok: true,
        data: { user: result.user, permissions: result.permissions },
      });
    } catch (err) {
      if (err instanceof AuthInputError) {
        return reply.code(err.status).send({
          ok: false,
          error: { code: err.code, message: err.message },
        });
      }
      throw err;
    }
  });

  app.post(
    '/api/auth/change-password',
    { preHandler: requireAuth({ db, config }) },
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        currentPassword?: unknown;
        newPassword?: unknown;
      };
      const currentPassword =
        typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      if (currentPassword === '' || newPassword === '') {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'currentPassword and newPassword are required',
          },
        });
      }
      try {
        const result = changePassword(db, config, request.user!.id, {
          currentPassword,
          newPassword,
        });
        recordAudit(db, {
          actorId: result.user.id,
          action: 'auth.password_changed',
          targetType: 'user',
          targetId: result.user.id,
          ip: request.ip,
        });
        reply.header('set-cookie', serializeSessionCookie(result.token, config.sessionTtlSec, { secure: config.secureCookies === true }));
        reply.header('cache-control', 'no-store');
        return {
          ok: true,
          data: {
            user: result.user,
            permissions: result.permissions,
            mustChangePassword: false,
          },
        };
      } catch (err) {
        if (err instanceof AuthInputError) {
          return reply.code(err.status).send({
            ok: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/auth/logout',
    { preHandler: requireAuth({ db, config }) },
    async (request, reply) => {
      if (request.user) {
        logout(db, request.user.id);
      }
      reply.header('set-cookie', serializeClearedSessionCookie({ secure: config.secureCookies === true }));
      reply.header('cache-control', 'no-store');
      return { ok: true, data: { loggedOut: true } };
    },
  );

  app.get('/api/me', { preHandler: requireAuth({ db, config }) }, async (request, reply) => {
    const result = request.user ? me(db, request.user.id) : null;
    if (!result) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'authentication required' },
      });
    }
    reply.header('cache-control', 'no-store');
    return { ok: true, data: result };
  });
}

