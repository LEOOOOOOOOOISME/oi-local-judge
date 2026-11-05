#!/usr/bin/env node
/**
 * Isolated release build.
 *
 *   npm run build:release                 # HEAD, portable dir + validated ZIP
 *   node tools/release/build-release.mjs --rev <ref> --no-zip --keep
 *
 * The project is built inside a temporary `git worktree`, so the developer
 * checkout keeps its app `dist` directories, `runtime/` and `release/` untouched. Only
 * `node_modules`, `native/<tool>/out` and `vendor` are reused from the checkout as
 * caches (node_modules through a junction). Output goes to the checkout's
 * `release/` directory, which is gitignored.
 */
import { execFileSync, execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReleaseArgs, resolveGit } from './args.mjs';
import { acquireBuildLock } from './lock.mjs';
import { createZipFromDirectory, validateZip } from './zip.mjs';
import { portableRequiredEntries } from '../build-portable.mjs';

const MAIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCK_FILE = join(MAIN_ROOT, 'release', '.build.lock');

function log(message) {
  console.log(`[build-release] ${message}`);
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(milliseconds) {
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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

/** Unique temporary worktree path below the OS temp directory. */
export function makeTempWorktreePath({
  base = tmpdir(),
  now = Date.now(),
  pid = process.pid,
} = {}) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return join(base, `oij-release-${stamp}-${pid}`);
}

function runGit(git, args, { cwd = MAIN_ROOT, encoding = null } = {}) {
  return execFileSync(git, args, {
    cwd,
    stdio: encoding ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function removeJunction(path) {
  try {
    const stats = lstatSync(path);
    if (!stats.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  try {
    unlinkSync(path);
    return true;
  } catch {
    try {
      // Junctions are reparse points; rmdir removes the link, not the target.
      rmdirSync(path);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The `node_modules` junction reused inside the temporary worktree contains a
 * `@oij/shared` workspace link that resolves to *this* checkout's
 * `packages/shared`, not to the worktree's copy. Any `tsc` run for the server
 * therefore needs this checkout's `packages/shared/dist` to exist, even though
 * the isolated build also compiles the worktree's own copy.
 *
 * Returns the compiler entry point shipped by the `typescript` dependency.
 */
export function resolveTscScript({ mainRoot = MAIN_ROOT, exists = existsSync } = {}) {
  const script = join(mainRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!exists(script)) {
    throw new Error(`TypeScript is not installed in ${mainRoot}; run \`npm ci\` before building the release.`);
  }
  return script;
}

function runSharedTypeScript({ mainRoot = MAIN_ROOT, tsconfig }) {
  const tsc = resolveTscScript({ mainRoot });
  try {
    execFileSync(process.execPath, [tsc, '-p', tsconfig], {
      cwd: mainRoot,
      stdio: 'inherit',
      windowsHide: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to build @oij/shared in ${mainRoot}: ${detail}`, { cause: error });
  }
}

/**
 * Builds the main checkout's `packages/shared` before the isolated worktree
 * build starts. Only that gitignored `dist` directory is written; app `dist`
 * directories stay untouched.
 */
export function ensureSharedPackageBuilt({
  mainRoot = MAIN_ROOT,
  exists = existsSync,
  runTsc = runSharedTypeScript,
  log: logFn = log,
} = {}) {
  const packageRoot = join(mainRoot, 'packages', 'shared');
  const tsconfig = join(packageRoot, 'tsconfig.json');
  const entry = join(packageRoot, 'dist', 'index.js');

  if (!exists(tsconfig)) {
    throw new Error(`cannot find the shared package tsconfig: ${tsconfig}`);
  }

  logFn(`building @oij/shared in the main checkout (${tsconfig}) ...`);
  runTsc({ mainRoot, tsconfig });

  if (!exists(entry)) {
    throw new Error(
      `building @oij/shared did not produce ${entry}; the isolated worktree resolves its ` +
        'node_modules/@oij/shared link to this directory, so the server build would fail.',
    );
  }
  return entry;
}

/**
 * Reuses the developer checkout's dependency tree and native/vendor artifacts
 * inside the temporary worktree. Nothing is copied back.
 */
function prepareWorktree(sourceRoot, { mainRoot = MAIN_ROOT } = {}) {
  const nodeModules = join(sourceRoot, 'node_modules');
  if (existsSync(nodeModules)) {
    log('build source already has node_modules; leaving it untouched.');
  } else {
    symlinkSync(join(mainRoot, 'node_modules'), nodeModules, 'junction');
    log('linked node_modules via junction.');
  }

  for (const rel of ['native/runner/out', 'native/interact/out', 'vendor']) {
    const source = join(mainRoot, ...rel.split('/'));
    const destination = join(sourceRoot, ...rel.split('/'));
    if (!existsSync(source)) {
      throw new Error(`missing build cache ${source}; run \`npm run build:native\` first.`);
    }
    if (existsSync(destination)) {
      log(`${rel} is already tracked in this revision; keeping it.`);
      continue;
    }
    cpSync(source, destination, { recursive: true, force: true });
    log(`copied ${rel} from the developer checkout.`);
  }

  // The cached node_modules belongs to the checkout's lockfile; use the same
  // lockfile so `npm ls` resolves exactly the packages that are available.
  const mainLock = join(mainRoot, 'package-lock.json');
  if (existsSync(mainLock)) {
    cpSync(mainLock, join(sourceRoot, 'package-lock.json'), { force: true });
    log('copied package-lock.json from the developer checkout.');
  }
}

function runProjectBuild(sourceRoot) {
  log('running `npm run build` in the isolated worktree ...');

  // esbuild's own cleanup of its temporary output fails with EACCES when the
  // worktree lives under %TEMP%. Keep that scratch directory inside the
  // gitignored release directory (on the project drive) instead.
  const viteTmp = join(MAIN_ROOT, 'release', `.vite-tmp-${process.pid}`);
  mkdirSync(viteTmp, { recursive: true });

  // npm normally prepends node_modules/.bin, but a junctioned shared
  // node_modules does not always survive that lookup. Prepend it explicitly so
  // the build is independent of the npm version's PATH heuristics.
  const binDirectories = [
    join(sourceRoot, 'node_modules', '.bin'),
    join(MAIN_ROOT, 'node_modules', '.bin'),
  ].filter((directory) => existsSync(directory));
  const env = { ...process.env, OIJ_RELEASE_BUILD: '1', OIJ_VITE_TMP: viteTmp };
  const pathKey = Object.keys(env).find((key) => /^path$/i.test(key)) ?? 'Path';
  env[pathKey] = [...binDirectories, env[pathKey] ?? ''].filter(Boolean).join(delimiter);

  try {
    execSync('npm run build', {
      cwd: sourceRoot,
      stdio: 'inherit',
      windowsHide: true,
      env,
    });
  } finally {
    rmSync(viteTmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function runPortableBuild(sourceRoot, releaseDir, version) {
  log('packaging the portable directory ...');
  const electronDist = findElectronDist(sourceRoot);
  if (electronDist) {
    log(`using Electron runtime from ${electronDist}.`);
  }
  execFileSync(
    process.execPath,
    [
      join(MAIN_ROOT, 'tools', 'build-portable.mjs'),
      '--source',
      sourceRoot,
      '--release-dir',
      releaseDir,
      '--version',
      version,
    ],
    {
      cwd: MAIN_ROOT,
      stdio: 'inherit',
      windowsHide: true,
      env: electronDist ? { ...process.env, OIJ_ELECTRON_DIST: electronDist } : process.env,
    },
  );
}

/**
 * Locates the Electron runtime. The worktree's node_modules is normally a
 * junction to the developer checkout, but a partially installed copy can lack
 * the 250 MB `electron/dist` download. In that case fall back to another
 * worktree of the same repository instead of reinstalling dependencies.
 */
function findElectronDist(sourceRoot) {
  const candidates = [
    process.env.OIJ_ELECTRON_DIST,
    join(sourceRoot, 'node_modules', 'electron', 'dist'),
    join(MAIN_ROOT, 'node_modules', 'electron', 'dist'),
  ].filter((candidate) => Boolean(candidate));

  try {
    const porcelain = execFileSync(
      resolveGit(),
      ['worktree', 'list', '--porcelain'],
      { cwd: MAIN_ROOT, encoding: 'utf8', windowsHide: true },
    );
    for (const line of porcelain.split(/\r?\n/)) {
      if (!line.startsWith('worktree ')) continue;
      candidates.push(join(line.slice('worktree '.length).trim(), 'node_modules', 'electron', 'dist'));
    }
  } catch {
    // Best effort: the two direct candidates above are usually enough.
  }

  return candidates.find((candidate) => existsSync(join(candidate, 'electron.exe'))) ?? null;
}

function cleanupWorktree(git, tempRoot, { keep, mainRoot = MAIN_ROOT } = {}) {
  if (keep) {
    log(`keeping temporary worktree: ${tempRoot}`);
    log('remove it later with `git worktree remove --force <path>`; node_modules is a junction.');
    return;
  }

  // Remove the junction before git touches the directory: a recursive delete
  // that follows the reparse point would wipe the developer's node_modules.
  if (removeJunction(join(tempRoot, 'node_modules'))) {
    log('removed the node_modules junction.');
  }

  try {
    runGit(git, ['worktree', 'remove', '--force', tempRoot], { cwd: mainRoot });
  } catch (error) {
    log(
      `git worktree remove failed (${error instanceof Error ? error.message : String(error)}); ` +
        'falling back to a direct removal.',
    );
  }
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

  try {
    runGit(git, ['worktree', 'prune'], { cwd: mainRoot });
  } catch {
    // Pruning is best effort; the worktree directory is already gone.
  }
}

function printUsage() {
  console.log(
    [
      'Usage: npm run build:release -- [options]',
      '',
      'Options:',
      '  --rev <ref>    revision to build (default: HEAD)',
      '  --no-zip       skip ZIP creation',
      '  --no-worktree  build the current checkout in place (debug only)',
      '  --keep         keep the temporary worktree after the build',
      '  --help         show this help',
    ].join('\n'),
  );
}

export function main(argv = process.argv.slice(2)) {
  const options = parseReleaseArgs(argv);
  if (options.help) {
    printUsage();
    return null;
  }

  const releaseDir = join(MAIN_ROOT, 'release');
  mkdirSync(releaseDir, { recursive: true });

  const lock = acquireBuildLock(LOCK_FILE, { log });
  log(`acquired build lock ${lock.path} (pid ${lock.pid}).`);

  const startedAt = Date.now();
  let git;
  let tempRoot = null;
  let sourceRoot = MAIN_ROOT;
  let summary = null;

  try {
    git = resolveGit();
    const gitVersion = execFileSync(git, ['--version'], {
      cwd: MAIN_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    log(`using ${gitVersion} (${git}).`);

    // The temporary worktree shares this checkout's node_modules through a
    // junction, and its `@oij/shared` workspace link resolves back here. Build
    // this checkout's shared package first, otherwise the isolated server
    // build cannot resolve `@oij/shared` on a clean (CI) checkout.
    ensureSharedPackageBuilt({ mainRoot: MAIN_ROOT, log });

    if (options.worktree) {
      const status = execFileSync(git, ['status', '--porcelain'], {
        cwd: MAIN_ROOT,
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      if (status) {
        log('WARNING: the developer checkout has uncommitted changes; only the committed revision is built.');
      }

      const commit = execFileSync(git, ['rev-parse', '--verify', `${options.rev}^{commit}`], {
        cwd: MAIN_ROOT,
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      tempRoot = makeTempWorktreePath();
      mkdirSync(tempRoot, { recursive: true });
      log(`creating temporary worktree ${tempRoot} at ${commit.slice(0, 12)} ...`);
      runGit(git, ['worktree', 'add', '--detach', tempRoot, commit]);
      sourceRoot = tempRoot;
      prepareWorktree(sourceRoot);
    } else {
      log('WARNING: --no-worktree builds the current checkout in place; this is a debug path.');
    }

    runProjectBuild(sourceRoot);

    const version = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8')).version;
    if (!version) throw new Error('build source package.json has no version');
    runPortableBuild(sourceRoot, releaseDir, version);

    const outName = `oi-local-judge-${version}-win-x64`;
    const outDir = join(releaseDir, outName);
    emptyDirectoryCheck(outDir);
    const directoryBytes = dirSize(outDir);
    log(`portable directory ready: ${outDir} (${formatSize(directoryBytes)}).`);

    let zip = null;
    if (options.zip) {
      const outZip = join(releaseDir, `${outName}.zip`);
      log(`creating ${outZip} with fflate (level 1, streaming) ...`);
      const zipResult = createZipFromDirectory(outDir, outZip, {
        prefix: outName,
        level: 1,
        log,
      });
      const validation = validateZip(outZip, portableRequiredEntries(outName));
      zip = {
        path: outZip,
        bytes: zipResult.bytes,
        entries: validation.entryCount,
        requiredEntries: validation.requiredCount,
      };
      log(
        `zip ready: ${outZip} (${formatSize(zipResult.bytes)}, ` +
          `${validation.entryCount} entries, ${validation.requiredCount} required entries validated).`,
      );
    }

    summary = {
      version,
      outName,
      outDir,
      directoryBytes,
      zip,
      durationMs: Date.now() - startedAt,
      sourceRoot,
    };
    log(
      `done in ${formatDuration(summary.durationMs)}. ` +
        `Portable: ${formatSize(directoryBytes)}` +
        (zip ? `, ZIP: ${formatSize(zip.bytes)}` : '') +
        '.',
    );
    return summary;
  } finally {
    try {
      if (tempRoot) {
        cleanupWorktree(git, tempRoot, { keep: options.keep });
      }
    } finally {
      lock.release();
      log('released build lock.');
    }
  }
}

function emptyDirectoryCheck(outDir) {
  if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
    throw new Error(`portable build did not create ${outDir}`);
  }
  if (!existsSync(join(outDir, 'OiJudge.exe'))) {
    throw new Error(`portable build created ${outDir} without OiJudge.exe`);
  }
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
    console.error(
      `\n[build-release] ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exitCode = 1;
  }
}
