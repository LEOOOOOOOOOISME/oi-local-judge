import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { getContest } from '../storage/repos/contests.js';
import {
  getRankingPlugin,
  listRankingPlugins,
  setRankingPluginEnabled,
  upsertRankingPlugin,
} from '../storage/repos/ranking-plugins.js';
import { invalidateOfficialRanking } from '../services/official-ranking.js';

export interface AdminRankingRouteOptions {
  db: DatabaseSync;
  config: Config;
  adminGuard: preHandlerHookHandler;
  pluginGuard: preHandlerHookHandler;
}

const BUILTIN_PRESETS = new Set(['oi', 'ioi', 'acm', 'cf-like']);

function parseConfig(body: Record<string, unknown>): Record<string, unknown> {
  const preset = typeof body.preset === 'string' ? body.preset : 'oi';
  const tie = body.tie === 'none' ? 'none' : 'same-rank';
  const cfLike =
    body.cfLike && typeof body.cfLike === 'object'
      ? {
          decay: Math.min(2, Math.max(0, Number((body.cfLike as { decay?: number }).decay ?? 0.5))),
          hackPoints: Math.min(
            1000,
            Math.max(0, Math.floor(Number((body.cfLike as { hackPoints?: number }).hackPoints ?? 100))),
          ),
          failedHackPenalty: Math.min(
            1000,
            Math.max(
              0,
              Math.floor(
                Number((body.cfLike as { failedHackPenalty?: number }).failedHackPenalty ?? 50),
              ),
            ),
          ),
        }
      : undefined;
  const hackWindowMinutes = Math.min(
    10_080,
    Math.max(0, Math.floor(Number(body.hackWindowMinutes ?? 0))),
  );
  const officialFreezeMinutesAfterHack = Math.min(
    10_080,
    Math.max(0, Math.floor(Number(body.officialFreezeMinutesAfterHack ?? 0))),
  );
  return {
    preset,
    tie,
    hackWindowMinutes,
    officialFreezeMinutesAfterHack,
    ...(cfLike ? { cfLike } : {}),
  };
}

export function registerAdminRankingRoutes(
  app: FastifyInstance,
  options: AdminRankingRouteOptions,
): void {
  app.post<{ Params: { id: string } }>(
    '/api/admin/contests/:id/official-freeze/release',
    { preHandler: options.adminGuard },
    async (request, reply) => {
      const contest = getContest(options.db, Number(request.params.id));
      if (!contest) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      options.db
        .prepare('UPDATE contests SET official_frozen_until = NULL WHERE id = ?')
        .run(contest.id);
      invalidateOfficialRanking(options.db, contest.id);
      return { ok: true, data: { released: true } };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/admin/contests/:id/ranking-config',
    { preHandler: options.adminGuard },
    async (request, reply) => {
      const contest = getContest(options.db, Number(request.params.id));
      if (!contest) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      return { ok: true, data: JSON.parse(contest.ranking_rule_json || '{}') as unknown };
    },
  );

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/admin/contests/:id/ranking-config',
    { preHandler: options.adminGuard },
    async (request, reply) => {
      const contest = getContest(options.db, Number(request.params.id));
      if (!contest) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      const config = parseConfig(request.body ?? {});
      const preset = config.preset as string;
      if (!BUILTIN_PRESETS.has(preset)) {
        if (!preset.startsWith('plugin:')) {
          return reply.code(400).send({ ok: false, error: { code: 'BAD_PRESET' } });
        }
        const name = preset.slice('plugin:'.length);
        if (!getRankingPlugin(options.db, name)) {
          return reply.code(400).send({ ok: false, error: { code: 'PLUGIN_NOT_FOUND' } });
        }
      }
      options.db
        .prepare('UPDATE contests SET ranking_rule_json = ? WHERE id = ?')
        .run(JSON.stringify(config), contest.id);
      invalidateOfficialRanking(options.db, contest.id);
      return { ok: true, data: config };
    },
  );

  app.get('/api/admin/ranking-plugins', { preHandler: options.pluginGuard }, async () => ({
    ok: true,
    data: listRankingPlugins(options.db).map((row) => ({
      id: row.id,
      name: row.name,
      sha256: row.sha256,
      enabled: row.enabled === 1,
      uploadedBy: row.uploaded_by,
      uploadedAt: row.uploaded_at,
    })),
  }));

  app.post<{ Querystring: { name?: string } }>(
    '/api/admin/ranking-plugins',
    { preHandler: options.pluginGuard, bodyLimit: 256 * 1024 },
    async (request, reply) => {
      const name = request.query.name?.trim();
      if (!name || !/^[a-z0-9-]{1,40}$/.test(name)) {
        return reply.code(400).send({ ok: false, error: { code: 'BAD_PLUGIN_NAME' } });
      }
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ ok: false, error: { code: 'EMPTY_BODY' } });
      }
      const sha256 = createHash('sha256').update(body).digest('hex');
      const dir = join(options.config.dataDir, 'plugins');
      mkdirSync(dir, { recursive: true });
      const relative = `plugins/${name}-${sha256.slice(0, 12)}.mjs`;
      writeFileSync(join(options.config.dataDir, relative), body);
      const row = upsertRankingPlugin(options.db, {
        name,
        jsPath: relative,
        sha256,
        uploadedBy: request.user?.id ?? 0,
      });
      return reply.code(201).send({
        ok: true,
        data: { id: row.id, name: row.name, sha256: row.sha256, restartRequired: true },
      });
    },
  );

  app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/admin/ranking-plugins/:id',
    { preHandler: options.pluginGuard },
    async (request) => {
      setRankingPluginEnabled(options.db, Number(request.params.id), request.body?.enabled === true);
      // A plugin can be referenced by any contest, so drop every cached ranking.
      invalidateOfficialRanking(options.db);
      return { ok: true, data: null };
    },
  );
}
