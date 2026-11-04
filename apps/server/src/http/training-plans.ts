import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { requireAuth } from '../security/auth.js';
import type { Role } from '../storage/repos/users.js';
import {
  addTrainingPlanItem,
  createTrainingPlan,
  deleteTrainingPlan,
  getTrainingPlan,
  getTrainingPlanProgress,
  listTrainingPlans,
  removeTrainingPlanItem,
  reorderTrainingPlanItems,
  TrainingPlanError,
  updateTrainingPlan,
  type UpdateTrainingPlanPatch,
} from '../services/training-plans.js';

export interface TrainingPlanRouteOptions {
  db: DatabaseSync;
  config: Config;
  auth?: preHandlerHookHandler;
}

function parsePositiveInt(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Roles that may manage a training plan for any class or team. */
function canManageAnyGroup(role: Role): boolean {
  return role === 'admin' || role === 'contestmanager';
}

function badRequest(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(400).send({ ok: false, error: { code, message } });
}

function notFound(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(404).send({ ok: false, error: { code, message } });
}

function sendTrainingPlanError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof TrainingPlanError) {
    return reply
      .code(err.status)
      .send({ ok: false, error: { code: err.code, message: err.message } });
  }
  throw err;
}

export function registerTrainingPlanRoutes(
  app: FastifyInstance,
  options: TrainingPlanRouteOptions,
): void {
  const { db } = options;
  const auth = options.auth ?? requireAuth({ db, config: options.config });
  const preHandler = [auth];

  app.get('/api/training-plans', { preHandler }, async (request) => {
    const user = request.user!;
    return {
      ok: true,
      data: listTrainingPlans(db, {
        userId: user.id,
        canManageAnyGroup: canManageAnyGroup(user.role),
      }),
    };
  });

  app.get<{ Params: { id: string } }>(
    '/api/training-plans/:id',
    { preHandler },
    async (request, reply) => {
      const planId = parsePositiveInt(request.params.id);
      if (planId === null) {
        return notFound(reply, 'TRAINING_PLAN_NOT_FOUND', 'training plan not found');
      }
      const user = request.user!;
      const detail = getTrainingPlan(db, {
        planId,
        userId: user.id,
        canManageAnyGroup: canManageAnyGroup(user.role),
      });
      if (!detail) {
        return notFound(reply, 'TRAINING_PLAN_NOT_FOUND', 'training plan not found');
      }
      return { ok: true, data: detail };
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/training-plans',
    { preHandler },
    async (request, reply) => {
      const user = request.user!;
      const body = request.body ?? {};
      if (!isPositiveInt(body.groupId)) {
        return badRequest(reply, 'TRAINING_PLAN_GROUP_INVALID', 'groupId is required');
      }
      try {
        const id = createTrainingPlan(db, {
          groupId: body.groupId,
          title: body.title,
          description: body.description,
          startsAt: body.startsAt,
          endsAt: body.endsAt,
          items: body.items,
          actorId: user.id,
          canManageAnyGroup: canManageAnyGroup(user.role),
        });
        return reply.code(201).send({ ok: true, data: { id } });
      } catch (err) {
        return sendTrainingPlanError(reply, err);
      }
    },
  );

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/training-plans/:id',
    { preHandler },
    async (request, reply) => {
      const planId = parsePositiveInt(request.params.id);
      if (planId === null) {
        return notFound(reply, 'TRAINING_PLAN_NOT_FOUND', 'training plan not found');
      }
      const user = request.user!;
      const body = request.body ?? {};
      const patch: UpdateTrainingPlanPatch = {};
      if (body.title !== undefined) patch.title = body.title;
      if (body.description !== undefined) patch.description = body.description;
      if (body.startsAt !== undefined) patch.startsAt = body.startsAt;
      if (body.endsAt !== undefined) patch.endsAt = body.endsAt;
      try {
        updateTrainingPlan(db, {
          planId,
          actorId: user.id,
          canManageAnyGroup: canManageAnyGroup(user.role),
          patch,
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendTrainingPlanError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/training-plans/:id',
    { preHandler },
    async (request, reply) => {
      const planId = parsePositiveInt(request.params.id);
      if (planId === null) {
        return notFound(reply, 'TRAINING_PLAN_NOT_FOUND', 'training plan not found');
      }
      const user = request.user!;
      try {
        deleteTrainingPlan(db, {
          planId,
          actorId: user.id,
          canManageAnyGroup: canManageAnyGroup(user.role),
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendTrainingPlanError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/training-plans/:id/items',
    { preHandler },
    async (request, reply) => {
      const planId = parsePositiveInt(request.params.id);
      if (planId === null) {
        return notFound(reply, 'TRAINING_PLAN_NOT_FOUND', 'training plan not found');
      }
      const user = request.user!;
      const body = request.body ?? {};
      if (!isPositiveInt(body.problemId)) {
        return badRequest(reply, 'TRAINING_PLAN_ITEM_INVALID', 'problemId is required');
      }
      try {
        const id = addTrainingPlanItem(db, {
          planId,
          actorId: user.id,
          canManageAnyGroup: canManageAnyGroup(user.role),
          problemId: body.problemId,
          targetScore: body.targetScore,
          dueAt: body.dueAt,
        });
        return reply.code(201).send({ ok: true, data: { id } });
      } catch (err) {
        return sendTrainingPlanError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; itemId: string } }>(
    '/api/training-plans/:id/items/:itemId',
    { preHandler },
    async (request, reply) => {
      const planId = parsePositiveInt(request.params.id);
      if (planId === null) {
        return notFound(reply, 'TRAINING_PLAN_NOT_FOUND', 'training plan not found');
      }
      const itemId = parsePositiveInt(request.params.itemId);
      if (itemId === null) {
        return notFound(reply, 'TRAINING_PLAN_ITEM_NOT_FOUND', 'training plan item not found');
      }
      const user = request.user!;
      try {
        removeTrainingPlanItem(db, {
          planId,
          itemId,
          actorId: user.id,
          canManageAnyGroup: canManageAnyGroup(user.role),
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendTrainingPlanError(reply, err);
      }
    },
  );

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/training-plans/:id/items',
    { preHandler },
    async (request, reply) => {
      const planId = parsePositiveInt(request.params.id);
      if (planId === null) {
        return notFound(reply, 'TRAINING_PLAN_NOT_FOUND', 'training plan not found');
      }
      const user = request.user!;
      const itemIds = (request.body ?? {}).itemIds;
      if (!Array.isArray(itemIds) || !itemIds.every(isPositiveInt)) {
        return badRequest(
          reply,
          'TRAINING_PLAN_ITEM_INVALID',
          'itemIds must be an array of positive integers',
        );
      }
      try {
        reorderTrainingPlanItems(db, {
          planId,
          itemIds,
          actorId: user.id,
          canManageAnyGroup: canManageAnyGroup(user.role),
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendTrainingPlanError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/training-plans/:id/progress',
    { preHandler },
    async (request, reply) => {
      const planId = parsePositiveInt(request.params.id);
      if (planId === null) {
        return notFound(reply, 'TRAINING_PLAN_NOT_FOUND', 'training plan not found');
      }
      const user = request.user!;
      try {
        return {
          ok: true,
          data: getTrainingPlanProgress(db, {
            planId,
            actorId: user.id,
            canManageAnyGroup: canManageAnyGroup(user.role),
          }),
        };
      } catch (err) {
        return sendTrainingPlanError(reply, err);
      }
    },
  );
}
