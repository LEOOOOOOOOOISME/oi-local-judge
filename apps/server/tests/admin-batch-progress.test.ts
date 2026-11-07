import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { signSession } from '../src/security/session.js';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { createBatchUpload } from '../src/storage/repos/batch-uploads.js';
import {
  addBatchItem,
  createBatchJob,
  getBatchJob,
  listBatchItems,
} from '../src/storage/repos/batches.js';
import { createProblem } from '../src/storage/repos/problems.js';
import {
  createSubmission,
  getSubmission,
} from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps) {
    try {
      await app.close();
    } catch {
      // already closed
    }
  }
  apps.length = 0;
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  dbs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

interface Ctx {
  dir: string;
  db: DatabaseSync;
  config: Config;
  app: FastifyInstance;
  adminCookie: string;
  contestantCookie: string;
  problemId: number;
}

const AC_SOURCE =
  '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}';

async function setup(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'oij-batch-progress-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  dbs.push(db);
  migrate(db);
  ensureDataDirs(dir);
  const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: dir }), dataDir: dir };
  const admin = createUser(db, { username: 'admin', passwordHash: 'x', role: 'admin' });
  const contestant = createUser(db, {
    username: 'contestant',
    passwordHash: 'x',
    role: 'contestant',
  });
  const app = await buildApp({ db, config });
  apps.push(app);
  const problemId = createProblem(db, {
    title: 'P1',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [],
  });
  return {
    dir,
    db,
    config,
    app,
    adminCookie: `oij.sid=${signSession({ userId: admin, version: 0 }, config.sessionSecret, 3600)}`,
    contestantCookie: `oij.sid=${signSession(
      { userId: contestant, version: 0 },
      config.sessionSecret,
      3600,
    )}`,
    problemId,
  };
}

function createUpload(ctx: Ctx, files: Record<string, Uint8Array>): string {
  const uploadId = randomUUID();
  const zip = zipSync(files);
  const directory = join(ctx.config.dataDir, 'uploads', 'batch');
  mkdirSync(directory, { recursive: true });
  const relativePath = `uploads/batch/${uploadId}.zip`;
  writeFileSync(join(ctx.config.dataDir, relativePath), zip);
  createBatchUpload(ctx.db, {
    uploadId,
    zipPath: relativePath,
    sizeBytes: zip.byteLength,
    sha256: 'sha',
  });
  return uploadId;
}

function sourceFiles(count: number, prefix = 'Student'): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (let index = 0; index < count; index += 1) {
    files[`${prefix}${index}/main.cpp`] = new TextEncoder().encode(AC_SOURCE);
  }
  return files;
}

async function listJobs(
  ctx: Ctx,
  query = '',
  cookie = ctx.adminCookie,
): Promise<{ statusCode: number; body: string; data: BatchJobsBody }> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/admin/batch/jobs${query ? `?${query}` : ''}`,
    headers: { cookie },
  });
  return {
    statusCode: response.statusCode,
    body: response.body,
    data: response.statusCode === 200 ? (response.json() as { data: BatchJobsBody }).data : emptyJobs(),
  };
}

async function getJobSummary(
  ctx: Ctx,
  id: number,
  cookie = ctx.adminCookie,
): Promise<{ statusCode: number; body: string; data: BatchJobSummaryBody }> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/admin/batch/jobs/${id}`,
    headers: { cookie },
  });
  return {
    statusCode: response.statusCode,
    body: response.body,
    data:
      response.statusCode === 200
        ? (response.json() as { data: BatchJobSummaryBody }).data
        : emptySummary(),
  };
}

interface BatchJobSummaryBody {
  id: number;
  status: string;
  phase: string;
  total: number;
  imported: number;
  judged: number;
  queued: number;
  failed: number;
  skipped: number;
  percent: number;
  eta: number | null;
  heartbeat: number | null;
  startedAt: number | null;
  updatedAt: number | null;
  createdAt: number;
  items?: unknown;
}

interface BatchJobsBody {
  items: BatchJobSummaryBody[];
  total: number;
  offset: number;
  limit: number;
}

function emptyJobs(): BatchJobsBody {
  return { items: [], total: 0, offset: 0, limit: 0 };
}

function emptySummary(): BatchJobSummaryBody {
  return {
    id: 0,
    status: '',
    phase: '',
    total: 0,
    imported: 0,
    judged: 0,
    queued: 0,
    failed: 0,
    skipped: 0,
    percent: 0,
    eta: null,
    heartbeat: null,
    startedAt: null,
    updatedAt: null,
    createdAt: 0,
  };
}

async function runUpload(
  ctx: Ctx,
  uploadId: string,
): Promise<{ statusCode: number; body: string; jobId: number; status: string }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/batch/uploads/${uploadId}/run`,
    headers: { cookie: ctx.adminCookie },
    payload: { studentLevel: 1, problemId: ctx.problemId, language: 'cpp17' },
  });
  const data =
    response.statusCode === 202
      ? (response.json() as { data: { jobId: number; status: string } }).data
      : { jobId: 0, status: '' };
  return { statusCode: response.statusCode, body: response.body, ...data };
}

async function waitUntil(
  check: () => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function seedFinishedJob(
  ctx: Ctx,
  options: { createdAt?: number; uploadId?: string | null } = {},
): number {
  const batchId = createBatchJob(ctx.db, {
    problemId: ctx.problemId,
    studentLevel: 1,
    mode: 'async',
    status: 'finished',
    phase: 'finished',
    uploadId: options.uploadId ?? null,
    createdAt: options.createdAt,
  });
  addBatchItem(ctx.db, {
    batchId,
    student: 'Alice',
    sourcePath: 'Alice/main.cpp',
    problemId: ctx.problemId,
    status: 'imported',
  });
  addBatchItem(ctx.db, {
    batchId,
    student: 'Bob',
    sourcePath: 'Bob/main.cpp',
    problemId: ctx.problemId,
    status: 'error',
    errorCode: 'EMPTY_SOURCE',
    errorMessage: 'empty',
  });
  return batchId;
}

describe('batch job list', () => {
  it('paginates, filters by status and keeps jobs permanently', async () => {
    const ctx = await setup();
    const a = seedFinishedJob(ctx, { createdAt: 1_000 });
    const b = seedFinishedJob(ctx);
    const c = createBatchJob(ctx.db, {
      problemId: ctx.problemId,
      studentLevel: 1,
      mode: 'async',
      status: 'failed',
      phase: 'failed',
      createdAt: 2,
    });

    const page1 = await listJobs(ctx, 'offset=0&limit=2');
    expect(page1.statusCode).toBe(200);
    expect(page1.data.total).toBe(3);
    expect(page1.data.offset).toBe(0);
    expect(page1.data.limit).toBe(2);
    expect(page1.data.items).toHaveLength(2);
    expect(page1.data.items[0]!.id).toBeGreaterThan(page1.data.items[1]!.id);

    const page2 = await listJobs(ctx, 'offset=2&limit=2');
    expect(page2.data.items).toHaveLength(1);
    expect(page2.data.items[0]!.id).toBe(a);

    const finished = await listJobs(ctx, 'status=finished');
    expect(finished.data.total).toBe(2);
    expect(finished.data.items.map((item) => item.id).sort()).toEqual([a, b].sort());
    const failed = await listJobs(ctx, 'status=failed');
    expect(failed.data.items.map((item) => item.id)).toEqual([c]);
    const invalid = await listJobs(ctx, 'status=nope');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toContain('INVALID_STATUS');

    // created_at is ancient but the job is still listed (no retention pruning).
    expect((await listJobs(ctx, 'limit=100')).data.items.some((item) => item.id === a)).toBe(
      true,
    );
  });

  it('enforces admin/setter permissions', async () => {
    const ctx = await setup();
    const forbidden = await listJobs(ctx, '', ctx.contestantCookie);
    expect(forbidden.statusCode).toBe(403);
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/batch/jobs',
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('returns aggregate counters without batch item details', async () => {
    const ctx = await setup();
    const batchId = createBatchJob(ctx.db, {
      problemId: ctx.problemId,
      studentLevel: 1,
      mode: 'async',
      status: 'judging',
      phase: 'judging',
      startedAt: Date.now() - 5000,
      heartbeatAt: Date.now() - 1000,
    });
    for (let index = 0; index < 5000; index += 1) {
      addBatchItem(ctx.db, {
        batchId,
        student: `Bulk${index}`,
        sourcePath: `Bulk${index}/main.cpp`,
        problemId: ctx.problemId,
        status: index % 10 === 0 ? 'error' : 'imported',
        errorCode: index % 10 === 0 ? 'EMPTY_SOURCE' : null,
        errorMessage: index % 10 === 0 ? 'empty' : null,
      });
    }
    const summary = await getJobSummary(ctx, batchId);
    expect(summary.statusCode).toBe(200);
    expect(summary.data.total).toBe(5000);
    expect(summary.data.failed).toBe(500);
    expect(summary.data.imported).toBe(4500);
    expect(summary.data.items).toBeUndefined();
    const list = await listJobs(ctx, 'limit=5');
    expect(list.data.items[0]!.items).toBeUndefined();
    expect(JSON.stringify(summary.data).length).toBeLessThan(4000);
  }, 30_000);
});

describe('batch job aggregate progress', () => {
  it('restores persisted phase, heartbeat and ETA after a restart', async () => {
    const ctx = await setup();
    const startedAt = Date.now() - 2000;
    const batchId = createBatchJob(ctx.db, {
      problemId: ctx.problemId,
      studentLevel: 1,
      mode: 'async',
      status: 'importing',
      phase: 'importing',
      startedAt,
      heartbeatAt: Date.now() - 500,
      meta: { progress: { processed: 50, totalCandidates: 100 } },
    });
    const summary = await getJobSummary(ctx, batchId);
    expect(summary.statusCode).toBe(200);
    expect(summary.data.phase).toBe('importing');
    expect(summary.data.status).toBe('importing');
    expect(summary.data.heartbeat).toBeGreaterThan(0);
    expect(summary.data.startedAt).toBe(startedAt);
    expect(summary.data.eta).toBeGreaterThan(0);
    expect(summary.data.eta).toBeLessThan(10);

    // A fresh app over the same database sees the same persisted progress.
    const restartedApp = await buildApp({ db: ctx.db, config: ctx.config });
    apps.push(restartedApp);
    const response = await restartedApp.inject({
      method: 'GET',
      url: `/api/admin/batch/jobs/${batchId}`,
      headers: { cookie: ctx.adminCookie },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: BatchJobSummaryBody }).data.phase).toBe('importing');
  });

  it('tracks phase transitions during a real import', async () => {
    const ctx = await setup();
    const uploadId = createUpload(ctx, sourceFiles(40));
    const run = await runUpload(ctx, uploadId);
    expect(run.statusCode).toBe(202);
    expect(['importing', 'queued']).toContain(run.status);
    await waitUntil(() => {
      const job = getBatchJob(ctx.db, run.jobId);
      return (
        !job ||
        (job.status !== 'importing' &&
          job.phase !== 'uploaded' &&
          job.phase !== 'parsing')
      );
    });
    const finished = getBatchJob(ctx.db, run.jobId)!;
    expect(['queued', 'judging', 'finished']).toContain(finished.status);
    expect(finished.phase).toBe('queued');
    expect(finished.heartbeat_at).not.toBeNull();
    expect(finished.eta_seconds).toBeNull();
    expect(listBatchItems(ctx.db, run.jobId)).toHaveLength(40);
  }, 60_000);

  it('allows only one importing batch at a time and queues the rest', async () => {
    const ctx = await setup();
    const firstUpload = createUpload(ctx, sourceFiles(600, 'First'));
    const secondUpload = createUpload(ctx, sourceFiles(20, 'Second'));
    const first = await runUpload(ctx, firstUpload);
    const second = await runUpload(ctx, secondUpload);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.status).toBe('importing');
    expect(second.status).toBe('queued');

    let sawTwoImporting = false;
    await waitUntil(() => {
      const importing = ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM batch_jobs WHERE mode = 'async' AND status = 'importing'",
        )
        .get() as unknown as { n: number };
      if (Number(importing.n) > 1) sawTwoImporting = true;
      const jobs = [first.jobId, second.jobId].map((id) => getBatchJob(ctx.db, id));
      return jobs.every((job) => job && job.status !== 'importing');
    }, 60_000);
    expect(sawTwoImporting).toBe(false);
    const firstJob = getBatchJob(ctx.db, first.jobId)!;
    const secondJob = getBatchJob(ctx.db, second.jobId)!;
    expect(firstJob.status).toBe('queued');
    expect(secondJob.status).toBe('queued');
    expect(listBatchItems(ctx.db, first.jobId)).toHaveLength(600);
    expect(listBatchItems(ctx.db, second.jobId)).toHaveLength(20);
  }, 120_000);
});

describe('batch job deletion', () => {
  it('deletes a terminal job, its items and its upload, keeps submissions and audits', async () => {
    const ctx = await setup();
    const uploadId = createUpload(ctx, sourceFiles(1));
    const batchId = seedFinishedJob(ctx, { uploadId });
    const userId = createUser(ctx.db, { username: 'alice', passwordHash: 'x' });
    const submissionId = createSubmission(ctx.db, {
      problemId: ctx.problemId,
      userId,
      language: 'cpp17',
      sourcePath: 'Alice/main.cpp',
      sourceHash: 'h',
      batchId,
    });
    const zipPath = join(ctx.config.dataDir, 'uploads', 'batch', `${uploadId}.zip`);
    expect(existsSync(zipPath)).toBe(true);

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/batch/jobs/${batchId}`,
      headers: { cookie: ctx.adminCookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(getBatchJob(ctx.db, batchId)).toBeNull();
    expect(listBatchItems(ctx.db, batchId)).toHaveLength(0);
    expect(getSubmission(ctx.db, submissionId)).not.toBeNull();
    expect(existsSync(zipPath)).toBe(false);
    expect(
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM batch_uploads WHERE upload_id = ?')
          .get(uploadId) as unknown as { n: number }
      ).n,
    ).toBe(0);
    const audit = ctx.db
      .prepare("SELECT action, target_id FROM audit_logs WHERE action = 'batch.job.delete'")
      .get() as unknown as { action: string; target_id: string } | undefined;
    expect(audit?.target_id).toBe(String(batchId));
  });

  it('refuses to delete active jobs, contest batches or unknown ids', async () => {
    const ctx = await setup();
    const active = createBatchJob(ctx.db, {
      problemId: ctx.problemId,
      studentLevel: 1,
      mode: 'async',
      status: 'importing',
      phase: 'importing',
    });
    const activeDelete = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/batch/jobs/${active}`,
      headers: { cookie: ctx.adminCookie },
    });
    expect(activeDelete.statusCode).toBe(409);
    expect(activeDelete.body).toContain('JOB_NOT_TERMINAL');

    const contestJob = createBatchJob(ctx.db, {
      problemId: ctx.problemId,
      studentLevel: 1,
      status: 'finished',
      phase: 'finished',
      contestId: 9,
    });
    const contestDelete = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/batch/jobs/${contestJob}`,
      headers: { cookie: ctx.adminCookie },
    });
    expect(contestDelete.statusCode).toBe(400);
    expect(contestDelete.body).toContain('NOT_STANDALONE_BATCH');

    const missing = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/admin/batch/jobs/999999',
      headers: { cookie: ctx.adminCookie },
    });
    expect(missing.statusCode).toBe(404);

    const forbidden = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/batch/jobs/${active}`,
      headers: { cookie: ctx.contestantCookie },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
