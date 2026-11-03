/**
 * Argument parsing for the release build tooling.
 *
 * Kept dependency-free and side-effect free so the release tests can import
 * these helpers without creating a worktree, a lock file or a build.
 */
import { existsSync } from 'node:fs';

/** Conventional Git for Windows location; prefer it over a PATH lookup. */
export const DEFAULT_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';

function takeValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value === '' || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function valueAfterEquals(arg, prefix) {
  const value = arg.slice(prefix.length);
  if (!value) throw new Error(`${prefix.replace(/=$/, '')} requires a value`);
  return value;
}

/**
 * Parses `tools/release/build-release.mjs` arguments.
 *
 * Defaults: build `HEAD` through a temporary worktree, create the ZIP, keep
 * neither the worktree nor the temporary directory.
 */
export function parseReleaseArgs(argv = []) {
  const options = {
    rev: 'HEAD',
    zip: true,
    worktree: true,
    keep: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--rev') {
      options.rev = takeValue(argv, index + 1, '--rev');
      index += 1;
    } else if (arg.startsWith('--rev=')) {
      options.rev = valueAfterEquals(arg, '--rev=');
    } else if (arg === '--zip') {
      options.zip = true;
    } else if (arg === '--no-zip') {
      options.zip = false;
    } else if (arg === '--no-worktree') {
      options.worktree = false;
    } else if (arg === '--keep') {
      options.keep = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (typeof options.rev !== 'string' || options.rev.trim() === '') {
    throw new Error('--rev must not be empty');
  }
  options.rev = options.rev.trim();
  return options;
}

/**
 * Parses `tools/build-portable.mjs` arguments.
 *
 * `--zip` remains available for direct/offline use; `build:release` creates
 * the archive itself so it can validate it before publishing.
 */
export function parsePortableArgs(argv = []) {
  const options = {
    source: null,
    releaseDir: null,
    version: null,
    zip: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--source') {
      options.source = takeValue(argv, index + 1, '--source');
      index += 1;
    } else if (arg.startsWith('--source=')) {
      options.source = valueAfterEquals(arg, '--source=');
    } else if (arg === '--release-dir') {
      options.releaseDir = takeValue(argv, index + 1, '--release-dir');
      index += 1;
    } else if (arg.startsWith('--release-dir=')) {
      options.releaseDir = valueAfterEquals(arg, '--release-dir=');
    } else if (arg === '--version') {
      options.version = takeValue(argv, index + 1, '--version');
      index += 1;
    } else if (arg.startsWith('--version=')) {
      options.version = valueAfterEquals(arg, '--version=');
    } else if (arg === '--zip') {
      options.zip = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  for (const [flag, value] of [
    ['--source', options.source],
    ['--release-dir', options.releaseDir],
    ['--version', options.version],
  ]) {
    if (value !== null && String(value).trim() === '') {
      throw new Error(`${flag} must not be empty`);
    }
  }
  return options;
}

/**
 * Resolves the Git executable without touching the network or the repository.
 *
 * Order: `OIJ_GIT`, the conventional Git for Windows install, then `git` from
 * PATH. An explicitly configured but missing executable is a hard error so a
 * typo cannot silently fall back to a different Git installation.
 */
export function resolveGit({
  env = process.env,
  exists = existsSync,
  defaultGit = DEFAULT_GIT,
} = {}) {
  const configured = env.OIJ_GIT;
  if (configured) {
    if (!exists(configured)) {
      throw new Error(`OIJ_GIT points to a missing Git executable: ${configured}`);
    }
    return configured;
  }
  return exists(defaultGit) ? defaultGit : 'git';
}
