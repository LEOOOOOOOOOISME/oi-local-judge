import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { hashPassword } from '../security/password.js';
import { transaction } from '../storage/db.js';
import {
  addBatchItem,
  getBatchItemStats,
  getBatchJob,
  listImportingBatchJobs,
  setBatchStatus,
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
  setBatchStatus(db, batchId, 'failed');
  setJobMeta(db, batchId, {
    error: { code, message },
    finishedAt: Date.now(),
  });
}

function cancelJob(db: DatabaseSync, batchId: number): void {
  setBatchStatus(db, batchId, 'canceled');
  setJobMeta(db, batchId, { canceledAt: Date.now() });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function isBatchImportActive(batchId: number): boolean {
  return activeImports.has(batchId);
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
    // crash mid-import still leaves a truthful failure report.
    transaction(db, () => {
      for (const failure of plan.failures) {
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
    // dropping the item.
    const missing = plan.candidates.filter(
      (candidate) => candidate.problemId !== null && !extracted.has(candidate.path),
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
      .filter((candidate) => candidate.problemId !== null && extracted.has(candidate.path))
      .sort(
        (left, right) =>
          left.student.localeCompare(right.student) ||
          (left.problemId ?? 0) - (right.problemId ?? 0) ||
          left.path.localeCompare(right.path),
      );
    const syntheticPasswordHash = hashPassword(randomUUID());
    const userCache = new Map<string, UserRow>();
    let processed = 0;

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
      setJobMeta(db, input.batchId, {
        progress: {
          processed,
          totalCandidates: ordered.length,
          imported: stats.imported,
          skipped: stats.skipped,
          errors: stats.errors,
          updatedAt: Date.now(),
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
    setBatchStatus(db, input.batchId, status);
    setJobMeta(db, input.batchId, {
      progress: {
        processed,
        totalCandidates: ordered.length,
        imported: stats.imported,
        skipped: stats.skipped,
        errors: stats.errors,
        updatedAt: Date.now(),
      },
      importedAt: Date.now(),
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
 * Resuming would mean guessing which candidates were already inserted, so the
 * simpler and honest strategy is chosen: an import stuck in `importing` is
 * marked `failed` with a BATCH_IMPORT_INTERRUPTED error. Submissions that were
 * already imported remain queued and are recovered by the judge scheduler;
 * batch items and partial counts stay intact for inspection. Jobs in
 * `queued`/`judging` are left alone because their status is derived from the
 * submissions, not owned by the importer.
 */
export function recoverInterruptedBatchImports(db: DatabaseSync): number {
  const jobs = listImportingBatchJobs(db);
  for (const job of jobs) {
    updateBatchJob(db, job.id, { status: 'failed' });
    updateBatchJob(db, job.id, {
      meta: {
        ...readMeta(job),
        error: {
          code: 'BATCH_IMPORT_INTERRUPTED',
          message: 'server restarted while the batch import was running',
        },
        recoveredAt: Date.now(),
      },
    });
  }
  return jobs.length;
}
