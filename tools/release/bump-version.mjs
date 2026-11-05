#!/usr/bin/env node
/**
 * Bumps the project version in every tracked manifest and in package-lock.json.
 *
 *   npm run release:bump -- 1.1.0-rc.5
 *   npm run release:bump -- 1.1.0-rc.5 --dry-run
 *
 * Only `version` fields change. Dependency ranges and lockfile dependency
 * entries are left untouched, so this is safe to run before tagging a release.
 * JSON is rewritten with two-space indentation, the file's existing line ending
 * and a trailing newline; nothing is written at all under `--dry-run`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Workspace manifests whose top-level `version` is kept in sync. */
export const VERSIONED_PACKAGE_FILES = [
  'package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'apps/desktop/package.json',
  'packages/shared/package.json',
];

export const LOCKFILE = 'package-lock.json';

/** `packages` entries in package-lock.json that mirror the five manifests. */
export const LOCK_PACKAGE_KEYS = [
  '',
  'apps/server',
  'apps/web',
  'apps/desktop',
  'packages/shared',
];

// Semantic Versioning 2.0.0, including prerelease and build metadata.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validates a release version and returns its trimmed form.
 *
 * Accepts stable versions (`1.2.3`), prereleases (`1.1.0-rc.5`) and build
 * metadata (`1.1.0+build.7`); rejects `1.1`, `v1.1.0`, leading zeros and an
 * empty prerelease/build suffix.
 */
export function validateVersion(version) {
  if (typeof version !== 'string') {
    throw new Error(`invalid semver version: expected a string, got ${typeof version}`);
  }
  const normalized = version.trim();
  if (!SEMVER_PATTERN.test(normalized)) {
    throw new Error(
      `invalid semver version: "${version}" ` +
        '(expected MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD], e.g. 1.1.0-rc.5)',
    );
  }
  return normalized;
}

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${path}: ${errorMessage(error)}`, { cause: error });
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${errorMessage(error)}`, { cause: error });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return { raw, data };
}

function serializeJson(data, source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return `${JSON.stringify(data, null, 2).replace(/\n/g, eol)}${eol}`;
}

function writeJson(path, text) {
  try {
    writeFileSync(path, text, 'utf8');
  } catch (error) {
    throw new Error(`cannot write ${path}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * Updates the five manifests and the matching package-lock.json entries.
 *
 * All files are read and validated before the first write, so a malformed
 * manifest leaves the checkout untouched. Returns a summary of the planned or
 * applied changes. `dryRun` reports the same summary without writing anything.
 *
 * @param {string} root repository root
 * @param {string} version new semver version
 * @param {{ dryRun?: boolean }} [options]
 */
export function bumpVersionFiles(root, version, { dryRun = false } = {}) {
  const targetVersion = validateVersion(version);
  const updates = [];
  const changes = [];

  for (const relativePath of VERSIONED_PACKAGE_FILES) {
    const path = join(root, relativePath);
    const { raw, data } = readJson(path);
    if (typeof data.version !== 'string' || data.version.trim() === '') {
      throw new Error(`${relativePath} has no "version" string; refusing to bump it`);
    }

    const oldVersion = data.version;
    data.version = targetVersion;
    updates.push({ path, text: serializeJson(data, raw) });
    changes.push({ path: relativePath, oldVersion, newVersion: targetVersion });
  }

  const lockPath = join(root, LOCKFILE);
  const { raw: lockRaw, data: lock } = readJson(lockPath);
  if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    throw new Error(`${LOCKFILE} has no "packages" object; cannot update workspace versions`);
  }

  const lockEntries = [];
  for (const key of LOCK_PACKAGE_KEYS) {
    const entry = lock.packages[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${LOCKFILE} is missing packages[${JSON.stringify(key)}]`);
    }
    if (typeof entry.version !== 'string' || entry.version.trim() === '') {
      throw new Error(
        `${LOCKFILE} packages[${JSON.stringify(key)}] has no "version" string; refusing to bump it`,
      );
    }

    const oldVersion = entry.version;
    entry.version = targetVersion;
    lockEntries.push({ key, oldVersion, newVersion: targetVersion });
  }

  // Lockfile v3 mirrors the root package version at the top level as well.
  if (typeof lock.version === 'string') {
    lock.version = targetVersion;
  }
  updates.push({ path: lockPath, text: serializeJson(lock, lockRaw) });

  if (!dryRun) {
    for (const update of updates) {
      writeJson(update.path, update.text);
    }
  }

  return {
    version: targetVersion,
    dryRun,
    changes,
    lock: { path: LOCKFILE, entries: lockEntries },
  };
}

/** Parses `bump-version.mjs` arguments. Throws on unknown flags and extra values. */
export function parseBumpArgs(argv = []) {
  const options = { version: null, dryRun: false, help: false };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown argument: ${arg}`);
    } else if (options.version === null) {
      options.version = arg;
    } else {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
  }

  if (!options.help && options.version === null) {
    throw new Error('missing <version> argument (e.g. release:bump -- 1.1.0-rc.5)');
  }
  if (options.version !== null && !options.help) {
    options.version = validateVersion(options.version);
  }
  return options;
}

function printUsage(log = console.log) {
  log(
    [
      'Usage: npm run release:bump -- <version> [--dry-run]',
      '',
      'Updates the root, apps/server, apps/web, apps/desktop and packages/shared',
      'version fields plus the matching package-lock.json entries.',
      '',
      'Options:',
      '  --dry-run  print the planned changes without writing files',
      '  --help     show this help',
    ].join('\n'),
  );
}

/**
 * CLI entry point. Throws on failure; the direct-run wrapper below reports the
 * error and exits non-zero so a bad version never leaves a silent partial bump.
 */
export function main(argv = process.argv.slice(2), { root = MAIN_ROOT, log = console.log } = {}) {
  const options = parseBumpArgs(argv);
  if (options.help) {
    printUsage(log);
    return null;
  }

  const result = bumpVersionFiles(root, options.version, { dryRun: options.dryRun });
  const verb = result.dryRun ? 'would update' : 'updated';

  for (const change of result.changes) {
    log(`[bump-version] ${verb} ${change.path}: ${change.oldVersion} -> ${change.newVersion}`);
  }
  for (const entry of result.lock.entries) {
    log(
      `[bump-version] ${verb} ${result.lock.path} packages[${JSON.stringify(entry.key)}]: ` +
        `${entry.oldVersion} -> ${entry.newVersion}`,
    );
  }
  log(
    `[bump-version] ${result.dryRun ? 'dry run, no files written;' : 'done;'} ` +
      `version ${result.version} in ${result.changes.length} manifests and package-lock.json.`,
  );
  return result;
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
      `\n[bump-version] ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exitCode = 1;
  }
}
