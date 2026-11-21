import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { defaultRunnerPath, runSandboxed } from './runner.js';
import type { WorkerRunOptions } from './worker.js';

export interface GeneratorRunOptions {
  generator: string;
  seed: number;
  workdir: string;
  timeMs?: number;
  /** Optional runner path override (tests). */
  runner?: string;
  /** Low-privilege account for the generator process. */
  worker?: WorkerRunOptions;
  /** Memory limit for the generator process. */
  memoryMb?: number;
}

export interface GeneratorRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  message: string;
}

const OUTPUT_LIMIT = 8 * 1024 * 1024;

function readCapped(path: string, limit: number): string {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length <= limit ? text : text.slice(0, limit);
  } catch {
    return '';
  }
}

/**
 * Runs a trusted generator inside the native Job Object runner.
 * Protocol: `generator <seed>` writes the test input to stdout.
 */
export async function runGenerator(options: GeneratorRunOptions): Promise<GeneratorRunResult> {
  const timeoutMs =
    Number.isFinite(options.timeMs) && (options.timeMs ?? 0) > 0
      ? (options.timeMs as number)
      : 10_000;
  const token = `${process.pid}-${randomUUID()}`;
  const generatorCopy = join(options.workdir, `.generator-${token}.exe`);
  const stdinFile = join(options.workdir, `.generator-${token}.in`);
  const stdoutFile = join(options.workdir, `.generator-${token}.out`);
  const stderrFile = join(options.workdir, `.generator-${token}.err`);
  try {
    copyFileSync(options.generator, generatorCopy);
    writeFileSync(stdinFile, '');
    const run = await runSandboxed({
      runner: options.runner ?? defaultRunnerPath(),
      exe: generatorCopy,
      args: [String(options.seed)],
      workdir: options.workdir,
      timeMs: timeoutMs,
      wallMs: timeoutMs + 2000,
      memoryMb: options.memoryMb ?? 512,
      processLimit: 1,
      outputLimitMb: 64,
      stdinFile,
      stdoutFile,
      stderrFile,
      worker: options.worker,
    });
    const stdout = readCapped(stdoutFile, OUTPUT_LIMIT);
    const stderr = readCapped(stderrFile, 64 * 1024);
    if (run.timedOut) {
      return { ok: false, stdout, stderr, message: `generator timed out after ${timeoutMs}ms` };
    }
    if (run.outputLimitExceeded) {
      return {
        ok: false,
        stdout: '',
        stderr,
        message: `generator stdout exceeded ${OUTPUT_LIMIT} bytes`,
      };
    }
    if (run.exitCode === 0) {
      return { ok: true, stdout, stderr, message: 'ok' };
    }
    return {
      ok: false,
      stdout,
      stderr,
      message: `generator exited with code ${run.exitCode}${stderr ? `: ${stderr.trim()}` : ''}`,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      message: `generator failed to run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    for (const file of [generatorCopy, stdinFile, stdoutFile, stderrFile]) {
      try {
        unlinkSync(file);
      } catch {
        // best-effort cleanup
      }
    }
  }
}
