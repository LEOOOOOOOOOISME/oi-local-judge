import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { JudgeCanceledError } from './cancellation.js';

const execFileAsync = promisify(execFile);

export interface RunOptions {
  /** Path to ojrunner.exe. Defaults to OIJ_RUNNER or native/runner/out/ojrunner.exe. */
  runner?: string;
  /** Executable to run inside the job. */
  exe: string;
  /** Working directory of the child process. */
  workdir: string;
  /** User CPU time limit in milliseconds (job per-process limit, +1s buffer). */
  timeMs: number;
  /** Wall-clock limit in milliseconds enforced by the runner. */
  wallMs: number;
  /** Committed-memory limit in MiB (JOB_OBJECT_LIMIT_PROCESS_MEMORY). */
  memoryMb: number;
  /** Active process limit of the job (1 = no child processes). */
  processLimit: number;
  /** File redirected to the child's stdin. */
  stdinFile: string;
  /** File redirected to the child's stdout. */
  stdoutFile: string;
  /** File redirected to the child's stderr. */
  stderrFile: string;
  /** Aborting this signal terminates the sandboxed runner process. */
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number;
  cpuMs: number;
  wallMs: number;
  peakMemKb: number;
  timedOut: boolean;
  oom: boolean;
  /** POSIX-style approximation of a crash NTSTATUS (0 when not a crash). */
  signal: number;
  stdoutBytes: number;
  stderrBytes: number;
  /** PID of the sandboxed process (useful for residue checks). */
  pid?: number;
}

export interface RawRunnerResult extends RunResult {
  ok?: boolean;
  error?: string;
}

export function defaultRunnerPath(): string {
  return process.env.OIJ_RUNNER ?? join(process.cwd(), 'native/runner/out/ojrunner.exe');
}

function assertNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`ojrunner returned invalid "${field}": ${JSON.stringify(value)}`);
  }
  return value;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`ojrunner returned invalid "${field}": ${JSON.stringify(value)}`);
  }
  return value;
}

function parseRunnerOutput(stdout: string): RawRunnerResult {  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error('ojrunner produced no output on stdout');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(last) as Record<string, unknown>;
  } catch {
    throw new Error(`ojrunner output is not JSON: ${last.slice(0, 500)}`);
  }
  return {
    exitCode: assertNumber(parsed.exitCode, 'exitCode'),
    cpuMs: assertNumber(parsed.cpuMs, 'cpuMs'),
    wallMs: assertNumber(parsed.wallMs, 'wallMs'),
    peakMemKb: assertNumber(parsed.peakMemKb, 'peakMemKb'),
    timedOut: assertBoolean(parsed.timedOut, 'timedOut'),
    oom: assertBoolean(parsed.oom, 'oom'),
    signal: assertNumber(parsed.signal, 'signal'),
    stdoutBytes: assertNumber(parsed.stdoutBytes, 'stdoutBytes'),
    stderrBytes: assertNumber(parsed.stderrBytes, 'stderrBytes'),
    pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
    ok: typeof parsed.ok === 'boolean' ? parsed.ok : undefined,
    error: typeof parsed.error === 'string' ? parsed.error : undefined,
  };
}

function toText(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf8');
}

/**
 * Runs `exe` inside a Windows Job Object through ojrunner.exe and returns the
 * measured RunResult. Throws when the runner itself cannot execute or reports an
 * internal error (callers should map that to a system error / SE verdict).
 */
export async function runSandboxed(o: RunOptions): Promise<RunResult> {
  const runner = o.runner ?? defaultRunnerPath();
  if (o.signal?.aborted) {
    throw new JudgeCanceledError();
  }
  if (!existsSync(runner)) {
    throw new Error(
      `ojrunner not found at ${runner}; run "node tools/build-runner.mjs" first`,
    );
  }
  const args = [
    '--exe',
    o.exe,
    '--workdir',
    o.workdir,
    '--time-ms',
    String(o.timeMs),
    '--wall-ms',
    String(o.wallMs),
    '--memory-mb',
    String(o.memoryMb),
    '--process-limit',
    String(o.processLimit),
    '--input',
    o.stdinFile,
    '--output',
    o.stdoutFile,
    '--stderr',
    o.stderrFile,
  ];

  let stdout = '';
  try {
    const outcome = await execFileAsync(runner, args, {
      timeout: o.wallMs + 5000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      signal: o.signal,
    });
    stdout = toText(outcome.stdout);
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      name?: string;
    };
    // Cancellation is not a runner failure: the process was terminated on
    // purpose, so surface a dedicated error the pipeline can map to `canceled`.
    if (
      o.signal?.aborted ||
      failure.name === 'AbortError' ||
      failure.code === 'ABORT_ERR'
    ) {
      throw new JudgeCanceledError();
    }
    // The runner prints a JSON diagnostic even on internal failures, so prefer
    // that over the generic exec error when both are available.
    if (failure.stdout !== undefined && toText(failure.stdout).trim().length > 0) {
      stdout = toText(failure.stdout);
    } else {
      throw new Error(
        `ojrunner failed to execute (${failure.code ?? failure.message}): ${toText(
          failure.stderr ?? '',
        )
          .trim()
          .slice(0, 2000)}`,
      );
    }
  }

  // A signal can fire between the runner exiting and stdout being parsed.
  if (o.signal?.aborted) {
    throw new JudgeCanceledError();
  }
  const result = parseRunnerOutput(stdout);
  if (result.ok === false || result.error !== undefined) {
    throw new Error(`ojrunner internal error: ${result.error ?? 'unknown'}`);
  }
  return result;
}
