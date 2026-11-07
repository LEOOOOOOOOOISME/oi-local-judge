import { spawn } from 'node:child_process';
import { judgeChildEnv } from './isolation.js';

export interface GeneratorRunOptions {
  generator: string;
  seed: number;
  workdir: string;
  timeMs?: number;
}

export interface GeneratorRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  message: string;
}

const OUTPUT_LIMIT = 8 * 1024 * 1024;

/**
 * Runs a trusted generator executable. Protocol: `generator <seed>` writes the
 * test input to stdout (a de-facto convention used by OI problem packages).
 */
export function runGenerator(options: GeneratorRunOptions): Promise<GeneratorRunResult> {
  const timeoutMs = options.timeMs ?? 10_000;
  return new Promise<GeneratorRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (result: GeneratorRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(options.generator, [String(options.seed)], {
      cwd: options.workdir,
      env: judgeChildEnv(process.env, options.workdir),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (err) =>
      finish({ ok: false, stdout, stderr, message: err.message }),
    );
    child.once('close', (code) => {
      if (timedOut) {
        finish({ ok: false, stdout, stderr, message: `generator timed out after ${timeoutMs}ms` });
      } else if (code === 0) {
        finish({ ok: true, stdout, stderr, message: 'ok' });
      } else {
        finish({
          ok: false,
          stdout,
          stderr,
          message: `generator exited with code ${code ?? -1}${stderr ? `: ${stderr.trim()}` : ''}`,
        });
      }
    });
  });
}
