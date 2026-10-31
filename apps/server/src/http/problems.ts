import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import {
  getProblemDetail,
  importProblemDirectory,
  listProblemDtos,
} from '../services/problems.js';

export interface ProblemRouteOptions {
  db: DatabaseSync;
  config: Config;
  adminGuard?: preHandlerHookHandler;
}

export function registerProblemRoutes(app: FastifyInstance, options: ProblemRouteOptions): void {
  app.get('/api/problems', async () => ({
    ok: true,
    data: listProblemDtos(options.db),
  }));

  app.get<{ Params: { id: string } }>('/api/problems/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const problem = Number.isInteger(id) ? getProblemDetail(options.db, id) : null;
    if (!problem || problem.visibility === 'hidden') {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'problem not found' } });
    }
    return { ok: true, data: problem };
  });

  const guards = options.adminGuard ? [options.adminGuard] : [];
  app.post<{ Body: { path?: string } }>(
    '/api/admin/problems/import',
    { preHandler: guards },
    async (request, reply) => {
      const path = request.body?.path;
      if (!path) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BAD_REQUEST', message: 'path is required' },
        });
      }
      try {
        const id = importProblemDirectory({
          db: options.db,
          config: options.config,
          sourceDir: path,
        });
        return reply.code(201).send({ ok: true, data: { id } });
      } catch (err) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'IMPORT_FAILED', message: (err as Error).message },
        });
      }
    },
  );
}
