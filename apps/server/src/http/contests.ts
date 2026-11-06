import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { authenticateRequest, requireAuth } from '../security/auth.js';
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
import {
  computeOfficialRanking,
  getOfficialRanking,
  getOfficialRankingVersion,
  invalidateOfficialRanking,
} from '../services/official-ranking.js';
import { getContestStatistics } from '../services/contest-statistics.js';
import { buildContestReport, contestReportToCsv } from '../services/contest-report.js';
import { getCorrectionRanking } from '../services/correction-ranking.js';
import { getTeamRanking } from '../services/team-ranking.js';
import {
  AwardConfigError,
  AwardScopeError,
  getContestAwards,
  getTeamContestAwards,
  setAwardConfig,
  type AwardQueryOptions,
  type AwardScope,
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

type IncludeHiddenParse = { ok: true; value: boolean } | { ok: false };

/**
 * `includeHidden=1|true` opts a manager into statistics/rankings that contain
 * hidden participants. `0|false` and omission mean public-only data.
 */
function readIncludeHidden(raw: unknown): IncludeHiddenParse {
  if (raw === undefined || raw === '0' || raw === 'false') return { ok: true, value: false };
  if (raw === '1' || raw === 'true') return { ok: true, value: true };
  return { ok: false };
}

/**
 * Public contest routes are anonymous, so optional authentication is resolved
 * from the session cookie only when hidden rows are requested.
 */
function canIncludeHidden(request: FastifyRequest, options: ContestRouteOptions): boolean {
  if (!options.config) return false;
  const authenticated = authenticateRequest(request, {
    db: options.db,
    config: options.config,
  });
  const role = authenticated?.user.role;
  return role === 'admin' || role === 'contestmanager';
}

function forbiddenIncludedHidden(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({
    ok: false,
    error: {
      code: 'FORBIDDEN',
      message: 'only admins and contest managers can include hidden participants',
    },
  });
}

function invalidIncludeHidden(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    ok: false,
    error: {
      code: 'INVALID_INCLUDE_HIDDEN',
      message: 'includeHidden must be 1, true, 0 or false',
    },
  });
}

type WindowTimestamp = { ok: true; value: number | null | undefined } | { ok: false };

function readWindowTimestamp(raw: unknown): WindowTimestamp {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, value: raw };
  return { ok: false };
}

function registrationWindowInvalid(
  openAt: number | null,
  closeAt: number | null,
): boolean {
  return openAt !== null && closeAt !== null && openAt >= closeAt;
}

function sendInvalidRegistrationWindow(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    ok: false,
    error: {
      code: 'INVALID_REGISTRATION_WINDOW',
      message: 'registrationOpenAt must be earlier than registrationCloseAt',
    },
  });
}

function parseAwardScope(raw: unknown): AwardScope | null {
  if (raw === undefined || raw === 'individual') return 'individual';
  if (raw === 'team') return 'team';
  return null;
}

/**
 * `participation=1` / `true` 开启参赛证书，`0` / `false` 关闭；缺省为关闭。
 * 其他值返回 null，由路由以 400 INVALID_PARTICIPATION 拒绝。
 */
function parseParticipation(raw: unknown): boolean | null {
  if (raw === undefined) return false;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return null;
}

function sendInvalidParticipation(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    ok: false,
    error: {
      code: 'INVALID_PARTICIPATION',
      message: 'participation must be 1, true, 0 or false',
    },
  });
}

async function loadContestAwards(
  db: DatabaseSync,
  contestId: number,
  scope: AwardScope,
  dataDir: string,
  options: AwardQueryOptions = {},
) {
  return scope === 'team'
    ? getTeamContestAwards(db, contestId, options)
    : getContestAwards(db, contestId, dataDir, options);
}

function sendAwardScopeError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AwardScopeError) {
    return reply
      .code(err.status)
      .send({ ok: false, error: { code: err.code, message: err.message } });
  }
  throw err;
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

  app.get<{
    Params: { id: string };
    Querystring: { includeHidden?: string };
  }>(
    '/api/contests/:id/official-ranking',
    async (request, reply) => {
      const parsed = readIncludeHidden(request.query?.includeHidden);
      if (!parsed.ok) return invalidIncludeHidden(reply);
      if (parsed.value && !canIncludeHidden(request, options)) {
        return forbiddenIncludedHidden(reply);
      }
      const contestId = Number(request.params.id);
      const dataDir = options.config?.dataDir ?? process.cwd();
      const ranking = parsed.value
        ? await computeOfficialRanking(
            options.db,
            contestId,
            dataDir,
            getOfficialRankingVersion(options.db, contestId),
            { includeHidden: true },
          )
        : await getOfficialRanking(options.db, contestId, dataDir);
      if (!ranking) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return { ok: true, data: ranking };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { includeHidden?: string };
  }>(
    '/api/contests/:id/statistics',
    async (request, reply) => {
      const parsed = readIncludeHidden(request.query?.includeHidden);
      if (!parsed.ok) return invalidIncludeHidden(reply);
      if (parsed.value && !canIncludeHidden(request, options)) {
        return forbiddenIncludedHidden(reply);
      }
      const stats = await getContestStatistics(
        options.db,
        Number(request.params.id),
        options.config?.dataDir ?? process.cwd(),
        { includeHidden: parsed.value },
      );
      if (!stats) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return { ok: true, data: stats };
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

  app.get<{
    Params: { id: string };
    Querystring: { scope?: string; participation?: string };
  }>(
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
      const scope = parseAwardScope(request.query?.scope);
      if (!scope) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'INVALID_SCOPE', message: 'scope must be individual or team' },
        });
      }
      const participation = parseParticipation(request.query?.participation);
      if (participation === null) {
        return sendInvalidParticipation(reply);
      }
      if (scope === 'team' && contest.team_mode === 'individual') {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'SCOPE_NOT_TEAM',
            message: 'this contest does not accept teams, so it has no team awards',
          },
        });
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
      try {
        const awards = await loadContestAwards(
          options.db,
          contestId,
          scope,
          options.config?.dataDir ?? process.cwd(),
          { includeParticipation: participation },
        );
        if (!awards) {
          return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
        }
        return { ok: true, data: awards };
      } catch (err) {
        return sendAwardScopeError(reply, err);
      }
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { scope?: string; participation?: string };
  }>(
    '/api/admin/contests/:id/awards',
    { preHandler: guards },
    async (request, reply) => {
      const scope = parseAwardScope(request.query?.scope);
      if (!scope) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'INVALID_SCOPE', message: 'scope must be individual or team' },
        });
      }
      const participation = parseParticipation(request.query?.participation);
      if (participation === null) {
        return sendInvalidParticipation(reply);
      }
      try {
        const awards = await loadContestAwards(
          options.db,
          Number(request.params.id),
          scope,
          options.config?.dataDir ?? process.cwd(),
          { includeParticipation: participation },
        );
        if (!awards) {
          return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
        }
        return { ok: true, data: awards };
      } catch (err) {
        return sendAwardScopeError(reply, err);
      }
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
      registrationOpenAt?: number | null;
      registrationCloseAt?: number | null;
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
      const openWindow = readWindowTimestamp(body.registrationOpenAt);
      const closeWindow = readWindowTimestamp(body.registrationCloseAt);
      if (!openWindow.ok || !closeWindow.ok) {
        return sendInvalidRegistrationWindow(reply);
      }
      if (registrationWindowInvalid(openWindow.value ?? null, closeWindow.value ?? null)) {
        return sendInvalidRegistrationWindow(reply);
      }
      const id = createContest(options.db, {
        name: body.name,
        mode: body.mode,
        teamMode: body.teamMode,
        registrationMode: body.registrationMode,
        registrationOpenAt: openWindow.value,
        registrationCloseAt: closeWindow.value,
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

  app.get<{
    Params: { id: string };
    Querystring: { format?: string; top?: string };
  }>(
    '/api/admin/contests/:id/report',
    { preHandler: guards },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      const format = request.query?.format ?? 'json';
      if (format !== 'json' && format !== 'csv') {
        return reply.code(400).send({
          ok: false,
          error: { code: 'INVALID_FORMAT', message: 'format must be json or csv' },
        });
      }
      let top: number | undefined;
      const rawTop = request.query?.top;
      if (rawTop !== undefined) {
        const parsed = Number(rawTop);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return reply.code(400).send({
            ok: false,
            error: { code: 'INVALID_TOP', message: 'top must be a positive integer' },
          });
        }
        top = parsed;
      }
      const report = await buildContestReport(
        options.db,
        contestId,
        options.config?.dataDir ?? process.cwd(),
        { top },
      );
      if (!report) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      if (format === 'csv') {
        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header(
          'content-disposition',
          `attachment; filename="contest-${contestId}-report.csv"`,
        );
        return reply.send(contestReportToCsv(report));
      }
      return { ok: true, data: report };
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
    invalidateOfficialRanking(options.db, contestId);
    return { ok: true, data: { added, missing } };
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/admin/contests/:id/participants/:userId',
    { preHandler: guards },
    async (request) => {
      const contestId = Number(request.params.id);
      removeParticipant(options.db, contestId, Number(request.params.userId));
      invalidateOfficialRanking(options.db, contestId);
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
      invalidateOfficialRanking(options.db, contestId);
      return { ok: true, data: null };
    },
  );

  app.put<{
    Params: { id: string; userId: string };
    Body: { extraTime?: number; status?: string };
  }>('/api/admin/contests/:id/participants/:userId', { preHandler: guards }, async (request) => {
    const contestId = Number(request.params.id);
    updateParticipant(options.db, contestId, Number(request.params.userId), {
      extraTime: request.body?.extraTime,
      status: request.body?.status,
    });
    invalidateOfficialRanking(options.db, contestId);
    return { ok: true, data: null };
  });

  app.put<{
    Params: { id: string };
    Body: {
      name?: string;
      mode?: string;
      teamMode?: string;
      registrationMode?: string;
      registrationOpenAt?: number | null;
      registrationCloseAt?: number | null;
      startAt?: number | null;
      endAt?: number | null;
      freezeAt?: number | null;
      unfreezeAt?: number | null;
      problems?: Array<{ problemId: number; points: number }>;
    };
  }>('/api/admin/contests/:id', { preHandler: guards }, async (request, reply) => {
    const contestId = Number(request.params.id);
    const contest = getContest(options.db, contestId);
    if (!contest) {
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
    const openWindow = readWindowTimestamp(body.registrationOpenAt);
    const closeWindow = readWindowTimestamp(body.registrationCloseAt);
    if (!openWindow.ok || !closeWindow.ok) {
      return sendInvalidRegistrationWindow(reply);
    }
    const resolvedOpen =
      openWindow.value === undefined ? contest.registration_open_at : openWindow.value;
    const resolvedClose =
      closeWindow.value === undefined ? contest.registration_close_at : closeWindow.value;
    if (registrationWindowInvalid(resolvedOpen, resolvedClose)) {
      return sendInvalidRegistrationWindow(reply);
    }
    updateContest(options.db, contestId, {
      name: body.name,
      mode: body.mode,
      teamMode: body.teamMode,
      registrationMode: body.registrationMode,
      registrationOpenAt: openWindow.value,
      registrationCloseAt: closeWindow.value,
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
    invalidateOfficialRanking(options.db, contestId);
    return { ok: true, data: { id: contestId } };
  });
}
