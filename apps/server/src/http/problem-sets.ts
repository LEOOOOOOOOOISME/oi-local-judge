import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { requireAuth } from '../security/auth.js';
import {
  addProblemSetItem,
  addProblemSetShare,
  createProblemSet,
  deleteProblemSet,
  getProblemSet,
  listProblemSets,
  ProblemSetError,
  removeProblemSetItem,
  removeProblemSetShare,
  reorderProblemSetItems,
  updateProblemSet,
  type ProblemSetGranteeType,
  type ProblemSetOwnerType,
  type ProblemSetSharePermission,
  type ProblemSetVisibility,
  type UpdateProblemSetPatch,
} from '../services/problem-sets.js';

export interface ProblemSetRouteOptions {
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

function badRequest(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(400).send({ ok: false, error: { code, message } });
}

function notFound(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(404).send({ ok: false, error: { code, message } });
}

function sendProblemSetError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ProblemSetError) {
    return reply
      .code(err.status)
      .send({ ok: false, error: { code: err.code, message: err.message } });
  }
  throw err;
}

function withCanDelete<T extends { canManage: boolean }>(value: T): T & { canDelete: boolean } {
  return { ...value, canDelete: value.canManage };
}

export function registerProblemSetRoutes(
  app: FastifyInstance,
  options: ProblemSetRouteOptions,
): void {
  const { db } = options;
  const auth = options.auth ?? requireAuth({ db, config: options.config });
  const preHandler = [auth];

  app.get('/api/problem-sets', { preHandler }, async (request) => ({
    ok: true,
    data: listProblemSets(db, { userId: request.user!.id }).map((set) => withCanDelete(set)),
  }));

  app.get<{ Params: { id: string } }>(
    '/api/problem-sets/:id',
    { preHandler },
    async (request, reply) => {
      const setId = parsePositiveInt(request.params.id);
      const user = request.user!;
      const detail =
        setId === null ? null : getProblemSet(db, setId, user.id, user.role === 'admin');
      if (!detail) {
        return notFound(reply, 'SET_NOT_FOUND', 'problem set not found');
      }
      return { ok: true, data: withCanDelete(detail) };
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/problem-sets',
    { preHandler },
    async (request, reply) => {
      const user = request.user!;
      const body = request.body ?? {};

      const title = body.title;
      if (typeof title !== 'string') {
        return badRequest(reply, 'SET_TITLE_INVALID', 'title is required');
      }
      const description = body.description ?? '';
      if (typeof description !== 'string') {
        return badRequest(reply, 'SET_DESCRIPTION_INVALID', 'description must be a string');
      }
      const ownerType = body.ownerType ?? 'user';
      if (ownerType !== 'user' && ownerType !== 'team') {
        return badRequest(reply, 'SET_OWNER_INVALID', 'ownerType must be user or team');
      }
      const ownerId = body.ownerId ?? (ownerType === 'user' ? user.id : null);
      if (!isPositiveInt(ownerId)) {
        return badRequest(reply, 'SET_OWNER_INVALID', 'ownerId is required');
      }
      const visibility = body.visibility ?? 'private';
      if (visibility !== 'private' && visibility !== 'public') {
        return badRequest(
          reply,
          'SET_VISIBILITY_INVALID',
          'visibility must be private or public',
        );
      }

      try {
        const id = createProblemSet(db, {
          title,
          description,
          ownerType: ownerType as ProblemSetOwnerType,
          ownerId,
          visibility: visibility as ProblemSetVisibility,
          actorId: user.id,
        });
        return reply.code(201).send({ ok: true, data: { id } });
      } catch (err) {
        return sendProblemSetError(reply, err);
      }
    },
  );

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/problem-sets/:id',
    { preHandler },
    async (request, reply) => {
      const setId = parsePositiveInt(request.params.id);
      if (setId === null) {
        return notFound(reply, 'SET_NOT_FOUND', 'problem set not found');
      }
      const user = request.user!;
      const body = request.body ?? {};
      const patch: UpdateProblemSetPatch = {};
      if (body.title !== undefined) patch.title = body.title as string;
      if (body.description !== undefined) patch.description = body.description as string;
      if (body.visibility !== undefined) {
        patch.visibility = body.visibility as ProblemSetVisibility;
      }

      try {
        updateProblemSet(db, {
          setId,
          actorId: user.id,
          isAdmin: user.role === 'admin',
          patch,
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendProblemSetError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/problem-sets/:id',
    { preHandler },
    async (request, reply) => {
      const setId = parsePositiveInt(request.params.id);
      if (setId === null) {
        return notFound(reply, 'SET_NOT_FOUND', 'problem set not found');
      }
      const user = request.user!;
      try {
        deleteProblemSet(db, {
          setId,
          actorId: user.id,
          isAdmin: user.role === 'admin',
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendProblemSetError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/problem-sets/:id/items',
    { preHandler },
    async (request, reply) => {
      const setId = parsePositiveInt(request.params.id);
      if (setId === null) {
        return notFound(reply, 'SET_NOT_FOUND', 'problem set not found');
      }
      const user = request.user!;
      const problemId = (request.body ?? {}).problemId;
      if (!isPositiveInt(problemId)) {
        return badRequest(reply, 'SET_ITEM_INVALID', 'problemId is required');
      }
      try {
        addProblemSetItem(db, {
          setId,
          problemId,
          actorId: user.id,
          isAdmin: user.role === 'admin',
        });
        return reply.code(201).send({ ok: true, data: null });
      } catch (err) {
        return sendProblemSetError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; problemId: string } }>(
    '/api/problem-sets/:id/items/:problemId',
    { preHandler },
    async (request, reply) => {
      const setId = parsePositiveInt(request.params.id);
      if (setId === null) {
        return notFound(reply, 'SET_NOT_FOUND', 'problem set not found');
      }
      const problemId = parsePositiveInt(request.params.problemId);
      if (problemId === null) {
        return notFound(reply, 'SET_ITEM_NOT_FOUND', 'problem is not in this problem set');
      }
      const user = request.user!;
      try {
        removeProblemSetItem(db, {
          setId,
          problemId,
          actorId: user.id,
          isAdmin: user.role === 'admin',
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendProblemSetError(reply, err);
      }
    },
  );

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/problem-sets/:id/items',
    { preHandler },
    async (request, reply) => {
      const setId = parsePositiveInt(request.params.id);
      if (setId === null) {
        return notFound(reply, 'SET_NOT_FOUND', 'problem set not found');
      }
      const user = request.user!;
      const problemIds = (request.body ?? {}).problemIds;
      if (!Array.isArray(problemIds) || !problemIds.every(isPositiveInt)) {
        return badRequest(
          reply,
          'SET_ITEM_INVALID',
          'problemIds must be an array of positive integers',
        );
      }
      try {
        reorderProblemSetItems(db, {
          setId,
          problemIds,
          actorId: user.id,
          isAdmin: user.role === 'admin',
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendProblemSetError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/problem-sets/:id/shares',
    { preHandler },
    async (request, reply) => {
      const setId = parsePositiveInt(request.params.id);
      if (setId === null) {
        return notFound(reply, 'SET_NOT_FOUND', 'problem set not found');
      }
      const user = request.user!;
      const body = request.body ?? {};
      const granteeType = body.granteeType;
      if (granteeType !== 'user' && granteeType !== 'team') {
        return badRequest(reply, 'SET_SHARE_INVALID', 'granteeType must be user or team');
      }
      const granteeId = body.granteeId;
      if (!isPositiveInt(granteeId)) {
        return badRequest(reply, 'SET_SHARE_INVALID', 'granteeId is required');
      }
      const permission = body.permission;
      if (permission !== 'read' && permission !== 'edit') {
        return badRequest(reply, 'SET_SHARE_INVALID', 'permission must be read or edit');
      }
      try {
        addProblemSetShare(db, {
          setId,
          granteeType: granteeType as ProblemSetGranteeType,
          granteeId,
          permission: permission as ProblemSetSharePermission,
          actorId: user.id,
          isAdmin: user.role === 'admin',
        });
        return reply.code(201).send({ ok: true, data: null });
      } catch (err) {
        return sendProblemSetError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; granteeType: string; granteeId: string } }>(
    '/api/problem-sets/:id/shares/:granteeType/:granteeId',
    { preHandler },
    async (request, reply) => {
      const setId = parsePositiveInt(request.params.id);
      if (setId === null) {
        return notFound(reply, 'SET_NOT_FOUND', 'problem set not found');
      }
      const granteeType = request.params.granteeType;
      if (granteeType !== 'user' && granteeType !== 'team') {
        return badRequest(reply, 'SET_SHARE_INVALID', 'granteeType must be user or team');
      }
      const granteeId = parsePositiveInt(request.params.granteeId);
      if (granteeId === null) {
        return badRequest(reply, 'SET_SHARE_INVALID', 'granteeId is required');
      }
      const user = request.user!;
      try {
        removeProblemSetShare(db, {
          setId,
          granteeType: granteeType as ProblemSetGranteeType,
          granteeId,
          actorId: user.id,
          isAdmin: user.role === 'admin',
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendProblemSetError(reply, err);
      }
    },
  );
}
