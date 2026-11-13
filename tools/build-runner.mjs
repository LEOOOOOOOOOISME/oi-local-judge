// Builds the native Job Object runner (ojrunner.exe) with the local GCC.
//
// Compiler resolution order:
//   1. OIJ_GXX environment variable
//   2. local WinLibs GCC 16.1 install used by this project
//   3. g++ from PATH
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const WINLIBS_GXX =
  'C:\\Users\\leo\\AppData\\Local\\Microsoft\\WinGet\\Packages\\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\\mingw64\\bin\\g++.exe';

export function resolveGxx() {
  if (process.env.OIJ_GXX) return process.env.OIJ_GXX;
  if (existsSync(WINLIBS_GXX)) return WINLIBS_GXX;
  return 'g++';
}

export function runnerPath() {
  return join(process.cwd(), 'native/runner/out/ojrunner.exe');
}

export function buildRunner() {
  const gxx = resolveGxx();
  const outDir = join(process.cwd(), 'native/runner/out');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'ojrunner.exe');
  execFileSync(
    gxx,
    [
      '-O2',
      '-std=c++17',
      '-Wall',
      '-Wextra',
      '-o',
      out,
      join(process.cwd(), 'native/runner/src/main.cpp'),
      '-lshell32',
      '-ladvapi32',
    ],
    { stdio: 'inherit' },
  );
  return out;
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/build-runner.mjs');
if (isMain) {
  const out = buildRunner();
  console.log('built', out);
}
