import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveGxx } from '../../../tools/build-runner.mjs';
import { runChecker } from '../src/judge/checker.js';

const gxx = resolveGxx();
const repoRoot = process.cwd();
const fixturesDir = join(repoRoot, 'tests', 'fixtures', 'checker');
const vendorDir = join(repoRoot, 'vendor');

let workDir: string;
const exe: Record<'sum' | 'partial' | 'slow' | 'lemon', string> = {
  sum: '',
  partial: '',
  slow: '',
  lemon: '',
};

function compile(name: 'sum' | 'partial' | 'slow' | 'lemon', source: string): void {
  const output = join(workDir, `${name}.exe`);
  execFileSync(
    gxx,
    ['-O2', '-std=c++17', '-I', vendorDir, '-o', output, join(fixturesDir, source)],
    { stdio: 'pipe' },
  );
  exe[name] = output;
}

function makeFiles(outputText: string): {
  input: string;
  output: string;
  answer: string;
} {
  const input = join(workDir, 'in.txt');
  const output = join(workDir, 'out.txt');
  const answer = join(workDir, 'ans.txt');
  writeFileSync(input, '1 2\n');
  writeFileSync(answer, '3\n');
  writeFileSync(output, outputText);
  return { input, output, answer };
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'oij-chk-'));
  compile('sum', 'testlib-sum.cpp');
  compile('partial', 'testlib-partial.cpp');
  compile('slow', 'testlib-slow.cpp');
  compile('lemon', 'lemon-sum.cpp');
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('runChecker testlib mode', () => {
  it('returns AC for equal output', async () => {
    const files = makeFiles('3\n');
    const result = await runChecker({
      mode: 'testlib',
      checker: exe.sum,
      ...files,
      workdir: workDir,
      timeMs: 10_000,
    });
    expect(result.status).toBe('AC');
    expect(result.score).toBe(1);
    expect(result.message).toContain('answer is correct');
  });

  it('returns WA for wrong output', async () => {
    const files = makeFiles('4\n');
    const result = await runChecker({
      mode: 'testlib',
      checker: exe.sum,
      ...files,
      workdir: workDir,
      timeMs: 10_000,
    });
    expect(result.status).toBe('WA');
    expect(result.score).toBe(0);
    expect(result.message).toContain('expected 3, got 4');
  });

  it('parses quitp(0.5) as a partial score', async () => {
    const files = makeFiles('4\n');
    const result = await runChecker({
      mode: 'testlib',
      checker: exe.partial,
      ...files,
      workdir: workDir,
      timeMs: 10_000,
    });
    expect(result.status).toBe('PC');
    expect(result.score).toBe(0.5);
    expect(result.message).toContain('half credit');
  });

  it('maps a checker timeout to SE', async () => {
    const files = makeFiles('3\n');
    const result = await runChecker({
      mode: 'testlib',
      checker: exe.slow,
      ...files,
      workdir: workDir,
      timeMs: 300,
    });
    expect(result.status).toBe('SE');
    expect(result.score).toBe(0);
  }, 20_000);

  it('maps a missing checker executable to SE', async () => {
    const files = makeFiles('3\n');
    const result = await runChecker({
      mode: 'testlib',
      checker: join(workDir, 'does-not-exist.exe'),
      ...files,
      workdir: workDir,
      timeMs: 5_000,
    });
    expect(result.status).toBe('SE');
    expect(result.score).toBe(0);
  });
});

describe('runChecker lemon mode', () => {
  it('returns AC with the full score', async () => {
    const files = makeFiles('3\n');
    const result = await runChecker({
      mode: 'lemon',
      checker: exe.lemon,
      ...files,
      workdir: workDir,
      timeMs: 10_000,
      fullScore: 100,
    });
    expect(result.status).toBe('AC');
    expect(result.score).toBe(100);
    expect(result.message).toContain('correct');
  });

  it('reads the partial score written by a six-argument checker', async () => {
    const files = makeFiles('4\n');
    const result = await runChecker({
      mode: 'lemon',
      checker: exe.lemon,
      ...files,
      workdir: workDir,
      timeMs: 10_000,
      fullScore: 100,
    });
    expect(result.status).toBe('PC');
    expect(result.score).toBe(50);
    expect(result.message).toContain('half credit');
  });

  it('returns WA for zero points', async () => {
    const files = makeFiles('10\n');
    const result = await runChecker({
      mode: 'lemon',
      checker: exe.lemon,
      ...files,
      workdir: workDir,
      timeMs: 10_000,
      fullScore: 100,
    });
    expect(result.status).toBe('WA');
    expect(result.score).toBe(0);
  });
});
