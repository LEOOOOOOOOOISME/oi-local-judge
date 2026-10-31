import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { healthRoutes } from './http/health.js';

export interface AppOptions {
  logger?: boolean;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(websocket);
  await app.register(healthRoutes);

  app.get('/', async (_req, reply) =>
    reply
      .type('text/html')
      .send(
        '<!doctype html><html><head><meta charset="utf-8"><title>OiJudge</title></head><body><h1>OiJudge</h1></body></html>',
      ),
  );

  app.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string };
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'invalid json' }));
      }
    });
  });

  return app;
}
