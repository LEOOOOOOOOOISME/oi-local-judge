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
import { login, logout, me } from '../services/auth.js';

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
      return reply.code(401).send({
        ok: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'invalid username or password' },
      });
    }

    reply.header('set-cookie', serializeSessionCookie(result.token, config.sessionTtlSec));
    reply.header('cache-control', 'no-store');
    return { ok: true, data: { user: result.user } };
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
