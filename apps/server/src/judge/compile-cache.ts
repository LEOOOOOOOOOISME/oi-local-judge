import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { compileSource } from './compiler.js';

export interface CompileCacheOptions {
  gxx: string;
  dataDir: string;
  sourcePath: string;
  language: string;
  /** Optional include directory (testlib.h for validators/checkers). */
  includeDir?: string;
  /** Compile timeout in milliseconds (default: compiler default). */
  timeoutMs?: number;
}

export interface CompileCacheResult {
  ok: boolean;
  exe?: string;
  cached: boolean;
  message: string;
}

/**
 * Compiles a submission once per (source, language, compiler) tuple. Identical
 * resubmissions and rejudges reuse the cached executable instead of invoking
 * g++ again, which is the dominant cost for small programs.
 */
export async function ensureCompiledProgram(
  options: CompileCacheOptions,
): Promise<CompileCacheResult> {
  const source = readFileSync(options.sourcePath);
  const key = createHash('sha256')
    .update(source)
    .update(`\0${options.language}\0${options.gxx}\0-O2\0-static\0${options.includeDir ?? ''}`)
    .digest('hex');
  const cacheDir = join(options.dataDir, 'cache', 'programs', key);
  const cachedExe = join(cacheDir, 'prog.exe');
  if (existsSync(cachedExe)) {
    return { ok: true, exe: cachedExe, cached: true, message: '' };
  }

  mkdirSync(cacheDir, { recursive: true });
  const tempDir = mkdtempSync(join(cacheDir, 'tmp-'));
  try {
    const compiled = await compileSource({
      gxx: options.gxx,
      sourcePath: options.sourcePath,
      outExe: join(tempDir, 'prog.exe'),
      workdir: tempDir,
      language: options.language,
      timeoutMs: options.timeoutMs,
      extraArgs: options.includeDir ? ['-I', options.includeDir] : [],
    });
    if (!compiled.ok) {
      return { ok: false, cached: false, message: compiled.message };
    }
    try {
      copyFileSync(join(tempDir, 'prog.exe'), cachedExe);
    } catch {
      if (!existsSync(cachedExe)) {
        return { ok: false, cached: false, message: 'failed to install compiled program into cache' };
      }
    }
    return { ok: true, exe: cachedExe, cached: false, message: compiled.message };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
