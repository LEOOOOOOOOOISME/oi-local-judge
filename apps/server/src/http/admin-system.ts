import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { createBackup, getDiagnostics, listBackups } from '../services/system-ops.js';
import { listAuditLogs } from '../storage/repos/audit.js';

export function registerAdminSystemRoutes(
  app: FastifyInstance,
  options: { db: DatabaseSync; config: Config; adminGuard: preHandlerHookHandler },
): void {
  app.get<{ Querystring: { limit?: string } }>(
    '/api/admin/audit',
    { preHandler: options.adminGuard },
    async (request) => ({
      ok: true,
      data: listAuditLogs(options.db, request.query.limit ? Number(request.query.limit) : 200).map(
        (row) => ({
          id: row.id,
          actorId: row.actor_id,
          action: row.action,
          targetType: row.target_type,
          targetId: row.target_id,
          detail: JSON.parse(row.detail_json) as unknown,
          ip: row.ip,
          createdAt: row.created_at,
        }),
      ),
    }),
  );

  app.get(
    '/api/admin/system/diagnostics',
    { preHandler: options.adminGuard },
    async () => ({ ok: true, data: getDiagnostics(options.db, options.config) }),
  );

  app.get(
    '/api/admin/system/backups',
    { preHandler: options.adminGuard },
    async () => ({ ok: true, data: listBackups(options.config) }),
  );

  app.post(
    '/api/admin/system/backups',
    { preHandler: options.adminGuard },
    async (_request, reply) => {
      const entry = createBackup(options.db, options.config);
      return reply.code(201).send({ ok: true, data: entry });
    },
  );
}
