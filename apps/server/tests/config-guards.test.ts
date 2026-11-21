import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig } from '../src/config.js';

describe('config guards', () => {
  it('falls back to a finite judge concurrency for invalid env values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oij-config-'));
    ensureDataDirs(dir);
    try {
      const config = loadConfig({
        OIJ_DATA_DIR: dir,
        OIJ_SESSION_SECRET: 'test-session-secret-0123456789-abcdef',
        OIJ_JUDGE_CONCURRENCY: 'abc',
      });
      expect(Number.isInteger(config.judgeConcurrency)).toBe(true);
      expect(config.judgeConcurrency).toBeGreaterThanOrEqual(1);
      expect(config.judgeConcurrency).toBeLessThanOrEqual(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
