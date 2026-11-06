import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import {
  createProblemCategory,
  listProblemCategories,
  ProblemNumberingError,
  updateProblemCategory,
  type ProblemCategoryRow,
} from '../storage/repos/problem-categories.js';

export interface AdminProblemCategoryRouteOptions {
  db: DatabaseSync;
  /** Listing is open to problem editors (admin/setter). */
  adminGuard: preHandlerHookHandler;
  /** Creating/renaming categories is admin-only. */
  manageGuard: preHandlerHookHandler;
}

function toDto(row: ProblemCategoryRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    nextSeq: row.next_seq,
    seqStart: row.seq_start,
    createdAt: row.created_at,
  };
}

function sendNumberingError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ProblemNumberingError) {
    return reply
      .code(err.status)
      .send({ ok: false, error: { code: err.code, message: err.message } });
  }
  throw err;
}

export function registerAdminProblemCategoryRoutes(
  app: FastifyInstance,
  options: AdminProblemCategoryRouteOptions,
): void {
  const guard = options.adminGuard;
  const manageGuard = options.manageGuard;

  app.get('/api/admin/problem-categories', { preHandler: guard }, async () => ({
    ok: true,
    data: listProblemCategories(options.db).map(toDto),
  }));

  app.post<{ Body: { code?: string; name?: string; seqStart?: number } }>(
    '/api/admin/problem-categories',
    { preHandler: manageGuard },
    async (request, reply) => {
      const body = request.body ?? {};
      try {
        const category = createProblemCategory(options.db, {
          code: body.code as string,
          name: body.name,
          seqStart: body.seqStart,
        });
        return reply.code(201).send({ ok: true, data: toDto(category) });
      } catch (err) {
        return sendNumberingError(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; seqStart?: number } }>(
    '/api/admin/problem-categories/:id',
    { preHandler: manageGuard },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const body = request.body ?? {};
      try {
        const category = updateProblemCategory(options.db, id, {
          name: body.name,
          seqStart: body.seqStart,
        });
        if (!category) {
          return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
        }
        return { ok: true, data: toDto(category) };
      } catch (err) {
        return sendNumberingError(reply, err);
      }
    },
  );
}
