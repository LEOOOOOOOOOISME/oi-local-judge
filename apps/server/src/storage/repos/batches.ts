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
}

export interface BatchItemRow {
  id: number;
  batch_id: number;
  student: string;
  source_path: string;
  submission_id: number | null;
  problem_id: number | null;
  user_id: number | null;
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
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO batch_jobs
         (problem_id, student_level, created_at, contest_id, mode, problem_level,
          problem_map_json, meta_json, created_by, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.problemId,
      input.studentLevel,
      Date.now(),
      input.contestId ?? null,
      input.mode ?? null,
      input.problemLevel ?? null,
      JSON.stringify(input.problemMap ?? {}),
      JSON.stringify(input.meta ?? {}),
      input.createdBy ?? null,
      input.status ?? 'running',
    );
  return Number(result.lastInsertRowid);
}

export function addBatchItem(
  db: DatabaseSync,
  input: {
    batchId: number;
    student: string;
    sourcePath: string;
    submissionId: number;
    problemId?: number | null;
    userId?: number | null;
  },
): void {
  db.prepare(
    'INSERT INTO batch_items(batch_id, student, source_path, submission_id, problem_id, user_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    input.batchId,
    input.student,
    input.sourcePath,
    input.submissionId,
    input.problemId ?? null,
    input.userId ?? null,
  );
}

export function updateBatchJob(
  db: DatabaseSync,
  id: number,
  patch: { status?: string; mode?: string | null; meta?: unknown },
): void {
  const sets: string[] = [];
  const values: Array<string | null> = [];
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
  if (sets.length === 0) return;
  db.prepare(`UPDATE batch_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
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

export function setBatchStatus(db: DatabaseSync, id: number, status: string): void {
  db.prepare('UPDATE batch_jobs SET status = ? WHERE id = ?').run(status, id);
}
