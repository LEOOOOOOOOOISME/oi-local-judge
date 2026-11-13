import { spawn } from 'node:child_process';
import { judgeChildEnv } from './isolation.js';
import type { WorkerRunOptions } from './worker.js';

export interface InteractiveRunOptions {
  runner: string;
  interactor: string;
  contestant: string;
  input: string;
  answer?: string;
  workdir: string;
  timeMs: number;
  wallMs?: number;
  memoryMb: number;
  interactorErr?: string;
  contestantErr?: string;
  /** Optional low-privilege Windows account for the contestant process only. */
  worker?: WorkerRunOptions;
}

export interface InteractiveRunResult {
  ok: boolean;
  error?: string;
  verdict: 'AC' | 'WA' | 'TLE' | 'RE' | 'SE';
  interactorExit: number;
  contestantExit: number;
  timedOut: boolean;
  cpuMs: number;
  wallMs: number;
  peakMemKb: number;
  message: string;
}

export function runInteractive(options: InteractiveRunOptions): Promise<InteractiveRunResult> {
  const args = [
    '--interactor',
    options.interactor,
    '--contestant',
    options.contestant,
    '--input',
    options.input,
    '--workdir',
    options.workdir,
    '--time-ms',
    String(options.timeMs),
    '--wall-ms',
    String(options.wallMs ?? options.timeMs + 5000),
    '--memory-mb',
    String(options.memoryMb),
  ];
  if (options.answer) args.push('--answer', options.answer);
  if (options.interactorErr) args.push('--interactor-err', options.interactorErr);
  if (options.contestantErr) args.push('--contestant-err', options.contestantErr);
  if (options.worker?.required) args.push('--worker-required');
  const childEnv = judgeChildEnv(process.env, options.workdir);
  if (options.worker) {
    childEnv.OIJ_INTERACT_WORKER_USER = options.worker.user;
    childEnv.OIJ_INTERACT_WORKER_PASSWORD = options.worker.password;
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: InteractiveRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(options.runner, args, {
      cwd: options.workdir,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({
        ok: false,
        error: 'interactive runner timed out',
        verdict: 'SE',
        interactorExit: -1,
        contestantExit: -1,
        timedOut: true,
        cpuMs: 0,
        wallMs: (options.wallMs ?? options.timeMs + 5000) + 1000,
        peakMemKb: 0,
        message: 'interactive runner timed out',
      });
    }, (options.wallMs ?? options.timeMs + 5000) + 5000);
    child.once('error', (err) =>
      finish({
        ok: false,
        error: err.message,
        verdict: 'SE',
        interactorExit: -1,
        contestantExit: -1,
        timedOut: false,
        cpuMs: 0,
        wallMs: 0,
        peakMemKb: 0,
        message: err.message,
      }),
    );
    child.once('close', () => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
      try {
        const parsed = JSON.parse(line) as Partial<InteractiveRunResult> & { ok?: boolean };
        if (!parsed.ok) {
          finish({
            ok: false,
            error: parsed.error ?? 'interactive runner failed',
            verdict: 'SE',
            interactorExit: parsed.interactorExit ?? -1,
            contestantExit: parsed.contestantExit ?? -1,
            timedOut: parsed.timedOut ?? false,
            cpuMs: parsed.cpuMs ?? 0,
            wallMs: parsed.wallMs ?? 0,
            peakMemKb: parsed.peakMemKb ?? 0,
            message: parsed.error ?? (stderr.trim() || 'interactive runner failed'),
          });
          return;
        }
        finish({
          ok: true,
          verdict: (parsed.verdict as InteractiveRunResult['verdict']) ?? 'SE',
          interactorExit: parsed.interactorExit ?? -1,
          contestantExit: parsed.contestantExit ?? -1,
          timedOut: parsed.timedOut ?? false,
          cpuMs: parsed.cpuMs ?? 0,
          wallMs: parsed.wallMs ?? 0,
          peakMemKb: parsed.peakMemKb ?? 0,
          message: parsed.verdict === 'AC' ? '' : `interactor exit ${parsed.interactorExit ?? -1}`,
        });
      } catch (err) {
        finish({
          ok: false,
          error: `bad interactive runner output: ${(err as Error).message}`,
          verdict: 'SE',
          interactorExit: -1,
          contestantExit: -1,
          timedOut: false,
          cpuMs: 0,
          wallMs: 0,
          peakMemKb: 0,
          message: stderr.trim() || 'bad interactive runner output',
        });
      }
    });
  });
}
