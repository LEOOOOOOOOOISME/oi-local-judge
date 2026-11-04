// Local runtime metrics (no Prometheus, no alerting).
//
// Everything is kept in-process: request counters, a fixed-size latency window
// and a small ring of slow requests. The event loop delay histogram is the only
// thing that needs an explicit lifecycle (`startEventLoopMonitor` /
// `stopEventLoopMonitor`), because leaving it enabled keeps a timer alive.
//
// Privacy: only the request path is stored. `request.url` may contain query
// strings (tokens, session ids), so it is reduced to its path before recording.
import { statfsSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { Config } from '../config.js';

/** A request at or above this duration is kept in the slow-request ring. */
export const SLOW_REQUEST_THRESHOLD_MS = 500;
/** Maximum number of slow requests retained. */
export const SLOW_REQUEST_LIMIT = 50;
/** Number of recent latencies used for the average / p95. */
export const LATENCY_WINDOW_SIZE = 1_000;
/** Maximum stored path length; guards against absurdly long URLs. */
const MAX_PATH_LENGTH = 200;
/** Event loop histogram bucket resolution in milliseconds. */
const EVENT_LOOP_RESOLUTION_MS = 20;

/** Process start time, derived once from the process uptime. */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

export interface SlowRequest {
  method: string;
  /** Request path only: query strings are never recorded. */
  url: string;
  status: number;
  durationMs: number;
  at: number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  statusCode: number;
  durationMs: number;
  /** When the request finished; defaults to now. */
  at?: number;
}

export interface RequestMetrics {
  total: number;
  serverErrors: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface ProcessMetrics {
  startedAt: number;
  uptimeSec: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  cpu: {
    /** Cumulative CPU time used by this process, in milliseconds. */
    userMs: number;
    systemMs: number;
    /** CPU time / wall time since process start, in percent (may exceed 100). */
    percent: number;
  };
}

export interface EventLoopDelayMetrics {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface QueueMetrics {
  queued: number;
  running: number;
  failed: number;
}

export interface DiskMetrics {
  freeBytes: number;
  totalBytes: number;
}

export interface RuntimeMetrics {
  generatedAt: number;
  requests: RequestMetrics;
  slowRequests: SlowRequest[];
  process: ProcessMetrics;
  eventLoopDelay: EventLoopDelayMetrics;
  queue: QueueMetrics;
  /** Null when the data directory is missing or the filesystem cannot be read. */
  disk: DiskMetrics | null;
}

interface MetricsState {
  requestCount: number;
  serverErrors: number;
  latencies: number[];
  slowRequests: SlowRequest[];
}

function createState(): MetricsState {
  return { requestCount: 0, serverErrors: 0, latencies: [], slowRequests: [] };
}

const state: MetricsState = createState();
let loopDelayHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;

/**
 * Reduces a raw request URL to its path. Query strings and fragments are
 * discarded so credentials embedded in a URL are never retained.
 */
export function requestPath(url: string): string {
  const path = url.split('?', 1)[0].split('#', 1)[0];
  return path.length > MAX_PATH_LENGTH ? path.slice(0, MAX_PATH_LENGTH) : path;
}

function normalizeDuration(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
}

/** Records one finished request. Called from the Fastify `onResponse` hook. */
export function recordRequest(input: RecordedRequest): void {
  const durationMs = normalizeDuration(input.durationMs);
  state.requestCount += 1;
  if (input.statusCode >= 500) state.serverErrors += 1;

  state.latencies.push(durationMs);
  if (state.latencies.length > LATENCY_WINDOW_SIZE) state.latencies.shift();

  if (durationMs >= SLOW_REQUEST_THRESHOLD_MS) {
    state.slowRequests.unshift({
      method: String(input.method).slice(0, 16),
      url: requestPath(String(input.url)),
      status: input.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      at: input.at ?? Date.now(),
    });
    if (state.slowRequests.length > SLOW_REQUEST_LIMIT) state.slowRequests.pop();
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Average of the current latency window; 0 when nothing was recorded yet. */
export function averageLatencyMs(): number {
  if (state.latencies.length === 0) return 0;
  const total = state.latencies.reduce((sum, value) => sum + value, 0);
  return round2(total / state.latencies.length);
}

/** Nearest-rank p95 of the current latency window; 0 when empty. */
export function p95LatencyMs(): number {
  const values = [...state.latencies].sort((a, b) => a - b);
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1);
  return round2(values[index] ?? 0);
}

/**
 * Starts the event loop delay sampler. Idempotent: a second call keeps the
 * existing histogram instead of installing another timer.
 */
export function startEventLoopMonitor(): void {
  if (loopDelayHistogram) return;
  loopDelayHistogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
  loopDelayHistogram.enable();
}

/** Stops and releases the event loop delay sampler. Safe to call repeatedly. */
export function stopEventLoopMonitor(): void {
  if (!loopDelayHistogram) return;
  loopDelayHistogram.disable();
  loopDelayHistogram = null;
}

function toMs(nanoseconds: number): number {
  return Math.round((nanoseconds / 1e6) * 1000) / 1000;
}

function eventLoopDelayMetrics(): EventLoopDelayMetrics {
  if (!loopDelayHistogram || loopDelayHistogram.count === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  return {
    p50Ms: toMs(loopDelayHistogram.percentile(50)),
    p95Ms: toMs(loopDelayHistogram.percentile(95)),
    p99Ms: toMs(loopDelayHistogram.percentile(99)),
    maxMs: toMs(loopDelayHistogram.max),
  };
}

/**
 * Counts judge tasks by queue state. Mirrors the diagnostics counter; a missing
 * table (fresh database) must not break the metrics payload.
 */
function countQueue(db: DatabaseSync): QueueMetrics {
  const counts: QueueMetrics = { queued: 0, running: 0, failed: 0 };
  try {
    const rows = db
      .prepare('SELECT status, COUNT(*) AS n FROM judge_tasks GROUP BY status')
      .all() as unknown as Array<{ status: string; n: number }>;
    for (const row of rows) {
      const count = Number(row.n);
      if (row.status === 'queued') counts.queued += count;
      else if (row.status === 'running' || row.status === 'compiling') counts.running += count;
      else if (row.status === 'failed') counts.failed += count;
    }
  } catch {
    // A missing table is reported as an empty queue.
  }
  return counts;
}

function diskMetrics(dataDir: string): DiskMetrics | null {
  try {
    const stats = statfsSync(resolve(dataDir));
    const blockSize = Number(stats.bsize);
    return {
      freeBytes: blockSize * Number(stats.bavail),
      totalBytes: blockSize * Number(stats.blocks),
    };
  } catch {
    return null;
  }
}

function processMetrics(now: number): ProcessMetrics {
  const usage = process.memoryUsage();
  const cpu = process.cpuUsage();
  const wallMs = Math.max(1, now - PROCESS_STARTED_AT);
  return {
    startedAt: PROCESS_STARTED_AT,
    uptimeSec: Math.max(0, Math.round((now - PROCESS_STARTED_AT) / 1000)),
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    cpu: {
      userMs: Math.round(cpu.user / 1000),
      systemMs: Math.round(cpu.system / 1000),
      percent: round2(((cpu.user + cpu.system) / 1000 / wallMs) * 100),
    },
  };
}

/**
 * Builds the current metrics snapshot. Reads the judge queue from `db` and free
 * disk space from `config.dataDir`; neither can throw.
 */
export function getRuntimeMetrics(
  db: DatabaseSync,
  config: Config,
  now: number = Date.now(),
): RuntimeMetrics {
  return {
    generatedAt: now,
    requests: {
      total: state.requestCount,
      serverErrors: state.serverErrors,
      avgLatencyMs: averageLatencyMs(),
      p95LatencyMs: p95LatencyMs(),
    },
    slowRequests: state.slowRequests.map((entry) => ({ ...entry })),
    process: processMetrics(now),
    eventLoopDelay: eventLoopDelayMetrics(),
    queue: countQueue(db),
    disk: diskMetrics(config.dataDir),
  };
}

/**
 * Clears all collected metrics and stops the event loop sampler.
 *
 * Test-only: stopping the sampler ensures a test never leaks its timer.
 */
export function resetMetrics(): void {
  state.requestCount = 0;
  state.serverErrors = 0;
  state.latencies = [];
  state.slowRequests = [];
  loopDelayHistogram?.reset();
  stopEventLoopMonitor();
}
