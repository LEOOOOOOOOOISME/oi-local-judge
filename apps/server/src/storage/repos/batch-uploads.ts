import type { DatabaseSync } from 'node:sqlite';

/**
 * A streamed batch ZIP that has already been written to disk.
 *
 * `zip_path` is stored relative to `config.dataDir` so the database stays
 * portable when the data directory moves. `entry_count` and
 * `total_uncompressed_bytes` are filled in by the first streaming scan
 * (preview or import), never by buffering the archive.
 */
export interface BatchUploadRow {
  id: number;
  upload_id: string;
  original_name: string | null;
  zip_path: string;
  size_bytes: number;
  sha256: string | null;
  entry_count: number;
  total_uncompressed_bytes: number;
  created_by: number | null;
  created_at: number;
  expires_at: number | null;
}

export interface CreateBatchUploadInput {
  uploadId: string;
  originalName?: string | null;
  zipPath: string;
  sizeBytes: number;
  sha256: string;
  createdBy?: number | null;
  expiresAt?: number | null;
}

export function createBatchUpload(db: DatabaseSync, input: CreateBatchUploadInput): void {
  db.prepare(
    `INSERT INTO batch_uploads
       (upload_id, original_name, zip_path, size_bytes, sha256, entry_count,
        total_uncompressed_bytes, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
  ).run(
    input.uploadId,
    input.originalName ?? null,
    input.zipPath,
    input.sizeBytes,
    input.sha256,
    input.createdBy ?? null,
    Date.now(),
    input.expiresAt ?? null,
  );
}

export function getBatchUpload(db: DatabaseSync, uploadId: string): BatchUploadRow | null {
  return (
    (db
      .prepare('SELECT * FROM batch_uploads WHERE upload_id = ?')
      .get(uploadId) as unknown as BatchUploadRow) ?? null
  );
}

/** Persists the counters learned from a streaming scan. */
export function updateBatchUploadScan(
  db: DatabaseSync,
  uploadId: string,
  entryCount: number,
  totalUncompressedBytes: number,
): void {
  db.prepare(
    'UPDATE batch_uploads SET entry_count = ?, total_uncompressed_bytes = ? WHERE upload_id = ?',
  ).run(entryCount, totalUncompressedBytes, uploadId);
}

export function deleteBatchUpload(db: DatabaseSync, uploadId: string): void {
  db.prepare('DELETE FROM batch_uploads WHERE upload_id = ?').run(uploadId);
}

/** Old uploads whose ZIP file can be cleaned up by a maintenance job. */
export function listExpiredBatchUploads(db: DatabaseSync, now = Date.now()): BatchUploadRow[] {
  return db
    .prepare('SELECT * FROM batch_uploads WHERE expires_at IS NOT NULL AND expires_at < ?')
    .all(now) as unknown as BatchUploadRow[];
}
