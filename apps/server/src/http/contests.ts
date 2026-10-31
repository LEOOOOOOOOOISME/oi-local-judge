import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { createContest } from '../storage/repos/contests.js';
import {
  endContest,
  freezeContest,
  getContestRanking,
  listContestDtos,
  startContest,
} from '../services/contests.js';

export interface ContestRouteOptions {
  db: DatabaseSync;
  adminGuard?: preHandlerHookHandler;
}

export function registerContestRoutes(app: FastifyInstance, options: ContestRouteOptions): void {
  app.get('/api/contests', async () => ({
    ok: true,
    data: listContestDtos(options.db),
  }));

  app.get<{ Params: { id: string } }>('/api/contests/:id/ranking', async (request, reply) => {
    const ranking = getContestRanking(options.db, Number(request.params.id));
    if (!ranking) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    return { ok: true, data: ranking.rows };
  });

  const guards = options.adminGuard ? [options.adminGuard] : [];

  app.post<{
    Body: {
      name?: string;
      mode?: string;
      startAt?: number;
      endAt?: number;
      freezeAt?: number;
      problemIds?: number[];
      participantIds?: number[];
    };
  }>(
    '/api/admin/contests',
    { preHandler: guards },
    async (request, reply) => {
      const body = request.body ?? {};
      if (!body.name) {
        return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST' } });
      }
      const id = createContest(options.db, {
        name: body.name,
        mode: body.mode,
        startAt: body.startAt,
        endAt: body.endAt,
        freezeAt: body.freezeAt,
        problemIds: body.problemIds,
      });
      for (const userId of body.participantIds ?? []) {
        options.db
          .prepare(
            "INSERT OR IGNORE INTO contest_participants(contest_id, user_id) VALUES (?, ?)",
          )
          .run(id, userId);
      }
      return reply.code(201).send({ ok: true, data: { id } });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/contests/:id/start',
    { preHandler: guards },
    async (request, reply) => {
      startContest(options.db, Number(request.params.id));
      return { ok: true, data: null };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/contests/:id/freeze',
    { preHandler: guards },
    async (request, reply) => {
      freezeContest(options.db, Number(request.params.id));
      return { ok: true, data: null };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/contests/:id/end',
    { preHandler: guards },
    async (request, reply) => {
      endContest(options.db, Number(request.params.id));
      return { ok: true, data: null };
    },
  );
}
