#!/usr/bin/env node
/**
 * Builds the NSIS installer from an already-built portable application.
 *
 *   1. npm run build
 *   2. node tools/build-portable.mjs --source . --release-dir release
 *   3. npm run build:installer
 *
 * The portable directory is produced by tools/build-portable.mjs (which also
 * normalizes file integrity levels); electron-builder only archives that tree,
 * so it must never pack the project sources again.
 *
 * Usage:
 *   node tools/release/build-installer.mjs
 *   node tools/release/build-installer.mjs --prepackaged release/oi-local-judge-1.1.0-rc.6-win-x64
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILDER_CLI = join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const RELEASE_DIR = join(ROOT, 'release');
const INSTALLER_DIR = join(RELEASE_DIR, 'installer');

function log(message) {
  console.log(`[build-installer] ${message}`);
}

function fail(message) {
  console.error(`\n[build-installer] ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { prepackaged: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--prepackaged') options.prepackaged = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else fail(`unknown argument: ${argv[i]}`);
  }
  return options;
}

/** Newest release/oi-local-judge-*-win-x64 directory with a complete app tree. */
function latestPortable() {
  if (!existsSync(RELEASE_DIR)) return null;
  const candidates = readdirSync(RELEASE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^oi-local-judge-.*-win-x64$/.test(entry.name))
    .map((entry) => join(RELEASE_DIR, entry.name))
    .filter(
      (dir) =>
        existsSync(join(dir, 'OiJudge.exe')) &&
        existsSync(join(dir, 'resources', 'app', 'package.json')) &&
        existsSync(join(dir, 'resources', 'app', 'apps', 'desktop', 'dist', 'main.js')),
    )
    .sort((a, b) => (a < b ? 1 : -1));
  return candidates[0] ?? null;
}

/** True when a file or directory still carries a Low mandatory integrity label. */
function isLowIntegrity(path) {
  try {
    const output = execFileSync('icacls.exe', [path], { encoding: 'utf8', windowsHide: true });
    return /Low Mandatory Level|低强制级别/i.test(output);
  } catch {
    return false;
  }
}

/**
 * electron-builder writes into the checkout's release/installer directory,
 * which inherits the Low integrity label of a sandboxed build workspace. A Low
 * integrity NSIS installer cannot write %LOCALAPPDATA%/Programs or its own
 * temporary extraction directory (both Medium), so it hangs on an invisible
 * error dialog instead of installing. Normalize the artifacts before they are
 * handed to a user.
 */
function normalizeInstallerIntegrity(installer) {
  if (process.platform !== 'win32') return;
  if (!isLowIntegrity(installer) && !isLowIntegrity(INSTALLER_DIR)) {
    log('installer integrity level is already Medium.');
    return;
  }
  log('installer output inherited a Low integrity label; normalizing to Medium ...');
  try {
    execFileSync(
      'icacls.exe',
      [INSTALLER_DIR, '/setintegritylevel', 'Medium', '/T', '/C', '/Q'],
      { stdio: 'inherit', windowsHide: true },
    );
    execFileSync('icacls.exe', [INSTALLER_DIR, '/setintegritylevel', 'Medium', '/C', '/Q'], {
      stdio: 'inherit',
      windowsHide: true,
    });
  } catch (error) {
    fail(
      `could not normalize the integrity level of ${INSTALLER_DIR}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (isLowIntegrity(installer)) {
    fail(`installer is still Low integrity after normalization: ${installer}`);
  }
  log('installer integrity level normalized to Medium.');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: node tools/release/build-installer.mjs [--prepackaged <portable dir>]');
    return;
  }
  if (!existsSync(BUILDER_CLI)) {
    fail(
      'electron-builder is not installed. Run `npm install --save-dev electron-builder` first.',
    );
  }

  const portable = options.prepackaged
    ? resolve(ROOT, options.prepackaged)
    : latestPortable();
  if (!portable) {
    fail(
      'no prepackaged portable directory found.\n' +
        'Run `npm run build` and `node tools/build-portable.mjs --source . --release-dir release` first.',
    );
  }
  const appPackage = JSON.parse(
    readFileSync(join(portable, 'resources', 'app', 'package.json'), 'utf8'),
  );
  const version = appPackage.version;
  if (!version) fail(`prepackaged app package has no version: ${portable}`);

  log(`prepackaged app: ${portable} (version ${version})`);
  log('running electron-builder (NSIS, x64, publish never) ...');
  const startedAt = Date.now();
  try {
    execFileSync(
      process.execPath,
      [BUILDER_CLI, '--prepackaged', portable, '--win', 'nsis', '--publish', 'never'],
      { cwd: ROOT, stdio: 'inherit', windowsHide: true },
    );
  } catch (error) {
    fail(
      `electron-builder failed: ${error instanceof Error ? error.message : String(error)}\n` +
        'See the log above; the installer is only valid when electron-builder exits 0.',
    );
  }

  const installer = join(INSTALLER_DIR, `OiJudge-Setup-${version}.exe`);
  if (!existsSync(installer)) {
    fail(`electron-builder exited 0 but ${installer} does not exist`);
  }
  const bytes = statSync(installer).size;
  if (bytes < 10 * 1024 * 1024) {
    fail(`installer is suspiciously small (${bytes} bytes): ${installer}`);
  }
  log(
    `installer ready: ${installer} (${(bytes / 1024 / 1024).toFixed(1)} MB, ` +
      `${Math.round((Date.now() - startedAt) / 1000)}s)`,
  );

  normalizeInstallerIntegrity(installer);

  if (process.platform === 'win32') {
    try {
      const status = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-AuthenticodeSignature -LiteralPath '${installer.replace(/'/g, "''")}').Status`,
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
      log(`signature: ${status || 'unknown'}`);
    } catch {
      log('signature: could not be checked');
    }
  }
}

main();
