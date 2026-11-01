import type { DatabaseSync } from 'node:sqlite';

export interface BatchJobRow {
  id: number;
  problem_id: number;
  status: string;
  student_level: number;
  created_at: number;
}

export interface BatchItemRow {
  id: number;
  batch_id: number;
  student: string;
  source_path: string;
  submission_id: number | null;
  problem_id: number | null;
}

export function createBatchJob(
  db: DatabaseSync,
  input: { problemId: number; studentLevel: number },
): number {
  const result = db
    .prepare('INSERT INTO batch_jobs(problem_id, student_level, created_at) VALUES (?, ?, ?)')
    .run(input.problemId, input.studentLevel, Date.now());
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
  },
): void {
  db.prepare(
    'INSERT INTO batch_items(batch_id, student, source_path, submission_id, problem_id) VALUES (?, ?, ?, ?, ?)',
  ).run(
    input.batchId,
    input.student,
    input.sourcePath,
    input.submissionId,
    input.problemId ?? null,
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

export function setBatchStatus(db: DatabaseSync, id: number, status: string): void {
  db.prepare('UPDATE batch_jobs SET status = ? WHERE id = ?').run(status, id);
}
