import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { unzipWithLimits, ZipLimitError } from '../src/services/zip-limits.js';

describe('zip limits', () => {
  const zip = zipSync({
    'a.txt': new TextEncoder().encode('a'.repeat(100)),
    'b.txt': new TextEncoder().encode('b'.repeat(100)),
  });

  it('expands a normal archive', () => {
    const files = unzipWithLimits(zip);
    expect(Object.keys(files).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('rejects a per-file oversized entry', () => {
    expect(() => unzipWithLimits(zip, { maxFileBytes: 50 })).toThrow(ZipLimitError);
  });

  it('rejects an archive whose total uncompressed size exceeds the limit', () => {
    expect(() => unzipWithLimits(zip, { maxTotalBytes: 150 })).toThrow(ZipLimitError);
  });

  it('rejects too many entries', () => {
    expect(() => unzipWithLimits(zip, { maxEntries: 1 })).toThrow(ZipLimitError);
  });
});
