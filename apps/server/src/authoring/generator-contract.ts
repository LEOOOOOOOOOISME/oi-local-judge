import { spawn } from 'node:child_process';

export interface ContractGeneratorInput {
  generator: string;
  seed: number;
  groupId: string;
  index: number;
  args: readonly string[];
  workdir: string;
  timeMs?: number;
  maxStdoutBytes?: number;
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

export function runContractGenerator(
  input: ContractGeneratorInput,
): Promise<ContractGeneratorResult> {
  const timeoutMs = input.timeMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = input.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  return new Promise<ContractGeneratorResult>((resolve) => {
    const chunks: Buffer[] = [];
    let stderr = '';
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;

    const finish = (result: ContractGeneratorResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(input.generator, buildGeneratorArgs(input), {
      cwd: input.workdir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > maxStdoutBytes) {
        overflow = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once('error', (error) => {
      finish({
        ok: false,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr,
        message: error.message,
        bytes,
        timedOut,
        overflow,
      });
    });

    child.once('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (timedOut) {
        finish({
          ok: false,
          stdout,
          stderr,
          message: `generator timed out after ${timeoutMs}ms`,
          bytes,
          timedOut,
          overflow,
        });
        return;
      }
      if (overflow) {
        finish({
          ok: false,
          stdout: '',
          stderr,
          message: `generator stdout exceeded ${maxStdoutBytes} bytes`,
          bytes,
          timedOut,
          overflow,
        });
        return;
      }
      if (code === 0) {
        finish({ ok: true, stdout, stderr, message: 'ok', bytes, timedOut, overflow });
        return;
      }
      finish({
        ok: false,
        stdout,
        stderr,
        message: `generator exited with code ${code ?? -1}${
          stderr ? `: ${stderr.trim()}` : ''
        }`,
        bytes,
        timedOut,
        overflow,
      });
    });
  });
}
