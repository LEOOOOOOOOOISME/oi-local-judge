import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe('server', () => {
  it('returns health payload', async () => {
    const app = await buildApp();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      data: { status: 'ok', version: 1 },
    });
  });

  it('serves the desktop shell', async () => {
    const app = await buildApp();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('OiJudge');
  });

  it('echoes ping over websocket', async () => {
    const app = await buildApp();
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const msg = await new Promise<unknown>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'ping' })));
      ws.on('message', (raw) => resolve(JSON.parse(String(raw))));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    ws.close();
    expect(msg).toEqual({ type: 'pong' });
  });
});
