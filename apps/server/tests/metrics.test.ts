import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import {
  getRuntimeMetrics,
  LATENCY_WINDOW_SIZE,
  recordRequest,
  resetMetrics,
  SLOW_REQUEST_THRESHOLD_MS,
  startEventLoopMonitor,
  type RuntimeMetrics,
} from '../src/services/metrics.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const NOW = 1_800_000_000_000;

const unitDb = openDatabase(':memory:');
migrate(unitDb);
const unitConfig: Config = {
  host: '127.0.0.1',
  port: 0,
  dataDir: tmpdir(),
  judgeConcurrency: 1,
  gxx: 'g++',
  runnerPath: '',
  interactRunnerPath: '',
  adminUsername: 'admin',
  adminPassword: 'admin123',
  sessionSecret: 'metrics-test-secret',
  sessionTtlSec: 3600,
};

afterAll(() => {
  resetMetrics();
  unitDb.close();
});

describe('metrics collector', () => {
  beforeEach(() => {
    resetMetrics();
  });

  afterEach(() => {
    resetMetrics();
  });

  it('records successful, failed and slow requests with average and p95', () => {
    recordRequest({ method: 'GET', url: '/api/a?token=secret', statusCode: 200, durationMs: 100 });
    recordRequest({ method: 'POST', url: '/api/b', statusCode: 201, durationMs: 300 });
    recordRequest({ method: 'GET', url: '/api/c', statusCode: 500, durationMs: 700 });

    const metrics = getRuntimeMetrics(unitDb, unitConfig, NOW);

    expect(metrics.generatedAt).toBe(NOW);
    expect(metrics.requests.total).toBe(3);
    expect(metrics.requests.serverErrors).toBe(1);
    expect(metrics.requests.avgLatencyMs).toBe(366.67);
    expect(metrics.requests.p95LatencyMs).toBe(700);
    expect(metrics.slowRequests).toHaveLength(1);
    expect(metrics.slowRequests[0]).toMatchObject({
      method: 'GET',
      url: '/api/c',
      status: 500,
      durationMs: 700,
    });
  });

  it('computes p95 with the nearest-rank rule over the latency window', () => {
    for (let value = 1; value <= 20; value += 1) {
      recordRequest({ method: 'GET', url: '/api/p95', statusCode: 200, durationMs: value });
    }
    const metrics = getRuntimeMetrics(unitDb, unitConfig, NOW);
    expect(metrics.requests.total).toBe(20);
    expect(metrics.requests.p95LatencyMs).toBe(19);
    expect(metrics.requests.avgLatencyMs).toBe(10.5);
  });

  it('keeps only the most recent latency window', () => {
    for (let value = 1; value <= LATENCY_WINDOW_SIZE + 10; value += 1) {
      recordRequest({ method: 'GET', url: '/api/window', statusCode: 200, durationMs: value });
    }
    const metrics = getRuntimeMetrics(unitDb, unitConfig, NOW);
    expect(metrics.requests.total).toBe(LATENCY_WINDOW_SIZE + 10);
    // The first ten values (1..10) fell out of the window.
    expect(metrics.requests.avgLatencyMs).toBe(
      Math.round(((11 + LATENCY_WINDOW_SIZE + 10) / 2) * 100) / 100,
    );
  });

  it('only stores the path of a slow request, never its query string', () => {
    recordRequest({
      method: 'GET',
      url: '/api/slow?token=super-secret&access_token=leak',
      statusCode: 200,
      durationMs: SLOW_REQUEST_THRESHOLD_MS,
    });
    const metrics = getRuntimeMetrics(unitDb, unitConfig, NOW);
    expect(metrics.slowRequests).toHaveLength(1);
    expect(metrics.slowRequests[0]?.url).toBe('/api/slow');
    expect(JSON.stringify(metrics)).not.toContain('super-secret');
    expect(JSON.stringify(metrics)).not.toContain('access_token');
  });

  it('caps the slow-request ring at 50 entries, newest first', () => {
    for (let index = 0; index < 55; index += 1) {
      recordRequest({
        method: 'GET',
        url: `/api/slow/${index}`,
        statusCode: 200,
        durationMs: SLOW_REQUEST_THRESHOLD_MS + index,
      });
    }
    const metrics = getRuntimeMetrics(unitDb, unitConfig, NOW);
    expect(metrics.slowRequests).toHaveLength(50);
    expect(metrics.slowRequests[0]?.url).toBe('/api/slow/54');
    expect(metrics.slowRequests.at(-1)?.url).toBe('/api/slow/5');
  });

  it('reports queue, process and disk state', () => {
    unitDb
      .prepare('INSERT INTO judge_tasks(submission_id, status, created_at) VALUES (?, ?, ?)')
      .run(1, 'queued', NOW);
    unitDb
      .prepare('INSERT INTO judge_tasks(submission_id, status, created_at) VALUES (?, ?, ?)')
      .run(2, 'running', NOW);
    unitDb
      .prepare('INSERT INTO judge_tasks(submission_id, status, created_at) VALUES (?, ?, ?)')
      .run(3, 'compiling', NOW);
    unitDb
      .prepare('INSERT INTO judge_tasks(submission_id, status, created_at) VALUES (?, ?, ?)')
      .run(4, 'failed', NOW);

    const metrics = getRuntimeMetrics(unitDb, unitConfig, NOW);
    expect(metrics.queue).toEqual({ queued: 1, running: 2, failed: 1 });
    expect(metrics.process.startedAt).toBeLessThanOrEqual(NOW);
    expect(metrics.process.uptimeSec).toBeGreaterThan(0);
    expect(metrics.process.rssBytes).toBeGreaterThan(0);
    expect(metrics.process.heapUsedBytes).toBeGreaterThan(0);
    expect(metrics.process.cpu.percent).toBeGreaterThanOrEqual(0);
    expect(metrics.disk).not.toBeNull();
    expect(metrics.disk?.totalBytes ?? 0).toBeGreaterThan(0);
  });

  it('resetMetrics clears counters and stops the event loop sampler', () => {
    recordRequest({ method: 'GET', url: '/api/c', statusCode: 500, durationMs: 700 });
    startEventLoopMonitor();
    resetMetrics();

    const metrics = getRuntimeMetrics(unitDb, unitConfig, NOW);
    expect(metrics.requests).toEqual({
      total: 0,
      serverErrors: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
    });
    expect(metrics.slowRequests).toEqual([]);
    expect(metrics.eventLoopDelay).toEqual({ p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 });
  });

  it('samples event loop delay while the monitor is running', async () => {
    startEventLoopMonitor();
    // Block the loop long enough for the 20 ms sampler to fire late.
    const until = Date.now() + 100;
    while (Date.now() < until) {
      // Busy wait.
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    const metrics = getRuntimeMetrics(unitDb, unitConfig, NOW);
    expect(metrics.eventLoopDelay.maxMs).toBeGreaterThan(0);
    expect(metrics.eventLoopDelay.p95Ms).toBeGreaterThanOrEqual(0);
    expect(metrics.eventLoopDelay.p95Ms).toBeLessThanOrEqual(metrics.eventLoopDelay.maxMs);
    expect(metrics.eventLoopDelay.p99Ms).toBeLessThanOrEqual(metrics.eventLoopDelay.maxMs);
  });
});

describe('system metrics route', () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let dataDir: string;
  let adminCookie: string;
  let contestantCookie: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'oij-metrics-'));
    db = openDatabase(':memory:');
    migrate(db);
    const config = {
      ...loadConfig({ ...process.env, OIJ_DATA_DIR: dataDir, OIJ_SESSION_SECRET: 'test-session-secret-0123456789-abcdef' }),
      dataDir,
      sessionSecret: 'metrics-http',
    };
    const adminId = createUser(db, {
      username: 'admin',
      passwordHash: hashPassword('admin123'),
      role: 'admin',
    });
    const contestantId = createUser(db, {
      username: 'alice',
      passwordHash: hashPassword('secret123'),
      role: 'contestant',
    });
    adminCookie = `oij.sid=${signSession({ userId: adminId, version: 0 }, config.sessionSecret, 3600)}`;
    contestantCookie = `oij.sid=${signSession(
      { userId: contestantId, version: 0 },
      config.sessionSecret,
      3600,
    )}`;
    app = await buildApp({ db, config });

    // Test-only routes exercised through the real hooks.
    app.get('/api/test/slow-probe', async () => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_REQUEST_THRESHOLD_MS + 60));
      return { ok: true, data: { slow: true } };
    });
    app.get('/api/test/boom', async () => {
      throw new Error('boom');
    });
  });

  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function fetchMetrics(cookie: string) {
    return app.inject({
      method: 'GET',
      url: '/api/admin/system/metrics',
      headers: { cookie },
    });
  }

  it('requires an admin session', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/admin/system/metrics' });
    expect(anonymous.statusCode).toBe(401);

    const contestant = await fetchMetrics(contestantCookie);
    expect(contestant.statusCode).toBe(403);
  });

  it('returns the metrics snapshot for admins', async () => {
    const response = await fetchMetrics(adminCookie);
    expect(response.statusCode, response.body).toBe(200);

    const metrics = (response.json() as { data: RuntimeMetrics }).data;
    expect(metrics.requests.total).toBeGreaterThanOrEqual(1);
    expect(typeof metrics.requests.serverErrors).toBe('number');
    expect(typeof metrics.requests.avgLatencyMs).toBe('number');
    expect(typeof metrics.requests.p95LatencyMs).toBe('number');
    expect(Array.isArray(metrics.slowRequests)).toBe(true);
    expect(metrics.process.rssBytes).toBeGreaterThan(0);
    expect(typeof metrics.process.uptimeSec).toBe('number');
    expect(typeof metrics.process.cpu.percent).toBe('number');
    expect(metrics.eventLoopDelay.p95Ms).toBeGreaterThanOrEqual(0);
    expect(metrics.queue).toEqual({ queued: 0, running: 0, failed: 0 });
    expect(metrics.disk).not.toBeNull();
  });

  it('records slow requests without leaking query strings', async () => {
    const probe = await app.inject({
      method: 'GET',
      url: '/api/test/slow-probe?token=super-secret&access_token=leak',
    });
    expect(probe.statusCode).toBe(200);

    const response = await fetchMetrics(adminCookie);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain('super-secret');
    expect(response.body).not.toContain('access_token');
    expect(response.body).not.toContain('token=');

    const metrics = (response.json() as { data: RuntimeMetrics }).data;
    const slow = metrics.slowRequests.find((entry) => entry.url === '/api/test/slow-probe');
    expect(slow).toBeDefined();
    expect(slow?.url).toBe('/api/test/slow-probe');
    expect(slow?.durationMs).toBeGreaterThanOrEqual(SLOW_REQUEST_THRESHOLD_MS);
    expect(metrics.slowRequests.every((entry) => !entry.url.includes('?'))).toBe(true);
  });

  it('counts 5xx responses', async () => {
    const boom = await app.inject({ method: 'GET', url: '/api/test/boom?token=boom-secret' });
    expect(boom.statusCode).toBe(500);

    const response = await fetchMetrics(adminCookie);
    const metrics = (response.json() as { data: RuntimeMetrics }).data;
    expect(metrics.requests.serverErrors).toBeGreaterThanOrEqual(1);
    expect(response.body).not.toContain('boom-secret');
  });
});
