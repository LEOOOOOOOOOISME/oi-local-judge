// Builds the native interactive runner (ojinteract.exe) with the local GCC.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGxx } from './build-runner.mjs';

export function interactRunnerPath() {
  return join(process.cwd(), 'native/interact/out/ojinteract.exe');
}

export function buildInteractRunner() {
  const outDir = join(process.cwd(), 'native/interact/out');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'ojinteract.exe');
  execFileSync(
    resolveGxx(),
    [
      '-O2',
      '-std=c++17',
      '-Wall',
      '-Wextra',
      '-o',
      out,
      join(process.cwd(), 'native/interact/src/main.cpp'),
      '-lshell32',
    ],
    { stdio: 'inherit' },
  );
  return out;
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/build-interact.mjs');
if (isMain) {
  console.log('built', buildInteractRunner());
}
