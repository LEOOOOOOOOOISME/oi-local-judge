import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { requireAuth } from '../security/auth.js';
import { getTeamMember } from '../storage/repos/teams.js';
import {
  addTeamMember,
  createTeam,
  dissolveTeam,
  getTeam,
  leaveTeam,
  listTeamsForUser,
  removeTeamMember,
  TeamError,
  transferCaptain,
  type TeamDetail,
  type TeamMemberDto,
  type TeamRole,
} from '../services/teams.js';

export interface TeamRouteOptions {
  db: DatabaseSync;
  config: Config;
  auth?: preHandlerHookHandler;
}

interface TeamDetailResponse extends Omit<TeamDetail, 'members'> {
  /** Role of the requesting user in this team, or null when not a member. */
  viewerRole: TeamRole | null;
  /** Roster is only populated for team members and administrators. */
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

function sendTeamError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof TeamError) {
    return reply
      .code(err.status)
      .send({ ok: false, error: { code: err.code, message: err.message } });
  }
  throw err;
}

export function registerTeamRoutes(app: FastifyInstance, options: TeamRouteOptions): void {
  const auth = options.auth ?? requireAuth({ db: options.db, config: options.config });
  const preHandler = [auth];

  app.get('/api/teams', { preHandler }, async (request) => ({
    ok: true,
    data: listTeamsForUser(options.db, request.user!.id),
  }));

  app.get<{ Params: { id: string } }>(
    '/api/teams/:id',
    { preHandler },
    async (request, reply) => {
      const teamId = parsePositiveInt(request.params.id);
      const team = teamId === null ? null : getTeam(options.db, teamId);
      if (!team || team.kind !== 'team') {
        return notFound(reply, 'TEAM_NOT_FOUND', 'team not found');
      }
      const user = request.user!;
      const member = getTeamMember(options.db, team.id, user.id);
      const data: TeamDetailResponse = {
        id: team.id,
        name: team.name,
        ownerId: team.ownerId,
        kind: team.kind,
        allowContest: team.allowContest,
        createdAt: team.createdAt,
        viewerRole: member?.role ?? null,
      };
      if (member || user.role === 'admin') {
        data.members = team.members;
      }
      return { ok: true, data };
    },
  );

  app.post<{ Body: { name?: unknown } }>(
    '/api/teams',
    { preHandler },
    async (request, reply) => {
      const name = (request.body ?? {}).name;
      if (typeof name !== 'string') {
        return badRequest(reply, 'TEAM_NAME_INVALID', 'team name is required');
      }
      try {
        const id = createTeam(options.db, { name, ownerId: request.user!.id });
        return reply.code(201).send({ ok: true, data: { id } });
      } catch (err) {
        return sendTeamError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { username?: unknown } }>(
    '/api/teams/:id/members',
    { preHandler },
    async (request, reply) => {
      const teamId = parsePositiveInt(request.params.id);
      if (teamId === null) {
        return notFound(reply, 'TEAM_NOT_FOUND', 'team not found');
      }
      const username = (request.body ?? {}).username;
      if (typeof username !== 'string' || username.trim() === '') {
        return badRequest(reply, 'BAD_REQUEST', 'username is required');
      }
      const user = request.user!;
      try {
        const sync = addTeamMember(options.db, {
          teamId,
          actorId: user.id,
          username,
          isAdmin: user.role === 'admin',
        });
        // Contest participation granted by this membership, plus contests that
        // were deliberately skipped because the user already represents
        // another registered team.
        return reply.code(201).send({ ok: true, data: { sync } });
      } catch (err) {
        return sendTeamError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/teams/:id/members/:userId',
    { preHandler },
    async (request, reply) => {
      const teamId = parsePositiveInt(request.params.id);
      if (teamId === null) {
        return notFound(reply, 'TEAM_NOT_FOUND', 'team not found');
      }
      const userId = parsePositiveInt(request.params.userId);
      if (userId === null) {
        return notFound(reply, 'TEAM_MEMBER_NOT_FOUND', 'team member not found');
      }
      const actor = request.user!;
      try {
        removeTeamMember(options.db, {
          teamId,
          actorId: actor.id,
          userId,
          isAdmin: actor.role === 'admin',
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendTeamError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/teams/:id/leave',
    { preHandler },
    async (request, reply) => {
      const teamId = parsePositiveInt(request.params.id);
      if (teamId === null) {
        return notFound(reply, 'TEAM_NOT_FOUND', 'team not found');
      }
      try {
        leaveTeam(options.db, teamId, request.user!.id);
        return { ok: true, data: null };
      } catch (err) {
        return sendTeamError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { userId?: unknown } }>(
    '/api/teams/:id/transfer',
    { preHandler },
    async (request, reply) => {
      const teamId = parsePositiveInt(request.params.id);
      if (teamId === null) {
        return notFound(reply, 'TEAM_NOT_FOUND', 'team not found');
      }
      const team = getTeam(options.db, teamId);
      if (!team || team.kind !== 'team') {
        return notFound(reply, 'TEAM_NOT_FOUND', 'team not found');
      }
      const rawUserId = (request.body ?? {}).userId;
      const userId =
        typeof rawUserId === 'number' && Number.isInteger(rawUserId) && rawUserId > 0
          ? rawUserId
          : null;
      if (userId === null) {
        return badRequest(reply, 'BAD_REQUEST', 'userId is required');
      }
      const actor = request.user!;
      try {
        transferCaptain(options.db, {
          teamId,
          actorId: actor.id,
          userId,
          isAdmin: actor.role === 'admin',
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendTeamError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/teams/:id',
    { preHandler },
    async (request, reply) => {
      const teamId = parsePositiveInt(request.params.id);
      if (teamId === null) {
        return notFound(reply, 'TEAM_NOT_FOUND', 'team not found');
      }
      const team = getTeam(options.db, teamId);
      if (!team || team.kind !== 'team') {
        return notFound(reply, 'TEAM_NOT_FOUND', 'team not found');
      }
      const actor = request.user!;
      try {
        dissolveTeam(options.db, {
          teamId,
          actorId: actor.id,
          isAdmin: actor.role === 'admin',
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendTeamError(reply, err);
      }
    },
  );
}
