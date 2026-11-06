import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig, type Config } from './config.js';
import { healthRoutes } from './http/health.js';
import { registerAuthRoutes } from './http/auth.js';
import { registerProblemRoutes } from './http/problems.js';
import { registerProblemShareRoutes } from './http/problem-shares.js';
import { registerAdminProblemRoutes } from './http/admin-problems.js';
import { registerAdminToolRoutes } from './http/admin-tools.js';
import { registerAdminAuthoringRoutes } from './http/admin-authoring.js';
import { registerAdminBatchRoutes } from './http/admin-batch.js';
import { registerAdminBodyParsers } from './http/admin-body-parser.js';
import { registerAdminUserRoutes } from './http/admin-users.js';
import { registerCommunityRoutes } from './http/community.js';
import { registerContestRoutes } from './http/contests.js';
import { registerAdminRegistrationRoutes } from './http/admin-registrations.js';
import { registerSubmissionRoutes } from './http/submissions.js';
import { registerAdminSystemRoutes } from './http/admin-system.js';
import { registerContestBatchRoutes } from './http/admin-contest-batch.js';
import { registerAdminRankingRoutes } from './http/admin-ranking.js';
import { registerAdminJudgeRoutes } from './http/admin-judge.js';
import { registerHackRoutes } from './http/hacks.js';
import { registerTeamRoutes } from './http/teams.js';
import { registerAdminTeamRoutes } from './http/admin-teams.js';
import { registerClassRoutes } from './http/classes.js';
import { registerLearningStatsRoutes } from './http/learning-stats.js';
import { registerProblemSetRoutes } from './http/problem-sets.js';
import { registerTrainingPlanRoutes } from './http/training-plans.js';
import { recordAudit } from './storage/repos/audit.js';
import { createHub, type Hub } from './realtime/hub.js';
import { authenticateRequest, requireAuth, requireRole } from './security/auth.js';
import { migrate } from './storage/migrate.js';
import { openDatabase } from './storage/db.js';
import { repairLegacyTestcasePaths } from './services/problems.js';
import {
  recordRequest,
  startEventLoopMonitor,
  stopEventLoopMonitor,
} from './services/metrics.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** High-resolution request start, used by the local runtime metrics. */
    metricsStartedAt?: bigint;
  }
}

export interface AppOptions {
  logger?: boolean;
  db?: DatabaseSync;
  config?: Config;
  hub?: Hub;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const ownsDb = !opts.db;
  const db = opts.db ?? openDatabase(':memory:');
  if (ownsDb) migrate(db);
  repairLegacyTestcasePaths(db, config.dataDir);
  const hub = opts.hub ?? createHub();

  const app = Fastify({ logger: opts.logger ?? false });
  startEventLoopMonitor();
  // Local runtime metrics: the start timestamp lives on the request, and only
  // the path (never the query string) is retained by the collector.
  app.addHook('onRequest', async (request) => {
    request.metricsStartedAt = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (request, reply) => {
    const startedAt = request.metricsStartedAt;
    const durationMs = startedAt
      ? Number(process.hrtime.bigint() - startedAt) / 1_000_000
      : reply.elapsedTime;
    recordRequest({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs,
    });
  });
  app.addHook('onResponse', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    if (!request.url.startsWith('/api/admin')) return;
    if (!request.user) return;
    recordAudit(db, {
      actorId: request.user.id,
      action: `${request.method} ${request.url.split('?')[0]}`,
      detail: { statusCode: reply.statusCode },
      ip: request.ip,
    });
  });
  // Raw admin uploads: the batch ZIP endpoint streams, everything else stays
  // buffered (10 GiB P0 limit) so existing problem/asset routes are unchanged.
  registerAdminBodyParsers(app);
  await app.register(websocket);
  await app.register(healthRoutes);

  await registerAuthRoutes(app, { db, config });
  registerProblemRoutes(app, {
    db,
    config,
    adminGuard: requireRole(['admin', 'setter'], { db, config }),
  });
  registerProblemShareRoutes(app, { db, config });
  registerAdminProblemRoutes(app, {
    db,
    config,
    adminGuard: requireRole(['admin', 'setter'], { db, config }),
  });
  registerAdminToolRoutes(app, {
    db,
    config,
    adminGuard: requireRole(['admin', 'setter'], { db, config }),
  });
  registerAdminAuthoringRoutes(app, {
    db,
    config,
    adminGuard: requireRole(['admin', 'setter'], { db, config }),
  });
  registerAdminBatchRoutes(app, {
    db,
    config,
    adminGuard: requireRole(['admin', 'setter'], { db, config }),
  });
  registerAdminUserRoutes(app, {
    db,
    adminGuard: requireRole(['admin', 'contestmanager'], { db, config }),
  });
  registerCommunityRoutes(app, { db, config });
  registerAdminSystemRoutes(app, {
    db,
    config,
    adminGuard: requireRole(['admin'], { db, config }),
  });
  registerContestBatchRoutes(app, {
    db,
    config,
    adminGuard: requireRole(['admin', 'setter', 'contestmanager'], { db, config }),
  });
  registerAdminRankingRoutes(app, {
    db,
    config,
    adminGuard: requireRole(['admin', 'contestmanager'], { db, config }),
    pluginGuard: requireRole(['admin'], { db, config }),
  });
  registerAdminJudgeRoutes(app, {
    db,
    config,
    adminGuard: requireRole(['admin', 'setter', 'contestmanager'], { db, config }),
  });
  registerHackRoutes(app, {
    db,
    config,
    auth: requireAuth({ db, config }),
    adminGuard: requireRole(['admin', 'contestmanager'], { db, config }),
  });
  const auth = requireAuth({ db, config });
  registerContestRoutes(app, {
    db,
    config,
    auth,
    adminGuard: requireRole(['admin', 'contestmanager'], { db, config }),
  });
  registerAdminRegistrationRoutes(app, {
    db,
    adminGuard: requireRole(['admin', 'contestmanager'], { db, config }),
  });
  registerSubmissionRoutes(app, { db, config });
  registerTeamRoutes(app, { db, config, auth });
  registerAdminTeamRoutes(app, {
    db,
    adminGuard: requireRole(['admin', 'contestmanager'], { db, config }),
  });
  registerClassRoutes(app, {
    db,
    config,
    auth,
    adminGuard: requireRole(['admin', 'contestmanager'], { db, config }),
  });
  registerLearningStatsRoutes(app, { db, config, auth });
  registerProblemSetRoutes(app, { db, config, auth });
  registerTrainingPlanRoutes(app, { db, config, auth });

  const webDist = join(process.cwd(), 'apps/web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
    });
    app.addHook('onSend', async (request, reply, payload) => {
      const url = request.url.split('?')[0];
      if (url.startsWith('/assets/')) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (!url.startsWith('/api/') && !url.startsWith('/ws')) {
        reply.header('Cache-Control', 'no-cache');
      }
      return payload;
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html')
        .send(
          '<!doctype html><html><head><meta charset="utf-8"><title>OiJudge</title></head><body><h1>OiJudge</h1></body></html>',
        ),
    );
  }

  app.get('/ws', { websocket: true }, (socket, request) => {
    const authenticated = authenticateRequest(request, { db, config });
    if (!authenticated) {
      socket.close(1008, 'unauthorized');
      return;
    }
    const rooms = [`user:${authenticated.user.id}`];
    if (authenticated.user.role === 'admin') rooms.push('admin');
    const rawContestId = (request.query as { contestId?: unknown } | undefined)?.contestId;
    const contestId = typeof rawContestId === 'string' ? Number(rawContestId) : Number.NaN;
    if (Number.isInteger(contestId) && contestId > 0) rooms.push(`contest:${contestId}`);
    hub.subscribe(socket, rooms);

    socket.send(JSON.stringify({ v: 1, type: 'hello', data: { userId: authenticated.user.id } }));
    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string };
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'invalid json' }));
      }
    });
    socket.on('close', () => hub.unsubscribe(socket));
  });

  app.addHook('onClose', async () => {
    stopEventLoopMonitor();
    if (ownsDb) db.close();
  });

  return app;
}
