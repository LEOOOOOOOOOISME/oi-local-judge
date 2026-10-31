import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGxx, runnerPath } from '../build-runner.mjs';

const dist = join(process.cwd(), 'apps/server/dist/judge/runner.js');
if (!existsSync(dist)) {
  console.error('missing apps/server/dist/judge/runner.js; run tsc first');
  process.exit(1);
}
const { runSandboxed } = await import(pathToFileURL(dist).href);

const gxx = resolveGxx();
const dir = mkdtempSync(join(process.cwd(), '.bench-run-'));
const src = join(process.cwd(), 'tests/fixtures/runner/ok.cpp');
const exe = join(dir, 'ok.exe');
execFileSync(gxx, ['-O2', '-std=c++17', '-o', exe, src]);
writeFileSync(join(dir, 'in.txt'), '1 2\n');

const samples = [];
const runnerWall = [];
for (let i = 0; i < 20; i++) {
  const start = process.hrtime.bigint();
  const result = await runSandboxed({
    runner: runnerPath(),
    exe,
    workdir: dir,
    timeMs: 1000,
    wallMs: 3000,
    memoryMb: 64,
    processLimit: 1,
    stdinFile: join(dir, 'in.txt'),
    stdoutFile: join(dir, 'out.txt'),
    stderrFile: join(dir, 'err.txt'),
  });
  samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  runnerWall.push(result.wallMs);
}
samples.sort((a, b) => a - b);
runnerWall.sort((a, b) => a - b);

console.log(
  JSON.stringify({
    endToEndMedianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(2)),
    runnerWallMedianMs: runnerWall[Math.floor(runnerWall.length / 2)],
    endToEndMinMs: Number(samples[0].toFixed(2)),
    endToEndMaxMs: Number(samples[samples.length - 1].toFixed(2)),
  }),
);

rmSync(dir, { recursive: true, force: true });
