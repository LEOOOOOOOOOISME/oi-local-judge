#!/usr/bin/env node
/**
 * Stamps build/icon.ico into the portable OiJudge.exe before electron-builder
 * archives it.
 *
 * electron-builder is invoked with `--prepackaged`, and in that mode it skips
 * `doPack()` entirely — including the rcedit/resedit step that normally writes
 * `win.icon` into the application executable. Without this step the installed
 * OiJudge.exe (and therefore the desktop/Start Menu shortcuts and the packaged
 * window icon) would still show the Electron logo while the NSIS installer,
 * uninstaller and header use the custom icon.
 *
 * Usage:
 *   node build/installer/stamp-exe-icon.mjs
 *   node build/installer/stamp-exe-icon.mjs --prepackaged release/oi-local-judge-1.1.0-win-x64
 *
 * The script is best effort: if resedit (a transitive dependency of
 * electron-builder) or the prepackaged directory is unavailable, it prints a
 * warning and exits 0 so the installer build itself is never blocked by the
 * icon step. It never claims the icon was applied when it was not.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASE_DIR = join(ROOT, 'release');
const ICON_PATH = join(ROOT, 'build', 'icon.ico');

function log(message) {
  console.log(`[stamp-exe-icon] ${message}`);
}

function warn(message) {
  console.warn(`[stamp-exe-icon] WARNING: ${message}`);
}

function parseArgs(argv) {
  const options = { prepackaged: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--prepackaged') options.prepackaged = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else warn(`unknown argument ignored: ${argv[i]}`);
  }
  return options;
}

/** Newest release/oi-local-judge-*-win-x64 directory with a packaged app. */
function latestPortable() {
  if (!existsSync(RELEASE_DIR)) return null;
  const candidates = readdirSync(RELEASE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^oi-local-judge-.*-win-x64$/.test(entry.name))
    .map((entry) => join(RELEASE_DIR, entry.name))
    .filter(
      (dir) =>
        existsSync(join(dir, 'OiJudge.exe')) &&
        existsSync(join(dir, 'resources', 'app', 'apps', 'desktop', 'dist', 'main.js')),
    )
    .sort((a, b) => (a < b ? 1 : -1));
  return candidates[0] ?? null;
}

async function loadResedit() {
  try {
    // require() (not import()) so NODE_PATH is honored when the dependency
    // tree lives outside this checkout, e.g. a shared node_modules junction.
    return require('resedit');
  } catch (error) {
    warn(
      'resedit is not installed, so the custom exe icon was not applied. ' +
        'Run `npm install` (electron-builder brings resedit) and rebuild the installer.',
    );
    log(`resedit require failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function stampExe(exePath, resedit) {
  const { NtExecutable, NtExecutableResource, Data, Resource } = resedit;
  const { VersionInfo } = Resource;
  const executable = NtExecutable.from(await readFile(exePath));
  const resources = NtExecutableResource.from(executable);
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  const iconFile = Data.IconFile.from(await readFile(ICON_PATH));
  const icons = iconFile.icons.map((icon) => icon.data);
  if (icons.length === 0) throw new Error(`${ICON_PATH} contains no icons`);
  const group = groups[0];
  Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    group ? group.id : 1,
    group ? group.lang : 0x0409,
    icons,
  );

  // --prepackaged skips electron-builder's version-resource step too, leaving
  // the file properties as "Electron". Write OiJudge's own metadata here.
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const version = String(packageJson.version ?? '').replace(/-.*$/, '');
  const versions = VersionInfo.fromEntries(resources.entries);
  const versionInfo =
    versions[0] ??
    VersionInfo.create(0x0409, {}, [{ lang: 0x0409, codepage: 1200, values: {} }]);
  versionInfo.setFileVersion(version);
  versionInfo.setProductVersion(version);
  versionInfo.setStringValues(
    versionInfo.getAllLanguagesForStringValues()[0] ?? { lang: 0x0409, codepage: 1200 },
    {
      CompanyName: 'OiJudge Team',
      FileDescription: 'OiJudge',
      FileVersion: version,
      InternalName: 'OiJudge',
      LegalCopyright: 'Copyright 2026 OiJudge Team',
      OriginalFilename: 'OiJudge.exe',
      ProductName: 'OiJudge',
      ProductVersion: version,
    },
  );
  versionInfo.outputToResourceEntries(resources.entries);

  resources.outputResource(executable);
  await writeFile(exePath, Buffer.from(executable.generate()));
  return icons.length;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: node build/installer/stamp-exe-icon.mjs [--prepackaged <portable dir>]');
    return;
  }
  if (!existsSync(ICON_PATH)) {
    warn(`${ICON_PATH} does not exist; skipping the exe icon step.`);
    return;
  }
  const portable = options.prepackaged ? resolve(ROOT, options.prepackaged) : latestPortable();
  if (!portable) {
    warn('no prepackaged portable directory found; skipping the exe icon step.');
    return;
  }
  const exePath = join(portable, 'OiJudge.exe');
  if (!existsSync(exePath)) {
    warn(`${exePath} does not exist; skipping the exe icon step.`);
    return;
  }
  const resedit = await loadResedit();
  if (!resedit) return;

  const count = await stampExe(exePath, resedit);
  log(`applied ${count} icon image(s) from ${ICON_PATH} to ${exePath}`);
}

main().catch((error) => {
  warn(`could not apply the exe icon: ${error instanceof Error ? error.message : String(error)}`);
});
