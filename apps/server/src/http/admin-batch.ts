import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { unzipSync } from 'fflate';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { hashPassword } from '../security/password.js';
import {
  MAX_SOURCE_BYTES_ADMIN,
  submitSource,
} from '../services/submissions.js';
import { getProblem } from '../storage/repos/problems.js';
import {
  addBatchItem,
  createBatchJob,
  getBatchItemStats,
  getBatchJob,
  listBatchItemFailures,
  listBatchItemsPage,
  setBatchStatus,
  type BatchItemImportStatus,
  type BatchItemRow,
  type BatchItemStats,
} from '../storage/repos/batches.js';
import { getSubmission } from '../storage/repos/submissions.js';
import {
  createUser,
  getUserByUsername,
  type UserRow,
} from '../storage/repos/users.js';

export interface AdminBatchRouteOptions {
  db: DatabaseSync;
  config: Config;
  adminGuard: preHandlerHookHandler;
  /** Override for tests and future settings support; defaults to 512 MiB. */
  maxSourceBytes?: number;
}

const SOURCE_EXTENSIONS = new Set(['.cpp', '.cc', '.cxx', '.c']);
const SOURCE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.cpp': 'cpp17',
  '.cc': 'cpp17',
  '.cxx': 'cpp17',
  '.c': 'c11',
};

// Batch upload limit for admin routes – very large (10 GB) so admins are never
// blocked by the body-size parser when importing student lists or bulk data.
const MAX_BATCH_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
/** Default GET page size; keeps 5000-item batches from being returned at once. */
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;
/** Cap the skipped/error summaries attached to run/get responses. */
const REPORT_LIMIT = 50;

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
 * Synthetic student usernames are stable and unique per student. Short names
 * keep the historical `batch_<student>` form so existing accounts are reused;
 * overlong names get a hash suffix instead of colliding after truncation.
 */
export function batchUsername(student: string): string {
  const base = `batch_${student}`;
  if (base.length <= 64) return base;
  const digest = createHash('sha1').update(student).digest('hex').slice(0, 8);
  return `${base.slice(0, 64 - digest.length - 1)}_${digest}`;
}

function ensureBatchUser(
  db: DatabaseSync,
  student: string,
  passwordHash: string,
): UserRow {
  const username = batchUsername(student);
  const existing = getUserByUsername(db, username);
  if (existing) return existing;
  try {
    createUser(db, {
      username,
      passwordHash,
      realName: student,
      role: 'contestant',
    });
  } catch (error) {
    // A concurrent request may have created the same synthetic user.
    const raced = getUserByUsername(db, username);
    if (raced) return raced;
    throw error;
  }
  const created = getUserByUsername(db, username);
  if (!created) throw new Error(`synthetic user ${username} was not created`);
  return created;
}

function classifySubmitError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/source is too large/i.test(message)) {
    return { code: 'SOURCE_TOO_LARGE', message };
  }
  if (/source is empty/i.test(message)) {
    return { code: 'EMPTY_SOURCE', message };
  }
  if (/unsupported language|require language|only accepted for/i.test(message)) {
    return { code: 'UNSUPPORTED_SOURCE', message };
  }
  if (/problem not found/i.test(message)) {
    return { code: 'UNMAPPED_PROBLEM', message };
  }
  return { code: 'SUBMIT_FAILED', message };
}

function resolveBatchStatus(stats: BatchItemStats): 'running' | 'finished' | 'failed' {
  if (stats.imported <= 0) return 'failed';
  return stats.done >= stats.imported ? 'finished' : 'running';
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
    Querystring: { offset?: string; limit?: string };
  }>('/api/admin/batch/:id', { preHandler: guard }, async (request, reply) => {
    const id = Number(request.params.id);
    const job = getBatchJob(options.db, id);
    if (!job) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    const offset = parseOffset(request.query.offset);
    const limit = parseLimit(request.query.limit);
    const stats = getBatchItemStats(options.db, id);
    // Contest batch jobs (contest_id != null) own their lifecycle; never rewrite
    // draft/ready/published statuses from the standalone batch progress route.
    const status = job.contest_id !== null ? job.status : resolveBatchStatus(stats);
    if (job.contest_id === null && job.status !== status) {
      setBatchStatus(options.db, id, status);
    }
    const items = listBatchItemsPage(options.db, id, offset, limit).map((item) => {
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
        status,
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
