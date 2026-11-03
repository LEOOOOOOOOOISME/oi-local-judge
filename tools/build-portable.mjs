#!/usr/bin/env node
/**
 * Builds a self-contained Windows portable distribution of OiJudge.
 *
 *   release/oi-local-judge-<version>-win-x64/
 *     OiJudge.exe
 *     启动 OiJudge.cmd
 *     resources/app/
 *       package.json                         (CJS entry point for Electron)
 *       apps/desktop/dist/                   (main + preload)
 *       apps/server/dist/  + package.json    (type: module)
 *       apps/web/dist/
 *       packages/shared/dist/ + package.json (type: module)
 *       native/runner/out/ojrunner.exe
 *       native/interact/out/ojinteract.exe
 *       vendor/                              (testlib.h for authoring)
 *       node_modules/                        (production dependencies only)
 *
 * Usage:
 *   node tools/build-portable.mjs          # directory only
 *   node tools/build-portable.mjs --zip    # directory + .zip
 *
 * The script never runs the project build itself; run `npm run build` and
 * `npm run build:native` first. It is safe to run repeatedly: the previous
 * release directory and zip are replaced.
 */
import { execFileSync, execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = ROOT_PKG.version ?? '0.0.0';
const WANT_ZIP = process.argv.includes('--zip');

const RELEASE_DIR = join(ROOT, 'release');
const OUT_NAME = `oi-local-judge-${VERSION}-win-x64`;
const OUT_DIR = join(RELEASE_DIR, OUT_NAME);
const OUT_ZIP = join(RELEASE_DIR, `${OUT_NAME}.zip`);

const ELECTRON_DIST = join(ROOT, 'node_modules', 'electron', 'dist');
const APP_DIR = join(OUT_DIR, 'resources', 'app');
const APP_PACKAGE = join(APP_DIR, 'package.json');
const LAUNCHER = join(OUT_DIR, '启动 OiJudge.cmd');

const REQUIRED = [
  'apps/desktop/dist/main.js',
  'apps/desktop/dist/preload.js',
  'apps/server/dist/cli.js',
  'apps/server/package.json',
  'apps/web/dist/index.html',
  'packages/shared/dist/index.js',
  'packages/shared/package.json',
  'native/runner/out/ojrunner.exe',
  'native/interact/out/ojinteract.exe',
  'node_modules/electron/dist/electron.exe',
  'package-lock.json',
];

// Packages the server needs at runtime. Checked after the copy so a broken
// dependency resolution fails the build instead of the packaged app.
const RUNTIME_PACKAGES = [
  'fastify',
  '@fastify/static',
  '@fastify/websocket',
  '@oij/shared',
  'sanitize-html',
  'markdown-it',
  'markdown-it-texmath',
  'katex',
  'fflate',
];

function log(message) {
  console.log(`[build-portable] ${message}`);
}

function fail(message) {
  console.error(`\n[build-portable] ERROR: ${message}`);
  process.exit(1);
}

/** Recursively copies a directory, replacing `dest` when it already exists. */
function copyDir(src, dest) {
  // Retries absorb transient Windows locks (antivirus/indexer/another shell
  // holding a file open), which otherwise surface as EPERM during the rebuild.
  rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, force: true, dereference: false });
}

function copyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { force: true });
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  }
  return total;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateInputs() {
  const missing = REQUIRED.filter((rel) => !existsSync(join(ROOT, rel)));
  if (missing.length > 0) {
    fail(
      'missing build artifacts:\n' +
        missing.map((rel) => `  - ${rel}`).join('\n') +
        '\nRun `npm run build` and `npm run build:native` first (the portable build never runs them).',
    );
  }
  if (!existsSync(join(ROOT, 'vendor', 'testlib.h'))) {
    log('WARNING: vendor/testlib.h is missing; testlib-based authoring will not work.');
  }
}

/**
 * Lists production dependency directories from npm, as paths relative to the
 * application root (e.g. `node_modules/fastify`).
 *
 * `npm ls` can exit non-zero when optional peer dependencies are absent; the
 * parseable output is still valid, so it is accepted in that case.
 */
function productionDependencies() {
  let stdout = '';
  try {
    stdout = execSync('npm ls --omit=dev --parseable --all', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    stdout = (error && error.stdout) || '';
    if (!stdout.trim()) {
      const stderr = (error && error.stderr) || '';
      fail(`\`npm ls --omit=dev --parseable --all\` produced no output.\n${stderr}`.trim());
    }
    log('npm ls reported missing optional peer dependencies; using its parseable output.');
  }

  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages ?? {};
  const seen = new Set();
  const available = [];
  let filtered = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/[\\/]+/);
    const nmIndex = parts.findIndex((part) => part.toLowerCase() === 'node_modules');
    // The repository root itself (and any path outside node_modules) is not a
    // dependency; workspaces are copied explicitly below.
    if (nmIndex < 0) continue;
    const rel = parts.slice(nmIndex).join('/');
    if (rel === 'node_modules') continue;
    if (rel.startsWith('node_modules/@oij/')) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);

    // In a workspace worktree `npm ls` may list hoisted packages as
    // "extraneous" (dev dependencies included). The lockfile's dev flags are
    // the reliable source for what `--omit=dev` should have removed.
    const info = lock[rel];
    if (info && (info.dev === true || info.devOptional === true || info.link === true)) {
      filtered += 1;
      continue;
    }
    if (!existsSync(join(ROOT, ...rel.split('/')))) {
      log(`WARNING: npm ls listed ${rel} but it does not exist; skipping.`);
      continue;
    }
    available.push(rel);
  }

  // Copy parents first: a package's own nested node_modules is copied with it,
  // so nested entries already covered by an included parent can be skipped.
  const rels = available.sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  );
  const included = [];
  for (const rel of rels) {
    if (included.some((parent) => rel.startsWith(`${parent}/`))) continue;
    included.push(rel);
  }
  return { included, total: seen.size, filtered };
}

function copyProductionDependencies() {
  const { included, total, filtered } = productionDependencies();
  const destNodeModules = join(APP_DIR, 'node_modules');
  mkdirSync(destNodeModules, { recursive: true });
  for (const rel of included) {
    const dest = join(APP_DIR, ...rel.split('/'));
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    copyDir(join(ROOT, ...rel.split('/')), dest);
  }
  log(
    `production dependencies: ${included.length} package(s) copied` +
      (filtered > 0 ? `, ${filtered} dev/extraneous package(s) ignored` : '') +
      ` (npm ls reported ${total} entries).`,
  );
}

/**
 * The native runners link against the MinGW runtime DLLs. Copy them next to
 * each executable when the compiler that built them can be located; the app
 * still works without this if the target machine has the same MinGW on PATH.
 */
function copyMinGwRuntime() {
  const WINLIBS_GXX =
    'C:\\Users\\leo\\AppData\\Local\\Microsoft\\WinGet\\Packages\\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\\mingw64\\bin\\g++.exe';
  const candidates = [];
  if (process.env.OIJ_GXX) candidates.push(process.env.OIJ_GXX);
  candidates.push(WINLIBS_GXX);
  let gxx = candidates.find((candidate) => existsSync(candidate));
  if (!gxx) {
    try {
      const found = execFileSync('where.exe', ['g++'], { encoding: 'utf8', windowsHide: true });
      gxx = found.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    } catch {
      gxx = undefined;
    }
  }
  if (!gxx) {
    log('WARNING: could not locate g++; MinGW runtime DLLs were not bundled.');
    return;
  }

  const binDir = dirname(gxx);
  // libstdc++-6.dll (POSIX thread build) imports libwinpthread-1.dll, and
  // libgcc_s_seh-1.dll is the unwinder both runners need; all three must sit
  // next to the executables or a machine without MinGW fails with
  // STATUS_DLL_NOT_FOUND (0xC0000135).
  const dlls = ['libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll'];
  for (const dll of dlls) {
    if (!existsSync(join(binDir, dll))) {
      log(`WARNING: ${dll} not found next to ${gxx}; MinGW runtime not bundled.`);
      return;
    }
  }
  for (const target of ['native/runner/out', 'native/interact/out']) {
    for (const dll of dlls) {
      copyFile(join(binDir, dll), join(APP_DIR, ...target.split('/'), dll));
    }
  }
  log(`bundled MinGW runtime DLLs (${dlls.join(', ')}) for the native runners.`);
}

function writeAppPackageJson() {
  // No `type` field: apps/desktop/dist/main.js is CommonJS. The server and
  // shared packages keep their own package.json with `"type": "module"`.
  const appPackage = {
    name: 'oi-local-judge',
    productName: 'OiJudge',
    version: VERSION,
    private: true,
    main: 'apps/desktop/dist/main.js',
  };
  writeFileSync(APP_PACKAGE, `${JSON.stringify(appPackage, null, 2)}\n`, 'utf8');
}

function writeLauncher() {
  // ASCII-only contents: cmd.exe reads batch files using the console code page,
  // so keeping the body ASCII avoids mojibake across Chinese Windows installs.
  const launcher = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'if not exist "%~dp0OiJudge.exe" (',
    '  echo OiJudge.exe was not found next to this launcher.',
    '  pause',
    '  exit /b 1',
    ')',
    'start "" "%~dp0OiJudge.exe"',
    'endlocal',
    '',
  ].join('\r\n');
  writeFileSync(LAUNCHER, launcher, 'utf8');
}

function checkRuntimePackages() {
  const missing = RUNTIME_PACKAGES.filter(
    (name) => !existsSync(join(APP_DIR, 'node_modules', ...name.split('/'), 'package.json')),
  );
  if (missing.length > 0) {
    fail(`packaged node_modules is missing runtime package(s): ${missing.join(', ')}`);
  }
}

/** Returns the first executable that answers `--version`, or null. */
function findExecutable(candidates, args = ['--version']) {
  for (const exe of candidates) {
    try {
      execFileSync(exe, args, { stdio: 'ignore', windowsHide: true });
      return exe;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function compressArchive() {
  rmSync(OUT_ZIP, { force: true });

  // Prefer the bsdtar that ships with Windows 10 1803+ (tar.exe): it streams
  // the archive straight to disk. Compress-Archive on Windows PowerShell 5.1
  // buffers the whole ~700 MB tree in memory and fails on this build, so it is
  // only used as a fallback (and through the streaming .NET ZipFile API).
  const tar = findExecutable(['tar.exe', 'tar']);
  if (tar) {
    log(`creating ${OUT_ZIP} with ${tar} ...`);
    try {
      execFileSync(tar, ['-a', '-c', '-f', OUT_ZIP, '-C', RELEASE_DIR, OUT_NAME], {
        stdio: 'inherit',
        windowsHide: true,
      });
      if (existsSync(OUT_ZIP) && statSync(OUT_ZIP).size > 0) return;
      log(`${tar} produced an empty zip; falling back to PowerShell.`);
    } catch (error) {
      log(
        `${tar} failed (${error instanceof Error ? error.message : String(error)}); ` +
          'falling back to PowerShell.',
      );
    }
    rmSync(OUT_ZIP, { force: true });
  }

  const ps = findExecutable(
    ['pwsh', 'powershell'],
    ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
  );
  if (!ps) fail('Neither tar nor PowerShell is available; cannot create the zip.');

  // .NET ZipFile streams the archive on both Windows PowerShell 5.1 and
  // PowerShell 7, so memory use stays flat regardless of the input size.
  const quote = (value) => value.replace(/'/g, "''");
  const command =
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
    `[System.IO.Compression.ZipFile]::CreateFromDirectory('${quote(OUT_DIR)}', ` +
    `'${quote(OUT_ZIP)}', [System.IO.Compression.CompressionLevel]::Optimal, $true)`;
  log(`creating ${OUT_ZIP} with ${ps} ...`);
  execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', command], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (!existsSync(OUT_ZIP) || statSync(OUT_ZIP).size === 0) {
    fail('PowerShell did not create the zip file.');
  }
}

function main() {
  validateInputs();

  log(`building ${OUT_NAME} ...`);
  rmSync(OUT_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(OUT_ZIP, { force: true });
  mkdirSync(RELEASE_DIR, { recursive: true });

  // Electron runtime (electron.exe, DLLs, locales, resources/).
  copyDir(ELECTRON_DIST, OUT_DIR);
  copyFile(join(OUT_DIR, 'electron.exe'), join(OUT_DIR, 'OiJudge.exe'));
  writeLauncher();

  // Application code and metadata.
  const copies = [
    ['apps/desktop/dist', 'apps/desktop/dist'],
    ['apps/server/dist', 'apps/server/dist'],
    ['apps/server/package.json', 'apps/server/package.json'],
    ['apps/web/dist', 'apps/web/dist'],
    ['packages/shared/dist', 'packages/shared/dist'],
    ['packages/shared/package.json', 'packages/shared/package.json'],
    ['native/runner/out/ojrunner.exe', 'native/runner/out/ojrunner.exe'],
    ['native/interact/out/ojinteract.exe', 'native/interact/out/ojinteract.exe'],
    ['vendor', 'vendor'],
  ];
  for (const [srcRel, destRel] of copies) {
    const src = join(ROOT, ...srcRel.split('/'));
    const dest = join(APP_DIR, ...destRel.split('/'));
    const isDir = statSync(src).isDirectory();
    if (isDir) copyDir(src, dest);
    else copyFile(src, dest);
  }
  writeAppPackageJson();

  // The server imports the workspace package by name, so provide the same
  // `node_modules/@oij/shared` resolution a normal install has.
  copyDir(join(ROOT, 'packages', 'shared', 'dist'), join(APP_DIR, 'node_modules', '@oij', 'shared', 'dist'));
  copyFile(
    join(ROOT, 'packages', 'shared', 'package.json'),
    join(APP_DIR, 'node_modules', '@oij', 'shared', 'package.json'),
  );

  copyProductionDependencies();
  copyMinGwRuntime();
  checkRuntimePackages();

  const dirBytes = dirSize(OUT_DIR);
  log(`portable directory ready: ${OUT_DIR} (${formatSize(dirBytes)})`);

  if (WANT_ZIP) {
    compressArchive();
    log(`zip ready: ${OUT_ZIP} (${formatSize(statSync(OUT_ZIP).size)})`);
  }
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
}
