import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { listAuditLogs } from '../storage/repos/audit.js';

export function registerAdminSystemRoutes(
  app: FastifyInstance,
  options: { db: DatabaseSync; adminGuard: preHandlerHookHandler },
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
}
