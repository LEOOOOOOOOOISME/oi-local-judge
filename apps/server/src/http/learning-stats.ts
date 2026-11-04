import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { requireAuth } from '../security/auth.js';
import {
  getClassLearningStats,
  getStudentStats,
  getStudentWrongProblems,
  LearningStatsError,
  type WrongProblemMode,
} from '../services/learning-stats.js';

export interface LearningStatsRouteOptions {
  db: DatabaseSync;
  config: Config;
  auth?: preHandlerHookHandler;
}

function parsePositiveInt(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean | null {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof LearningStatsError) {
    return reply
      .code(err.status)
      .send({ ok: false, error: { code: err.code, message: err.message } });
  }
  throw err;
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message } });
}

export function registerLearningStatsRoutes(
  app: FastifyInstance,
  options: LearningStatsRouteOptions,
): void {
  const auth = options.auth ?? requireAuth({ db: options.db, config: options.config });
  const preHandler = [auth];

  app.get<{
    Params: { id: string };
    Querystring: { classId?: string; includeContest?: string };
  }>('/api/students/:id/stats', { preHandler }, async (request, reply) => {
    const userId = parsePositiveInt(request.params.id);
    if (userId === null) {
      return reply
        .code(404)
        .send({ ok: false, error: { code: 'STUDENT_NOT_FOUND', message: 'student not found' } });
    }
    const includeContest = parseBoolean(request.query.includeContest, true);
    if (includeContest === null) {
      return badRequest(reply, 'includeContest must be a boolean');
    }
    let classId: number | undefined;
    if (request.query.classId !== undefined) {
      const parsed = parsePositiveInt(request.query.classId);
      if (parsed === null) {
        return reply
          .code(404)
          .send({ ok: false, error: { code: 'CLASS_NOT_FOUND', message: 'class not found' } });
      }
      classId = parsed;
    }
    const user = request.user!;
    try {
      return {
        ok: true,
        data: getStudentStats(
          options.db,
          userId,
          { userId: user.id, isAdmin: user.role === 'admin' },
          { classId, includeContest },
        ),
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { mode?: string; includeContest?: string; classId?: string };
  }>('/api/students/:id/wrong-problems', { preHandler }, async (request, reply) => {
    const userId = parsePositiveInt(request.params.id);
    if (userId === null) {
      return reply
        .code(404)
        .send({ ok: false, error: { code: 'STUDENT_NOT_FOUND', message: 'student not found' } });
    }
    const includeContest = parseBoolean(request.query.includeContest, true);
    if (includeContest === null) {
      return badRequest(reply, 'includeContest must be a boolean');
    }
    let classId: number | undefined;
    if (request.query.classId !== undefined) {
      const parsed = parsePositiveInt(request.query.classId);
      if (parsed === null) {
        return reply
          .code(404)
          .send({ ok: false, error: { code: 'CLASS_NOT_FOUND', message: 'class not found' } });
      }
      classId = parsed;
    }
    const mode = (request.query.mode ?? 'never-ac') as WrongProblemMode;
    const user = request.user!;
    try {
      return {
        ok: true,
        data: getStudentWrongProblems(
          options.db,
          userId,
          { userId: user.id, isAdmin: user.role === 'admin' },
          { mode, includeContest, classId },
        ),
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { includeContest?: string };
  }>('/api/classes/:id/learning-stats', { preHandler }, async (request, reply) => {
    const classId = parsePositiveInt(request.params.id);
    if (classId === null) {
      return reply
        .code(404)
        .send({ ok: false, error: { code: 'CLASS_NOT_FOUND', message: 'class not found' } });
    }
    const includeContest = parseBoolean(request.query.includeContest, true);
    if (includeContest === null) {
      return badRequest(reply, 'includeContest must be a boolean');
    }
    const user = request.user!;
    try {
      return {
        ok: true,
        data: getClassLearningStats(
          options.db,
          classId,
          { userId: user.id, isAdmin: user.role === 'admin' },
          { includeContest },
        ),
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
