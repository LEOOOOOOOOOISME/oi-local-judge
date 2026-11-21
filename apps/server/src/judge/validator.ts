import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { defaultRunnerPath, runSandboxed } from './runner.js';
import type { WorkerRunOptions } from './worker.js';

export interface ValidatorRunOptions {
  validator: string;
  input: string;
  workdir: string;
  timeMs?: number;
  /** Optional runner path override (tests). */
  runner?: string;
  /** Low-privilege account for the validator process. */
  worker?: WorkerRunOptions;
  /** Memory limit for the validator process. */
  memoryMb?: number;
}

export interface ValidatorRunResult {
  ok: boolean;
  message: string;
}

const OUTPUT_LIMIT = 64 * 1024;

function readCapped(path: string): string {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length <= OUTPUT_LIMIT ? text : text.slice(0, OUTPUT_LIMIT);
  } catch {
    return '';
  }
}

/**
 * Runs a validator inside the native Job Object runner.
 *
 * The validator, its input and its stdio files are materialized in the per-run
 * workdir because the worker account cannot read the data directory or the
 * compile cache. Timeouts kill the whole job, not only the root process.
 */
export async function runValidator(
  options: ValidatorRunOptions,
): Promise<ValidatorRunResult> {
  const timeoutMs =
    Number.isFinite(options.timeMs) && (options.timeMs ?? 0) > 0
      ? (options.timeMs as number)
      : 10_000;
  const token = `${process.pid}-${randomUUID()}`;
  const validatorCopy = join(options.workdir, `.validator-${token}.exe`);
  const inputFile = join(options.workdir, `.validator-${token}.in`);
  const stdoutFile = join(options.workdir, `.validator-${token}.out`);
  const stderrFile = join(options.workdir, `.validator-${token}.err`);
  try {
    copyFileSync(options.validator, validatorCopy);
    // testlib's stdin reader on Windows expects CRLF line endings when fed
    // through a redirected file; normalize so LF-only data validates.
    const inputText = readFileSync(options.input, 'utf8').replace(/\r?\n/g, '\r\n');
    writeFileSync(inputFile, inputText);
    const run = await runSandboxed({
      runner: options.runner ?? defaultRunnerPath(),
      exe: validatorCopy,
      workdir: options.workdir,
      timeMs: timeoutMs,
      wallMs: timeoutMs + 2000,
      memoryMb: options.memoryMb ?? 512,
      processLimit: 1,
      outputLimitMb: 64,
      stdinFile: inputFile,
      stdoutFile,
      stderrFile,
      worker: options.worker,
    });
    const output = (readCapped(stderrFile) || readCapped(stdoutFile)).trim();
    if (run.timedOut) {
      return { ok: false, message: `validator timed out after ${timeoutMs}ms` };
    }
    if (run.outputLimitExceeded) {
      return { ok: false, message: 'validator exceeded the 64 MiB output limit' };
    }
    if (run.exitCode === 0) {
      return { ok: true, message: output || 'ok' };
    }
    return {
      ok: false,
      message: output || `validator exited with code ${run.exitCode}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `validator failed to run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    for (const file of [validatorCopy, inputFile, stdoutFile, stderrFile]) {
      try {
        unlinkSync(file);
      } catch {
        // best-effort cleanup
      }
    }
  }
}
