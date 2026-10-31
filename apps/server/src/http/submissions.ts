import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { requireAuth } from '../security/auth.js';
import { getSubmissionDetail, submitSource } from '../services/submissions.js';
import { listSubmissions, getSubmission } from '../storage/repos/submissions.js';

export interface SubmissionRouteOptions {
  db: DatabaseSync;
  config: Config;
}

export function registerSubmissionRoutes(
  app: FastifyInstance,
  options: SubmissionRouteOptions,
): void {
  const auth = requireAuth(options);

  app.post<{
    Body: {
      problemId?: number;
      language?: string;
      code?: string;
      contestId?: number | null;
    };
  }>('/api/submissions', { preHandler: auth }, async (request, reply) => {
    const body = request.body ?? {};
    if (!body.problemId || !body.language || typeof body.code !== 'string') {
      return reply.code(400).send({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'problemId, language and code are required' },
      });
    }
    try {
      const { id } = submitSource(
        { db: options.db, config: options.config },
        {
          userId: request.user!.id,
          problemId: body.problemId,
          language: body.language,
          code: body.code,
          contestId: body.contestId ?? null,
        },
      );
      return reply.code(201).send({ ok: true, data: { id, status: 'queued' } });
    } catch (err) {
      const message = (err as Error).message;
      const status = /too large/.test(message) ? 413 : /not found/.test(message) ? 404 : 400;
      return reply.code(status).send({ ok: false, error: { code: 'SUBMIT_FAILED', message } });
    }
  });

  app.get<{ Params: { id: string } }>(
    '/api/submissions/:id',
    { preHandler: auth },
    async (request, reply) => {
      const id = Number(request.params.id);
      const detail = Number.isInteger(id) ? getSubmissionDetail(options.db, id) : null;
      if (!detail) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const canViewAll = ['admin', 'setter', 'contestmanager'].includes(request.user!.role);
      if (!canViewAll && detail.userId !== request.user!.id) {
        return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN' } });
      }
      const row = getSubmission(options.db, id)!;
      try {
        detail.code = readFileSync(join(options.config.dataDir, row.source_path), 'utf8');
      } catch {
        detail.code = '';
      }
      return { ok: true, data: detail };
    },
  );

  app.get<{
    Querystring: {
      userId?: string;
      problemId?: string;
      contestId?: string;
      beforeId?: string;
      limit?: string;
    };
  }>('/api/submissions', { preHandler: auth }, async (request) => {
    const canViewAll = ['admin', 'setter', 'contestmanager'].includes(request.user!.role);
    const requestedUser = request.query.userId === 'me' ? request.user!.id : Number(request.query.userId);
    const userId = Number.isInteger(requestedUser) && requestedUser > 0 ? requestedUser : request.user!.id;
    const rows = listSubmissions(options.db, {
      userId: canViewAll ? (userId || undefined) : request.user!.id,
      problemId: request.query.problemId ? Number(request.query.problemId) : undefined,
      contestId: request.query.contestId ? Number(request.query.contestId) : undefined,
      beforeId: request.query.beforeId ? Number(request.query.beforeId) : undefined,
      limit: request.query.limit ? Number(request.query.limit) : 20,
    });
    return { ok: true, data: rows.map((row) => getSubmissionDetail(options.db, row.id)) };
  });
}
