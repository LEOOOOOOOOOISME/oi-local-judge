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

  app.post<{
    Body: { csv?: string; defaultPassword?: string };
  }>('/api/admin/users/import', { preHandler: options.adminGuard }, async (request, reply) => {
    const text = request.body?.csv;
    if (!text || typeof text !== 'string') {
      return reply.code(400).send({ ok: false, error: { code: 'EMPTY_CSV' } });
    }
    const defaultPassword = request.body?.defaultPassword ?? '123456';
    const created: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ line: number; message: string }> = [];
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '');
    lines.forEach((line, index) => {
      if (index === 0 && /username|用户名/i.test(line)) return;
      const parts = line.split(',').map((part) => part.trim());
      const username = parts[0];
      const password = parts[1] || defaultPassword;
      if (!username) {
        errors.push({ line: index + 1, message: 'missing username' });
        return;
      }
      if (password.length < 4) {
        errors.push({ line: index + 1, message: 'password too short' });
        return;
      }
      if (getUserByUsername(options.db, username)) {
        skipped.push(username);
        return;
      }
      createUser(options.db, {
        username,
        passwordHash: hashPassword(password),
        realName: parts[2] || null,
        className: parts[3] || null,
        role: parts[4] === 'admin' || parts[4] === 'setter' ? parts[4] : 'contestant',
      });
      created.push(username);
    });
    return { ok: true, data: { created, skipped, errors } };
  });
}
