import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultRunnerPath, runSandboxed } from '../src/judge/runner.js';

const repoRoot = process.cwd();
const fixturesDir = join(repoRoot, 'tests/fixtures/runner');
const runner = defaultRunnerPath();
// NOTE: scratch files must live inside the workspace. Under the DSH
// workspace-write file sandbox, spawned native processes are denied writes to
// %TEMP% (CreateFileW -> ERROR_ACCESS_DENIED), even though node itself can
// write there. native/runner/out is git-ignored and owned by this task.
const scratchRoot = join(repoRoot, 'native/runner/out');

const WINLIBS_GXX =
  'C:\\Users\\leo\\AppData\\Local\\Microsoft\\WinGet\\Packages\\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\\mingw64\\bin\\g++.exe';

function resolveGxx(): string {
  if (process.env.OIJ_GXX) return process.env.OIJ_GXX;
  if (existsSync(WINLIBS_GXX)) return WINLIBS_GXX;
  return 'g++';
}

type FixtureName = 'ok' | 'tle' | 'alloc';

let workdir = '';
const exePath = {} as Record<FixtureName, string>;

function outPath(name: string): string {
  return join(workdir, name);
}

async function expectProcessGone(pid: number | undefined, timeoutMs = 5000): Promise<void> {
  expect(pid).toBeGreaterThan(0);
  const target = pid as number;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(target, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process ${target} is still alive ${timeoutMs}ms after the run`);
}

beforeAll(() => {
  expect(existsSync(runner), 'build the runner first: node tools/build-runner.mjs').toBe(true);
  workdir = mkdtempSync(join(scratchRoot, 'runner-test-'));
  const gxx = resolveGxx();
  for (const name of ['ok', 'tle', 'alloc'] as const) {
    const exe = join(workdir, `${name}.exe`);
    execFileSync(gxx, ['-O2', '-std=c++17', '-o', exe, join(fixturesDir, `${name}.cpp`)], {
      stdio: 'pipe',
    });
    exePath[name] = exe;
  }
  writeFileSync(join(workdir, 'in.txt'), '1 2\n');
}, 120000);

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

function runFixture(
  name: FixtureName,
  opts: { timeMs: number; wallMs: number; memoryMb: number },
) {
  return runSandboxed({
    runner,
    exe: exePath[name],
    workdir,
    timeMs: opts.timeMs,
    wallMs: opts.wallMs,
    memoryMb: opts.memoryMb,
    processLimit: 1,
    stdinFile: join(workdir, 'in.txt'),
    stdoutFile: outPath(`${name}.out.txt`),
    stderrFile: outPath(`${name}.err.txt`),
  });
}

describe('ojrunner sandbox', () => {
  it('runs a normal program, redirects stdio and reports times', async () => {
    const r = await runFixture('ok', { timeMs: 1000, wallMs: 5000, memoryMb: 64 });

    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.oom).toBe(false);
    expect(r.cpuMs).toBeGreaterThanOrEqual(0);
    expect(r.wallMs).toBeGreaterThanOrEqual(0);
    expect(r.stdoutBytes).toBeGreaterThan(0);
    // stdin + stdout redirection actually reached the child. Windows CRT stdio
    // is in text mode, so "\n" is written as "\r\n".
    expect(readFileSync(outPath('ok.out.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('3\n');
    await expectProcessGone(r.pid);
  });

  it('kills a wall-clock time-limit-exceeded program', async () => {
    const r = await runFixture('tle', { timeMs: 200, wallMs: 1000, memoryMb: 64 });

    expect(r.timedOut).toBe(true);
    expect(r.wallMs).toBeGreaterThanOrEqual(900);
    expect(r.wallMs).toBeLessThan(10000);
    // TLE is not a memory verdict.
    expect(r.oom).toBe(false);
    // The killed process must not be left behind.
    await expectProcessGone(r.pid);
  });

  it('enforces the 32MB job memory limit on a 128MB allocation', async () => {
    const r = await runFixture('alloc', { timeMs: 2000, wallMs: 5000, memoryMb: 32 });

    // The job memory limit makes the 128MB allocation fail. The program then
    // dies in its CRT abort path (STATUS_STACK_BUFFER_OVERRUN / SIGABRT); under
    // load that teardown can stall past the wall-clock watchdog instead, so the
    // verdict must not depend on which of the two happened.
    expect(r.oom).toBe(true);
    // The limit must cap committed memory; the allocation cannot sneak past it.
    expect(r.peakMemKb).toBeLessThanOrEqual(34 * 1024);
    await expectProcessGone(r.pid);
  });
});
