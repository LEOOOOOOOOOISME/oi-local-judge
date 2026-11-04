import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import {
  SettingsValidationError,
  settingsView,
  writePersistedSettings,
  type PersistedSettings,
} from '../services/settings.js';
import { createBackup, getDiagnostics, listBackups, requestRestore, RestoreError } from '../services/system-ops.js';
import { getRuntimeMetrics } from '../services/metrics.js';
import {
  LearningStatsRebuildBusyError,
  rebuildLearningStatsNow,
} from '../services/learning-stats-scheduler.js';
import { listAuditLogs, recordAudit } from '../storage/repos/audit.js';

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
    '/api/admin/system/metrics',
    { preHandler: options.adminGuard },
    async () => ({ ok: true, data: getRuntimeMetrics(options.db, options.config) }),
  );

  // Manual rebuild of the learning-analytics cache tables. The rebuild is
  // synchronous; while it runs the event loop is blocked (reported by the
  // scheduler as a slow run). A concurrent request is rejected by the guard.
  app.post(
    '/api/admin/system/learning-stats/rebuild',
    { preHandler: options.adminGuard },
    async (request, reply) => {
      try {
        const result = rebuildLearningStatsNow(options.db);
        recordAudit(options.db, {
          actorId: request.user?.id ?? null,
          action: 'learning_stats.rebuild',
          targetType: 'learning_stats',
          detail: result,
          ip: request.ip,
        });
        return { ok: true, data: result };
      } catch (error) {
        if (error instanceof LearningStatsRebuildBusyError) {
          return reply.code(error.status).send({
            ok: false,
            error: { code: error.code, message: error.message },
          });
        }
        throw error;
      }
    },
  );

  app.get(
    '/api/admin/system/backups',
    { preHandler: options.adminGuard },
    async () => ({ ok: true, data: listBackups(options.config) }),
  );

  app.get(
    '/api/admin/system/settings',
    { preHandler: options.adminGuard },
    async () => ({ ok: true, data: settingsView(options.config, options.config.dataDir) }),
  );

  app.put<{ Body: PersistedSettings }>(
    '/api/admin/system/settings',
    { preHandler: options.adminGuard },
    async (request, reply) => {
      const body = request.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BAD_REQUEST', message: 'settings must be a JSON object' },
        });
      }
      // Persisted settings only take effect on the next start, so the running
      // config (and its effective values) is intentionally left untouched.
      try {
        writePersistedSettings(options.config.dataDir, body);
      } catch (error) {
        if (error instanceof SettingsValidationError) {
          return reply.code(400).send({
            ok: false,
            error: { code: 'BAD_REQUEST', message: error.message },
          });
        }
        throw error;
      }
      return {
        ok: true,
        data: {
          settings: settingsView(options.config, options.config.dataDir),
          restartRequired: true,
        },
      };
    },
  );

  app.post<{ Body: { backupId?: unknown; confirm?: unknown } }>(
    '/api/admin/system/restore',
    { preHandler: options.adminGuard },
    async (request, reply) => {
      const body = request.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BAD_REQUEST', message: 'restore request must be a JSON object' },
        });
      }
      // Destructive and applied on the next start, so require an explicit
      // confirmation token rather than a boolean.
      if (body.confirm !== 'RESTORE') {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BAD_REQUEST', message: 'confirm must be "RESTORE"' },
        });
      }
      if (typeof body.backupId !== 'string' || body.backupId.length === 0) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BAD_REQUEST', message: 'backupId is required' },
        });
      }
      try {
        // Stages the restore only: nothing is replaced while the server runs.
        const staged = requestRestore(options.config, body.backupId);
        return { ok: true, data: staged };
      } catch (error) {
        if (error instanceof RestoreError) {
          const status =
            error.code === 'INVALID_BACKUP_ID'
              ? 400
              : error.code === 'BACKUP_NOT_FOUND'
                ? 404
                : 500;
          return reply.code(status).send({
            ok: false,
            error: { code: error.code, message: error.message },
          });
        }
        throw error;
      }
    },
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
