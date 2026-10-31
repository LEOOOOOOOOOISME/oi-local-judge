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
import { registerAdminProblemRoutes } from './http/admin-problems.js';
import { registerAdminToolRoutes } from './http/admin-tools.js';
import { registerAdminBatchRoutes } from './http/admin-batch.js';
import { registerContestRoutes } from './http/contests.js';
import { registerSubmissionRoutes } from './http/submissions.js';
import { createHub, type Hub } from './realtime/hub.js';
import { authenticateRequest, requireRole } from './security/auth.js';
import { migrate } from './storage/migrate.js';
import { openDatabase } from './storage/db.js';

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
  const hub = opts.hub ?? createHub();

  const app = Fastify({ logger: opts.logger ?? false });
  app.addContentTypeParser(
    ['application/octet-stream', 'application/zip'],
    { parseAs: 'buffer', bodyLimit: 80 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
  await app.register(websocket);
  await app.register(healthRoutes);

  await registerAuthRoutes(app, { db, config });
  registerProblemRoutes(app, {
    db,
    config,
    adminGuard: requireRole(['admin', 'setter'], { db, config }),
  });
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
  registerAdminBatchRoutes(app, {
    db,
    config,
    adminGuard: requireRole(['admin', 'setter'], { db, config }),
  });
  registerContestRoutes(app, {
    db,
    adminGuard: requireRole(['admin', 'contestmanager'], { db, config }),
  });
  registerSubmissionRoutes(app, { db, config });

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
    if (ownsDb) db.close();
  });

  return app;
}
