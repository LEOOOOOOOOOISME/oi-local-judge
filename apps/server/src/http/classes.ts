import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { requireAuth } from '../security/auth.js';
import { getTeamMember } from '../storage/repos/teams.js';
import {
  addClassCoach,
  addClassMember,
  createClass,
  getClass,
  listClassesForUser,
  removeClassCoach,
  removeClassMember,
  TeamError,
  type TeamDetail,
  type TeamMemberDto,
  type TeamRole,
} from '../services/teams.js';

export interface ClassRouteOptions {
  db: DatabaseSync;
  config: Config;
  auth?: preHandlerHookHandler;
  /**
   * Guard for `POST /api/admin/classes`; only admins and contest managers may
   * create a class. Defaults to authentication plus the service-level role
   * check.
   */
  adminGuard?: preHandlerHookHandler;
}

interface ClassDetailResponse extends Omit<TeamDetail, 'members'> {
  /** Role of the requesting user in this class, or null when not a member. */
  viewerRole: TeamRole | null;
  /** Roster is only populated for class members and administrators. */
  members?: TeamMemberDto[];
}

function parsePositiveInt(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function notFound(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(404).send({ ok: false, error: { code, message } });
}

function badRequest(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(400).send({ ok: false, error: { code, message } });
}

function sendClassError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof TeamError) {
    return reply
      .code(err.status)
      .send({ ok: false, error: { code: err.code, message: err.message } });
  }
  throw err;
}

export function registerClassRoutes(app: FastifyInstance, options: ClassRouteOptions): void {
  const auth = options.auth ?? requireAuth({ db: options.db, config: options.config });
  const preHandler = [auth];
  const createGuard = options.adminGuard ?? auth;

  app.get('/api/classes', { preHandler }, async (request) => ({
    ok: true,
    data: listClassesForUser(options.db, request.user!.id),
  }));

  app.get<{ Params: { id: string } }>(
    '/api/classes/:id',
    { preHandler },
    async (request, reply) => {
      const classId = parsePositiveInt(request.params.id);
      const group = classId === null ? null : getClass(options.db, classId);
      if (!group) {
        return notFound(reply, 'CLASS_NOT_FOUND', 'class not found');
      }
      const user = request.user!;
      const member = getTeamMember(options.db, group.id, user.id);
      const data: ClassDetailResponse = {
        id: group.id,
        name: group.name,
        ownerId: group.ownerId,
        kind: group.kind,
        allowContest: group.allowContest,
        createdAt: group.createdAt,
        viewerRole: member?.role ?? null,
      };
      if (member || user.role === 'admin') {
        data.members = group.members;
      }
      return { ok: true, data };
    },
  );

  app.post<{ Body: { name?: unknown; allowContest?: unknown } }>(
    '/api/admin/classes',
    { preHandler: createGuard },
    async (request, reply) => {
      const body = request.body ?? {};
      if (typeof body.name !== 'string') {
        return badRequest(reply, 'TEAM_NAME_INVALID', 'class name is required');
      }
      if (body.allowContest !== undefined && typeof body.allowContest !== 'boolean') {
        return badRequest(reply, 'BAD_REQUEST', 'allowContest must be a boolean');
      }
      const actor = request.user!;
      try {
        const id = createClass(options.db, {
          name: body.name,
          ownerId: actor.id,
          actorRole: actor.role,
          allowContest: body.allowContest,
        });
        return reply.code(201).send({ ok: true, data: { id } });
      } catch (err) {
        return sendClassError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { username?: unknown; role?: unknown } }>(
    '/api/classes/:id/members',
    { preHandler },
    async (request, reply) => {
      const classId = parsePositiveInt(request.params.id);
      if (classId === null) {
        return notFound(reply, 'CLASS_NOT_FOUND', 'class not found');
      }
      const body = request.body ?? {};
      if (typeof body.username !== 'string' || body.username.trim() === '') {
        return badRequest(reply, 'BAD_REQUEST', 'username is required');
      }
      if (body.role !== undefined && typeof body.role !== 'string') {
        return badRequest(reply, 'BAD_REQUEST', 'role must be a string');
      }
      const actor = request.user!;
      try {
        const sync = addClassMember(options.db, {
          classId,
          actorId: actor.id,
          username: body.username,
          role: body.role,
          isAdmin: actor.role === 'admin',
        });
        return reply.code(201).send({ ok: true, data: { sync } });
      } catch (err) {
        return sendClassError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/classes/:id/members/:userId',
    { preHandler },
    async (request, reply) => {
      const classId = parsePositiveInt(request.params.id);
      if (classId === null) {
        return notFound(reply, 'CLASS_NOT_FOUND', 'class not found');
      }
      const userId = parsePositiveInt(request.params.userId);
      if (userId === null) {
        return notFound(reply, 'CLASS_MEMBER_NOT_FOUND', 'class member not found');
      }
      const actor = request.user!;
      try {
        removeClassMember(options.db, {
          classId,
          actorId: actor.id,
          userId,
          isAdmin: actor.role === 'admin',
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendClassError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { username?: unknown } }>(
    '/api/classes/:id/coaches',
    { preHandler },
    async (request, reply) => {
      const classId = parsePositiveInt(request.params.id);
      if (classId === null) {
        return notFound(reply, 'CLASS_NOT_FOUND', 'class not found');
      }
      const username = (request.body ?? {}).username;
      if (typeof username !== 'string' || username.trim() === '') {
        return badRequest(reply, 'BAD_REQUEST', 'username is required');
      }
      const actor = request.user!;
      try {
        addClassCoach(options.db, {
          classId,
          actorId: actor.id,
          username,
          isAdmin: actor.role === 'admin',
        });
        return reply.code(201).send({ ok: true, data: null });
      } catch (err) {
        return sendClassError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/classes/:id/coaches/:userId',
    { preHandler },
    async (request, reply) => {
      const classId = parsePositiveInt(request.params.id);
      if (classId === null) {
        return notFound(reply, 'CLASS_NOT_FOUND', 'class not found');
      }
      const userId = parsePositiveInt(request.params.userId);
      if (userId === null) {
        return notFound(reply, 'CLASS_NOT_COACH', 'class coach not found');
      }
      const actor = request.user!;
      try {
        removeClassCoach(options.db, {
          classId,
          actorId: actor.id,
          userId,
          isAdmin: actor.role === 'admin',
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendClassError(reply, err);
      }
    },
  );
}
