import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { compileSource } from './compiler.js';

export interface CheckerCacheOptions {
  gxx: string;
  dataDir: string;
  sourcePath: string;
  /** Directory containing testlib.h (for `-I`). */
  includeDir?: string;
}

export interface CheckerCacheResult {
  ok: boolean;
  exe?: string;
  message: string;
}

/**
 * Compiles a special-judge checker once and reuses it across submissions.
 * The cache key covers the checker source, compiler path and the fixed flags
 * used below, so editing the checker or switching compilers misses the cache.
 */
export async function ensureChecker(options: CheckerCacheOptions): Promise<CheckerCacheResult> {
  const source = readFileSync(options.sourcePath);
  const key = createHash('sha256')
    .update(source)
    .update(`\0${options.gxx}\0-std=c++17\0shared-runtime\0testlib`)
    .digest('hex');
  const cacheDir = join(options.dataDir, 'cache', 'checkers', key);
  const cachedExe = join(cacheDir, 'checker.exe');
  if (existsSync(cachedExe)) {
    return { ok: true, exe: cachedExe, message: 'checker cache hit' };
  }

  mkdirSync(cacheDir, { recursive: true });
  const tempDir = mkdtempSync(join(cacheDir, 'tmp-'));
  try {
    const compiled = await compileSource({
      gxx: options.gxx,
      sourcePath: options.sourcePath,
      outExe: join(tempDir, 'checker.exe'),
      workdir: tempDir,
      language: 'cpp17',
      staticLink: false,
      extraArgs: options.includeDir ? ['-I', options.includeDir] : [],
    });
    if (!compiled.ok) {
      return { ok: false, message: compiled.message };
    }
    try {
      copyFileSync(join(tempDir, 'checker.exe'), cachedExe);
    } catch {
      // Another process may have populated the cache concurrently.
      if (!existsSync(cachedExe)) {
        return { ok: false, message: 'failed to install compiled checker into cache' };
      }
    }
    return { ok: true, exe: cachedExe, message: 'checker compiled' };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
