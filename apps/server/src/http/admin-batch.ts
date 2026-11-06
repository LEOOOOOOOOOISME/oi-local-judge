import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { unzipSync } from 'fflate';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { hashPassword } from '../security/password.js';
import { cancelSubmission } from '../services/submissions.js';
import { MAX_SOURCE_BYTES_ADMIN, submitSource } from '../services/submissions.js';
import { getProblem } from '../storage/repos/problems.js';
import {
  addBatchItem,
  createBatchJob,
  findUnfinishedBatchJobForUpload,
  getBatchItemStats,
  getBatchJob,
  listBatchItemFailures,
  listBatchItemsPage,
  listBatchSubmissionIds,
  setBatchStatus,
  updateBatchJob,
  type BatchItemImportStatus,
  type BatchItemRow,
  type BatchItemStats,
  type BatchJobRow,
} from '../storage/repos/batches.js';
import {
  createBatchUpload,
  getBatchUpload,
  updateBatchUploadScan,
} from '../storage/repos/batch-uploads.js';
import { getSubmission } from '../storage/repos/submissions.js';
import type { UserRow } from '../storage/repos/users.js';import {
  batchUsername,
  classifySubmitError,
  ensureBatchUser,
  isBatchImportActive,
  startBatchImport,
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

/**
 * Status of a streaming async import. `importing` is owned by the background
 * job; afterwards the phase is derived from persisted batch_items/submissions
 * so a restart or a missed status write can never strand a job.
 */
function resolveAsyncBatchStatus(
  job: { status: string },
  stats: BatchItemStats,
  importActive: boolean,
): string {
  if (job.status === 'canceled') return 'canceled';
  if (job.status === 'failed') return 'failed';
  if (job.status === 'importing') {
    if (importActive) return 'importing';
    return stats.imported > 0 ? 'queued' : 'failed';
  }
  if (stats.imported <= 0) return 'failed';
  if (stats.done >= stats.imported) return 'finished';
  if (stats.done > 0) return 'judging';
  return 'queued';
}

function importProgressFromMeta(
  job: BatchJobRow | null,
): { processed: number; totalCandidates: number } | null {
  if (!job) return null;
  try {
    const meta = JSON.parse(job.meta_json) as {
      progress?: { processed?: number; totalCandidates?: number };
    };
    const progress = meta.progress;
    if (!progress || typeof progress.processed !== 'number') return null;
    return {
      processed: progress.processed,
      totalCandidates: Number(progress.totalCandidates ?? 0),
    };
  } catch {
    return null;
  }
}

function buildProgress(
  stats: BatchItemStats,
  status: string,
  job: BatchJobRow | null,
): {
  total: number;
  imported: number;
  skipped: number;
  errors: number;
  judged: number;
  percent: number;
  phase: string;
  import: { processed: number; totalCandidates: number } | null;
} {
  const imported = importProgressFromMeta(job);
  let percent = 0;
  if (status === 'importing' && imported) {
    percent =
      imported.totalCandidates > 0
        ? Math.min(99, Math.round((imported.processed / imported.totalCandidates) * 100))
        : 0;
  } else if (stats.imported > 0) {
    percent = Math.min(100, Math.round((stats.done / stats.imported) * 100));
  } else if (status === 'finished') {
    percent = 100;
  }
  return {
    total: stats.total,
    imported: stats.imported,
    skipped: stats.skipped,
    errors: stats.errors,
    judged: stats.done,
    percent,
    phase: status,
    import: imported,
  };
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
    const language = body.language ?? 'cpp17';
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
      status: 'importing',
      uploadId: upload.upload_id,
    });
    startBatchImport(
      { db: options.db, config: options.config, maxSourceBytes },
      {
        batchId,
        uploadId: upload.upload_id,
        studentLevel,
        problemLevel,
        problemId,
        problemMap,
        language,
      },
    );
    return reply.code(202).send({
      ok: true,
      data: { jobId: batchId, id: batchId, status: 'importing' },
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
        const status = resolveAsyncBatchStatus(job, getBatchItemStats(options.db, id), false);
        if (status === 'finished') {
          return reply.code(409).send({
            ok: false,
            error: { code: 'CANNOT_CANCEL', message: 'batch already finished' },
          });
        }
      }
      cancelBatchImport(id);
      setBatchStatus(options.db, id, 'canceled');
      updateBatchJob(options.db, id, {
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
        const numeric = Number(folder);
        if (Number.isInteger(numeric) && getProblem(options.db, numeric)) resolved = numeric;
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
    setBatchStatus(options.db, batchId, status);
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
    // Contest batch jobs (contest_id != null) own their lifecycle; never rewrite
    // draft/ready/published statuses from the standalone batch progress route.
    let status: string;
    if (job.contest_id !== null) {
      status = job.status;
    } else if (job.mode === 'async') {
      status = resolveAsyncBatchStatus(job, stats, isBatchImportActive(id));
      // Do not clobber `importing` while the background job still owns it.
      if ((job.status !== 'importing' || !isBatchImportActive(id)) && job.status !== status) {
        setBatchStatus(options.db, id, status);
      }
    } else {
      status = resolveBatchStatus(stats);
      if (job.status !== status) setBatchStatus(options.db, id, status);
    }
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
        studentLevel: job.student_level,
        offset,
        limit,
        total: stats.total,
        count: items.length,
        importedCount: stats.imported,
        skippedCount: stats.skipped,
        errorCount: stats.errors,
        judgedCount: stats.done,
        acCount: stats.acCount,
        averageScore: stats.imported > 0 ? stats.scoreSum / stats.imported : 0,
        distinctStudentCount: stats.distinctStudents,
        distinctProblemCount: stats.distinctProblems,
        progress: buildProgress(stats, status, job),
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
