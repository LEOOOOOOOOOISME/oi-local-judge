import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import {
  createProblemAttachment,
  deleteProblemAttachment,
  getProblemAttachment,
  listProblemAttachments,
  replaceProblemAttachment,
  type ProblemAttachmentRow,
} from '../storage/repos/attachments.js';

/** Single attachment limit requested by the product spec (50 MiB). */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/**
 * Request-body limit handed to Fastify/the raw parser. It is one byte above the
 * product limit so the route handler (not Fastify's generic 413 envelope) can
 * reject `MAX + 1` with the documented `{ ok:false, error:{ code } }` shape.
 */
export const ATTACHMENT_BODY_LIMIT = MAX_ATTACHMENT_BYTES + 1;

export type AttachmentVisibility = 'problem' | 'admin';

const ATTACHMENT_VISIBILITIES: readonly AttachmentVisibility[] = ['problem', 'admin'];

const EXTENSION_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
};

export interface ProblemAttachmentDto {
  id: number;
  problemId: number;
  filename: string;
  size: number;
  mime: string;
  visibility: AttachmentVisibility;
  createdAt: number;
  downloadUrl: string;
}

export class AttachmentError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Validates a user-supplied filename. Path separators, control characters and
 * dot-only names are rejected outright so a malicious name can neither escape
 * the attachment directory nor poison a response header.
 */
export function sanitizeAttachmentFilename(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > 200) return null;
  if (name === '.' || name === '..') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\/\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** MIME type is derived from the extension; the client-declared type is not trusted. */
export function resolveAttachmentMime(filename: string): string | null {
  const extension = extname(filename).toLowerCase();
  return EXTENSION_MIME[extension] ?? null;
}

function normalizeVisibility(raw: unknown): AttachmentVisibility {
  if (raw === undefined || raw === null || raw === '') return 'problem';
  if (typeof raw !== 'string' || !ATTACHMENT_VISIBILITIES.includes(raw as AttachmentVisibility)) {
    throw new AttachmentError(
      'BAD_VISIBILITY',
      400,
      'visibility must be "problem" or "admin"',
    );
  }
  return raw as AttachmentVisibility;
}

function dataDirRoot(config: Config): string {
  return resolve(config.dataDir);
}

/** Absolute path for a stored attachment, or null when it would escape dataDir. */
function absoluteStoragePath(config: Config, storagePath: string): string | null {
  const base = dataDirRoot(config);
  const absolute = resolve(base, storagePath);
  if (absolute === base || !absolute.startsWith(`${base}${sep}`)) return null;
  return absolute;
}

function storageRelativePath(problemId: number, filename: string): string {
  const extension = extname(filename).toLowerCase();
  return `problems/${problemId}/attachments/${randomUUID()}${extension}`;
}

function writeAttachmentData(config: Config, storagePath: string, data: Buffer): void {
  const absolute = absoluteStoragePath(config, storagePath);
  if (!absolute) {
    throw new AttachmentError('BAD_STORAGE_PATH', 500, 'invalid attachment storage path');
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, data);
}

function removeStoredFile(config: Config, storagePath: string): void {
  const absolute = absoluteStoragePath(config, storagePath);
  if (!absolute) return;
  try {
    rmSync(absolute, { force: true });
  } catch {
    // A missing/locked file must not block deleting the metadata row.
  }
}

/** Serializes a row without ever exposing `storage_path`. */
export function toProblemAttachmentDto(row: ProblemAttachmentRow): ProblemAttachmentDto {
  return {
    id: row.id,
    problemId: row.problem_id,
    filename: row.filename,
    size: row.size,
    mime: row.mime,
    visibility: row.visibility === 'admin' ? 'admin' : 'problem',
    createdAt: row.created_at,
    downloadUrl: `/api/attachments/${row.id}`,
  };
}

export function listProblemAttachmentDtos(
  db: DatabaseSync,
  problemId: number,
  options: { includeAdmin: boolean },
): ProblemAttachmentDto[] {
  return listProblemAttachments(db, problemId)
    .filter((row) => options.includeAdmin || row.visibility !== 'admin')
    .map(toProblemAttachmentDto);
}

export function getProblemAttachmentRow(
  db: DatabaseSync,
  id: number,
): ProblemAttachmentRow | null {
  return getProblemAttachment(db, id);
}

export interface SaveProblemAttachmentInput {
  problemId: number;
  filename: unknown;
  visibility?: unknown;
  data: Buffer;
  createdBy: number;
  replaceId?: number | null;
}

export function saveProblemAttachment(
  db: DatabaseSync,
  config: Config,
  input: SaveProblemAttachmentInput,
): ProblemAttachmentDto {
  const filename = sanitizeAttachmentFilename(input.filename);
  if (!filename) {
    throw new AttachmentError('UNSAFE_FILENAME', 400, 'invalid attachment filename');
  }
  const mime = resolveAttachmentMime(filename);
  if (!mime) {
    throw new AttachmentError(
      'UNSUPPORTED_TYPE',
      400,
      'only PDF, image (png/jpeg/gif/webp/bmp/svg) and ZIP attachments are supported',
    );
  }
  const visibility = normalizeVisibility(input.visibility);
  if (input.data.length === 0) {
    throw new AttachmentError('EMPTY_BODY', 400, 'attachment is empty');
  }
  if (input.data.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      'FILE_TOO_LARGE',
      413,
      `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
    );
  }

  if (typeof input.replaceId === 'number') {
    const existing = getProblemAttachment(db, input.replaceId);
    if (!existing || existing.problem_id !== input.problemId) {
      throw new AttachmentError('NOT_FOUND', 404, 'attachment not found');
    }
    const storagePath = storageRelativePath(input.problemId, filename);
    writeAttachmentData(config, storagePath, input.data);
    try {
      const updated = replaceProblemAttachment(db, existing.id, {
        filename,
        storagePath,
        size: input.data.length,
        mime,
        visibility,
      });
      if (!updated) throw new AttachmentError('NOT_FOUND', 404, 'attachment not found');
      removeStoredFile(config, existing.storage_path);
      return toProblemAttachmentDto(updated);
    } catch (error) {
      removeStoredFile(config, storagePath);
      throw error;
    }
  }

  const storagePath = storageRelativePath(input.problemId, filename);
  writeAttachmentData(config, storagePath, input.data);
  try {
    const row = createProblemAttachment(db, {
      problemId: input.problemId,
      filename,
      storagePath,
      size: input.data.length,
      mime,
      visibility,
      createdBy: input.createdBy,
    });
    return toProblemAttachmentDto(row);
  } catch (error) {
    removeStoredFile(config, storagePath);
    throw error;
  }
}

export interface DeleteProblemAttachmentResult {
  removedFile: boolean;
}

export function deleteProblemAttachmentRecord(
  db: DatabaseSync,
  config: Config,
  row: ProblemAttachmentRow,
): DeleteProblemAttachmentResult {
  const absolute = absoluteStoragePath(config, row.storage_path);
  let removedFile = false;
  if (absolute) {
    try {
      rmSync(absolute, { force: true });
      removedFile = true;
    } catch {
      removedFile = false;
    }
  }
  deleteProblemAttachment(db, row.id);
  return { removedFile };
}

/** Absolute path of the stored file for streaming, or null when missing/unsafe. */
export function attachmentFilePath(
  config: Config,
  row: ProblemAttachmentRow,
): string | null {
  return absoluteStoragePath(config, row.storage_path);
}

/**
 * RFC 6266/RFC 5987 Content-Disposition with an ASCII fallback and UTF-8 name.
 * CR/LF and quotes are stripped so a filename can never inject a header.
 */
export function attachmentContentDisposition(filename: string): string {
  const safe = filename.replace(/[\r\n"]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
