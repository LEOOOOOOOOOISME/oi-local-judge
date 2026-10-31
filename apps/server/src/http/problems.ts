import { createReadStream, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import {
  getProblemDetail,
  importProblemDirectory,
  listProblemDtos,
  stripObjectiveAnswers,
} from '../services/problems.js';
import { getProblem, getTestcases } from '../storage/repos/problems.js';

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
    return { ok: true, data: stripObjectiveAnswers(problem) };
  });

  app.get<{ Params: { id: string } }>('/api/problems/:id/answer-files', async (request, reply) => {
    const problem = getProblem(options.db, Number(request.params.id));
    if (!problem || problem.type !== 'output-only' || problem.visibility === 'hidden') {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    return {
      ok: true,
      data: getTestcases(options.db, problem.id).map((testcase) => ({
        id: testcase.id,
        ordinal: testcase.ordinal,
        points: testcase.points,
        inputUrl: `/api/problems/${problem.id}/answer-files/${testcase.id}`,
      })),
    };
  });

  app.get<{ Params: { id: string; testcaseId: string } }>(
    '/api/problems/:id/answer-files/:testcaseId',
    async (request, reply) => {
      const problem = getProblem(options.db, Number(request.params.id));
      if (!problem || problem.type !== 'output-only' || problem.visibility === 'hidden') {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const testcase = getTestcases(options.db, problem.id).find(
        (row) => row.id === Number(request.params.testcaseId),
      );
      if (!testcase) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      const absolute = join(options.config.dataDir, testcase.input_path);
      if (!absolute.startsWith(options.config.dataDir) || !existsSync(absolute)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return reply
        .header('content-type', 'text/plain; charset=utf-8')
        .header('content-disposition', `attachment; filename="${basename(testcase.input_path)}"`)
        .send(createReadStream(absolute));
    },
  );

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
