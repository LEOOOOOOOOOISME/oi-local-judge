import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { createContest } from '../storage/repos/contests.js';
import {
  addParticipant,
  countContestSubmissions,
  deleteContest,
  getContest,
  listContestParticipants,
  removeParticipant,
  setContestProblems,
  updateContest,
  updateParticipant,
} from '../storage/repos/contests.js';
import { getUserByUsername } from '../storage/repos/users.js';
import {
  endContest,
  freezeContest,
  getClassStats,
  getContestDetail,
  getContestRanking,
  listContestDtos,
  startContest,
  unfreezeContest,
} from '../services/contests.js';
import { getOfficialRanking } from '../services/official-ranking.js';
import { getCorrectionRanking } from '../services/correction-ranking.js';

export interface ContestRouteOptions {
  db: DatabaseSync;
  config?: Config;
  adminGuard?: preHandlerHookHandler;
}

export function registerContestRoutes(app: FastifyInstance, options: ContestRouteOptions): void {
  app.get('/api/contests', async () => ({
    ok: true,
    data: listContestDtos(options.db),
  }));

  app.get<{ Params: { id: string } }>('/api/contests/:id', async (request, reply) => {
    const detail = getContestDetail(options.db, Number(request.params.id));
    if (!detail) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    return { ok: true, data: detail };
  });

  app.get<{ Params: { id: string } }>('/api/contests/:id/ranking', async (request, reply) => {
    const ranking = getContestRanking(options.db, Number(request.params.id));
    if (!ranking) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    return { ok: true, data: ranking.rows };
  });

  app.get<{ Params: { id: string } }>(
    '/api/contests/:id/official-ranking',
    async (request, reply) => {
      const ranking = await getOfficialRanking(
        options.db,
        Number(request.params.id),
        options.config?.dataDir ?? process.cwd(),
      );
      if (!ranking) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return { ok: true, data: ranking };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/contests/:id/correction-ranking',
    async (request, reply) => {
      const ranking = getCorrectionRanking(options.db, Number(request.params.id));
      if (!ranking) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return { ok: true, data: ranking };
    },
  );

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

  app.post<{ Params: { id: string } }>(
    '/api/admin/contests/:id/unfreeze',
    { preHandler: guards },
    async (request, reply) => {
      unfreezeContest(options.db, Number(request.params.id));
      return { ok: true, data: null };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/admin/contests/:id/class-stats',
    { preHandler: guards },
    async (request, reply) => {
      const rows = await getClassStats(
        options.db,
        Number(request.params.id),
        options.config?.dataDir ?? process.cwd(),
      );
      if (!rows) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      return { ok: true, data: rows };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/admin/contests/:id/participants',
    { preHandler: guards },
    async (request) => ({
      ok: true,
      data: listContestParticipants(options.db, Number(request.params.id)),
    }),
  );

  app.post<{
    Params: { id: string };
    Body: { userIds?: number[]; usernames?: string[] };
  }>('/api/admin/contests/:id/participants', { preHandler: guards }, async (request, reply) => {
    const contestId = Number(request.params.id);
    if (!getContest(options.db, contestId)) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    const added: number[] = [];
    const missing: string[] = [];
    for (const userId of request.body?.userIds ?? []) {
      addParticipant(options.db, contestId, userId);
      added.push(userId);
    }
    for (const username of request.body?.usernames ?? []) {
      const user = getUserByUsername(options.db, username);
      if (!user) {
        missing.push(username);
        continue;
      }
      addParticipant(options.db, contestId, user.id);
      added.push(user.id);
    }
    return { ok: true, data: { added, missing } };
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/admin/contests/:id/participants/:userId',
    { preHandler: guards },
    async (request) => {
      removeParticipant(options.db, Number(request.params.id), Number(request.params.userId));
      return { ok: true, data: null };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/contests/:id',
    { preHandler: guards },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      if (!getContest(options.db, contestId)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      if (countContestSubmissions(options.db, contestId) > 0) {
        return reply.code(409).send({
          ok: false,
          error: { code: 'HAS_SUBMISSIONS', message: 'contest still has submissions' },
        });
      }
      deleteContest(options.db, contestId);
      return { ok: true, data: null };
    },
  );

  app.put<{
    Params: { id: string; userId: string };
    Body: { extraTime?: number; status?: string };
  }>('/api/admin/contests/:id/participants/:userId', { preHandler: guards }, async (request) => {
    updateParticipant(options.db, Number(request.params.id), Number(request.params.userId), {
      extraTime: request.body?.extraTime,
      status: request.body?.status,
    });
    return { ok: true, data: null };
  });

  app.put<{
    Params: { id: string };
    Body: {
      name?: string;
      mode?: string;
      startAt?: number | null;
      endAt?: number | null;
      freezeAt?: number | null;
      unfreezeAt?: number | null;
      problems?: Array<{ problemId: number; points: number }>;
    };
  }>('/api/admin/contests/:id', { preHandler: guards }, async (request, reply) => {
    const contestId = Number(request.params.id);
    if (!getContest(options.db, contestId)) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    const body = request.body ?? {};
    updateContest(options.db, contestId, {
      name: body.name,
      mode: body.mode,
      startAt: body.startAt,
      endAt: body.endAt,
      freezeAt: body.freezeAt,
      unfreezeAt: body.unfreezeAt,
    });
    if (Array.isArray(body.problems)) {
      setContestProblems(
        options.db,
        contestId,
        body.problems
          .filter((entry) => Number.isInteger(entry.problemId))
          .map((entry) => ({
            problemId: entry.problemId,
            points: Math.max(0, Number(entry.points) || 0),
          })),
      );
    }
    return { ok: true, data: { id: contestId } };
  });
}
