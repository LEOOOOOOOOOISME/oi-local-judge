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
 *   node tools/build-portable.mjs
 *   node tools/build-portable.mjs --zip
 *   node tools/build-portable.mjs --source <dir> --release-dir <dir> --version <version>
 *
 * By default the build source is the repository that contains this script and
 * the output goes to `<source>/release`. `build:release` runs this script from
 * the developer checkout with `--source <temporary-worktree>`, so the build
 * artifacts never touch the development worktree.
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
import { parsePortableArgs } from './release/args.mjs';
import { createZipFromDirectory, validateZip } from './release/zip.mjs';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Populated by `configure()`. Keeping these mutable (instead of module-level
// constants) is what allows one script to package a temporary worktree.
let SOURCE_ROOT = SCRIPT_ROOT;
let VERSION = '0.0.0';
let WANT_ZIP = false;
let RELEASE_DIR = join(SCRIPT_ROOT, 'release');
let OUT_NAME = 'oi-local-judge-0.0.0-win-x64';
let OUT_DIR = join(RELEASE_DIR, OUT_NAME);
let OUT_ZIP = join(RELEASE_DIR, `${OUT_NAME}.zip`);
let ELECTRON_DIST = join(SCRIPT_ROOT, 'node_modules', 'electron', 'dist');
let APP_DIR = join(OUT_DIR, 'resources', 'app');
let APP_PACKAGE = join(APP_DIR, 'package.json');
let LAUNCHER = join(OUT_DIR, '启动 OiJudge.cmd');

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

/** Resolves every path from the parsed CLI options. */
function configure(options) {
  SOURCE_ROOT = options.source ? resolve(options.source) : SCRIPT_ROOT;
  const packageJsonPath = join(SOURCE_ROOT, 'package.json');
  if (!existsSync(packageJsonPath)) {
    fail(`no package.json in build source: ${SOURCE_ROOT}`);
  }
  const sourcePackage = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  VERSION = options.version ?? sourcePackage.version ?? '0.0.0';
  WANT_ZIP = options.zip;
  RELEASE_DIR = options.releaseDir ? resolve(options.releaseDir) : join(SOURCE_ROOT, 'release');
  OUT_NAME = `oi-local-judge-${VERSION}-win-x64`;
  OUT_DIR = join(RELEASE_DIR, OUT_NAME);
  OUT_ZIP = join(RELEASE_DIR, `${OUT_NAME}.zip`);
  APP_DIR = join(OUT_DIR, 'resources', 'app');
  APP_PACKAGE = join(APP_DIR, 'package.json');
  LAUNCHER = join(OUT_DIR, '启动 OiJudge.cmd');

  // A temporary worktree gets node_modules through a junction to the developer
  // checkout, but fall back to the checkout that contains this script so a
  // direct invocation still works if the source has no node_modules.
  const electronCandidates = [
    process.env.OIJ_ELECTRON_DIST,
    join(SOURCE_ROOT, 'node_modules', 'electron', 'dist'),
    join(SCRIPT_ROOT, 'node_modules', 'electron', 'dist'),
  ].filter((candidate) => Boolean(candidate));
  ELECTRON_DIST =
    electronCandidates.find((candidate) => existsSync(join(candidate, 'electron.exe'))) ??
    electronCandidates[0];
}

/** Entries that must exist in the published ZIP for a given portable build. */
export function portableRequiredEntries(outName = OUT_NAME) {
  const app = `${outName}/resources/app`;
  return [
    `${outName}/OiJudge.exe`,
    `${outName}/启动 OiJudge.cmd`,
    `${app}/package.json`,
    `${app}/apps/desktop/dist/main.js`,
    `${app}/apps/desktop/dist/preload.js`,
    `${app}/apps/server/dist/cli.js`,
    `${app}/apps/server/package.json`,
    `${app}/apps/web/dist/index.html`,
    `${app}/packages/shared/dist/index.js`,
    `${app}/packages/shared/package.json`,
    `${app}/native/runner/out/ojrunner.exe`,
    `${app}/native/interact/out/ojinteract.exe`,
    `${app}/node_modules/fastify/package.json`,
    `${app}/node_modules/@oij/shared/package.json`,
    `${app}/vendor/testlib.h`,
  ];
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
  const missing = REQUIRED.filter((rel) => !existsSync(join(SOURCE_ROOT, rel)));
  if (!existsSync(join(ELECTRON_DIST, 'electron.exe'))) {
    missing.push('node_modules/electron/dist/electron.exe');
  }
  if (missing.length > 0) {
    fail(
      `missing build artifacts in ${SOURCE_ROOT}:\n` +
        missing.map((rel) => `  - ${rel}`).join('\n') +
        '\nRun `npm run build` and `npm run build:native` first (the portable build never runs them).',
    );
  }
  if (!existsSync(join(SOURCE_ROOT, 'vendor', 'testlib.h'))) {
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
      cwd: SOURCE_ROOT,
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

  const lock = JSON.parse(readFileSync(join(SOURCE_ROOT, 'package-lock.json'), 'utf8')).packages ?? {};
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
    if (!existsSync(join(SOURCE_ROOT, ...rel.split('/')))) {
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
    copyDir(join(SOURCE_ROOT, ...rel.split('/')), dest);
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

/**
 * Creates the release ZIP with fflate's streaming writer. Only the central
 * directory is read back for validation, so a ~700 MB tree never has to be
 * buffered in memory.
 */
function compressArchive() {
  log(`creating ${OUT_ZIP} with fflate (level 1, streaming) ...`);
  createZipFromDirectory(OUT_DIR, OUT_ZIP, { prefix: OUT_NAME, level: 1, log });
  const validation = validateZip(OUT_ZIP, portableRequiredEntries(OUT_NAME));
  log(
    `zip ready: ${OUT_ZIP} (${formatSize(statSync(OUT_ZIP).size)}, ` +
      `${validation.entryCount} entries validated)`,
  );
}

function printUsage() {
  console.log(
    [
      'Usage: node tools/build-portable.mjs [options]',
      '',
      'Options:',
      '  --source <dir>        build source root (default: this repository)',
      '  --release-dir <dir>   output directory (default: <source>/release)',
      '  --version <version>   override the version read from <source>/package.json',
      '  --zip                 also create the streaming ZIP',
      '  --help                show this help',
    ].join('\n'),
  );
}

function main(argv = process.argv.slice(2)) {
  const options = parsePortableArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }
  configure(options);
  validateInputs();

  log(`building ${OUT_NAME} from ${SOURCE_ROOT} ...`);
  rmSync(OUT_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  // The previous ZIP is replaced atomically by createZipFromDirectory; keep it
  // in place until the new archive was written and validated.
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
    const src = join(SOURCE_ROOT, ...srcRel.split('/'));
    const dest = join(APP_DIR, ...destRel.split('/'));
    const isDir = statSync(src).isDirectory();
    if (isDir) copyDir(src, dest);
    else copyFile(src, dest);
  }
  writeAppPackageJson();

  // The server imports the workspace package by name, so provide the same
  // `node_modules/@oij/shared` resolution a normal install has.
  copyDir(join(SOURCE_ROOT, 'packages', 'shared', 'dist'), join(APP_DIR, 'node_modules', '@oij', 'shared', 'dist'));
  copyFile(
    join(SOURCE_ROOT, 'packages', 'shared', 'package.json'),
    join(APP_DIR, 'node_modules', '@oij', 'shared', 'package.json'),
  );

  copyProductionDependencies();
  copyMinGwRuntime();
  checkRuntimePackages();

  const dirBytes = dirSize(OUT_DIR);
  log(`portable directory ready: ${OUT_DIR} (${formatSize(dirBytes)})`);

  if (WANT_ZIP) compressArchive();
}

function isDirectRun() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}
