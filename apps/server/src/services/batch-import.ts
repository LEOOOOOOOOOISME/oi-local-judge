import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { hashPassword } from '../security/password.js';
import { transaction } from '../storage/db.js';
import {
  addBatchItem,
  findImportingBatchJob,
  getBatchItemStats,
  getBatchJob,
  listBatchItems,
  listImportingBatchJobs,
  listPendingImportJobs,
  updateBatchJob,
  type BatchJobRow,
} from '../storage/repos/batches.js';
import { getBatchUpload, updateBatchUploadScan } from '../storage/repos/batch-uploads.js';
import { resolveProblemReference } from '../storage/repos/problems.js';
import type { UserRow } from '../storage/repos/users.js';
import { createUser, getUserByUsername } from '../storage/repos/users.js';
import { BATCH_JUDGE_PRIORITY, MAX_SOURCE_BYTES_ADMIN, submitSource } from './submissions.js';
import { planBatchSources } from './batch-plan.js';
import {
  BatchImportCanceledError,
  BatchZipError,
  extractZipEntries,
  MAX_BATCH_FILE_BYTES,
  MAX_BATCH_UNCOMPRESSED_BYTES,
  scanZipStream,
} from './batch-zip.js';

/** Default import transaction size from the design: one commit per 500 items. */
export const BATCH_IMPORT_CHUNK_SIZE = 500;

export interface BatchImportOptions {
  db: DatabaseSync;
  config: Config;
  /** Override for tests; defaults to the admin source limit (512 MiB). */
  maxSourceBytes?: number;
  chunkSize?: number;
}

export interface BatchImportInput {
  batchId: number;
  uploadId: string;
  studentLevel: number;
  problemLevel: number;
  problemId: number;
  problemMap: Record<string, number>;
  language: string;
}

interface ImportControl {
  canceled: boolean;
}

/** In-process handles for imports that can still be canceled. */
const activeImports = new Map<number, ImportControl>();

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

export function ensureBatchUser(
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

export function classifySubmitError(error: unknown): { code: string; message: string } {
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

function readMeta(job: BatchJobRow | null): Record<string, unknown> {
  if (!job) return {};
  try {
    const parsed = JSON.parse(job.meta_json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function setJobMeta(
  db: DatabaseSync,
  batchId: number,
  patch: Record<string, unknown>,
): void {
  const job = getBatchJob(db, batchId);
  if (!job) return;
  updateBatchJob(db, batchId, { meta: { ...readMeta(job), ...patch } });
}

function failJob(db: DatabaseSync, batchId: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof BatchZipError
      ? error.code
      : error instanceof BatchImportCanceledError
        ? 'BATCH_CANCELED'
        : 'BATCH_IMPORT_FAILED';
  const now = Date.now();
  updateBatchJob(db, batchId, {
    status: 'failed',
    phase: 'failed',
    heartbeatAt: now,
    etaSeconds: 0,
  });
  setJobMeta(db, batchId, {
    error: { code, message },
    finishedAt: now,
  });
}

function cancelJob(db: DatabaseSync, batchId: number): void {
  const now = Date.now();
  updateBatchJob(db, batchId, {
    status: 'canceled',
    phase: 'canceled',
    heartbeatAt: now,
    etaSeconds: 0,
  });
  setJobMeta(db, batchId, { canceledAt: now, finishedAt: now });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function isBatchImportActive(batchId: number): boolean {
  return activeImports.has(batchId);
}

export interface BatchEtaInput {
  phase: string;
  processed?: number;
  total?: number;
  judged?: number;
  imported?: number;
  startedAt?: number | null;
  now?: number;
}

/**
 * Rough remaining seconds for the monitor. Parsing has no ETA yet; importing
 * uses the processed-source rate and judging uses the judged-submission rate.
 * Terminal phases return 0, unknown phases return null.
 */
export function estimateBatchEta(input: BatchEtaInput): number | null {
  const phase = input.phase;
  if (phase === 'finished' || phase === 'failed' || phase === 'canceled') return 0;
  const now = input.now ?? Date.now();
  const startedAt = input.startedAt ?? null;
  if (startedAt === null || now <= startedAt) return null;
  const elapsed = now - startedAt;
  if (phase === 'parsing' || phase === 'importing') {
    const total = Math.max(0, input.total ?? 0);
    const processed = Math.max(0, input.processed ?? 0);
    if (total <= 0) return null;
    if (processed >= total) return 0;
    if (processed <= 0) return null;
    const rate = processed / elapsed;
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return Math.max(0, Math.ceil((total - processed) / rate / 1000));
  }
  if (phase === 'queued' || phase === 'judging') {
    const imported = Math.max(0, input.imported ?? 0);
    const judged = Math.max(0, input.judged ?? 0);
    const remaining = imported - judged;
    if (imported <= 0) return null;
    if (remaining <= 0) return 0;
    if (judged <= 0) return null;
    const rate = judged / elapsed;
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return Math.max(0, Math.ceil(remaining / rate / 1000));
  }
  return null;
}

function importInputFromJob(job: BatchJobRow): BatchImportInput {
  return {
    batchId: job.id,
    uploadId: job.upload_id ?? '',
    studentLevel: Math.max(1, Math.floor(job.student_level || 1)),
    problemLevel: Math.max(0, Math.floor(job.problem_level ?? 0)),
    problemId: job.problem_id,
    problemMap: parseProblemMap(job.problem_map_json),
    language: 'cpp17',
  };
}

/**
 * Single-flight importer: at most one async import runs at a time. Waiting jobs
 * are persisted as `status=queued, phase=uploaded`; this starts the oldest one
 * when the slot is free. Called when a job is created and after every import
 * finishes (success, failure or cancel).
 */
export function scheduleNextBatchImport(options: BatchImportOptions): number | null {
  if (activeImports.size > 0) return null;
  // A persisted importing row without an in-process control belongs to startup
  // recovery; do not race a second import past it.
  if (findImportingBatchJob(options.db)) return null;
  for (const job of listPendingImportJobs(options.db)) {
    if (activeImports.has(job.id)) continue;
    if (!job.upload_id) {
      markResumeFailed(options.db, job.id, 'BATCH_RESUME_UPLOAD_MISSING', 'upload id is missing');
      continue;
    }
    const upload = getBatchUpload(options.db, job.upload_id);
    if (!upload) {
      markResumeFailed(
        options.db,
        job.id,
        'BATCH_RESUME_UPLOAD_MISSING',
        `upload ${job.upload_id} no longer exists`,
      );
      continue;
    }
    if (!existsSync(join(options.config.dataDir, upload.zip_path))) {
      markResumeFailed(
        options.db,
        job.id,
        'BATCH_RESUME_UPLOAD_MISSING',
        `archive ${upload.zip_path} no longer exists`,
      );
      continue;
    }
    startBatchImport(options, importInputFromJob(job));
    return job.id;
  }
  return null;
}

/**
 * Marks an in-flight import canceled. The background loop notices the flag
 * between chunks (and during ZIP extraction) and finalizes the job as
 * `canceled`; already-imported submissions are canceled by the HTTP route.
 */
export function cancelBatchImport(batchId: number): boolean {
  const control = activeImports.get(batchId);
  if (!control) return false;
  control.canceled = true;
  return true;
}

/**
 * Starts an asynchronous import. The HTTP route returns 202 immediately; the
 * ZIP is scanned/extracted and the submissions are inserted on later ticks so
 * large batches never block the event loop for a whole request.
 */
export function startBatchImport(
  options: BatchImportOptions,
  input: BatchImportInput,
): void {
  if (activeImports.has(input.batchId)) return;
  const control: ImportControl = { canceled: false };
  activeImports.set(input.batchId, control);
  // Promote synchronously so the run/list response and the single-flight slot
  // agree before the first setImmediate tick.
  const existing = getBatchJob(options.db, input.batchId);
  const now = Date.now();
  updateBatchJob(options.db, input.batchId, {
    status: 'importing',
    phase: 'parsing',
    startedAt: existing?.started_at ?? now,
    heartbeatAt: now,
    etaSeconds: null,
  });
  setImmediate(() => {
    void runBatchImport(options, input, control)
      .catch((error: unknown) => {
        // runBatchImport records its own failures; this guard only keeps the
        // detached promise quiet if bookkeeping itself throws.
        try {
          failJob(options.db, input.batchId, error);
        } catch {
          // ignore
        }
      })
      .finally(() => {
        if (activeImports.get(input.batchId) === control) {
          activeImports.delete(input.batchId);
        }
        try {
          // Free slot: promote the oldest queued import. A failure here must
          // never mask the finished job's own result.
          scheduleNextBatchImport(options);
        } catch {
          // ignore
        }
      });
  });
}

async function runBatchImport(
  options: BatchImportOptions,
  input: BatchImportInput,
  control: ImportControl,
): Promise<void> {
  const { db, config } = options;
  const maxSourceBytes = options.maxSourceBytes ?? MAX_SOURCE_BYTES_ADMIN;
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? BATCH_IMPORT_CHUNK_SIZE));
  const upload = getBatchUpload(db, input.uploadId);
  if (!upload) {
    failJob(db, input.batchId, new BatchZipError('BAD_ZIP', 'upload not found'));
    return;
  }
  const zipPath = join(config.dataDir, upload.zip_path);
  const tempDir = mkdtempSync(join(config.dataDir, 'tmp', 'batch-import-'));

  try {
    const job = getBatchJob(db, input.batchId);
    if (!job) return;
    if (control.canceled) {
      cancelJob(db, input.batchId);
      return;
    }
    const importStartedAt = job.started_at ?? Date.now();
    updateBatchJob(db, input.batchId, {
      status: 'importing',
      phase: 'parsing',
      startedAt: importStartedAt,
      heartbeatAt: Date.now(),
      etaSeconds: null,
    });
    // A resumed import re-plans the same immutable upload. Every source path
    // already recorded (imported, skipped or error) is final, so a restart
    // never duplicates a submission or a failure row.
    const existingPaths = new Set(
      listBatchItems(db, input.batchId).map((item) => item.source_path),
    );

    // 1. Streaming scan: only entry metadata is kept, never the archive.
    const scan = await scanZipStream(zipPath, {
      maxFileBytes: MAX_BATCH_FILE_BYTES,
      maxTotalUncompressedBytes: MAX_BATCH_UNCOMPRESSED_BYTES,
    });
    updateBatchUploadScan(db, upload.upload_id, scan.entryCount, scan.totalUncompressedBytes);
    if (control.canceled) {
      cancelJob(db, input.batchId);
      return;
    }

    const resolveProblem = (folder: string): number | null => {
      const mapped = input.problemMap[folder];
      const mappedProblem = resolveProblemReference(db, mapped);
      if (mappedProblem) return mappedProblem.id;
      // Folders may name a problem by its display id (P1001) or numeric id.
      return resolveProblemReference(db, folder)?.id ?? null;
    };
    const plan = planBatchSources({
      files: scan.files,
      directories: scan.directories,
      skipped: scan.skipped,
      studentLevel: input.studentLevel,
      problemLevel: input.problemLevel,
      singleProblemId: input.problemLevel > 0 ? null : input.problemId,
      problemMap: input.problemMap,
      resolveProblem,
      maxSourceBytes,
      defaultLanguage: input.language,
      unmapped: 'error',
    });

    // 2. Persist every planning failure (skipped/error) before importing, so a
    // crash mid-import still leaves a truthful failure report. On resume the
    // already recorded failures are skipped.
    const pendingFailures = plan.failures.filter(
      (failure) => !existingPaths.has(failure.sourcePath),
    );
    transaction(db, () => {
      for (const failure of pendingFailures) {
        addBatchItem(db, {
          batchId: input.batchId,
          student: failure.student,
          sourcePath: failure.sourcePath,
          submissionId: null,
          problemId: failure.problemId,
          status: failure.status,
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage,
        });
      }
    });
    setJobMeta(db, input.batchId, {
      duplicateCount: plan.duplicates.length,
      duplicates: plan.duplicates.slice(0, 50),
      skippedEntries: plan.skipped.slice(0, 50),
      totalFiles: plan.totalFiles,
      validCount: plan.validCount,
      existingItemCount: existingPaths.size,
      resumed: existingPaths.size > 0,
    });
    if (control.canceled) {
      cancelJob(db, input.batchId);
      return;
    }

    // 3. Extract only the planned sources to a temp directory, one entry at a
    // time. Sources are bounded by maxSourceBytes, so the archive is never
    // buffered as a whole.
    const wanted = new Set(
      plan.candidates
        .map((candidate) => candidate.path)
        .filter((path) => path.length > 0),
    );
    const extracted = await extractZipEntries(zipPath, tempDir, wanted, {
      maxFileBytes: Math.max(maxSourceBytes, 1),
      maxTotalUncompressedBytes: MAX_BATCH_UNCOMPRESSED_BYTES,
      isCanceled: () => control.canceled,
    });
    if (control.canceled) {
      cancelJob(db, input.batchId);
      return;
    }

    // The scan and extraction are two independent passes over the file; an
    // entry that disappeared between them is recorded instead of silently
    // dropping the item. Paths already recorded by a previous attempt are not
    // re-recorded on resume.
    const missing = plan.candidates.filter(
      (candidate) =>
        candidate.problemId !== null &&
        !existingPaths.has(candidate.path) &&
        !extracted.has(candidate.path),
    );
    if (missing.length > 0) {
      transaction(db, () => {
        for (const candidate of missing) {
          addBatchItem(db, {
            batchId: input.batchId,
            student: candidate.student,
            sourcePath: candidate.path,
            problemId: candidate.problemId,
            status: 'error',
            errorCode: 'EXTRACT_FAILED',
            errorMessage: 'source entry could not be extracted from the ZIP',
          });
        }
      });
    }

    // 4. Import in chunks: one transaction per chunk, one password hash for the
    // whole batch, per-item failures recorded instead of aborting the batch.
    const ordered = [...plan.candidates]
      .filter(
        (candidate) =>
          candidate.problemId !== null &&
          !existingPaths.has(candidate.path) &&
          extracted.has(candidate.path),
      )
      .sort(
        (left, right) =>
          left.student.localeCompare(right.student) ||
          (left.problemId ?? 0) - (right.problemId ?? 0) ||
          left.path.localeCompare(right.path),
      );
    const syntheticPasswordHash = hashPassword(randomUUID());
    const userCache = new Map<string, UserRow>();
    const totalCandidates = plan.candidates.length;
    const alreadyProcessed = plan.candidates.filter((candidate) =>
      existingPaths.has(candidate.path),
    ).length;
    let processed = 0;
    updateBatchJob(db, input.batchId, {
      phase: 'importing',
      heartbeatAt: Date.now(),
      etaSeconds: estimateBatchEta({
        phase: 'importing',
        processed: alreadyProcessed,
        total: totalCandidates,
        startedAt: importStartedAt,
      }),
    });

    for (let offset = 0; offset < ordered.length; offset += chunkSize) {
      if (control.canceled) break;
      const chunk = ordered.slice(offset, offset + chunkSize);
      // Read source text before opening the transaction: a transaction must
      // stay short so it never fights the judge worker for the SQLite write
      // lock across slow disk I/O.
      const prepared = chunk.map((candidate) => {
        const filePath = extracted.get(candidate.path)!;
        return { candidate, code: readFileSync(filePath, 'utf8') };
      });
      transaction(db, () => {
        for (const { candidate, code } of prepared) {
          const problemId = candidate.problemId!;
          if (code.length === 0) {
            addBatchItem(db, {
              batchId: input.batchId,
              student: candidate.student,
              sourcePath: candidate.path,
              problemId,
              status: 'error',
              errorCode: 'EMPTY_SOURCE',
              errorMessage: 'source file is empty',
            });
            continue;
          }
          let user: UserRow;
          try {
            user =
              userCache.get(candidate.student) ??
              ensureBatchUser(db, candidate.student, syntheticPasswordHash);
            userCache.set(candidate.student, user);
          } catch (error) {
            addBatchItem(db, {
              batchId: input.batchId,
              student: candidate.student,
              sourcePath: candidate.path,
              problemId,
              status: 'error',
              errorCode: 'USER_CREATE_FAILED',
              errorMessage: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          try {
            const { id } = submitSource(
              { db, config },
              {
                userId: user.id,
                problemId,
                language: candidate.language,
                code,
                contestId: null,
                batchId: input.batchId,
                skipCooldown: true,
                // Admin batch pipelines submit on behalf of synthetic students,
                // so the practice read ACL does not apply.
                skipAccessCheck: true,
                judgePriority: BATCH_JUDGE_PRIORITY,
              },
            );
            addBatchItem(db, {
              batchId: input.batchId,
              student: candidate.student,
              sourcePath: candidate.path,
              submissionId: id,
              problemId,
              userId: user.id,
              status: 'imported',
            });
          } catch (error) {
            const classified = classifySubmitError(error);
            addBatchItem(db, {
              batchId: input.batchId,
              student: candidate.student,
              sourcePath: candidate.path,
              problemId,
              userId: user.id,
              status: 'error',
              errorCode: classified.code,
              errorMessage: classified.message,
            });
          }
        }
      });

      processed += chunk.length;
      const stats = getBatchItemStats(db, input.batchId);
      const processedTotal = alreadyProcessed + processed;
      const now = Date.now();
      updateBatchJob(db, input.batchId, {
        phase: 'importing',
        heartbeatAt: now,
        etaSeconds: estimateBatchEta({
          phase: 'importing',
          processed: processedTotal,
          total: totalCandidates,
          startedAt: importStartedAt,
          now,
        }),
      });
      setJobMeta(db, input.batchId, {
        progress: {
          processed: processedTotal,
          totalCandidates,
          imported: stats.imported,
          skipped: stats.skipped,
          errors: stats.errors,
          updatedAt: now,
        },
      });
      await yieldToEventLoop();
    }

    if (control.canceled) {
      cancelJob(db, input.batchId);
      return;
    }

    const stats = getBatchItemStats(db, input.batchId);
    const status = stats.imported <= 0 ? 'failed' : 'queued';
    const finishedAt = Date.now();
    updateBatchJob(db, input.batchId, {
      status,
      phase: status === 'failed' ? 'failed' : 'queued',
      heartbeatAt: finishedAt,
      etaSeconds: status === 'failed' ? 0 : null,
    });
    setJobMeta(db, input.batchId, {
      progress: {
        processed: alreadyProcessed + processed,
        totalCandidates,
        imported: stats.imported,
        skipped: stats.skipped,
        errors: stats.errors,
        updatedAt: finishedAt,
      },
      importedAt: finishedAt,
    });
  } catch (error) {
    if (control.canceled || error instanceof BatchImportCanceledError) {
      cancelJob(db, input.batchId);
    } else {
      failJob(db, input.batchId, error);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Startup recovery for imports interrupted by a process restart.
 *
 * The uploaded ZIP is immutable and the plan is deterministic, so an import
 * stuck in `importing` can be resumed instead of being thrown away: every
 * `batch_items` row already written (imported, skipped or error) is treated as
 * final, and the importer continues with the remaining sources. The job keeps
 * `importing` while the resumed run works and settles back to `queued` (or
 * `failed` when nothing could be imported), exactly like a fresh import.
 *
 * A job whose upload row or archive is gone cannot be resumed and is marked
 * `failed` with `BATCH_RESUME_UPLOAD_MISSING`; jobs in `queued`/`judging` are
 * left alone because their status is derived from the submissions.
 */
export interface BatchRecoveryOptions {
  config: Config;
  /** Forwarded to a resumed import (tests/settings overrides). */
  maxSourceBytes?: number;
  /** Forwarded to a resumed import (tests/settings overrides). */
  chunkSize?: number;
}

function parseProblemMap(json: string): Record<string, number> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: Record<string, number> = {};
    for (const [folder, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(value);
      if (Number.isInteger(id) && id > 0) map[folder] = id;
    }
    return map;
  } catch {
    return {};
  }
}

function markResumeFailed(
  db: DatabaseSync,
  batchId: number,
  code: string,
  message: string,
): void {
  const now = Date.now();
  updateBatchJob(db, batchId, {
    status: 'failed',
    phase: 'failed',
    heartbeatAt: now,
    etaSeconds: 0,
  });
  setJobMeta(db, batchId, {
    error: { code, message },
    resumeFailedAt: now,
  });
}

export function recoverInterruptedBatchImports(
  db: DatabaseSync,
  options: BatchRecoveryOptions,
): number {
  const jobs = listImportingBatchJobs(db);
  let started = false;
  for (const job of jobs) {
    if (isBatchImportActive(job.id)) {
      started = true;
      continue;
    }
    if (!job.upload_id) {
      markResumeFailed(db, job.id, 'BATCH_RESUME_UPLOAD_MISSING', 'upload id is missing');
      continue;
    }
    const upload = getBatchUpload(db, job.upload_id);
    if (!upload) {
      markResumeFailed(
        db,
        job.id,
        'BATCH_RESUME_UPLOAD_MISSING',
        `upload ${job.upload_id} no longer exists`,
      );
      continue;
    }
    if (!existsSync(join(options.config.dataDir, upload.zip_path))) {
      markResumeFailed(
        db,
        job.id,
        'BATCH_RESUME_UPLOAD_MISSING',
        `archive ${upload.zip_path} no longer exists`,
      );
      continue;
    }
    if (started) {
      // Single-flight: only the first interrupted import resumes now; the rest
      // wait as pending imports and start as soon as the slot is free.
      const now = Date.now();
      updateBatchJob(db, job.id, {
        status: 'queued',
        phase: 'uploaded',
        heartbeatAt: now,
        etaSeconds: null,
      });
      setJobMeta(db, job.id, { resumeRequestedAt: now, requeuedAt: now });
      continue;
    }
    started = true;
    setJobMeta(db, job.id, { resumeRequestedAt: Date.now() });
    startBatchImport(
      {
        db,
        config: options.config,
        maxSourceBytes: options.maxSourceBytes,
        chunkSize: options.chunkSize,
      },
      importInputFromJob(job),
    );
  }
  // Also promote previously queued imports (e.g. a crash left jobs waiting for
  // the single-flight slot) when no import is active.
  scheduleNextBatchImport({
    db,
    config: options.config,
    maxSourceBytes: options.maxSourceBytes,
    chunkSize: options.chunkSize,
  });
  return jobs.length;
}
