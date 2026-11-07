import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { unzipSync } from 'fflate';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { hashPassword } from '../security/password.js';
import { cancelSubmission } from '../services/submissions.js';
import { MAX_SOURCE_BYTES_ADMIN, submitSource } from '../services/submissions.js';
import { getProblem, resolveProblemReference } from '../storage/repos/problems.js';
import {
  addBatchItem,
  BATCH_TERMINAL_STATUSES,
  countBatchJobsForUpload,
  createBatchJob,
  deleteBatchJobRows,
  findUnfinishedBatchJobForUpload,
  getBatchItemStats,
  getBatchJob,
  getBatchJobWithCounts,
  listBatchItemFailures,
  listBatchItemsPage,
  listBatchJobsPage,
  listBatchSubmissionIds,
  updateBatchJob,
  type BatchItemImportStatus,
  type BatchItemRow,
  type BatchItemStats,
  type BatchJobListRow,
  type BatchJobRow,
} from '../storage/repos/batches.js';
import {
  createBatchUpload,
  deleteBatchUpload,
  getBatchUpload,
  updateBatchUploadScan,
} from '../storage/repos/batch-uploads.js';
import { recordAudit } from '../storage/repos/audit.js';
import { getSubmission } from '../storage/repos/submissions.js';
import type { UserRow } from '../storage/repos/users.js';import {
  batchUsername,
  classifySubmitError,
  ensureBatchUser,
  estimateBatchEta,
  isBatchImportActive,
  scheduleNextBatchImport,
  cancelBatchImport,
} from '../services/batch-import.js';
import {
  MAX_BATCH_FILE_BYTES,
  MAX_BATCH_UNCOMPRESSED_BYTES,
  MAX_BATCH_ZIP_BYTES,
  BatchZipError,
  freeDiskBytes,
  scanZipStream,
  writeStreamedUpload,
} from '../services/batch-zip.js';
import {
  SOURCE_EXTENSIONS,
  SOURCE_LANGUAGE_BY_EXTENSION,
  planBatchSources,
} from '../services/batch-plan.js';
import {
  iterateBatchCsv,
  iterateBatchHtml,
  writeBatchXlsx,
} from '../services/batch-export.js';

export interface AdminBatchRouteOptions {
  db: DatabaseSync;
  config: Config;
  adminGuard: preHandlerHookHandler;
  /** Override for tests and future settings support; defaults to 512 MiB. */
  maxSourceBytes?: number;
}

// Batch upload limit for admin routes – very large (10 GB) so admins are never
// blocked by the body-size parser when importing student lists or bulk data.
const MAX_BATCH_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
/** Default GET page size; keeps 5000-item batches from being returned at once. */
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;
/** Cap the skipped/error summaries attached to run/get responses. */
const REPORT_LIMIT = 50;
/** A streaming upload response reports the same capped preview failure sample. */
const PREVIEW_REPORT_LIMIT = 100;

type FailureStatus = Extract<BatchItemImportStatus, 'skipped' | 'error'>;

interface SourceCandidate {
  path: string;
  code: string;
  language: string;
  student: string;
  problemId: number;
}

interface ImportFailure {
  student: string;
  sourcePath: string;
  problemId: number | null;
  status: FailureStatus;
  errorCode: string;
  errorMessage: string;
}

function safePath(name: string): string | null {
  const normalized = normalize(name).replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return null;
  return normalized;
}

function zipEntries(body: Buffer): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(body));
}

function parseOffset(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function parseLimit(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(parsed)));
}

/**
 * P0 remains the compatibility path: the old endpoints still buffer and import
 * synchronously, while `/api/admin/batch/uploads` + `/uploads/:id/run` stream
 * and import in the background.
 */
export { batchUsername } from '../services/batch-import.js';

function readMetaForJob(db: DatabaseSync, batchId: number): Record<string, unknown> {
  const job = getBatchJob(db, batchId);
  if (!job) return {};
  try {
    const parsed = JSON.parse(job.meta_json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function resolveBatchStatus(stats: BatchItemStats): 'running' | 'finished' | 'failed' {
  if (stats.imported <= 0) return 'failed';
  return stats.done >= stats.imported ? 'finished' : 'running';
}

const IMPORT_STATUS_VALUES = new Set<BatchItemImportStatus>(['imported', 'skipped', 'error']);

function parseImportStatus(value: string | undefined): BatchItemImportStatus | null {
  return value && IMPORT_STATUS_VALUES.has(value as BatchItemImportStatus)
    ? (value as BatchItemImportStatus)
    : null;
}

/** Default/maximum page size of the persisted batch job monitor. */
const JOB_LIST_DEFAULT_LIMIT = 20;
const JOB_LIST_MAX_LIMIT = 200;
const JOB_STATUS_VALUES = new Set([
  'uploaded',
  'parsing',
  'importing',
  'queued',
  'judging',
  'finished',
  'failed',
  'canceled',
  'running',
]);

function parseJobListLimit(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return JOB_LIST_DEFAULT_LIMIT;
  return Math.min(JOB_LIST_MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

function parseJobStatus(value: string | undefined): string | null | undefined {
  const status = value?.trim().toLowerCase();
  if (!status || status === 'all') return null;
  if (!JOB_STATUS_VALUES.has(status)) return undefined;
  return status;
}

interface JobCounts {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  judged: number;
  queued: number;
}

export interface BatchJobSummary {
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
  problemId: number;
  mode: string | null;
  uploadId: string | null;
  canDelete: boolean;
  error: { code: string; message: string } | null;
}

function readJobMeta(job: { meta_json: string }): Record<string, unknown> {
  try {
    const parsed = JSON.parse(job.meta_json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Derives the user-visible status/phase from persisted fields and aggregate
 * counters. `uploaded` means the job is waiting for the single-flight importer;
 * `queued` after importing means the submissions are waiting for the judge.
 */
function resolveJobState(
  job: { status: string; phase: string },
  counts: JobCounts,
  importActive: boolean,
): { status: string; phase: string } {
  if (job.status === 'canceled') return { status: 'canceled', phase: 'canceled' };
  if (job.status === 'failed') return { status: 'failed', phase: 'failed' };
  if (job.status === 'finished' || job.phase === 'finished') {
    return { status: 'finished', phase: 'finished' };
  }
  if (
    importActive ||
    job.status === 'importing' ||
    job.phase === 'parsing' ||
    job.phase === 'importing'
  ) {
    return {
      status: 'importing',
      phase: job.phase === 'parsing' ? 'parsing' : 'importing',
    };
  }
  if (job.status === 'queued' && job.phase === 'uploaded') {
    return { status: 'queued', phase: 'uploaded' };
  }
  if (counts.imported <= 0) return { status: 'failed', phase: 'failed' };
  if (counts.judged >= counts.imported) return { status: 'finished', phase: 'finished' };
  if (counts.judged > 0) return { status: 'judging', phase: 'judging' };
  return { status: 'queued', phase: 'queued' };
}

function summarizeJob(
  job: BatchJobRow,
  counts: JobCounts,
  importActive: boolean,
): BatchJobSummary {
  const state = resolveJobState(job, counts, importActive);
  const meta = readJobMeta(job);
  const progress = meta.progress as
    | { processed?: number; totalCandidates?: number }
    | undefined;
  let percent = 0;
  if (state.status === 'finished') {
    percent = 100;
  } else if (state.status === 'importing') {
    const total = Number(progress?.totalCandidates ?? 0);
    const processed = Number(progress?.processed ?? 0);
    percent =
      total > 0 ? Math.min(99, Math.round((processed / total) * 100)) : 0;
  } else if (counts.imported > 0) {
    percent = Math.min(100, Math.round((counts.judged / counts.imported) * 100));
  }
  const eta = estimateBatchEta({
    phase: state.phase,
    processed: Number(progress?.processed ?? 0),
    total: Number(progress?.totalCandidates ?? 0),
    judged: counts.judged,
    imported: counts.imported,
    startedAt: job.started_at,
  });
  const errorMeta = meta.error as { code?: unknown; message?: unknown } | undefined;
  return {
    id: job.id,
    status: state.status,
    phase: state.phase,
    total: counts.total,
    imported: counts.imported,
    judged: counts.judged,
    queued: counts.queued,
    failed: counts.failed,
    skipped: counts.skipped,
    percent,
    eta,
    heartbeat: job.heartbeat_at ?? job.updated_at ?? job.created_at,
    startedAt: job.started_at,
    updatedAt: job.updated_at ?? job.created_at,
    createdAt: job.created_at,
    problemId: job.problem_id,
    mode: job.mode,
    uploadId: job.upload_id,
    canDelete: BATCH_TERMINAL_STATUSES.has(state.status),
    error:
      errorMeta && typeof errorMeta.code === 'string'
        ? {
            code: errorMeta.code,
            message: typeof errorMeta.message === 'string' ? errorMeta.message : '',
          }
        : null,
  };
}

function jobCountsFromRow(row: BatchJobListRow): JobCounts {
  return {
    total: row.total,
    imported: row.imported,
    skipped: row.skipped,
    failed: row.failed,
    judged: row.judged,
    queued: row.queued,
  };
}

function jobCountsFromStats(stats: BatchItemStats): JobCounts {
  return {
    total: stats.total,
    imported: stats.imported,
    skipped: stats.skipped,
    failed: stats.errors,
    judged: stats.done,
    queued: Math.max(0, stats.imported - stats.done),
  };
}

/** Persists derived monitor fields on the row so refresh/restart can restore it. */
function refreshStoredJob(
  db: DatabaseSync,
  job: BatchJobRow,
  summary: BatchJobSummary,
): void {
  const now = Date.now();
  const shouldTouch =
    summary.status === 'importing' ||
    summary.status === 'judging' ||
    summary.status === 'queued';
  const heartbeat = shouldTouch ? now : job.heartbeat_at;
  const statusChanged = job.status !== summary.status;
  const phaseChanged = job.phase !== summary.phase;
  const etaChanged = job.eta_seconds !== summary.eta;
  const staleHeartbeat = shouldTouch && now - (job.heartbeat_at ?? 0) > 1000;
  if (!statusChanged && !phaseChanged && !etaChanged && !staleHeartbeat) return;
  updateBatchJob(db, job.id, {
    status: summary.status,
    phase: summary.phase,
    etaSeconds: summary.eta,
    heartbeatAt: heartbeat,
  });
}


function toFailureDto(row: BatchItemRow): {
  id: number;
  student: string;
  sourcePath: string;
  problemId: number | null;
  errorCode: string | null;
  errorMessage: string | null;
} {
  return {
    id: row.id,
    student: row.student,
    sourcePath: row.source_path,
    problemId: row.problem_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function addFailureItem(
  db: DatabaseSync,
  batchId: number,
  failure: ImportFailure,
): void {
  addBatchItem(db, {
    batchId,
    student: failure.student,
    sourcePath: failure.sourcePath,
    submissionId: null,
    problemId: failure.problemId,
    status: failure.status,
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
  });
}

export function registerAdminBatchRoutes(
  app: FastifyInstance,
  options: AdminBatchRouteOptions,
): void {
  const guard = options.adminGuard;
  const maxSourceBytes = options.maxSourceBytes ?? MAX_SOURCE_BYTES_ADMIN;

  app.post(
    '/api/admin/batch/upload',
    { preHandler: guard, bodyLimit: MAX_BATCH_UPLOAD_BYTES },
    async (request, reply) => {
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ ok: false, error: { code: 'EMPTY_BODY' } });
      }
      let files: Record<string, Uint8Array>;
      try {
        files = zipEntries(body);
      } catch (err) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BAD_ZIP', message: (err as Error).message },
        });
      }
      const uploadDir = join(options.config.dataDir, 'uploads', 'batch');
      mkdirSync(uploadDir, { recursive: true });
      const uploadId = randomUUID();
      writeFileSync(join(uploadDir, `${uploadId}.zip`), body);
      const paths = Object.keys(files)
        .filter((name) => !name.endsWith('/'))
        .map((name) => safePath(name))
        .filter((name): name is string => name !== null)
        .sort();
      return reply.code(201).send({ ok: true, data: { uploadId, files: paths } });
    },
  );

  // -------------------------------------------------------------------------
  // P1 streaming upload + async import.
  // -------------------------------------------------------------------------

  app.post(
    '/api/admin/batch/uploads',
    { preHandler: guard },
    async (request, reply) => {
      const body = request.body as unknown;
      if (body === undefined || body === null) {
        return reply
          .code(400)
          .send({ ok: false, error: { code: 'EMPTY_BODY', message: 'raw zip body required' } });
      }
      const contentLengthHeader = request.headers['content-length'];
      const contentLength = Number(contentLengthHeader);
      if (
        contentLengthHeader === undefined ||
        !Number.isFinite(contentLength) ||
        contentLength < 0
      ) {
        return reply.code(411).send({
          ok: false,
          error: { code: 'LENGTH_REQUIRED', message: 'Content-Length is required' },
        });
      }
      if (contentLength === 0) {
        return reply.code(400).send({ ok: false, error: { code: 'EMPTY_BODY' } });
      }
      if (contentLength > MAX_BATCH_ZIP_BYTES) {
        return reply.code(413).send({
          ok: false,
          error: {
            code: 'BATCH_ZIP_TOO_LARGE',
            message: `zip is ${contentLength} bytes; limit is ${MAX_BATCH_ZIP_BYTES} bytes`,
          },
        });
      }

      const uploadDir = join(options.config.dataDir, 'uploads', 'batch');
      mkdirSync(uploadDir, { recursive: true });
      const freeBytes = freeDiskBytes(uploadDir);
      if (freeBytes !== null && freeBytes < contentLength) {
        return reply.code(507).send({
          ok: false,
          error: {
            code: 'BATCH_DISK_FULL',
            message: `only ${freeBytes} bytes free, upload needs ${contentLength}`,
          },
        });
      }

      const uploadId = randomUUID();
      const relativePath = `uploads/batch/${uploadId}.zip`;
      const targetPath = join(options.config.dataDir, relativePath);
      let written;
      try {
        written = await writeStreamedUpload(body as Buffer | NodeJS.ReadableStream, targetPath, {
          expectedBytes: contentLength,
          maxBytes: MAX_BATCH_ZIP_BYTES,
        });
      } catch (err) {
        if (err instanceof BatchZipError) {
          const status = err.code === 'BATCH_ZIP_TOO_LARGE' ? 413 : 400;
          return reply.code(status).send({
            ok: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
      const originalName =
        typeof request.headers['x-file-name'] === 'string'
          ? request.headers['x-file-name']
          : null;
      createBatchUpload(options.db, {
        uploadId,
        originalName,
        zipPath: relativePath,
        sizeBytes: written.sizeBytes,
        sha256: written.sha256,
        createdBy: request.user?.id ?? null,
      });
      return reply.code(201).send({
        ok: true,
        data: {
          uploadId,
          originalName,
          status: 'uploaded',
          sizeBytes: written.sizeBytes,
          sha256: written.sha256,
        },
      });
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { studentLevel?: string; problemLevel?: string };
  }>('/api/admin/batch/uploads/:id/preview', { preHandler: guard }, async (request, reply) => {
    const upload = getBatchUpload(options.db, request.params.id);
    if (!upload) {
      return reply.code(404).send({ ok: false, error: { code: 'UPLOAD_NOT_FOUND' } });
    }
    const studentLevel = Math.max(
      1,
      Math.floor(Number(request.query.studentLevel ?? 1) || 1),
    );
    const problemLevel = Math.max(0, Math.floor(Number(request.query.problemLevel ?? 0) || 0));
    const zipPath = join(options.config.dataDir, upload.zip_path);
    let scan;
    try {
      scan = await scanZipStream(zipPath, {
        maxFileBytes: MAX_BATCH_FILE_BYTES,
        maxTotalUncompressedBytes: MAX_BATCH_UNCOMPRESSED_BYTES,
      });
    } catch (err) {
      if (err instanceof BatchZipError) {
        const status =
          err.code === 'BATCH_ENTRY_LIMIT' || err.code === 'BATCH_UNCOMPRESSED_LIMIT'
            ? 413
            : 400;
        return reply.code(status).send({
          ok: false,
          error: { code: err.code, message: err.message },
        });
      }
      throw err;
    }
    updateBatchUploadScan(
      options.db,
      upload.upload_id,
      scan.entryCount,
      scan.totalUncompressedBytes,
    );
    const plan = planBatchSources({
      files: scan.files,
      directories: scan.directories,
      skipped: scan.skipped,
      studentLevel,
      problemLevel,
      singleProblemId: null,
      maxSourceBytes,
      defaultLanguage: 'cpp17',
      // Preview counts structurally valid sources before any mapping exists.
      unmapped: 'allow',
    });
    return {
      ok: true,
      data: {
        uploadId: upload.upload_id,
        originalName: upload.original_name,
        status: 'uploaded',
        sizeBytes: upload.size_bytes,
        sha256: upload.sha256,
        entryCount: scan.entryCount,
        totalUncompressedBytes: scan.totalUncompressedBytes,
        studentLevel,
        problemLevel,
        treeSample: plan.treeSample,
        maxDepth: plan.maxDepth,
        students: plan.studentFolders.length,
        studentSample: plan.studentSample,
        problemFolders: plan.problemFolders,
        invalidStudents: plan.invalidStudents.slice(0, PREVIEW_REPORT_LIMIT),
        duplicates: plan.duplicates.slice(0, PREVIEW_REPORT_LIMIT),
        duplicateCount: plan.duplicates.length,
        validCount: plan.validCount,
        totalFiles: plan.totalFiles,
        skipped: plan.skipped.slice(0, PREVIEW_REPORT_LIMIT),
        failures: plan.failures.slice(0, PREVIEW_REPORT_LIMIT),
      },
    };
  });

  app.post<{
    Params: { id: string };
    Body: {
      studentLevel?: number;
      problemLevel?: number;
      problemId?: number;
      problemMap?: Record<string, number>;
      language?: string;
    };
  }>('/api/admin/batch/uploads/:id/run', { preHandler: guard }, async (request, reply) => {
    const upload = getBatchUpload(options.db, request.params.id);
    if (!upload) {
      return reply.code(404).send({ ok: false, error: { code: 'UPLOAD_NOT_FOUND' } });
    }
    const body = request.body ?? {};
    const studentLevel = Math.max(1, Math.floor(Number(body.studentLevel ?? 1) || 1));
    const problemLevel = Math.max(0, Math.floor(Number(body.problemLevel ?? 0) || 0));
    const multiProblem = problemLevel > 0;
    const problemId = Number(body.problemId);
    if (!multiProblem && !Number.isInteger(problemId)) {
      return reply
        .code(400)
        .send({ ok: false, error: { code: 'BAD_REQUEST', message: 'problemId is required' } });
    }
    if (!multiProblem && !getProblem(options.db, problemId)) {
      return reply.code(404).send({ ok: false, error: { code: 'PROBLEM_NOT_FOUND' } });
    }
    const problemMap: Record<string, number> = {};
    for (const [folder, value] of Object.entries(body.problemMap ?? {})) {
      const id = Number(value);
      if (!Number.isInteger(id) || !getProblem(options.db, id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BAD_PROBLEM_MAP', message: `unknown problem for folder: ${folder}` },
        });
      }
      problemMap[folder] = id;
    }
    const unfinished = findUnfinishedBatchJobForUpload(options.db, upload.upload_id);
    if (unfinished) {
      return reply.code(409).send({
        ok: false,
        error: { code: 'BATCH_ALREADY_RUNNING', jobId: unfinished.id },
      });
    }
    const batchId = createBatchJob(options.db, {
      problemId: multiProblem ? 0 : problemId,
      studentLevel,
      contestId: null,
      mode: 'async',
      problemLevel: multiProblem ? problemLevel : null,
      problemMap,
      createdBy: request.user?.id ?? null,
      status: 'queued',
      phase: 'uploaded',
      uploadId: upload.upload_id,
    });
    // Single-flight importer: if another import owns the slot this job stays
    // queued (phase uploaded) and is promoted when the slot frees up.
    scheduleNextBatchImport({
      db: options.db,
      config: options.config,
      maxSourceBytes,
    });
    const current = getBatchJob(options.db, batchId);
    return reply.code(202).send({
      ok: true,
      data: {
        jobId: batchId,
        id: batchId,
        status: current?.status === 'importing' ? 'importing' : 'queued',
      },
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/admin/batch/:id/cancel',
    { preHandler: guard },
    async (request, reply) => {
      const id = Number(request.params.id);
      const job = getBatchJob(options.db, id);
      if (!job) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      if (job.contest_id !== null) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'NOT_STANDALONE_BATCH', message: 'contest batches are owned by the contest' },
        });
      }
      if (job.mode === 'async' && !isBatchImportActive(id) && job.status !== 'importing') {
        const state = resolveJobState(
          job,
          jobCountsFromStats(getBatchItemStats(options.db, id)),
          false,
        );
        if (state.status === 'finished') {
          return reply.code(409).send({
            ok: false,
            error: { code: 'CANNOT_CANCEL', message: 'batch already finished' },
          });
        }
      }
      cancelBatchImport(id);
      updateBatchJob(options.db, id, {
        status: 'canceled',
        phase: 'canceled',
        heartbeatAt: Date.now(),
        etaSeconds: 0,
        meta: { ...readMetaForJob(options.db, id), canceledAt: Date.now() },
      });
      const submissionIds = listBatchSubmissionIds(options.db, id);
      let canceled = 0;
      const actor = {
        id: request.user?.id ?? 0,
        role: request.user?.role ?? 'admin',
      };
      for (const submissionId of submissionIds) {
        try {
          cancelSubmission(options.db, submissionId, actor);
          canceled += 1;
        } catch {
          // Terminal submissions and worker-owned tasks may already be gone;
          // cancellation is best-effort per item.
        }
      }
      return { ok: true, data: { id, status: 'canceled', canceled } };
    },
  );

  // -------------------------------------------------------------------------
  // Persisted batch job monitor: paginated list, aggregate detail, deletion.
  // -------------------------------------------------------------------------
  app.get<{
    Querystring: { offset?: string; limit?: string; status?: string };
  }>('/api/admin/batch/jobs', { preHandler: guard }, async (request, reply) => {
    const status = parseJobStatus(request.query.status);
    if (status === undefined) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'INVALID_STATUS', message: 'unknown batch status' },
      });
    }
    const offset = parseOffset(request.query.offset);
    const limit = parseJobListLimit(request.query.limit);
    const { items, total } = listBatchJobsPage(options.db, offset, limit, status);
    return {
      ok: true,
      data: {
        items: items.map((row) =>
          summarizeJob(row, jobCountsFromRow(row), isBatchImportActive(row.id)),
        ),
        total,
        offset,
        limit,
      },
    };
  });

  app.get<{ Params: { id: string } }>(
    '/api/admin/batch/jobs/:id',
    { preHandler: guard },
    async (request, reply) => {
      const id = Number(request.params.id);
      const row = getBatchJobWithCounts(options.db, id);
      if (!row) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      const summary = summarizeJob(row, jobCountsFromRow(row), isBatchImportActive(row.id));
      // Contest batches keep their own lifecycle; standalone jobs persist the
      // derived phase/heartbeat so a refresh or restart restores the monitor.
      if (row.contest_id === null) refreshStoredJob(options.db, row, summary);
      return { ok: true, data: summary };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/batch/jobs/:id',
    { preHandler: guard },
    async (request, reply) => {
      const id = Number(request.params.id);
      const job = getBatchJob(options.db, id);
      if (!job) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      if (job.contest_id !== null) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'NOT_STANDALONE_BATCH',
            message: 'contest batches are owned by the contest',
          },
        });
      }
      const stats = getBatchItemStats(options.db, id);
      const summary = summarizeJob(
        job,
        jobCountsFromStats(stats),
        isBatchImportActive(id),
      );
      if (!summary.canDelete) {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'JOB_NOT_TERMINAL',
            message: 'only finished, failed or canceled jobs can be deleted',
          },
        });
      }
      const upload = job.upload_id ? getBatchUpload(options.db, job.upload_id) : null;
      deleteBatchJobRows(options.db, id);
      // The archive is only useful to this job family. Remove it when no other
      // job references the upload; submissions, judge tasks and problems stay.
      if (upload && countBatchJobsForUpload(options.db, upload.upload_id) === 0) {
        rmSync(join(options.config.dataDir, upload.zip_path), { force: true });
        deleteBatchUpload(options.db, upload.upload_id);
      }
      recordAudit(options.db, {
        actorId: request.user?.id ?? null,
        action: 'batch.job.delete',
        targetType: 'batch_job',
        targetId: id,
        detail: {
          uploadId: job.upload_id,
          total: summary.total,
          phase: summary.phase,
        },
        ip: request.ip,
      });
      return { ok: true, data: { id, deleted: true } };
    },
  );

  app.post<{
    Body: {
      uploadId?: string;
      problemId?: number;
      studentLevel?: number;
      problemLevel?: number;
      problemMap?: Record<string, number>;
      language?: string;
    };
  }>('/api/admin/batch/run', { preHandler: guard }, async (request, reply) => {
    const { uploadId } = request.body ?? {};
    const problemId = Number(request.body?.problemId);
    const studentLevel = Math.max(1, Math.floor(Number(request.body?.studentLevel ?? 1)));
    const problemLevel = Math.floor(Number(request.body?.problemLevel ?? 0));
    const multiProblem = problemLevel > 0;
    const language = request.body?.language ?? 'cpp17';
    if (!uploadId || (!multiProblem && !Number.isInteger(problemId))) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST' } });
    }
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_UPLOAD_ID' } });
    }
    const zipPath = join(options.config.dataDir, 'uploads', 'batch', `${uploadId}.zip`);
    if (!existsSync(zipPath)) {
      return reply.code(404).send({ ok: false, error: { code: 'UPLOAD_NOT_FOUND' } });
    }
    if (!multiProblem && !getProblem(options.db, problemId)) {
      return reply.code(404).send({ ok: false, error: { code: 'PROBLEM_NOT_FOUND' } });
    }

    let files: Record<string, Uint8Array>;
    try {
      files = zipEntries(readFileSync(zipPath));
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'BAD_ZIP', message: (err as Error).message },
      });
    }

    const problemMap = new Map<string, number>();
    for (const [folder, value] of Object.entries(request.body?.problemMap ?? {})) {
      const id = Number(value);
      if (Number.isInteger(id) && getProblem(options.db, id)) problemMap.set(folder, id);
    }
    const resolvedProblems = new Map<string, number | null>();
    const resolveProblem = (folder: string): number | null => {
      if (resolvedProblems.has(folder)) return resolvedProblems.get(folder)!;
      let resolved: number | null = null;
      if (problemMap.has(folder)) {
        resolved = problemMap.get(folder)!;
      } else {
        // The folder itself may be a display id (P1001) or a numeric problem id.
        resolved = resolveProblemReference(options.db, folder)?.id ?? null;
      }
      resolvedProblems.set(folder, resolved);
      return resolved;
    };

    const maxLevel = Math.max(studentLevel, multiProblem ? problemLevel : studentLevel);
    const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
    const studentFolders = new Set<string>();
    const itemStudents = new Set<string>();
    const claimedSources = new Set<string>();
    const candidates: SourceCandidate[] = [];
    const failures: ImportFailure[] = [];
    let duplicateCount = 0;

    for (const [rawName, content] of entries) {
      const isDirectory = rawName.endsWith('/');
      const relative = safePath(rawName.replace(/\/+$/, ''));
      if (!relative) {
        failures.push({
          student: '(unsafe path)',
          sourcePath: rawName,
          problemId: null,
          status: 'error',
          errorCode: 'UNSAFE_PATH',
          errorMessage: rawName,
        });
        continue;
      }
      const parts = relative.split('/').filter(Boolean);
      if (parts.length === 0) continue;
      if (isDirectory) {
        const student = parts[studentLevel - 1];
        if (parts.length >= studentLevel && student) studentFolders.add(student);
        continue;
      }
      // A file inside a student directory (not the student path itself).
      if (parts.length > studentLevel) {
        const student = parts[studentLevel - 1];
        if (student) studentFolders.add(student);
      }
      const extension = relative.slice(relative.lastIndexOf('.')).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(extension)) continue;
      if (parts.length <= maxLevel) continue;
      const student = parts[studentLevel - 1];
      if (!student) continue;
      const folder = multiProblem ? (parts[problemLevel - 1] ?? '') : '';
      const sourceProblemId = multiProblem ? resolveProblem(folder) : problemId;
      const claimKey = sourceProblemId
        ? `${student}\u0000${sourceProblemId}`
        : `${student}\u0000folder:${folder}`;
      if (claimedSources.has(claimKey)) {
        duplicateCount += 1;
        continue;
      }
      claimedSources.add(claimKey);
      itemStudents.add(student);
      if (!sourceProblemId) {
        failures.push({
          student,
          sourcePath: relative,
          problemId: null,
          status: 'error',
          errorCode: 'UNMAPPED_PROBLEM',
          errorMessage: `no problem mapping for folder: ${folder || '(empty)'}`,
        });
        continue;
      }
      if (content.length === 0) {
        failures.push({
          student,
          sourcePath: relative,
          problemId: sourceProblemId,
          status: 'error',
          errorCode: 'EMPTY_SOURCE',
          errorMessage: 'source file is empty',
        });
        continue;
      }
      if (content.length > maxSourceBytes) {
        failures.push({
          student,
          sourcePath: relative,
          problemId: sourceProblemId,
          status: 'error',
          errorCode: 'SOURCE_TOO_LARGE',
          errorMessage: `source is ${content.length} bytes; limit is ${maxSourceBytes} bytes`,
        });
        continue;
      }
      candidates.push({
        path: relative,
        code: Buffer.from(content).toString('utf8'),
        language:
          SOURCE_LANGUAGE_BY_EXTENSION[extension] ?? language,
        student,
        problemId: sourceProblemId,
      });
    }

    // Student folders with no usable source are skipped, not fatal.
    for (const student of [...studentFolders].sort((left, right) =>
      left.localeCompare(right),
    )) {
      if (itemStudents.has(student)) continue;
      failures.push({
        student,
        sourcePath: student,
        problemId: null,
        status: 'skipped',
        errorCode: 'INVALID_STUDENT_FOLDER',
        errorMessage: 'student folder has no usable source file at the selected level',
      });
    }

    if (candidates.length === 0 && failures.length === 0) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'NO_SOURCES',
          message: 'no student folders or .cpp sources found at the selected level',
        },
      });
    }

    const batchId = createBatchJob(options.db, {
      problemId: multiProblem ? 0 : problemId,
      studentLevel,
      contestId: null,
      problemLevel: multiProblem ? problemLevel : null,
      problemMap: Object.fromEntries(problemMap),
      createdBy: request.user?.id ?? null,
      status: 'running',
      phase: 'importing',
      startedAt: Date.now(),
    });

    for (const failure of failures) addFailureItem(options.db, batchId, failure);

    // Hash the synthetic-student password once per batch instead of per student.
    const syntheticPasswordHash = hashPassword(randomUUID());
    const userCache = new Map<string, UserRow>();
    const created: Array<{ student: string; problemId: number; submissionId: number }> = [];
    const ordered = [...candidates].sort(
      (left, right) =>
        left.student.localeCompare(right.student) ||
        left.problemId - right.problemId ||
        left.path.localeCompare(right.path),
    );
    for (const source of ordered) {
      let user: UserRow;
      try {
        user =
          userCache.get(source.student) ??
          ensureBatchUser(options.db, source.student, syntheticPasswordHash);
        userCache.set(source.student, user);
      } catch (err) {
        addFailureItem(options.db, batchId, {
          student: source.student,
          sourcePath: source.path,
          problemId: source.problemId,
          status: 'error',
          errorCode: 'USER_CREATE_FAILED',
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      try {
        const { id } = submitSource(
          { db: options.db, config: options.config },
          {
            userId: user.id,
            problemId: source.problemId,
            language: source.language,
            code: source.code,
            contestId: null,
            batchId,
            skipCooldown: true,
            // Admin batch pipelines submit on behalf of synthetic students, so the
            // practice read ACL does not apply.
            skipAccessCheck: true,
          },
        );
        addBatchItem(options.db, {
          batchId,
          student: source.student,
          sourcePath: source.path,
          submissionId: id,
          problemId: source.problemId,
          userId: user.id,
          status: 'imported',
        });
        created.push({
          student: source.student,
          problemId: source.problemId,
          submissionId: id,
        });
      } catch (err) {
        const classified = classifySubmitError(err);
        addFailureItem(options.db, batchId, {
          student: source.student,
          sourcePath: source.path,
          problemId: source.problemId,
          status: 'error',
          errorCode: classified.code,
          errorMessage: classified.message,
        });
      }
    }

    const stats = getBatchItemStats(options.db, batchId);
    const status = resolveBatchStatus(stats);
    updateBatchJob(options.db, batchId, {
      status,
      phase:
        status === 'finished' ? 'finished' : status === 'failed' ? 'failed' : 'queued',
      heartbeatAt: Date.now(),
      etaSeconds: status === 'finished' || status === 'failed' ? 0 : null,
    });
    return reply.code(201).send({
      ok: true,
      data: {
        id: batchId,
        status,
        count: created.length,
        total: stats.total,
        importedCount: stats.imported,
        skippedCount: stats.skipped,
        errorCount: stats.errors,
        duplicateCount,
        items: created,
        multiProblem,
        skipped: listBatchItemFailures(options.db, batchId, 'skipped', REPORT_LIMIT).map(
          toFailureDto,
        ),
        errors: listBatchItemFailures(options.db, batchId, 'error', REPORT_LIMIT).map(
          toFailureDto,
        ),
      },
    });
  });

  // -------------------------------------------------------------------------
  // Batch result export (CSV long table, printable HTML, XLSX long + matrix).
  // -------------------------------------------------------------------------
  app.get<{
    Params: { id: string };
    Querystring: { format?: string; matrix?: string };
  }>('/api/admin/batch/:id/export', { preHandler: guard }, async (request, reply) => {
    const id = Number(request.params.id);
    const format = (request.query.format ?? 'csv').toLowerCase();
    if (format !== 'csv' && format !== 'xlsx' && format !== 'html') {
      return reply.code(400).send({
        ok: false,
        error: { code: 'INVALID_FORMAT', message: 'format must be csv, xlsx or html' },
      });
    }
    const job = getBatchJob(options.db, id);
    if (!job) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    const matrixOnly =
      format === 'csv' &&
      (request.query.matrix === '1' || request.query.matrix === 'true');
    const extension = matrixOnly ? 'csv' : format;
    const filename = matrixOnly
      ? `batch-${id}-matrix.csv`
      : `batch-${id}.${extension}`;
    reply.header('content-disposition', `attachment; filename="${filename}"`);
    reply.header('cache-control', 'no-store');
    if (format === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8');
      return reply.send(
        Readable.from(iterateBatchCsv(options.db, id, { matrix: matrixOnly }), {
          objectMode: false,
        }),
      );
    }
    if (format === 'html') {
      reply.header('content-type', 'text/html; charset=utf-8');
      return reply.send(Readable.from(iterateBatchHtml(options.db, id), { objectMode: false }));
    }
    reply.header(
      'content-type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const stream = new PassThrough();
    // The workbook is produced asynchronously after the response starts; any
    // failure destroys the stream so the client sees a truncated download
    // instead of a silently incomplete workbook.
    void writeBatchXlsx(options.db, id, stream).catch((error: unknown) => {
      stream.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    return reply.send(stream);
  });

  app.get<{
    Params: { id: string };
    Querystring: { offset?: string; limit?: string; status?: string };
  }>('/api/admin/batch/:id', { preHandler: guard }, async (request, reply) => {
    const id = Number(request.params.id);
    const job = getBatchJob(options.db, id);
    if (!job) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    const offset = parseOffset(request.query.offset);
    const limit = parseLimit(request.query.limit);
    const itemStatus = parseImportStatus(request.query.status);
    const stats = getBatchItemStats(options.db, id);
    const importActive = isBatchImportActive(id);
    const summary = summarizeJob(job, jobCountsFromStats(stats), importActive);
    // Contest batch jobs (contest_id != null) own their lifecycle; never
    // rewrite draft/ready/published statuses from the standalone monitor.
    let status = summary.status;
    let phase = summary.phase;
    if (job.contest_id !== null) {
      status = job.status;
      phase = job.phase || job.status;
    } else if (job.mode === 'async') {
      // Persist the derived monitor state so refresh/restart can restore it.
      refreshStoredJob(options.db, job, summary);
    } else {
      // Legacy synchronous P0 jobs keep their historical running/finished
      // status contract; only the phase is new.
      status = resolveBatchStatus(stats);
      phase =
        status === 'finished' ? 'finished' : status === 'failed' ? 'failed' : 'queued';
      if (job.status !== status) {
        updateBatchJob(options.db, id, {
          status,
          phase,
          heartbeatAt: Date.now(),
          etaSeconds: status === 'finished' || status === 'failed' ? 0 : null,
        });
      }
    }
    const meta = readJobMeta(job);
    const progressMeta = meta.progress as
      | { processed?: number; totalCandidates?: number }
      | undefined;
    const importProgress =
      progressMeta && typeof progressMeta.processed === 'number'
        ? {
            processed: progressMeta.processed,
            totalCandidates: Number(progressMeta.totalCandidates ?? 0),
          }
        : null;
    const items = listBatchItemsPage(options.db, id, offset, limit, itemStatus).map((item) => {
      const submission = item.submission_id
        ? getSubmission(options.db, item.submission_id)
        : null;
      const itemProblemId = item.problem_id ?? (job.problem_id || null);
      const importStatus =
        item.status ?? (item.submission_id ? ('imported' as const) : null);
      const status =
        submission?.status ??
        (importStatus === 'skipped'
          ? 'skipped'
          : importStatus === 'error'
            ? 'error'
            : 'missing');
      return {
        id: item.id,
        student: item.student,
        problemId: itemProblemId,
        problemTitle: itemProblemId
          ? (getProblem(options.db, itemProblemId)?.title ?? null)
          : null,
        sourcePath: item.source_path,
        submissionId: item.submission_id,
        importStatus,
        status,
        errorCode: item.error_code ?? null,
        errorMessage: item.error_message ?? null,
        verdict: submission?.verdict ?? null,
        score: submission?.score ?? 0,
        timeMs: submission?.time_ms ?? 0,
        memoryKb: submission?.memory_kb ?? 0,
      };
    });
    return {
      ok: true,
      data: {
        id,
        problemId: job.problem_id,
        multiProblem: job.problem_id === 0,
        mode: job.mode,
        uploadId: job.upload_id,
        status,
        jobStatus: job.status,
        phase,
        eta: summary.eta,
        heartbeat: summary.heartbeat,
        startedAt: summary.startedAt,
        updatedAt: summary.updatedAt,
        studentLevel: job.student_level,
        offset,
        limit,
        total: stats.total,
        count: items.length,
        importedCount: stats.imported,
        skippedCount: stats.skipped,
        errorCount: stats.errors,
        failedCount: summary.failed,
        queuedCount: summary.queued,
        judgedCount: stats.done,
        acCount: stats.acCount,
        averageScore: stats.imported > 0 ? stats.scoreSum / stats.imported : 0,
        distinctStudentCount: stats.distinctStudents,
        distinctProblemCount: stats.distinctProblems,
        progress: {
          total: summary.total,
          imported: summary.imported,
          skipped: summary.skipped,
          errors: summary.failed,
          judged: summary.judged,
          queued: summary.queued,
          percent: summary.percent,
          phase: summary.phase,
          eta: summary.eta,
          heartbeat: summary.heartbeat,
          startedAt: summary.startedAt,
          updatedAt: summary.updatedAt,
          import: importProgress,
        },
        items,
        skipped: listBatchItemFailures(options.db, id, 'skipped', REPORT_LIMIT).map(
          toFailureDto,
        ),
        errors: listBatchItemFailures(options.db, id, 'error', REPORT_LIMIT).map(
          toFailureDto,
        ),
      },
    };
  });
}
