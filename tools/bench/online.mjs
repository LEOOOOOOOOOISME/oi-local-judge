#!/usr/bin/env node
// Online-concurrency benchmark.
//
// Starts the real HTTP server (`buildApp` + file-backed SQLite + the in-process
// judge scheduler) on an ephemeral 127.0.0.1 port, seeds a temporary data
// directory with the sample problem plus one running contest and N accepted
// participants, then:
//
//   1. Online phase — N virtual users loop over contest detail / official
//      ranking / team ranking for `OIJ_BENCH_DURATION` seconds while a shared
//      semaphore caps in-flight requests at `OIJ_BENCH_CONCURRENCY`.
//   2. Submission phase — `OIJ_BENCH_SUBMISSIONS` distinct users POST a valid
//      C++ AC solution to `/api/submissions` concurrently, then the harness
//      waits for the judge queue to drain (bounded by
//      `OIJ_BENCH_JUDGE_TIMEOUT_MS`).
//
// The final JSON on stdout is the baseline: status codes, latency percentiles,
// rps, RSS, queue state, submission outcome and judging throughput. The process
// exits 1 when the online 5xx/network failure rate exceeds 1 %, a health check
// fails, or a submission returns 5xx. 429 is counted separately and is never a
// failure by itself.
//
// Usage:
//   npx tsx tools/bench/online.mjs
//   OIJ_BENCH_USERS=30 OIJ_BENCH_CONCURRENCY=10 OIJ_BENCH_DURATION=10 \
//     OIJ_BENCH_SUBMISSIONS=10 npx tsx tools/bench/online.mjs
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { cpus, freemem, release as osRelease, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../apps/server/src/app.ts';
import { ensureDataDirs, loadConfig } from '../../apps/server/src/config.ts';
import { startScheduler } from '../../apps/server/src/judge/scheduler.ts';
import { importProblemDirectory } from '../../apps/server/src/services/problems.ts';
import { startContest } from '../../apps/server/src/services/contests.ts';
import { signSession } from '../../apps/server/src/security/session.ts';
import { SESSION_COOKIE } from '../../apps/server/src/security/auth.ts';
import {
  addParticipant,
  createContest,
} from '../../apps/server/src/storage/repos/contests.ts';
import { openDatabase } from '../../apps/server/src/storage/db.ts';
import { migrate } from '../../apps/server/src/storage/migrate.ts';
import { createUser } from '../../apps/server/src/storage/repos/users.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE_PROBLEM_DIR = join(REPO_ROOT, 'tools', 'seed', 'sample-problem');
const AC_SOURCE =
  '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}\n';

const USERS = positiveInt(process.env.OIJ_BENCH_USERS, 300);
const CONCURRENCY = Math.min(USERS, positiveInt(process.env.OIJ_BENCH_CONCURRENCY, 50));
const DURATION_SEC = positiveInt(process.env.OIJ_BENCH_DURATION, 60);
const SUBMISSIONS = positiveInt(process.env.OIJ_BENCH_SUBMISSIONS, 50);
const JUDGE_TIMEOUT_MS = positiveInt(process.env.OIJ_BENCH_JUDGE_TIMEOUT_MS, 180_000);
const REQUEST_TIMEOUT_MS = positiveInt(process.env.OIJ_BENCH_REQUEST_TIMEOUT_MS, 30_000);
const MAX_FAILURE_RATE = 0.01;

function positiveInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return round(sorted[rank - 1], 2);
}

function rssMb() {
  return round(process.memoryUsage().rss / 1024 / 1024, 1);
}

function machineInfo() {
  const cpuList = cpus();
  return {
    platform: `${process.platform} ${process.arch}`,
    osRelease: osRelease(),
    cpuModel: cpuList[0]?.model?.trim() ?? 'unknown',
    cpuCores: cpuList.length,
    cpuSpeedMhz: cpuList[0]?.speed ?? null,
    totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
    freeMemoryMbAtStart: Math.round(freemem() / 1024 / 1024),
    node: process.version,
  };
}

// A minimal FIFO semaphore: at most `limit` requests are in flight, while every
// one of the N virtual users keeps looping until the deadline.
function createSemaphore(limit) {
  let active = 0;
  const waiters = [];
  return {
    async acquire() {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise((resolveWaiter) => waiters.push(resolveWaiter));
    },
    release() {
      const next = waiters.shift();
      if (next) next();
      else active -= 1;
    },
  };
}

function statusBucket(status) {
  if (status >= 500) return 'http5xx';
  if (status === 429) return 'rateLimited';
  if (status >= 400) return 'otherClientErrors';
  if (status >= 200 && status < 300) return 'ok2xx';
  return 'other';
}

async function main() {
  // Keep the throwaway data directory inside the checkout's gitignored
  // `runtime/` directory: the native Windows judge runner needs to create files
  // there and can be denied write access under `%TEMP%` on sandboxed setups.
  mkdirSync(join(REPO_ROOT, 'runtime'), { recursive: true });
  const dataDir = mkdtempSync(join(REPO_ROOT, 'runtime', 'bench-online-'));
  const startedAt = new Date().toISOString();
  const machine = machineInfo();
  const baseConfig = loadConfig({ ...process.env, OIJ_DATA_DIR: dataDir });
  const config = {
    ...baseConfig,
    dataDir,
    host: '127.0.0.1',
    port: 0,
    runnerPath:
      existsSync(baseConfig.runnerPath) || process.env.OIJ_RUNNER
        ? baseConfig.runnerPath
        : join(REPO_ROOT, 'native', 'runner', 'out', 'ojrunner.exe'),
  };
  ensureDataDirs(dataDir);
  mkdirSync(config.dataDir, { recursive: true });

  const db = openDatabase(join(dataDir, 'bench.db'));
  migrate(db);

  let app = null;
  let scheduler = null;
  let rssTimer = null;
  const failures = [];

  const result = {
    benchmark: 'online-concurrency',
    generatedAt: startedAt,
    users: USERS,
    concurrency: CONCURRENCY,
    durationSec: DURATION_SEC,
    submissionsRequested: SUBMISSIONS,
    machine,
    config: {
      judgeConcurrency: config.judgeConcurrency,
      runnerPath: config.runnerPath,
      gxx: config.gxx,
      dataDir: '<temp dataDir>',
    },
    online: null,
    requests: 0,
    errors: 0,
    errorBreakdown: null,
    statusCodes: {},
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    maxMs: 0,
    rps: 0,
    memoryRssMb: rssMb(),
    peakRssMb: 0,
    queue: null,
    submissions: null,
    judgingThroughputPerSec: 0,
    health: {},
    pass: false,
    failures,
  };

  let peakRss = 0;
  const sampleRss = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };

  try {
    // Seed: one problem from tools/seed/sample-problem, one running contest,
    // N accepted participants. Sessions are signed directly so seeding never
    // pays for N password hashes.
    const problemId = importProblemDirectory({
      db,
      config,
      sourceDir: SAMPLE_PROBLEM_DIR,
    });

    const now = Date.now();
    const contestId = createContest(db, {
      name: 'Online concurrency benchmark',
      mode: 'oi',
      teamMode: 'individual',
      startAt: now - 60_000,
      endAt: now + (DURATION_SEC + 3600) * 1000,
      problemIds: [problemId],
    });
    startContest(db, contestId);

    const passwordHash = 'bench-reused-hash';
    const users = [];
    db.exec('BEGIN');
    try {
      for (let index = 0; index < USERS; index += 1) {
        const userId = createUser(db, {
          username: `bench_user_${String(index + 1).padStart(4, '0')}`,
          passwordHash,
          realName: `Bench User ${index + 1}`,
          className: `class-${(index % 10) + 1}`,
          role: 'contestant',
        });
        addParticipant(db, contestId, userId, now);
        const token = signSession(
          { userId, version: 0 },
          config.sessionSecret,
          config.sessionTtlSec,
        );
        users.push({ userId, cookie: `${SESSION_COOKIE}=${token}` });
      }
    } finally {
      db.exec('COMMIT');
    }

    app = await buildApp({ db, config, logger: false });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : null;
    if (!port) throw new Error('server did not report a bound port');
    const baseUrl = `http://127.0.0.1:${port}`;

    const health = async (label) => {
      try {
        const response = await fetch(`${baseUrl}/api/health`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = await response.json().catch(() => null);
        result.health[label] = {
          status: response.status,
          ok: response.ok && body?.ok === true,
        };
        if (!result.health[label].ok) failures.push(`health check failed (${label})`);
      } catch (error) {
        result.health[label] = { status: null, ok: false, error: String(error) };
        failures.push(`health check failed (${label})`);
      }
    };

    await health('beforeOnline');

    // Scheduler starts with the server so submissions are judged for real.
    scheduler = startScheduler({
      db,
      config,
      pollIntervalMs: Number(process.env.OIJ_BENCH_POLL_MS ?? 20),
    });
    rssTimer = setInterval(sampleRss, 500);

    // ---- Online phase -----------------------------------------------------
    const endpoints = [
      { path: `/api/contests/${contestId}`, name: 'contest-detail' },
      { path: `/api/contests/${contestId}/official-ranking`, name: 'official-ranking' },
      { path: `/api/contests/${contestId}/team-ranking`, name: 'team-ranking' },
    ];
    const perEndpoint = Object.fromEntries(
      endpoints.map((endpoint) => [
        endpoint.name,
        { requests: 0, statusCodes: {}, errors: 0, latencySumMs: 0 },
      ]),
    );
    const semaphore = createSemaphore(CONCURRENCY);
    const latencies = [];
    const statusCodes = {};
    const errorBreakdown = {
      network: 0,
      http5xx: 0,
      otherClientErrors: 0,
      rateLimited: 0,
    };
    let requestCount = 0;
    const phaseStart = performance.now();
    const deadline = phaseStart + DURATION_SEC * 1000;

    const record = (endpoint, status, latencyMs, failed) => {
      requestCount += 1;
      latencies.push(latencyMs);
      const bucket = status === null ? 'network' : statusBucket(status);
      if (status === null) errorBreakdown.network += 1;
      else if (statusCodes[status] === undefined) statusCodes[status] = 1;
      else statusCodes[status] += 1;
      if (status !== null && bucket !== 'ok2xx' && bucket in errorBreakdown) {
        errorBreakdown[bucket] += 1;
      }
      const endpointStat = perEndpoint[endpoint.name];
      endpointStat.requests += 1;
      endpointStat.latencySumMs += latencyMs;
      if (status !== null) {
        endpointStat.statusCodes[status] = (endpointStat.statusCodes[status] ?? 0) + 1;
      }
      if (failed) {
        endpointStat.errors += 1;
      }
    };

    const runVirtualUser = async (userIndex) => {
      let cursor = userIndex % endpoints.length;
      while (performance.now() < deadline) {
        await semaphore.acquire();
        try {
          if (performance.now() >= deadline) break;
          const endpoint = endpoints[cursor % endpoints.length];
          cursor += 1;
          const requestStart = performance.now();
          let status = null;
          let failed = true;
          try {
            const response = await fetch(`${baseUrl}${endpoint.path}`, {
              headers: { cookie: users[userIndex].cookie, accept: 'application/json' },
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            await response.arrayBuffer();
            status = response.status;
            failed = status >= 500;
          } catch {
            status = null;
          } finally {
            record(endpoint, status, performance.now() - requestStart, failed);
          }
        } finally {
          semaphore.release();
        }
      }
    };

    await Promise.all(Array.from({ length: USERS }, (_, index) => runVirtualUser(index)));
    const onlineElapsedMs = performance.now() - phaseStart;

    latencies.sort((left, right) => left - right);
    const serverErrors = errorBreakdown.http5xx + errorBreakdown.network;
    const totalForRate = Math.max(requestCount, 1);
    const failureRate = serverErrors / totalForRate;

    result.online = {
      elapsedMs: round(onlineElapsedMs, 1),
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      endpoints: Object.fromEntries(
        Object.entries(perEndpoint).map(([name, stat]) => [
          name,
          {
            requests: stat.requests,
            statusCodes: stat.statusCodes,
            errors: stat.errors,
            averageMs: stat.requests > 0 ? round(stat.latencySumMs / stat.requests, 2) : 0,
          },
        ]),
      ),
    };
    result.requests = requestCount;
    result.errors = serverErrors;
    result.errorBreakdown = errorBreakdown;
    result.statusCodes = statusCodes;
    result.p50Ms = percentile(latencies, 0.5);
    result.p95Ms = percentile(latencies, 0.95);
    result.p99Ms = percentile(latencies, 0.99);
    result.maxMs = latencies.length > 0 ? round(latencies[latencies.length - 1], 2) : 0;
    result.rps = round(requestCount / (onlineElapsedMs / 1000), 2);
    result.memoryRssMb = rssMb();
    result.peakRssMb = round(peakRss / 1024 / 1024, 1);

    if (requestCount === 0) failures.push('online phase issued no requests');
    if (failureRate > MAX_FAILURE_RATE) {
      failures.push(
        `online 5xx/network failure rate ${round(failureRate * 100, 2)}% exceeds 1%`,
      );
    }

    // ---- Submission phase -------------------------------------------------
    const submitterCount = Math.min(SUBMISSIONS, users.length);
    if (submitterCount < SUBMISSIONS) {
      result.submissionsRequested = submitterCount;
    }
    const submissionStatuses = {};
    const submissionErrors = { network: 0, http5xx: 0, http429: 0, other: 0 };
    const createdIds = [];
    const submitLatencies = [];
    const submitStarted = performance.now();

    const postSubmission = async (userIndex) => {
      const requestStart = performance.now();
      try {
        const response = await fetch(`${baseUrl}/api/submissions`, {
          method: 'POST',
          headers: {
            cookie: users[userIndex].cookie,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            problemId,
            contestId,
            language: 'cpp17',
            code: AC_SOURCE,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = await response.json().catch(() => null);
        submissionStatuses[response.status] = (submissionStatuses[response.status] ?? 0) + 1;
        if (response.status >= 500) submissionErrors.http5xx += 1;
        else if (response.status === 429) submissionErrors.http429 += 1;
        else if (response.status < 200 || response.status >= 300) submissionErrors.other += 1;
        if (response.ok && body?.data?.id) createdIds.push(body.data.id);
      } catch {
        submissionErrors.network += 1;
      } finally {
        submitLatencies.push(performance.now() - requestStart);
      }
    };

    await Promise.all(Array.from({ length: submitterCount }, (_, index) => postSubmission(index)));
    const submitBurstMs = performance.now() - submitStarted;

    // Snapshot right after the burst, before judging can drain the queue.
    const snapshotQueue = () => {
      const byStatus = {};
      for (const row of db
        .prepare('SELECT status, COUNT(*) AS n FROM submissions GROUP BY status')
        .all()) {
        byStatus[row.status] = Number(row.n);
      }
      const tasks = {};
      for (const row of db
        .prepare('SELECT status, COUNT(*) AS n FROM judge_tasks GROUP BY status')
        .all()) {
        tasks[row.status] = Number(row.n);
      }
      return { submissionsByStatus: byStatus, judgeTasksByStatus: tasks };
    };

    const queueAtSubmit = snapshotQueue();
    const placeholders = createdIds.map(() => '?').join(',');
    const pendingSql = `SELECT COUNT(*) AS n FROM submissions WHERE id IN (${placeholders}) AND status NOT IN ('finished','failed')`;

    let judged = 0;
    let drainTimedOut = false;
    const drainStart = performance.now();
    if (createdIds.length > 0) {
      for (;;) {
        const pending = Number(db.prepare(pendingSql).get(...createdIds).n);
        judged = createdIds.length - pending;
        if (pending === 0) break;
        if (performance.now() - submitStarted > JUDGE_TIMEOUT_MS) {
          drainTimedOut = true;
          break;
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
      }
    }
    const judgingWallMs = performance.now() - submitStarted;
    const drainMs = performance.now() - drainStart;

    const verdicts = {};
    if (createdIds.length > 0) {
      for (const row of db
        .prepare(
          `SELECT verdict, status, COUNT(*) AS n FROM submissions WHERE id IN (${placeholders}) GROUP BY verdict, status`,
        )
        .all(...createdIds)) {
        const key = row.status === 'finished' ? (row.verdict ?? 'NULL') : row.status;
        verdicts[key] = (verdicts[key] ?? 0) + Number(row.n);
      }
    }
    const queueAtEnd = snapshotQueue();

    const failedSamples =
      createdIds.length > 0
        ? db
            .prepare(
              `SELECT id, status, verdict, message FROM submissions
               WHERE id IN (${placeholders}) AND status = 'failed' LIMIT 5`,
            )
            .all(...createdIds)
        : [];

    result.submissions = {
      requested: submitterCount,
      burstMs: round(submitBurstMs, 1),
      statusCodes: submissionStatuses,
      accepted2xx: Object.entries(submissionStatuses)
        .filter(([status]) => Number(status) >= 200 && Number(status) < 300)
        .reduce((sum, [, count]) => sum + count, 0),
      rateLimited429: submissionErrors.http429,
      failed5xx: submissionErrors.http5xx,
      otherErrors: submissionErrors.other,
      networkErrors: submissionErrors.network,
      createdIds: createdIds.length,
      acceptedLatency: {
        p50Ms: percentile([...submitLatencies].sort((left, right) => left - right), 0.5),
        p95Ms: percentile([...submitLatencies].sort((left, right) => left - right), 0.95),
      },
      verdicts,
      failedSamples,
      judged,
      pending: Math.max(0, createdIds.length - judged),
      drainMs: round(drainMs, 1),
      judgingWallMs: round(judgingWallMs, 1),
      drainTimedOut,
    };
    result.queue = {
      afterSubmit: queueAtSubmit,
      afterDrain: queueAtEnd,
    };
    result.judgingThroughputPerSec =
      judged > 0 ? round(judged / (judgingWallMs / 1000), 2) : 0;

    if (submissionErrors.http5xx > 0) {
      failures.push(`${submissionErrors.http5xx} submission request(s) returned 5xx`);
    }
    if (submissionErrors.network > 0) {
      failures.push(`${submissionErrors.network} submission request(s) failed at the network level`);
    }
    if (createdIds.length === 0) failures.push('no submission was accepted');
    if (drainTimedOut) {
      failures.push(`judge queue did not drain within ${JUDGE_TIMEOUT_MS}ms`);
    }

    await health('afterDrain');
    result.memoryRssMb = rssMb();
    result.peakRssMb = Math.max(result.peakRssMb, round(peakRss / 1024 / 1024, 1));
    result.pass = failures.length === 0;
  } catch (error) {
    failures.push(`benchmark error: ${String(error?.stack ?? error)}`);
    result.pass = false;
  } finally {
    if (rssTimer !== null) clearInterval(rssTimer);
    if (scheduler !== null) await scheduler.stop().catch(() => {});
    if (app !== null) await app.close().catch(() => {});
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify(result, null, 2));
  return result.pass ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
