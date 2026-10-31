// C++ compiler wrapper for the judge pipeline.
//
// The compiler is invoked as a child process with a hard timeout (default 15s).
// Captured diagnostics are truncated to 64 KiB and a partially written
// executable is removed on failure so callers never reuse a stale binary.
import { spawn, type ChildProcess } from 'node:child_process';
import { unlink } from 'node:fs/promises';

export const COMPILER_OUTPUT_LIMIT = 64 * 1024;
export const DEFAULT_COMPILE_TIMEOUT_MS = 15_000;

const CPP_LANGUAGES = new Set(['cpp', 'cpp17', 'c++', 'c++17', 'gnu++17']);

export interface CompileOptions {
  /** Absolute path of the g++ executable. */
  gxx: string;
  /** Absolute path of the submitted source file. */
  sourcePath: string;
  /** Absolute path of the executable to produce. */
  outExe: string;
  /** Working directory for the compiler process. */
  workdir: string;
  /** Submission language, e.g. "cpp17". */
  language: string;
  /** Override the compile timeout (milliseconds). */
  timeoutMs?: number;
  /** Extra compiler arguments appended after the defaults. */
  extraArgs?: readonly string[];
}

export interface CompileResult {
  ok: boolean;
  /** Empty on success; compiler output (or a timeout/startup message) on failure. */
  message: string;
}

export function isSupportedLanguage(language: string): boolean {
  return CPP_LANGUAGES.has(language.trim().toLowerCase());
}

function truncateOutput(text: string): string {
  if (text.length <= COMPILER_OUTPUT_LIMIT) return text;
  return `${text.slice(0, COMPILER_OUTPUT_LIMIT)}\n...[truncated]`;
}

function killProcessTree(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    // ignore: the process may have exited already
  }
  if (process.platform === 'win32' && child.pid !== undefined) {
    // g++ spawns cc1plus; killing only g++ can leave the compiler proper alive.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => {
      // best effort only
    });
  }
}

function runCompiler(
  gxx: string,
  args: string[],
  workdir: string,
  timeoutMs: number,
): Promise<CompileResult> {
  return new Promise<CompileResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(gxx, args, {
      cwd: workdir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const capture = (chunk: Buffer, isStderr: boolean) => {
      if (isStderr) {
        if (stderr.length < COMPILER_OUTPUT_LIMIT) stderr += chunk.toString('utf8');
      } else if (stdout.length < COMPILER_OUTPUT_LIMIT) {
        stdout += chunk.toString('utf8');
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => capture(chunk, false));
    child.stderr?.on('data', (chunk: Buffer) => capture(chunk, true));

    const formatted = () =>
      [stdout.trim(), stderr.trim()].filter((part) => part.length > 0).join('\n');

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    const settle = (result: CompileResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (err) => {
      settle({ ok: false, message: `failed to start compiler (${gxx}): ${err.message}` });
    });

    child.on('close', (code) => {
      if (timedOut) {
        const output = formatted();
        settle({
          ok: false,
          message: truncateOutput(
            `compilation timed out after ${timeoutMs}ms${output ? `\n${output}` : ''}`,
          ),
        });
        return;
      }
      if (code === 0) {
        settle({ ok: true, message: '' });
        return;
      }
      const output = formatted();
      settle({
        ok: false,
        message: truncateOutput(
          output.length > 0 ? output : `compilation failed with exit code ${code ?? 'unknown'}`,
        ),
      });
    });
  });
}

/**
 * Compiles `sourcePath` into `outExe` inside `workdir`.
 * Returns {ok:false, message} for unsupported languages, compiler start errors,
 * non-zero exit codes and timeouts. The caller owns the temporary directory.
 */
export async function compileSource(options: CompileOptions): Promise<CompileResult> {
  if (!isSupportedLanguage(options.language)) {
    return { ok: false, message: `unsupported language: ${options.language}` };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS;
  const args = [
    '-O2',
    '-std=c++17',
    '-static',
    '-o',
    options.outExe,
    options.sourcePath,
    ...(options.extraArgs ?? []),
  ];

  const result = await runCompiler(options.gxx, args, options.workdir, timeoutMs);
  if (!result.ok) {
    // Never leave a half-written executable behind for the pipeline to run.
    await unlink(options.outExe).catch(() => {
      // ignore: the file may not exist
    });
  }
  return result;
}
