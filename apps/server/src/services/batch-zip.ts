import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Unzip, UnzipInflate } from 'fflate';

/**
 * Streaming batch ZIP limits (P0 decisions retained):
 * - upload itself: 5 GiB
 * - one source entry: 512 MiB
 * - everything decompressed: 10 GiB
 */
export const MAX_BATCH_ZIP_BYTES = 5 * 1024 ** 3;
export const MAX_BATCH_FILES = 200_000;
export const MAX_BATCH_UNCOMPRESSED_BYTES = 10 * 1024 ** 3;
export const MAX_BATCH_FILE_BYTES = 512 * 1024 ** 2;
/** Hard upper bound for a single HTTP body (admin uploads, unchanged from P0). */
export const MAX_ADMIN_BODY_BYTES = 10 * 1024 ** 3;
/** How many distinct paths a preview tree sample may contain. */
export const TREE_SAMPLE_LIMIT = 200;

export type BatchZipErrorCode =
  | 'BATCH_ZIP_TOO_LARGE'
  | 'BATCH_ENTRY_LIMIT'
  | 'BATCH_FILE_TOO_LARGE'
  | 'BATCH_UNCOMPRESSED_LIMIT'
  | 'BATCH_DISK_FULL'
  | 'BAD_ZIP'
  | 'INCOMPLETE_UPLOAD';

export class BatchZipError extends Error {
  readonly code: BatchZipErrorCode;

  constructor(code: BatchZipErrorCode, message: string) {
    super(message);
    this.name = 'BatchZipError';
    this.code = code;
  }
}

/** Thrown when an in-flight import/extraction is canceled by an admin. */
export class BatchImportCanceledError extends Error {
  constructor() {
    super('batch import canceled');
    this.name = 'BatchImportCanceledError';
  }
}

export interface ZipEntryInfo {
  /** Normalized forward-slash path relative to the archive root. */
  path: string;
  /** Path exactly as it appeared in the ZIP (used for error reporting). */
  rawPath: string;
  /** Uncompressed byte size (actual, when the archive carries no size header). */
  size: number;
  directory: boolean;
}

export type ZipSkipReason = 'UNSAFE_PATH' | 'BATCH_FILE_TOO_LARGE' | 'ENTRY_ERROR';

export interface ZipSkippedEntry {
  path: string;
  reason: ZipSkipReason;
  message?: string;
}

export interface ZipScanResult {
  files: ZipEntryInfo[];
  directories: ZipEntryInfo[];
  /** Total entries seen in the archive (files + directories). */
  entryCount: number;
  totalFiles: number;
  totalUncompressedBytes: number;
  skipped: ZipSkippedEntry[];
}

/**
 * Rejects absolute paths, Windows drive paths, backslash traversal and `..`
 * segments. Returns a normalized `/`-separated relative path, or null.
 */
export function safeZipEntryPath(name: string): string | null {
  const normalized = name.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized || normalized.includes('\0')) return null;
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..')) return null;
  return normalized;
}

function trimDirectory(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

interface ScanState {
  files: ZipEntryInfo[];
  directories: ZipEntryInfo[];
  skipped: ZipSkippedEntry[];
  entryCount: number;
  totalUncompressedBytes: number;
  fatal: BatchZipError | null;
}

/**
 * Streams a ZIP archive and returns its entry list without ever holding the
 * whole archive (or the whole extraction) in memory.
 *
 * Entries larger than `maxFileBytes` are still decompressed so the archive
 * stream stays aligned, but they are reported as `skipped` and excluded from
 * `files`. Exceeding the entry count or total uncompressed size aborts the scan
 * with a `BatchZipError`; a single bad entry never aborts it.
 */
export async function scanZipStream(
  zipPath: string,
  options: {
    maxEntries?: number;
    maxFileBytes?: number;
    maxTotalUncompressedBytes?: number;
  } = {},
): Promise<ZipScanResult> {
  const maxEntries = options.maxEntries ?? MAX_BATCH_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_BATCH_FILE_BYTES;
  const maxTotal = options.maxTotalUncompressedBytes ?? MAX_BATCH_UNCOMPRESSED_BYTES;
  const state: ScanState = {
    files: [],
    directories: [],
    skipped: [],
    entryCount: 0,
    totalUncompressedBytes: 0,
    fatal: null,
  };

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    if (state.fatal) {
      file.terminate?.();
      return;
    }
    state.entryCount += 1;
    if (state.entryCount > maxEntries) {
      state.fatal = new BatchZipError(
        'BATCH_ENTRY_LIMIT',
        `zip has more than ${maxEntries} entries`,
      );
      file.terminate?.();
      return;
    }

    const rawPath = file.name;
    const safePath = safeZipEntryPath(rawPath);
    const directory = rawPath.endsWith('/');
    if (!safePath) {
      state.skipped.push({
        path: rawPath,
        reason: 'UNSAFE_PATH',
        message: 'absolute, traversal or invalid path',
      });
      // The stream still has to be consumed, so discard its data.
      file.ondata = () => {};
      file.start();
      return;
    }
    if (directory) {
      state.directories.push({ path: trimDirectory(safePath), rawPath, size: 0, directory: true });
      file.ondata = () => {};
      file.start();
      return;
    }

    const entry: ZipEntryInfo = {
      path: safePath,
      rawPath,
      size: Number(file.originalSize ?? 0),
      directory: false,
    };
    let received = 0;
    let overflow = false;
    file.ondata = (err, chunk, final) => {
      if (state.fatal) return;
      if (err) {
        state.fatal = new BatchZipError('BAD_ZIP', err.message);
        return;
      }
      if (chunk.length > 0) {
        received += chunk.length;
        state.totalUncompressedBytes += chunk.length;
        if (state.totalUncompressedBytes > maxTotal) {
          state.fatal = new BatchZipError(
            'BATCH_UNCOMPRESSED_LIMIT',
            `zip decompresses to more than ${maxTotal} bytes`,
          );
          file.terminate?.();
          return;
        }
        if (received > maxFileBytes) overflow = true;
      }
      if (final) {
        entry.size = received;
        if (overflow) {
          state.skipped.push({
            path: rawPath,
            reason: 'BATCH_FILE_TOO_LARGE',
            message: `entry is larger than ${maxFileBytes} bytes`,
          });
        } else {
          state.files.push(entry);
        }
      }
    };
    file.start();
  };

  const stream = createReadStream(zipPath, { highWaterMark: 256 * 1024 });
  try {
    for await (const chunk of stream) {
      if (state.fatal) break;
      unzip.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), false);
    }
    if (!state.fatal) unzip.push(new Uint8Array(0), true);
  } catch (err) {
    if (!state.fatal) {
      state.fatal =
        err instanceof BatchZipError
          ? err
          : new BatchZipError('BAD_ZIP', err instanceof Error ? err.message : String(err));
    }
  } finally {
    stream.destroy();
  }

  if (state.fatal) throw state.fatal;
  return {
    files: state.files,
    directories: state.directories,
    entryCount: state.entryCount,
    totalFiles: state.files.length,
    totalUncompressedBytes: state.totalUncompressedBytes,
    skipped: state.skipped,
  };
}

/**
 * Extracts only the wanted entries to a temporary directory, one entry at a
 * time. Returns a map of archive path -> temporary file path.
 */
export async function extractZipEntries(
  zipPath: string,
  destDir: string,
  wanted: ReadonlySet<string>,
  options: {
    maxFileBytes?: number;
    maxTotalUncompressedBytes?: number;
    isCanceled?: () => boolean;
  } = {},
): Promise<Map<string, string>> {
  const maxFileBytes = options.maxFileBytes ?? MAX_BATCH_FILE_BYTES;
  const maxTotal = options.maxTotalUncompressedBytes ?? MAX_BATCH_UNCOMPRESSED_BYTES;
  mkdirSync(destDir, { recursive: true });

  const written = new Map<string, string>();
  let total = 0;
  let index = 0;
  let fatal: Error | null = null;
  const canceled = (): boolean => options.isCanceled?.() === true;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    if (fatal) {
      file.terminate?.();
      return;
    }
    if (canceled()) {
      fatal = new BatchImportCanceledError();
      file.terminate?.();
      return;
    }
    const path = safeZipEntryPath(file.name);
    if (!path || !wanted.has(path)) {
      // Consume and discard; leaving a file unstarted makes fflate buffer it.
      file.ondata = () => {};
      file.start();
      return;
    }

    const target = join(destDir, `${index}.src`);
    index += 1;
    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;
    file.ondata = (err, chunk, final) => {
      if (fatal || done) return;
      if (err) {
        fatal = new BatchZipError('BAD_ZIP', err.message);
        return;
      }
      if (chunk.length > 0) {
        received += chunk.length;
        total += chunk.length;
        if (received > maxFileBytes) {
          fatal = new BatchZipError(
            'BATCH_FILE_TOO_LARGE',
            `${path} is larger than ${maxFileBytes} bytes`,
          );
          file.terminate?.();
          return;
        }
        if (total > maxTotal) {
          fatal = new BatchZipError(
            'BATCH_UNCOMPRESSED_LIMIT',
            `zip decompresses to more than ${maxTotal} bytes`,
          );
          file.terminate?.();
          return;
        }
        // Copy: fflate may reuse its internal output buffer between pushes.
        chunks.push(Buffer.from(chunk));
      }
      if (final) {
        done = true;
        writeFileSync(target, Buffer.concat(chunks));
        written.set(path, target);
      }
    };
    file.start();
  };

  const stream = createReadStream(zipPath, { highWaterMark: 256 * 1024 });
  try {
    for await (const chunk of stream) {
      if (fatal) break;
      if (canceled()) {
        fatal = new BatchImportCanceledError();
        break;
      }
      unzip.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), false);
    }
    if (!fatal) unzip.push(new Uint8Array(0), true);
  } catch (err) {
    if (!fatal) {
      fatal =
        err instanceof BatchZipError
          ? err
          : new BatchZipError('BAD_ZIP', err instanceof Error ? err.message : String(err));
    }
  } finally {
    stream.destroy();
  }

  if (fatal) throw fatal;
  return written;
}

export interface StreamedUploadResult {
  sizeBytes: number;
  sha256: string;
  absolutePath: string;
}

/**
 * Writes a raw request body (Buffer from tests or the live IncomingMessage
 * stream) to `targetPath`, hashing it on the fly. The body is never buffered as
 * a whole and the partial file is removed on every failure path.
 */
export async function writeStreamedUpload(
  source: Buffer | NodeJS.ReadableStream,
  targetPath: string,
  options: { expectedBytes: number; maxBytes?: number },
): Promise<StreamedUploadResult> {
  const maxBytes = options.maxBytes ?? MAX_BATCH_ZIP_BYTES;
  const tempPath = `${targetPath}.${randomUUID()}.part`;
  const hash = createHash('sha256');
  let size = 0;

  try {
    if (Buffer.isBuffer(source)) {
      if (source.length > maxBytes) {
        throw new BatchZipError(
          'BATCH_ZIP_TOO_LARGE',
          `body is larger than ${maxBytes} bytes`,
        );
      }
      size = source.length;
      hash.update(source);
      writeFileSync(tempPath, source);
    } else {
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > maxBytes) {
            callback(
              new BatchZipError('BATCH_ZIP_TOO_LARGE', `body is larger than ${maxBytes} bytes`),
            );
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(source, meter, createWriteStream(tempPath));
    }
    if (size !== options.expectedBytes) {
      throw new BatchZipError(
        'INCOMPLETE_UPLOAD',
        `received ${size} bytes but Content-Length was ${options.expectedBytes}`,
      );
    }
    renameSync(tempPath, targetPath);
    return { sizeBytes: size, sha256: hash.digest('hex'), absolutePath: targetPath };
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}

/** Free bytes on the volume that holds `dir`, or null when unknown. */
export function freeDiskBytes(dir: string): number | null {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}
