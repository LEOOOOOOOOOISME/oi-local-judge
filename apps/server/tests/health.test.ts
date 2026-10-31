import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { createUser } from '../src/storage/repos/users.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const db = openDatabase(':memory:');
  migrate(db);
  const config = loadConfig({ ...process.env, OIJ_SESSION_SECRET: 'test-secret' });
  const app = await buildApp({ db, config });
  cleanups.push(async () => {
    await app.close();
    db.close();
  });
  return { app, db, config };
}

describe('server', () => {
  it('returns health payload', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      data: { status: 'ok', version: 1 },
    });
  });

  it('serves the desktop shell', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('OiJudge');
  });

  it('rejects unauthenticated websocket connections', async () => {
    const { app } = await setup();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const code = await new Promise<number>((resolve, reject) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    expect(code).toBe(1008);
  });

  it('echoes ping over an authenticated websocket', async () => {
    const { app, db, config } = await setup();
    const userId = createUser(db, {
      username: 'alice',
      passwordHash: hashPassword('secret'),
    });
    const token = signSession({ userId, version: 0 }, config.sessionSecret, 3600);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { Cookie: `oij.sid=${token}` },
    });
    const msgs: unknown[] = [];
    const pong = await new Promise<unknown>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'ping' })));
      ws.on('message', (raw) => {
        const parsed = JSON.parse(String(raw));
        msgs.push(parsed);
        if (parsed.type === 'pong') resolve(parsed);
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    ws.close();
    expect(pong).toEqual({ type: 'pong' });
    expect(msgs.some((m) => (m as { type?: string }).type === 'hello')).toBe(true);
  });
});
