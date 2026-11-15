#!/usr/bin/env node
/**
 * `npm run build:installer` entry point.
 *
 *   1. applies build/icon.ico to the prepackaged OiJudge.exe (electron-builder
 *      skips its rcedit step in --prepackaged mode); then
 *   2. runs tools/release/build-installer.mjs, which archives that tree into
 *      the NSIS installer.
 *
 * Arguments (for example --prepackaged <dir>) are forwarded to both steps so
 * they always operate on the same portable directory.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARGS = process.argv.slice(2);

function run(script) {
  const result = spawnSync(process.execPath, [script, ...ARGS], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    console.error(`[build-installer] could not run ${script}: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

const iconStatus = run(join(ROOT, 'build', 'installer', 'stamp-exe-icon.mjs'));
if (iconStatus !== 0) {
  console.error('[build-installer] the exe icon step failed; see the message above.');
  process.exit(iconStatus);
}

process.exit(run(join(ROOT, 'tools', 'release', 'build-installer.mjs')));
