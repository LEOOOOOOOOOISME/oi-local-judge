import { unzipSync } from 'fflate';

/** Limits for admin-supplied ZIP buffers that are expanded synchronously. */
export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ZIP_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_ZIP_COMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;

export class ZipLimitError extends Error {
  readonly code = 'ZIP_LIMIT';

  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

export interface ZipLimitOptions {
  maxEntries?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxCompressedBytes?: number;
}

/**
 * Decompresses a ZIP after checking its central-directory sizes.
 *
 * `unzipSync` allocates every entry before route code can inspect it, so a
 * small zip bomb could exhaust the process. fflate's filter sees each entry's
 * original size before decompression, which lets us reject the archive first.
 */
export function unzipWithLimits(
  data: Uint8Array,
  options: ZipLimitOptions = {},
): Record<string, Uint8Array> {
  const maxEntries = options.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxFileBytes = options.maxFileBytes ?? MAX_ZIP_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;
  const maxCompressedBytes = options.maxCompressedBytes ?? MAX_ZIP_COMPRESSED_BYTES;

  if (data.length > maxCompressedBytes) {
    throw new ZipLimitError(
      `zip is ${data.length} bytes; compressed limit is ${maxCompressedBytes} bytes`,
    );
  }
  let entries = 0;
  let total = 0;
  return unzipSync(data, {
    filter: (file) => {
      entries += 1;
      total += file.originalSize;
      if (entries > maxEntries) {
        throw new ZipLimitError(`zip has more than ${maxEntries} entries`);
      }
      if (file.originalSize > maxFileBytes) {
        throw new ZipLimitError(
          `zip entry ${file.name} is ${file.originalSize} bytes; file limit is ${maxFileBytes}`,
        );
      }
      if (total > maxTotalBytes) {
        throw new ZipLimitError(
          `zip expands to more than ${maxTotalBytes} bytes (limit reached at ${file.name})`,
        );
      }
      return true;
    },
  });
}
