import type { DatabaseSync } from 'node:sqlite';

/** A problem attachment row; `storage_path` is internal and never serialized. */
export interface ProblemAttachmentRow {
  id: number;
  problem_id: number;
  filename: string;
  storage_path: string;
  size: number;
  mime: string;
  visibility: string;
  created_by: number;
  created_at: number;
}

export interface CreateProblemAttachmentInput {
  problemId: number;
  filename: string;
  storagePath: string;
  size: number;
  mime: string;
  visibility: string;
  createdBy: number;
  createdAt?: number;
}

export function createProblemAttachment(
  db: DatabaseSync,
  input: CreateProblemAttachmentInput,
): ProblemAttachmentRow {
  const result = db
    .prepare(
      `INSERT INTO problem_attachments(
         problem_id, filename, storage_path, size, mime, visibility, created_by, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.problemId,
      input.filename,
      input.storagePath,
      input.size,
      input.mime,
      input.visibility,
      input.createdBy,
      input.createdAt ?? Date.now(),
    );
  return getProblemAttachment(db, Number(result.lastInsertRowid))!;
}

export function getProblemAttachment(
  db: DatabaseSync,
  id: number,
): ProblemAttachmentRow | null {
  return (
    (db
      .prepare('SELECT * FROM problem_attachments WHERE id = ?')
      .get(id) as unknown as ProblemAttachmentRow) ?? null
  );
}

export function listProblemAttachments(
  db: DatabaseSync,
  problemId: number,
): ProblemAttachmentRow[] {
  return db
    .prepare('SELECT * FROM problem_attachments WHERE problem_id = ? ORDER BY id')
    .all(problemId) as unknown as ProblemAttachmentRow[];
}

export interface ReplaceProblemAttachmentInput {
  filename: string;
  storagePath: string;
  size: number;
  mime: string;
  visibility: string;
}

export function replaceProblemAttachment(
  db: DatabaseSync,
  id: number,
  input: ReplaceProblemAttachmentInput,
): ProblemAttachmentRow | null {
  const result = db
    .prepare(
      `UPDATE problem_attachments
          SET filename = ?, storage_path = ?, size = ?, mime = ?, visibility = ?
        WHERE id = ?`,
    )
    .run(
      input.filename,
      input.storagePath,
      input.size,
      input.mime,
      input.visibility,
      id,
    );
  if (result.changes === 0) return null;
  return getProblemAttachment(db, id);
}

export function deleteProblemAttachment(db: DatabaseSync, id: number): boolean {
  const result = db.prepare('DELETE FROM problem_attachments WHERE id = ?').run(id);
  return result.changes > 0;
}
