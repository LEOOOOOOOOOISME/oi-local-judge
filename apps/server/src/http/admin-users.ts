import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../security/password.js';
import { createUser, getUserByUsername, listUsers } from '../storage/repos/users.js';

export interface AdminUserRouteOptions {
  db: DatabaseSync;
  adminGuard: preHandlerHookHandler;
}

function toDto(row: ReturnType<typeof listUsers>[number]) {
  return {
    id: row.id,
    username: row.username,
    realName: row.real_name,
    className: row.class_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function registerAdminUserRoutes(
  app: FastifyInstance,
  options: AdminUserRouteOptions,
): void {
  app.get<{ Querystring: { query?: string; class?: string; limit?: string } }>(
    '/api/admin/users',
    { preHandler: options.adminGuard },
    async (request) => ({
      ok: true,
      data: listUsers(options.db, {
        query: request.query.query,
        className: request.query.class,
        limit: request.query.limit ? Number(request.query.limit) : 200,
      }).map(toDto),
    }),
  );

  app.post<{
    Body: {
      username?: string;
      password?: string;
      realName?: string;
      className?: string;
      role?: 'admin' | 'setter' | 'contestmanager' | 'contestant';
    };
  }>('/api/admin/users', { preHandler: options.adminGuard }, async (request, reply) => {
    const body = request.body ?? {};
    const username = body.username?.trim();
    if (!username || !body.password || body.password.length < 4) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'username and password (>=4) are required' },
      });
    }
    if (getUserByUsername(options.db, username)) {
      return reply.code(409).send({ ok: false, error: { code: 'USER_EXISTS' } });
    }
    const id = createUser(options.db, {
      username,
      passwordHash: hashPassword(body.password),
      realName: body.realName ?? null,
      className: body.className ?? null,
      role: body.role ?? 'contestant',
    });
    return reply.code(201).send({ ok: true, data: { id } });
  });
}
