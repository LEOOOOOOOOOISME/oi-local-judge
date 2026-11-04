import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { searchTeams } from '../services/teams.js';

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
}
