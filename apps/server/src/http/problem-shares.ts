import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import type { UserRow } from '../storage/repos/users.js';
import { getProblem, type ProblemRow } from '../storage/repos/problems.js';
import { requireAuth } from '../security/auth.js';
import {
  addProblemShare,
  canManageProblemShares,
  canViewProblem,
  listProblemShares,
  ProblemAclError,
  removeProblemShare,
  type ProblemActor,
  type ProblemGranteeType,
  type ProblemSharePermission,
} from '../services/problem-acl.js';

export interface ProblemShareRouteOptions {
  db: DatabaseSync;
  config: Config;
}

interface ShareTarget {
  problem: ProblemRow;
  actor: ProblemActor;
}

function parsePositiveInt(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function notFound(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(404).send({ ok: false, error: { code, message } });
}

function forbidden(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(403).send({ ok: false, error: { code, message } });
}

function badRequest(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(400).send({ ok: false, error: { code, message } });
}

function sendAclError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ProblemAclError) {
    return reply
      .code(err.status)
      .send({ ok: false, error: { code: err.code, message: err.message } });
  }
  throw err;
}

/**
 * Loads the problem and verifies share management rights. Problems the actor
 * cannot even view are reported as 404 so hidden problems do not leak existence.
 */
function loadShareTarget(
  options: ProblemShareRouteOptions,
  rawId: string,
  user: UserRow,
  reply: FastifyReply,
): ShareTarget | null {
  const problemId = parsePositiveInt(rawId);
  const problem = problemId === null ? null : getProblem(options.db, problemId);
  if (!problem) {
    notFound(reply, 'PROBLEM_NOT_FOUND', 'problem not found');
    return null;
  }
  const actor: ProblemActor = {
    userId: user.id,
    isAdmin: user.role === 'admin',
  };
  if (!canManageProblemShares(options.db, problem, actor)) {
    if (canViewProblem(options.db, problem, actor)) {
      forbidden(reply, 'PROBLEM_FORBIDDEN', 'not allowed to manage problem shares');
    } else {
      notFound(reply, 'PROBLEM_NOT_FOUND', 'problem not found');
    }
    return null;
  }
  return { problem, actor };
}

function assertGranteeType(value: unknown): value is ProblemGranteeType {
  return value === 'user' || value === 'team';
}

function assertPermission(value: unknown): value is ProblemSharePermission {
  return value === 'read' || value === 'edit';
}

export function registerProblemShareRoutes(
  app: FastifyInstance,
  options: ProblemShareRouteOptions,
): void {
  const auth = requireAuth(options);

  app.get<{ Params: { id: string } }>(
    '/api/problems/:id/shares',
    { preHandler: auth },
    async (request, reply) => {
      const target = loadShareTarget(
        options,
        request.params.id,
        request.user!,
        reply,
      );
      if (!target) return;
      return { ok: true, data: listProblemShares(options.db, target.problem.id) };
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/problems/:id/shares',
    { preHandler: auth },
    async (request, reply) => {
      const target = loadShareTarget(
        options,
        request.params.id,
        request.user!,
        reply,
      );
      if (!target) return;
      const body = request.body ?? {};
      const granteeType = body.granteeType;
      if (!assertGranteeType(granteeType)) {
        return badRequest(reply, 'PROBLEM_SHARE_INVALID', 'granteeType must be user or team');
      }
      if (!isPositiveInt(body.granteeId)) {
        return badRequest(reply, 'PROBLEM_SHARE_INVALID', 'granteeId is required');
      }
      const permission = body.permission;
      if (!assertPermission(permission)) {
        return badRequest(reply, 'PROBLEM_SHARE_INVALID', 'permission must be read or edit');
      }
      try {
        addProblemShare(options.db, {
          problemId: target.problem.id,
          granteeType,
          granteeId: body.granteeId,
          permission,
          actorId: target.actor.userId!,
          isAdmin: target.actor.isAdmin,
        });
        return reply.code(201).send({ ok: true, data: null });
      } catch (err) {
        return sendAclError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; granteeType: string; granteeId: string } }>(
    '/api/problems/:id/shares/:granteeType/:granteeId',
    { preHandler: auth },
    async (request, reply) => {
      const granteeType = request.params.granteeType;
      if (!assertGranteeType(granteeType)) {
        return badRequest(reply, 'PROBLEM_SHARE_INVALID', 'granteeType must be user or team');
      }
      const granteeId = parsePositiveInt(request.params.granteeId);
      if (granteeId === null) {
        return badRequest(reply, 'PROBLEM_SHARE_INVALID', 'granteeId is required');
      }
      const target = loadShareTarget(
        options,
        request.params.id,
        request.user!,
        reply,
      );
      if (!target) return;
      try {
        removeProblemShare(options.db, {
          problemId: target.problem.id,
          granteeType,
          granteeId,
          actorId: target.actor.userId!,
          isAdmin: target.actor.isAdmin,
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendAclError(reply, err);
      }
    },
  );
}
