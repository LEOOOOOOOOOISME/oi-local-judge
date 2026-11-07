import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { judgeChildEnv } from './isolation.js';

export interface ValidatorRunOptions {
  validator: string;
  input: string;
  workdir: string;
  timeMs?: number;
}

export interface ValidatorRunResult {
  ok: boolean;
  message: string;
}

const OUTPUT_LIMIT = 64 * 1024;

/** Runs a trusted validator executable against one test input. */
export function runValidator(options: ValidatorRunOptions): Promise<ValidatorRunResult> {
  const timeoutMs = options.timeMs ?? 10_000;
  return new Promise<ValidatorRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (result: ValidatorRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(options.validator, [], {
      cwd: options.workdir,
      env: judgeChildEnv(process.env, options.workdir),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let inputText: string;
    try {
      // testlib's stdin reader on Windows expects CRLF line endings when fed
      // through a pipe; normalize so LF-only data files validate consistently.
      inputText = readFileSync(options.input, 'utf8').replace(/\r?\n/g, '\r\n');
    } catch (err) {
      child.kill();
      return finish({ ok: false, message: `cannot read input: ${(err as Error).message}` });
    }
    child.stdin.end(inputText);    const capture = (chunk: Buffer, target: 'out' | 'err') => {
      const text = chunk.toString('utf8');
      if (target === 'out') stdout = (stdout + text).slice(0, OUTPUT_LIMIT);
      else stderr = (stderr + text).slice(0, OUTPUT_LIMIT);
    };
    child.stdout?.on('data', (chunk: Buffer) => capture(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => capture(chunk, 'err'));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (err) => finish({ ok: false, message: err.message }));
    child.once('close', (code) => {
      const output = (stderr.trim() || stdout.trim()).slice(0, OUTPUT_LIMIT);
      if (timedOut) {
        finish({ ok: false, message: `validator timed out after ${timeoutMs}ms` });
      } else if (code === 0) {
        finish({ ok: true, message: output || 'ok' });
      } else {
        finish({ ok: false, message: output || `validator exited with code ${code ?? -1}` });
      }
    });
  });
}
