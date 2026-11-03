import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { requireAuth } from '../security/auth.js';
import { createContest, isRegistrationMode, isTeamMode } from '../storage/repos/contests.js';
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
import { getTeamRanking } from '../services/team-ranking.js';
import {
  AwardConfigError,
  getContestAwards,
  setAwardConfig,
} from '../services/awards.js';
import {
  ContestTeamError,
  getRegisteredTeamForUser,
  listContestTeams,
  registerTeamForContest,
  removeTeamFromContest,
} from '../services/contest-teams.js';
import {
  cancelRegistration,
  ContestRegistrationError,
  getMyRegistration,
  registerForContest,
} from '../services/contest-registrations.js';

export interface ContestRouteOptions {
  db: DatabaseSync;
  config?: Config;
  adminGuard?: preHandlerHookHandler;
  auth?: preHandlerHookHandler;
}

function sendContestTeamError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ContestTeamError) {
    return reply
      .code(err.status)
      .send({ ok: false, error: { code: err.code, message: err.message } });
  }
  throw err;
}

function sendContestRegistrationError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ContestRegistrationError) {
    return reply
      .code(err.status)
      .send({ ok: false, error: { code: err.code, message: err.message } });
  }
  throw err;
}

function parseTeamId(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
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
    '/api/contests/:id/team-ranking',
    async (request, reply) => {
      const ranking = getTeamRanking(options.db, Number(request.params.id));
      if (!ranking) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return { ok: true, data: ranking.rows };
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
  // Team registration routes need an authenticated user. A caller that only
  // registered the public contest routes (tests) can omit it; the full app
  // always passes an explicit auth guard.
  const teamAuth =
    options.auth ??
    (options.config ? requireAuth({ db: options.db, config: options.config }) : undefined);
  const teamGuards = teamAuth ? [teamAuth] : [];

  app.get<{ Params: { id: string } }>(
    '/api/contests/:id/awards',
    { preHandler: teamGuards },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      const user = request.user;
      if (!user) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHORIZED', message: 'authentication required' },
        });
      }
      const contest = getContest(options.db, contestId);
      if (!contest) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const ready =
        contest.status === 'ended' ||
        contest.status === 'archived' ||
        contest.archived_at !== null;
      const isManager = user.role === 'admin' || user.role === 'contestmanager';
      if (!ready && !isManager) {
        return reply.code(403).send({
          ok: false,
          error: {
            code: 'AWARDS_NOT_READY',
            message: 'awards are available after the contest ends',
          },
        });
      }
      const awards = await getContestAwards(
        options.db,
        contestId,
        options.config?.dataDir ?? process.cwd(),
      );
      if (!awards) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return { ok: true, data: awards };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/admin/contests/:id/awards',
    { preHandler: guards },
    async (request, reply) => {
      const awards = await getContestAwards(
        options.db,
        Number(request.params.id),
        options.config?.dataDir ?? process.cwd(),
      );
      if (!awards) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return { ok: true, data: awards };
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/admin/contests/:id/awards/config',
    { preHandler: guards },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      if (!getContest(options.db, contestId)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const raw = body.config ?? body;
      try {
        const config = setAwardConfig(options.db, contestId, raw, {
          actorId: request.user?.id ?? null,
          ip: request.ip,
        });
        return { ok: true, data: config };
      } catch (err) {
        if (err instanceof AwardConfigError) {
          return reply
            .code(err.status)
            .send({ ok: false, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  if (teamAuth) {
    app.post<{ Params: { id: string }; Body: { teamId?: unknown } }>(
      '/api/contests/:id/teams',
      { preHandler: teamGuards },
      async (request, reply) => {
        const contestId = Number(request.params.id);
        const teamId = parseTeamId((request.body ?? {}).teamId);
        if (teamId === null) {
          return reply.code(400).send({
            ok: false,
            error: { code: 'BAD_REQUEST', message: 'teamId must be a positive integer' },
          });
        }
        try {
          const role = request.user!.role;
          registerTeamForContest(options.db, {
            contestId,
            teamId,
            actorId: request.user!.id,
            isAdmin: role === 'admin' || role === 'contestmanager',
          });
          return reply.code(201).send({ ok: true, data: null });
        } catch (err) {
          return sendContestTeamError(reply, err);
        }
      },
    );

    app.get<{ Params: { id: string } }>(
      '/api/contests/:id/teams',
      { preHandler: teamGuards },
      async (request, reply) => {
        const contestId = Number(request.params.id);
        const user = request.user!;
        try {
          const data = listContestTeams(options.db, contestId);
          const isManager = user.role === 'admin' || user.role === 'contestmanager';
          if (!isManager && getRegisteredTeamForUser(options.db, contestId, user.id) === null) {
            return reply.code(403).send({
              ok: false,
              error: {
                code: 'FORBIDDEN',
                message: 'only registered team members and managers can view team registrations',
              },
            });
          }
          return { ok: true, data };
        } catch (err) {
          return sendContestTeamError(reply, err);
        }
      },
    );
  }

  if (teamAuth) {
    app.get<{ Params: { id: string } }>(
      '/api/contests/:id/registration',
      { preHandler: teamGuards },
      async (request, reply) => {
        const contestId = Number(request.params.id);
        const contest = getContest(options.db, contestId);
        if (!contest) {
          return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
        }
        return {
          ok: true,
          data: {
            mode: contest.registration_mode,
            registration: getMyRegistration(options.db, contestId, request.user!.id),
          },
        };
      },
    );

    app.post<{ Params: { id: string } }>(
      '/api/contests/:id/register',
      { preHandler: teamGuards },
      async (request, reply) => {
        try {
          const status = registerForContest(options.db, {
            contestId: Number(request.params.id),
            userId: request.user!.id,
          });
          return { ok: true, data: { status } };
        } catch (err) {
          return sendContestRegistrationError(reply, err);
        }
      },
    );

    app.delete<{ Params: { id: string } }>(
      '/api/contests/:id/register',
      { preHandler: teamGuards },
      async (request, reply) => {
        try {
          cancelRegistration(options.db, {
            contestId: Number(request.params.id),
            userId: request.user!.id,
          });
          return { ok: true, data: null };
        } catch (err) {
          return sendContestRegistrationError(reply, err);
        }
      },
    );
  }

  app.post<{ Params: { id: string }; Body: { teamId?: unknown } }>(
    '/api/admin/contests/:id/teams',
    { preHandler: guards },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      const teamId = parseTeamId((request.body ?? {}).teamId);
      if (teamId === null) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BAD_REQUEST', message: 'teamId must be a positive integer' },
        });
      }
      try {
        registerTeamForContest(options.db, {
          contestId,
          teamId,
          actorId: request.user?.id ?? 0,
          isAdmin: true,
        });
        return reply.code(201).send({ ok: true, data: null });
      } catch (err) {
        return sendContestTeamError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; teamId: string } }>(
    '/api/admin/contests/:id/teams/:teamId',
    { preHandler: guards },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      const teamId = Number(request.params.teamId);
      try {
        removeTeamFromContest(options.db, {
          contestId,
          teamId,
          actorId: request.user?.id ?? 0,
          isAdmin: true,
        });
        return { ok: true, data: null };
      } catch (err) {
        return sendContestTeamError(reply, err);
      }
    },
  );

  app.post<{
    Body: {
      name?: string;
      mode?: string;
      teamMode?: string;
      registrationMode?: string;
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
      if (body.teamMode !== undefined && !isTeamMode(body.teamMode)) {
        return reply.code(400).send({ ok: false, error: { code: 'INVALID_TEAM_MODE' } });
      }
      if (
        body.registrationMode !== undefined &&
        !isRegistrationMode(body.registrationMode)
      ) {
        return reply
          .code(400)
          .send({ ok: false, error: { code: 'INVALID_REGISTRATION_MODE' } });
      }
      const id = createContest(options.db, {
        name: body.name,
        mode: body.mode,
        teamMode: body.teamMode,
        registrationMode: body.registrationMode,
        startAt: body.startAt,
        endAt: body.endAt,
        freezeAt: body.freezeAt,
        problemIds: body.problemIds,
      });
      for (const userId of body.participantIds ?? []) {
        addParticipant(options.db, id, userId);
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
      teamMode?: string;
      registrationMode?: string;
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
    if (body.teamMode !== undefined && !isTeamMode(body.teamMode)) {
      return reply.code(400).send({ ok: false, error: { code: 'INVALID_TEAM_MODE' } });
    }
    if (
      body.registrationMode !== undefined &&
      !isRegistrationMode(body.registrationMode)
    ) {
      return reply
        .code(400)
        .send({ ok: false, error: { code: 'INVALID_REGISTRATION_MODE' } });
    }
    updateContest(options.db, contestId, {
      name: body.name,
      mode: body.mode,
      teamMode: body.teamMode,
      registrationMode: body.registrationMode,
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
