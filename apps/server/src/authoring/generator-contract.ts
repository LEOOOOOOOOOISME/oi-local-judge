import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { defaultRunnerPath, runSandboxed } from '../judge/runner.js';
import type { WorkerRunOptions } from '../judge/worker.js';

export interface ContractGeneratorInput {
  generator: string;
  seed: number;
  groupId: string;
  index: number;
  args: readonly string[];
  workdir: string;
  timeMs?: number;
  maxStdoutBytes?: number;
  /** Optional runner path override (tests). */
  runner?: string;
  /** Low-privilege account for the generator process. */
  worker?: WorkerRunOptions;
  /** Memory limit for the generator process. */
  memoryMb?: number;
}

export interface ContractGeneratorResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  message: string;
  bytes: number;
  timedOut: boolean;
  overflow: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STDOUT = 64 * 1024 * 1024;

/** testlib 契约：--seed、--group、--index，其余参数按 argv 原样追加。 */
export function buildGeneratorArgs(
  input: Pick<ContractGeneratorInput, 'seed' | 'groupId' | 'index' | 'args'>,
): string[] {
  return [
    `--seed=${input.seed}`,
    `--group=${input.groupId}`,
    `--index=${input.index}`,
    ...input.args,
  ];
}

function readCapped(path: string, limit: number): { text: string; bytes: number } {
  try {
    const buffer = readFileSync(path);
    const bytes = buffer.length;
    return {
      text: (bytes <= limit ? buffer : buffer.subarray(0, limit)).toString('utf8'),
      bytes,
    };
  } catch {
    return { text: '', bytes: 0 };
  }
}

/**
 * Runs a contract generator inside the native Job Object runner. The generator
 * account cannot read the data directory or compile cache; the executable and
 * stdio files live in the per-run workdir.
 */
export async function runContractGenerator(
  input: ContractGeneratorInput,
): Promise<ContractGeneratorResult> {
  const timeoutMs = input.timeMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = input.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const token = `${process.pid}-${randomUUID()}`;
  const generatorCopy = join(input.workdir, `.generator-${token}.exe`);
  const stdinFile = join(input.workdir, `.generator-${token}.in`);
  const stdoutFile = join(input.workdir, `.generator-${token}.out`);
  const stderrFile = join(input.workdir, `.generator-${token}.err`);
  try {
    copyFileSync(input.generator, generatorCopy);
    writeFileSync(stdinFile, '');
    const run = await runSandboxed({
      runner: input.runner ?? defaultRunnerPath(),
      exe: generatorCopy,
      args: buildGeneratorArgs(input),
      workdir: input.workdir,
      timeMs: timeoutMs,
      wallMs: timeoutMs + 2000,
      memoryMb: input.memoryMb ?? 512,
      processLimit: 1,
      outputLimitMb: Math.max(1, Math.ceil(maxStdoutBytes / (1024 * 1024))),
      stdinFile,
      stdoutFile,
      stderrFile,
      worker: input.worker,
    });
    const stdout = readCapped(stdoutFile, maxStdoutBytes);
    const stderr = readCapped(stderrFile, 64 * 1024).text;
    const overflow = run.outputLimitExceeded || stdout.bytes > maxStdoutBytes;
    const base = {
      stderr,
      bytes: stdout.bytes,
      timedOut: run.timedOut,
      overflow,
    };
    if (run.timedOut) {
      return { ...base, ok: false, stdout: stdout.text, message: `generator timed out after ${timeoutMs}ms` };
    }
    if (overflow) {
      return {
        ...base,
        ok: false,
        stdout: '',
        message: `generator stdout exceeded ${maxStdoutBytes} bytes`,
      };
    }
    if (run.exitCode === 0) {
      return { ...base, ok: true, stdout: stdout.text, message: 'ok' };
    }
    return {
      ...base,
      ok: false,
      stdout: stdout.text,
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
      bytes: 0,
      timedOut: false,
      overflow: false,
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
