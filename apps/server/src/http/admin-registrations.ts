import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { getContest } from '../storage/repos/contests.js';
import {
  checkInParticipant,
  ContestRegistrationError,
  listRegistrations,
  reviewRegistration,
} from '../services/contest-registrations.js';

export interface AdminRegistrationRouteOptions {
  db: DatabaseSync;
  adminGuard: preHandlerHookHandler;
}

function sendRegistrationError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ContestRegistrationError) {
    return reply
      .code(err.status)
      .send({ ok: false, error: { code: err.code, message: err.message } });
  }
  throw err;
}

export function registerAdminRegistrationRoutes(
  app: FastifyInstance,
  options: AdminRegistrationRouteOptions,
): void {
  const guard = options.adminGuard;

  app.get<{ Params: { id: string } }>(
    '/api/admin/contests/:id/registrations',
    { preHandler: guard },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      if (!getContest(options.db, contestId)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return { ok: true, data: listRegistrations(options.db, contestId) };
    },
  );

  const review = (action: 'approve' | 'reject') => {
    app.post<{ Params: { id: string; userId: string } }>(
      `/api/admin/contests/:id/registrations/:userId/${action}`,
      { preHandler: guard },
      async (request, reply) => {
        try {
          reviewRegistration(options.db, {
            contestId: Number(request.params.id),
            userId: Number(request.params.userId),
            action,
            actorId: request.user?.id ?? 0,
          });
          return { ok: true, data: null };
        } catch (err) {
          return sendRegistrationError(reply, err);
        }
      },
    );
  };
  review('approve');
  review('reject');

  app.post<{ Params: { id: string; userId: string } }>(
    '/api/admin/contests/:id/registrations/:userId/check-in',
    { preHandler: guard },
    async (request, reply) => {
      try {
        checkInParticipant(options.db, {
          contestId: Number(request.params.id),
          userId: Number(request.params.userId),
          actorId: request.user?.id ?? 0,
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendRegistrationError(reply, err);
      }
    },
  );
}
