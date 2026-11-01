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
import { AuthInputError, login, logout, me, register } from '../services/auth.js';
import { recordAudit } from '../storage/repos/audit.js';

const loginFailures = new Map<string, number[]>();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

const registrationAttempts = new Map<string, number[]>();
const REGISTRATION_WINDOW_MS = 10 * 60 * 1000;
const REGISTRATION_MAX_ATTEMPTS = 5;

function allowRegistration(key: string): boolean {
  const now = Date.now();
  const recent = (registrationAttempts.get(key) ?? []).filter(
    (value) => now - value < REGISTRATION_WINDOW_MS,
  );
  if (recent.length >= REGISTRATION_MAX_ATTEMPTS) {
    registrationAttempts.set(key, recent);
    return false;
  }
  recent.push(now);
  registrationAttempts.set(key, recent);
  return true;
}

function tooManyFailures(key: string): boolean {
  const now = Date.now();
  const recent = (loginFailures.get(key) ?? []).filter((value) => now - value < LOGIN_WINDOW_MS);
  loginFailures.set(key, recent);
  return recent.length >= LOGIN_MAX_FAILURES;
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

    const result = login(db, config, username, password);
    if (!result) {
      const key = `${request.ip}:${username.toLowerCase()}`;
      const failures = loginFailures.get(key) ?? [];
      failures.push(Date.now());
      loginFailures.set(key, failures);
      recordAudit(db, {
        action: 'auth.login_failed',
        detail: { username },
        ip: request.ip,
      });
      if (tooManyFailures(key)) {
        reply.header('retry-after', '600');
        return reply.code(429).send({
          ok: false,
          error: { code: 'TOO_MANY_ATTEMPTS', message: 'too many failed logins, try again later' },
        });
      }
      return reply.code(401).send({
        ok: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'invalid username or password' },
      });
    }

    loginFailures.delete(`${request.ip}:${username.toLowerCase()}`);
    recordAudit(db, {
      actorId: result.user.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: result.user.id,
      ip: request.ip,
    });

    reply.header('set-cookie', serializeSessionCookie(result.token, config.sessionTtlSec));
    reply.header('cache-control', 'no-store');
    return { ok: true, data: { user: result.user } };
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
      reply.header('set-cookie', serializeSessionCookie(result.token, config.sessionTtlSec));
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
    '/api/auth/logout',
    { preHandler: requireAuth({ db, config }) },
    async (request, reply) => {
      if (request.user) {
        logout(db, request.user.id);
      }
      reply.header('set-cookie', serializeClearedSessionCookie());
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
