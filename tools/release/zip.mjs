/**
 * Streaming ZIP creation and validation.
 *
 * `createZipFromDirectory` compresses one file at a time through fflate's
 * `ZipDeflate` stream and writes chunks straight to disk, so peak memory stays
 * near one read buffer even for the ~700 MB portable tree. The old approach
 * (`Compress-Archive`) buffered the whole archive in memory.
 *
 * `validateZip` reads only the end-of-central-directory record and the central
 * directory: it proves the archive is structurally complete and contains the
 * expected entries without extracting ~700 MB.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_MIN_SIZE = 22;
const MAX_ZIP_COMMENT_SIZE = 0xffff;
const READ_CHUNK_SIZE = 1024 * 1024;

function toZipPath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Lists every file and directory below `sourceDir`, without following
 * symlinks/junctions, using paths relative to the archive prefix.
 */
export function collectZipEntries(sourceDir, prefix = '') {
  const normalizedPrefix = prefix ? `${toZipPath(prefix).replace(/\/+$/, '')}/` : '';
  const entries = [];
  if (normalizedPrefix) {
    entries.push({ kind: 'directory', name: normalizedPrefix, absolute: sourceDir });
  }

  const walk = (absoluteDir, relativeDir) => {
    const children = readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const child of children) {
      const absolute = join(absoluteDir, child.name);
      const relative = relativeDir ? `${relativeDir}/${child.name}` : child.name;
      const name = `${normalizedPrefix}${relative}`;
      if (child.isDirectory()) {
        entries.push({ kind: 'directory', name: `${name}/`, absolute });
        walk(absolute, relative);
      } else if (child.isFile()) {
        entries.push({ kind: 'file', name, absolute });
      }
    }
  };

  walk(resolve(sourceDir), '');
  return entries;
}

function removeQuietly(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort: the caller is already failing.
  }
}

/**
 * Creates a ZIP atomically: writes `<zipPath>.tmp`, validates nothing here, and
 * renames it over `zipPath` only after the central directory was flushed.
 */
export function createZipFromDirectory(
  sourceDir,
  zipPath,
  { prefix = '', level = 1, log = () => {} } = {},
) {
  const source = resolve(sourceDir);
  if (!statSync(source).isDirectory()) {
    throw new Error(`not a directory: ${source}`);
  }

  const entries = collectZipEntries(source, prefix);
  const files = entries.filter((entry) => entry.kind === 'file').length;
  if (files === 0) throw new Error(`refusing to create an empty ZIP from ${source}`);

  mkdirSync(dirname(zipPath), { recursive: true });
  const temporaryPath = `${zipPath}.tmp`;
  removeQuietly(temporaryPath);

  let targetFd;
  let failure = null;
  let finished = false;
  let bytesWritten = 0;
  let sourceBytes = 0;

  const zip = new Zip((error, chunk, final) => {
    if (error) {
      failure = error;
      return;
    }
    if (chunk && chunk.length > 0) {
      try {
        writeSync(targetFd, chunk);
        bytesWritten += chunk.length;
      } catch (writeError) {
        failure = writeError;
        return;
      }
    }
    if (final) finished = true;
  });

  const throwIfFailed = () => {
    if (failure) throw failure;
  };

  try {
    targetFd = openSync(temporaryPath, 'w');
    const buffer = Buffer.allocUnsafe(READ_CHUNK_SIZE);

    for (const entry of entries) {
      throwIfFailed();
      if (entry.kind === 'directory') {
        const stream = new ZipPassThrough(entry.name);
        zip.add(stream);
        stream.push(new Uint8Array(0), true);
        continue;
      }

      const stream = new ZipDeflate(entry.name, { level });
      zip.add(stream);
      const sourceFd = openSync(entry.absolute, 'r');
      try {
        for (;;) {
          const read = readSync(sourceFd, buffer, 0, buffer.length, null);
          if (read === 0) break;
          sourceBytes += read;
          stream.push(new Uint8Array(buffer.buffer, buffer.byteOffset, read), false);
          throwIfFailed();
        }
      } finally {
        closeSync(sourceFd);
      }
      stream.push(new Uint8Array(0), true);
      throwIfFailed();
    }

    zip.end();
    throwIfFailed();
    if (!finished) throw new Error('ZIP stream ended without emitting its central directory');
  } catch (error) {
    failure = failure ?? error;
  } finally {
    if (targetFd !== undefined) {
      try {
        closeSync(targetFd);
      } catch {
        // Already closed or never opened.
      }
    }
  }

  if (failure) {
    removeQuietly(temporaryPath);
    throw failure;
  }
  if (bytesWritten === 0) {
    removeQuietly(temporaryPath);
    throw new Error('ZIP writer produced no bytes');
  }

  removeQuietly(zipPath);
  renameSync(temporaryPath, zipPath);
  log(`wrote ${zipPath} (${entries.length} entries, ${bytesWritten} bytes)`);
  return {
    zipPath,
    entries: entries.length,
    files,
    directories: entries.length - files,
    bytes: bytesWritten,
    sourceBytes,
  };
}

function readAt(handle, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(handle, buffer, offset, length - offset, position + offset);
    if (read === 0) throw new Error('unexpected end of ZIP file while reading the central directory');
    offset += read;
  }
  return buffer;
}

/**
 * Parses the end-of-central-directory record and every central directory
 * entry. Throws when the file is not a structurally complete ZIP archive.
 */
export function readZipCentralDirectory(zipPath) {
  const stats = statSync(zipPath);
  if (stats.size < END_OF_CENTRAL_DIRECTORY_MIN_SIZE) {
    throw new Error(`not a ZIP archive (too small): ${zipPath}`);
  }

  const handle = openSync(zipPath, 'r');
  try {
    const header = readAt(handle, 4, 0);
    if (header.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(`not a ZIP archive (bad local header): ${zipPath}`);
    }

    const tailLength = Math.min(
      stats.size,
      END_OF_CENTRAL_DIRECTORY_MIN_SIZE + MAX_ZIP_COMMENT_SIZE,
    );
    const tailStart = stats.size - tailLength;
    const tail = readAt(handle, tailLength, tailStart);

    let eocd = -1;
    for (let index = tail.length - END_OF_CENTRAL_DIRECTORY_MIN_SIZE; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
      // The signature byte sequence may also occur inside the ZIP comment.
      // Only accept a record whose comment length reaches the end of the file.
      const candidateComment = tail.readUInt16LE(index + 20);
      if (index + END_OF_CENTRAL_DIRECTORY_MIN_SIZE + candidateComment === tail.length) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) {
      throw new Error(`not a ZIP archive (missing end of central directory): ${zipPath}`);
    }

    const disk = tail.readUInt16LE(eocd + 4);
    const centralDirectoryDisk = tail.readUInt16LE(eocd + 6);
    const entriesOnDisk = tail.readUInt16LE(eocd + 8);
    const totalEntries = tail.readUInt16LE(eocd + 10);
    const centralDirectorySize = tail.readUInt32LE(eocd + 12);
    const centralDirectoryOffset = tail.readUInt32LE(eocd + 16);
    const commentLength = tail.readUInt16LE(eocd + 20);
    const eocdOffset = tailStart + eocd;

    if (disk !== 0 || centralDirectoryDisk !== 0) {
      throw new Error(`multi-disk ZIP archives are not supported: ${zipPath}`);
    }
    if (entriesOnDisk !== totalEntries) {
      throw new Error(`inconsistent ZIP entry count: ${zipPath}`);
    }
    if (
      totalEntries === 0xffff ||
      centralDirectorySize === 0xffffffff ||
      centralDirectoryOffset === 0xffffffff
    ) {
      throw new Error(`ZIP64 archives are not supported by this validator: ${zipPath}`);
    }
    if (eocd + END_OF_CENTRAL_DIRECTORY_MIN_SIZE + commentLength !== tail.length) {
      throw new Error(`truncated ZIP comment: ${zipPath}`);
    }
    if (
      centralDirectoryOffset + centralDirectorySize > eocdOffset ||
      centralDirectoryOffset > eocdOffset
    ) {
      throw new Error(`central directory lies outside the file: ${zipPath}`);
    }

    const centralDirectory = readAt(handle, centralDirectorySize, centralDirectoryOffset);
    const entries = [];
    let position = 0;
    for (let index = 0; index < totalEntries; index += 1) {
      if (position + 46 > centralDirectory.length) {
        throw new Error(`truncated ZIP central directory at entry ${index}: ${zipPath}`);
      }
      if (centralDirectory.readUInt32LE(position) !== CENTRAL_HEADER_SIGNATURE) {
        throw new Error(`bad ZIP central directory signature at entry ${index}: ${zipPath}`);
      }
      const flags = centralDirectory.readUInt16LE(position + 8);
      const nameLength = centralDirectory.readUInt16LE(position + 28);
      const extraLength = centralDirectory.readUInt16LE(position + 30);
      const entryCommentLength = centralDirectory.readUInt16LE(position + 32);
      const compressedSize = centralDirectory.readUInt32LE(position + 20);
      const uncompressedSize = centralDirectory.readUInt32LE(position + 24);
      const localHeaderOffset = centralDirectory.readUInt32LE(position + 42);
      const nameStart = position + 46;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > centralDirectory.length) {
        throw new Error(`truncated ZIP entry name at entry ${index}: ${zipPath}`);
      }
      const name = centralDirectory.subarray(nameStart, nameEnd).toString('utf8');
      entries.push({
        name,
        flags,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      position = nameEnd + extraLength + entryCommentLength;
    }
    if (position !== centralDirectory.length) {
      throw new Error(`trailing bytes in ZIP central directory: ${zipPath}`);
    }

    return {
      entries,
      totalEntries,
      centralDirectorySize,
      centralDirectoryOffset,
      commentLength,
      size: stats.size,
    };
  } finally {
    closeSync(handle);
  }
}

function assertSafeEntryName(name, zipPath) {
  const normalized = toZipPath(name);
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`unsafe ZIP entry name ${JSON.stringify(name)} in ${zipPath}`);
  }
}

/**
 * Verifies the central directory and a set of required entries. Returns the
 * archive summary; throws with the complete list of missing entries otherwise.
 */
export function validateZip(zipPath, requiredEntries = []) {
  const directory = readZipCentralDirectory(zipPath);
  const names = new Set();
  for (const entry of directory.entries) {
    assertSafeEntryName(entry.name, zipPath);
    names.add(entry.name);
  }

  const required = [...new Set(requiredEntries.map((entry) => toZipPath(entry)))];
  const missing = required.filter((entry) => !names.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `ZIP ${zipPath} is missing ${missing.length} required entr${missing.length === 1 ? 'y' : 'ies'}:\n` +
        missing.map((entry) => `  - ${entry}`).join('\n'),
    );
  }

  return {
    zipPath,
    size: directory.size,
    entryCount: directory.entries.length,
    requiredCount: required.length,
    entries: directory.entries,
  };
}
