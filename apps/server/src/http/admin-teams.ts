import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { searchTeams, type TeamKind } from '../services/teams.js';

export interface AdminTeamRouteOptions {
  db: DatabaseSync;
  adminGuard: preHandlerHookHandler;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

/**
 * Parses the optional `kind` filter.
 *
 * Returns `undefined` when the parameter is absent (both kinds) and `null` when
 * it is present but not a recognized kind, so the caller can answer 400.
 */
function parseKind(raw: string | undefined): TeamKind | undefined | null {
  if (raw === undefined || raw.trim() === '') return undefined;
  const kind = raw.trim();
  if (kind === 'class' || kind === 'team') return kind;
  return null;
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply
    .code(400)
    .send({ ok: false, error: { code: 'BAD_REQUEST', message } });
}

export function registerAdminTeamRoutes(
  app: FastifyInstance,
  options: AdminTeamRouteOptions,
): void {
  app.get<{ Querystring: { query?: string; limit?: string } }>(
    '/api/admin/teams',
    { preHandler: options.adminGuard },
    async (request) => ({
      ok: true,
      data: searchTeams(options.db, {
        query: request.query.query,
        limit: parseLimit(request.query.limit),
      }),
    }),
  );

  // 训练计划选择器使用的全量班级/团队搜索：管理员与比赛管理员可用。
  app.get<{ Querystring: { kind?: string; query?: string; limit?: string } }>(
    '/api/admin/groups',
    { preHandler: options.adminGuard },
    async (request, reply) => {
      const kind = parseKind(request.query.kind);
      if (kind === null) {
        return badRequest(reply, "kind must be 'class' or 'team'");
      }
      return {
        ok: true,
        data: searchTeams(options.db, {
          query: request.query.query,
          limit: parseLimit(request.query.limit),
          kind,
        }),
      };
    },
  );
}
