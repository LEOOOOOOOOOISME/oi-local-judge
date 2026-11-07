import type { DatabaseSync } from 'node:sqlite';

export interface BatchJobRow {
  id: number;
  problem_id: number;
  status: string;
  student_level: number;
  created_at: number;
  contest_id: number | null;
  mode: string | null;
  problem_level: number | null;
  problem_map_json: string;
  meta_json: string;
  created_by: number | null;
  /** Upload this job was created from (streaming async imports); NULL for legacy runs. */
  upload_id: string | null;
  /** uploaded / parsing / importing / queued / judging / finished / failed / canceled. */
  phase: string;
  started_at: number | null;
  updated_at: number | null;
  heartbeat_at: number | null;
  eta_seconds: number | null;
}

/** Aggregate counters used by the job list/monitor without loading batch items. */
export interface BatchJobCounts {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  judged: number;
  queued: number;
}

export interface BatchJobListRow extends BatchJobRow, BatchJobCounts {}

/** Terminal statuses that may be deleted from the monitor. */
export const BATCH_TERMINAL_STATUSES = new Set(['finished', 'failed', 'canceled']);

export type BatchItemImportStatus = 'imported' | 'skipped' | 'error';

export interface BatchItemRow {
  id: number;
  batch_id: number;
  student: string;
  source_path: string;
  submission_id: number | null;
  problem_id: number | null;
  user_id: number | null;
  /** Import outcome for P0 batch jobs; NULL for legacy/contest rows. */
  status: BatchItemImportStatus | null;
  error_code: string | null;
  error_message: string | null;
}

export interface BatchItemStats {
  total: number;
  imported: number;
  skipped: number;
  errors: number;
  /** Imported items whose submission reached a terminal state. */
  done: number;
  acCount: number;
  scoreSum: number;
  distinctStudents: number;
  distinctProblems: number;
}

export function createBatchJob(
  db: DatabaseSync,
  input: {
    problemId: number;
    studentLevel: number;
    contestId?: number | null;
    mode?: string | null;
    problemLevel?: number | null;
    problemMap?: Record<string, number>;
    meta?: unknown;
    createdBy?: number | null;
    status?: string;
    phase?: string;
    uploadId?: string | null;
    createdAt?: number;
    startedAt?: number | null;
    heartbeatAt?: number | null;
    etaSeconds?: number | null;
  },
): number {
  const now = Date.now();
  const createdAt = input.createdAt ?? now;
  const result = db
    .prepare(
      `INSERT INTO batch_jobs
         (problem_id, student_level, created_at, contest_id, mode, problem_level,
          problem_map_json, meta_json, created_by, status, upload_id, phase,
          started_at, updated_at, heartbeat_at, eta_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.problemId,
      input.studentLevel,
      createdAt,
      input.contestId ?? null,
      input.mode ?? null,
      input.problemLevel ?? null,
      JSON.stringify(input.problemMap ?? {}),
      JSON.stringify(input.meta ?? {}),
      input.createdBy ?? null,
      input.status ?? 'running',
      input.uploadId ?? null,
      input.phase ?? '',
      input.startedAt ?? null,
      now,
      input.heartbeatAt ?? now,
      input.etaSeconds ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function updateBatchJob(
  db: DatabaseSync,
  id: number,
  patch: {
    status?: string;
    mode?: string | null;
    meta?: unknown;
    phase?: string;
    startedAt?: number | null;
    heartbeatAt?: number | null;
    etaSeconds?: number | null;
    updatedAt?: number | null;
  },
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.mode !== undefined) {
    sets.push('mode = ?');
    values.push(patch.mode);
  }
  if (patch.meta !== undefined) {
    sets.push('meta_json = ?');
    values.push(JSON.stringify(patch.meta));
  }
  if (patch.phase !== undefined) {
    sets.push('phase = ?');
    values.push(patch.phase);
  }
  if (patch.startedAt !== undefined) {
    sets.push('started_at = ?');
    values.push(patch.startedAt);
  }
  if (patch.heartbeatAt !== undefined) {
    sets.push('heartbeat_at = ?');
    values.push(patch.heartbeatAt);
  }
  if (patch.etaSeconds !== undefined) {
    sets.push('eta_seconds = ?');
    values.push(patch.etaSeconds);
  }
  sets.push('updated_at = ?');
  values.push(patch.updatedAt ?? Date.now());
  if (sets.length === 1) return;
  db.prepare(`UPDATE batch_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

export function addBatchItem(
  db: DatabaseSync,
  input: {
    batchId: number;
    student: string;
    sourcePath: string;
    submissionId?: number | null;
    problemId?: number | null;
    userId?: number | null;
    status?: BatchItemImportStatus | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO batch_items
       (batch_id, student, source_path, submission_id, problem_id, user_id,
        status, error_code, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.batchId,
    input.student,
    input.sourcePath,
    input.submissionId ?? null,
    input.problemId ?? null,
    input.userId ?? null,
    input.status ?? null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
  );
}

export function getBatchJob(db: DatabaseSync, id: number): BatchJobRow | null {
  return (
    (db.prepare('SELECT * FROM batch_jobs WHERE id = ?').get(id) as unknown as BatchJobRow) ?? null
  );
}

export function listBatchItems(db: DatabaseSync, batchId: number): BatchItemRow[] {
  return db
    .prepare('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY student')
    .all(batchId) as unknown as BatchItemRow[];
}

/** One stable page of a batch, ordered by insertion id. */
export function listBatchItemsPage(
  db: DatabaseSync,
  batchId: number,
  offset: number,
  limit: number,
  status?: BatchItemImportStatus | null,
): BatchItemRow[] {
  if (status) {
    return db
      .prepare(
        'SELECT * FROM batch_items WHERE batch_id = ? AND status = ? ORDER BY id LIMIT ? OFFSET ?',
      )
      .all(batchId, status, limit, offset) as unknown as BatchItemRow[];
  }
  return db
    .prepare('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY id LIMIT ? OFFSET ?')
    .all(batchId, limit, offset) as unknown as BatchItemRow[];
}

/** Submission ids of a batch that a cancel request may still interrupt. */
export function listBatchSubmissionIds(db: DatabaseSync, batchId: number): number[] {
  return (
    db
      .prepare(
        `SELECT id FROM submissions
         WHERE batch_id = ? AND status IN ('queued', 'compiling', 'running')
         ORDER BY id`,
      )
      .all(batchId) as unknown as Array<{ id: number }>
  ).map((row) => row.id);
}

/** Whether a streaming upload already has an unfinished async import job. */
export function findUnfinishedBatchJobForUpload(
  db: DatabaseSync,
  uploadId: string,
): BatchJobRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM batch_jobs
         WHERE upload_id = ? AND mode = 'async'
           AND status IN ('importing', 'queued', 'judging')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(uploadId) as unknown as BatchJobRow) ?? null
  );
}

/** Async import jobs interrupted by a process restart (status stuck at importing). */
export function listImportingBatchJobs(db: DatabaseSync): BatchJobRow[] {
  return db
    .prepare("SELECT * FROM batch_jobs WHERE mode = 'async' AND status = 'importing'")
    .all() as unknown as BatchJobRow[];
}

/** Aggregate counters for a batch without loading every item into memory. */
export function getBatchItemStats(db: DatabaseSync, batchId: number): BatchItemStats {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN bi.status = 'imported' OR (bi.status IS NULL AND bi.submission_id IS NOT NULL) THEN 1 ELSE 0 END), 0) AS imported,
         COALESCE(SUM(CASE WHEN bi.status = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped,
         COALESCE(SUM(CASE WHEN bi.status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
         COALESCE(SUM(CASE WHEN s.status IN ('finished', 'failed', 'canceled') THEN 1 ELSE 0 END), 0) AS done,
         COALESCE(SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END), 0) AS ac_count,
         COALESCE(SUM(CASE WHEN s.id IS NOT NULL THEN s.score ELSE 0 END), 0) AS score_sum,
         COUNT(DISTINCT bi.student) AS distinct_students,
         COUNT(DISTINCT bi.problem_id) AS distinct_problems
       FROM batch_items bi
       LEFT JOIN submissions s ON s.id = bi.submission_id
       WHERE bi.batch_id = ?`,
    )
    .get(batchId) as unknown as {
    total: number;
    imported: number;
    skipped: number;
    errors: number;
    done: number;
    ac_count: number;
    score_sum: number;
    distinct_students: number;
    distinct_problems: number;
  };
  return {
    total: Number(row.total),
    imported: Number(row.imported),
    skipped: Number(row.skipped),
    errors: Number(row.errors),
    done: Number(row.done),
    acCount: Number(row.ac_count),
    scoreSum: Number(row.score_sum),
    distinctStudents: Number(row.distinct_students),
    distinctProblems: Number(row.distinct_problems),
  };
}

/** List skipped or error items for the capped summary attached to API responses. */
export function listBatchItemFailures(
  db: DatabaseSync,
  batchId: number,
  status: 'skipped' | 'error',
  limit: number,
): BatchItemRow[] {
  return db
    .prepare(
      'SELECT * FROM batch_items WHERE batch_id = ? AND status = ? ORDER BY id LIMIT ?',
    )
    .all(batchId, status, limit) as unknown as BatchItemRow[];
}

export function setBatchStatus(db: DatabaseSync, id: number, status: string): void {
  db.prepare('UPDATE batch_jobs SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    Date.now(),
    id,
  );
}

const BATCH_JOB_COUNTS_SELECT = `
  (SELECT COUNT(*) FROM batch_items bi WHERE bi.batch_id = bj.id) AS item_total,
  (SELECT COUNT(*) FROM batch_items bi
     WHERE bi.batch_id = bj.id
       AND (bi.status = 'imported' OR (bi.status IS NULL AND bi.submission_id IS NOT NULL))) AS item_imported,
  (SELECT COUNT(*) FROM batch_items bi
     WHERE bi.batch_id = bj.id AND bi.status = 'skipped') AS item_skipped,
  (SELECT COUNT(*) FROM batch_items bi
     WHERE bi.batch_id = bj.id AND bi.status = 'error') AS item_failed,
  (SELECT COUNT(*) FROM batch_items bi
     JOIN submissions s ON s.id = bi.submission_id
     WHERE bi.batch_id = bj.id AND s.status IN ('finished', 'failed', 'canceled')) AS item_judged,
  (SELECT COUNT(*) FROM batch_items bi
     JOIN submissions s ON s.id = bi.submission_id
     WHERE bi.batch_id = bj.id AND s.status IN ('queued', 'compiling', 'running')) AS item_queued
`;

interface BatchJobSqlRow extends BatchJobRow {
  item_total: number;
  item_imported: number;
  item_skipped: number;
  item_failed: number;
  item_judged: number;
  item_queued: number;
}

function mapJobListRow(row: BatchJobSqlRow): BatchJobListRow {
  return {
    ...row,
    total: Number(row.item_total),
    imported: Number(row.item_imported),
    skipped: Number(row.item_skipped),
    failed: Number(row.item_failed),
    judged: Number(row.item_judged),
    queued: Number(row.item_queued),
  };
}

/**
 * Standalone batch jobs for the monitor, newest first. Counts come from
 * correlated aggregate subqueries so a 5000-item batch never loads its items.
 * Contest-owned batches are excluded: the contest console owns their lifecycle.
 */
export function listBatchJobsPage(
  db: DatabaseSync,
  offset: number,
  limit: number,
  status?: string | null,
): { items: BatchJobListRow[]; total: number } {
  const where = ['bj.contest_id IS NULL'];
  const params: Array<string | number> = [];
  if (status) {
    where.push('bj.status = ?');
    params.push(status);
  }
  const clause = where.join(' AND ');
  const rows = db
    .prepare(
      `SELECT bj.*, ${BATCH_JOB_COUNTS_SELECT}
         FROM batch_jobs bj
        WHERE ${clause}
        ORDER BY bj.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as BatchJobSqlRow[];
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM batch_jobs bj WHERE ${clause}`)
    .get(...params) as unknown as { n: number };
  return { items: rows.map(mapJobListRow), total: Number(totalRow.n) };
}

/** One aggregate row for the job monitor; never returns batch item details. */
export function getBatchJobWithCounts(
  db: DatabaseSync,
  id: number,
): BatchJobListRow | null {
  const row = db
    .prepare(
      `SELECT bj.*, ${BATCH_JOB_COUNTS_SELECT}
         FROM batch_jobs bj
        WHERE bj.id = ?`,
    )
    .get(id) as unknown as BatchJobSqlRow | undefined;
  return row ? mapJobListRow(row) : null;
}

/** Imports waiting for the single-flight importer, oldest first. */
export function listPendingImportJobs(db: DatabaseSync): BatchJobRow[] {
  return db
    .prepare(
      `SELECT * FROM batch_jobs
        WHERE mode = 'async' AND status = 'queued' AND phase = 'uploaded'
          AND upload_id IS NOT NULL
        ORDER BY id`,
    )
    .all() as unknown as BatchJobRow[];
}

/** Any import currently holding the single-flight importer slot. */
export function findImportingBatchJob(db: DatabaseSync): BatchJobRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM batch_jobs WHERE mode = 'async' AND status = 'importing' ORDER BY id LIMIT 1",
      )
      .get() as unknown as BatchJobRow) ?? null
  );
}

/**
 * Deletes one standalone batch job and its items. Submissions, submissions'
 * judge tasks, problems and users are intentionally kept. The caller removes
 * the upload archive after checking it is no longer referenced.
 */
export function deleteBatchJobRows(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM batch_items WHERE batch_id = ?').run(id);
  db.prepare('DELETE FROM batch_jobs WHERE id = ?').run(id);
}

/** Number of jobs still referencing an upload (used before deleting its ZIP). */
export function countBatchJobsForUpload(db: DatabaseSync, uploadId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM batch_jobs WHERE upload_id = ?')
    .get(uploadId) as unknown as { n: number };
  return Number(row.n);
}
