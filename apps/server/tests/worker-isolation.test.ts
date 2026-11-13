import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  loadConfig,
  resolveWorkerIsolationMode,
  workerIsolationIssue,
  type Config,
} from '../src/config.js';
import {
  buildDataDirDenyArgs,
  buildWorkdirGrantArgs,
  workerRunOptions,
} from '../src/judge/worker.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oij-worker-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 8787,
    dataDir: tempDir(),
    judgeConcurrency: 1,
    gxx: 'g++',
    runnerPath: 'ojrunner.exe',
    interactRunnerPath: 'ojinteract.exe',
    adminUsername: 'admin',
    sessionSecret: 'test-secret-32-bytes-long-0000000000',
    sessionTtlSec: 3600,
    workerIsolation: 'optional',
    ...overrides,
  };
}

describe('worker isolation configuration', () => {
  it('fails closed when required but no credentials are configured', () => {
    const issue = workerIsolationIssue(baseConfig({ workerIsolation: 'required' }));
    expect(issue).toContain('required');
    expect(issue).toContain('worker');
  });

  it('allows optional mode without credentials', () => {
    expect(workerIsolationIssue(baseConfig())).toBeNull();
  });

  it('rejects half-configured credentials', () => {
    expect(
      workerIsolationIssue(
        baseConfig({ workerIsolation: 'required', workerUser: 'OiJudgeWorker' }),
      ),
    ).toContain('together');
    expect(
      workerIsolationIssue(
        baseConfig({ workerIsolation: 'required', workerPassword: 'secret' }),
      ),
    ).toContain('together');
  });

  it('accepts required mode with credentials and exposes runner options', () => {
    const config = baseConfig({
      workerIsolation: 'required',
      workerUser: 'OiJudgeWorker',
      workerPassword: 'secret',
    });
    expect(workerIsolationIssue(config)).toBeNull();
    expect(workerRunOptions(config)).toEqual({
      user: 'OiJudgeWorker',
      password: 'secret',
      required: true,
    });
  });

  it('rejects an unknown isolation mode instead of silently disabling it', () => {
    expect(() => resolveWorkerIsolationMode({ OIJ_WORKER_ISOLATION: 'off' })).toThrow(
      /optional.*required/,
    );
  });

  it('loads credentials from worker.json and lets environment variables win', () => {
    const dataDir = tempDir();
    writeFileSync(
      join(dataDir, 'worker.json'),
      JSON.stringify({ username: 'OiJudgeWorker', password: 'file-password' }),
      'utf8',
    );
    const fromFile = loadConfig({ OIJ_DATA_DIR: dataDir });
    expect(fromFile.workerUser).toBe('OiJudgeWorker');
    expect(fromFile.workerPassword).toBe('file-password');
    expect(fromFile.workerIsolation).toBe('optional');

    const fromEnv = loadConfig({
      OIJ_DATA_DIR: dataDir,
      OIJ_WORKER_USER: 'EnvWorker',
      OIJ_WORKER_PASSWORD: 'env-password',
      OIJ_WORKER_ISOLATION: 'required',
    });
    expect(fromEnv.workerUser).toBe('EnvWorker');
    expect(fromEnv.workerPassword).toBe('env-password');
    expect(fromEnv.workerIsolation).toBe('required');
  });

  it('builds the documented icacls ACL commands', () => {
    const grant = buildWorkdirGrantArgs('D:\\data-judge-tmp\\sub-1', 'OiJudgeWorker');
    expect(grant[0]).toBe('D:\\data-judge-tmp\\sub-1');
    expect(grant).toContain('/grant');
    expect(grant).toContain('OiJudgeWorker:(OI)(CI)M');

    const deny = buildDataDirDenyArgs('D:\\data', 'OiJudgeWorker');
    expect(deny[0]).toBe('D:\\data');
    expect(deny).toContain('/deny');
    expect(deny).toContain('OiJudgeWorker:(OI)(CI)R');
  });
});

describe('native runner worker fail-closed', () => {
  const runner = join(process.cwd(), 'native/runner/out/ojrunner.exe');
  const available = process.platform === 'win32' && existsSync(runner);
  const itIf = available ? it : it.skip;

  itIf('refuses to run when required and credentials are absent', () => {
    const workdir = tempDir();
    const out = join(workdir, 'out.txt');
    const err = join(workdir, 'err.txt');
    const input = join(workdir, 'in.txt');
    writeFileSync(out, '');
    writeFileSync(err, '');
    writeFileSync(input, 'x');
    let stdout = '';
    let code = 0;
    try {
      stdout = execFileSync(
        runner,
        [
          '--exe',
          'C:\\Windows\\System32\\cmd.exe',
          '--workdir',
          workdir,
          '--input',
          input,
          '--output',
          out,
          '--stderr',
          err,
          '--time-ms',
          '100',
          '--wall-ms',
          '1000',
          '--memory-mb',
          '64',
          '--process-limit',
          '1',
          '--worker-required',
        ],
        { encoding: 'utf8', env: { ...process.env, OIJ_RUNNER_WORKER_USER: '', OIJ_RUNNER_WORKER_PASSWORD: '' } },
      );
    } catch (error) {
      const failure = error as { stdout?: string; status?: number };
      stdout = failure.stdout ?? '';
      code = failure.status ?? 1;
    }
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stdout.trim()) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('worker isolation required');
  });
});
