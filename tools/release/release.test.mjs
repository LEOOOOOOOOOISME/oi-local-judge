import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { parsePortableArgs, parseReleaseArgs, resolveGit } from './args.mjs';
import { acquireBuildLock, isProcessAlive, releaseBuildLock } from './lock.mjs';
import {
  collectZipEntries,
  createZipFromDirectory,
  readZipCentralDirectory,
  validateZip,
} from './zip.mjs';
import { ensureSharedPackageBuilt, makeTempWorktreePath, resolveTscScript } from './build-release.mjs';
import { portableRequiredEntries } from '../build-portable.mjs';

const temporaryDirectories = [];

function makeTemporaryDirectory(prefix = 'oij-release-test-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('parseReleaseArgs', () => {
  it('uses safe defaults', () => {
    expect(parseReleaseArgs([])).toEqual({
      rev: 'HEAD',
      zip: true,
      worktree: true,
      keep: false,
      help: false,
    });
  });

  it('parses --rev in both spellings', () => {
    expect(parseReleaseArgs(['--rev', 'v1.2.3']).rev).toBe('v1.2.3');
    expect(parseReleaseArgs(['--rev=v1.2.3']).rev).toBe('v1.2.3');
  });

  it('parses boolean switches', () => {
    const options = parseReleaseArgs(['--no-zip', '--no-worktree', '--keep']);
    expect(options.zip).toBe(false);
    expect(options.worktree).toBe(false);
    expect(options.keep).toBe(true);
  });

  it('rejects missing values and unknown flags', () => {
    expect(() => parseReleaseArgs(['--rev'])).toThrow(/--rev requires a value/);
    expect(() => parseReleaseArgs(['--rev', '--keep'])).toThrow(/--rev requires a value/);
    expect(() => parseReleaseArgs(['--rev='])).toThrow(/--rev requires a value/);
    expect(() => parseReleaseArgs(['--wat'])).toThrow(/unknown argument/);
  });
});

describe('parsePortableArgs', () => {
  it('keeps direct use backward compatible', () => {
    expect(parsePortableArgs([])).toEqual({
      source: null,
      releaseDir: null,
      version: null,
      zip: false,
      help: false,
    });
    expect(parsePortableArgs(['--zip']).zip).toBe(true);
  });

  it('parses source, release dir and version overrides', () => {
    const options = parsePortableArgs([
      '--source',
      'D:\\build\\src',
      '--release-dir=release-out',
      '--version',
      '9.9.9',
    ]);
    expect(options).toMatchObject({
      source: 'D:\\build\\src',
      releaseDir: 'release-out',
      version: '9.9.9',
    });
  });

  it('rejects missing values and unknown flags', () => {
    expect(() => parsePortableArgs(['--source'])).toThrow(/--source requires a value/);
    expect(() => parsePortableArgs(['--version='])).toThrow(/--version requires a value/);
    expect(() => parsePortableArgs(['--nope'])).toThrow(/unknown argument/);
  });
});

describe('resolveGit', () => {
  it('prefers OIJ_GIT and refuses a configured path that does not exist', () => {
    const env = { OIJ_GIT: 'C:\\custom\\git.exe' };
    expect(resolveGit({ env, exists: () => true })).toBe('C:\\custom\\git.exe');
    expect(() => resolveGit({ env, exists: () => false })).toThrow(/missing Git executable/);
  });

  it('prefers the conventional Git for Windows path over PATH', () => {
    expect(
      resolveGit({
        env: {},
        exists: (path) => path === 'C:\\Program Files\\Git\\cmd\\git.exe',
      }),
    ).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(resolveGit({ env: {}, exists: () => false })).toBe('git');
  });
});

describe('build lock', () => {
  it('writes the owner PID and releases only its own lock', () => {
    const directory = makeTemporaryDirectory();
    const lockPath = join(directory, 'release', '.build.lock');

    const lock = acquireBuildLock(lockPath);
    const payload = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(payload.pid).toBe(process.pid);
    expect(payload.token).toBe(lock.token);

    expect(releaseBuildLock(lockPath, 'not-the-token')).toBe(false);
    expect(existsSync(lockPath)).toBe(true);

    expect(lock.release()).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(lock.release()).toBe(false);
  });

  it('refuses a lock whose owner PID is alive', () => {
    const directory = makeTemporaryDirectory();
    const lockPath = join(directory, '.build.lock');
    acquireBuildLock(lockPath);

    expect(() => acquireBuildLock(lockPath, { isAlive: () => true })).toThrow(/already running/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('removes a stale lock owned by a dead PID', () => {
    const directory = makeTemporaryDirectory();
    const lockPath = join(directory, '.build.lock');
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 424242, token: 'dead-owner', startedAt: '2020-01-01T00:00:00Z' })}\n`,
    );

    const lock = acquireBuildLock(lockPath, { isAlive: () => false });
    const payload = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(payload.token).toBe(lock.token);
    expect(payload.pid).toBe(process.pid);
    expect(lock.release()).toBe(true);
  });

  it('does not steal a fresh unreadable lock, but does remove an old one', () => {
    const directory = makeTemporaryDirectory();
    const lockPath = join(directory, '.build.lock');
    writeFileSync(lockPath, 'corrupt');

    expect(() => acquireBuildLock(lockPath, { staleGraceMs: 60_000 })).toThrow(/unreadable/);

    const lock = acquireBuildLock(lockPath, {
      now: Date.now() + 120_000,
      staleGraceMs: 60_000,
      isAlive: () => false,
    });
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe(lock.token);
    lock.release();
  });

  it('detects live and invalid PIDs', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe('temporary worktree path', () => {
  it('is unique, inside tmpdir and includes the PID', () => {
    const base = join(tmpdir(), 'oij-temp-base');
    const first = makeTempWorktreePath({ base, now: 1_700_000_000_000, pid: 1234 });
    const second = makeTempWorktreePath({ base, now: 1_700_000_000_001, pid: 1234 });

    expect(first.startsWith(base)).toBe(true);
    expect(first).toContain('oij-release-');
    expect(first).toContain('1234');
    expect(first).not.toBe(second);
    expect(first.slice(base.length + 1)).not.toMatch(/[<>:"/\\|?*]/);
  });
});

describe('ensureSharedPackageBuilt', () => {
  const mainRoot = join(tmpdir(), 'oij-main-checkout');
  const sharedRoot = join(mainRoot, 'packages', 'shared');
  const tsconfig = join(sharedRoot, 'tsconfig.json');
  const entry = join(sharedRoot, 'dist', 'index.js');

  it('runs tsc for the shared package in the checkout and returns its entry point', () => {
    const calls = [];
    const built = new Set();
    const result = ensureSharedPackageBuilt({
      mainRoot,
      exists: (path) => path === tsconfig || built.has(path),
      runTsc: (options) => {
        calls.push(options);
        built.add(entry);
      },
      log: () => {},
    });

    expect(result).toBe(entry);
    expect(calls).toEqual([{ mainRoot, tsconfig }]);
  });

  it('fails loudly when the build produces no dist/index.js', () => {
    expect(() =>
      ensureSharedPackageBuilt({
        mainRoot,
        exists: (path) => path === tsconfig,
        runTsc: () => {},
        log: () => {},
      }),
    ).toThrow(/did not produce[\s\S]*dist[\\/]index\.js/);
  });

  it('fails loudly when the shared tsconfig is missing', () => {
    expect(() =>
      ensureSharedPackageBuilt({
        mainRoot,
        exists: () => false,
        runTsc: () => {
          throw new Error('should not run');
        },
        log: () => {},
      }),
    ).toThrow(/cannot find the shared package tsconfig/);
  });

  it('resolves the TypeScript compiler from the checkout and rejects a missing install', () => {
    const tsc = join(mainRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    expect(resolveTscScript({ mainRoot, exists: (path) => path === tsc })).toBe(tsc);
    expect(() => resolveTscScript({ mainRoot, exists: () => false })).toThrow(
      /TypeScript is not installed/,
    );
  });
});

describe('streaming zip', () => {
  function makeSourceTree() {
    const root = makeTemporaryDirectory();
    mkdirSync(join(root, 'nested'), { recursive: true });
    mkdirSync(join(root, 'empty'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<h1>OiJudge</h1>', 'utf8');
    writeFileSync(join(root, 'nested', 'a.txt'), 'alpha', 'utf8');
    writeFileSync(join(root, '启动 OiJudge.cmd'), '@echo off\r\n', 'utf8');
    return root;
  }

  it('lists files and directories under the archive prefix', () => {
    const source = makeSourceTree();
    const names = collectZipEntries(source, 'pkg').map((entry) => entry.name);
    expect(names).toContain('pkg/');
    expect(names).toContain('pkg/index.html');
    expect(names).toContain('pkg/nested/a.txt');
    expect(names).toContain('pkg/empty/');
    expect(names).toContain('pkg/启动 OiJudge.cmd');
  });

  it('writes an atomically renamed zip with a valid central directory', () => {
    const directory = makeTemporaryDirectory();
    const source = makeSourceTree();
    const zipPath = join(directory, 'release.zip');
    writeFileSync(zipPath, 'previous release', 'utf8');

    const result = createZipFromDirectory(source, zipPath, { prefix: 'pkg', level: 1 });
    expect(existsSync(`${zipPath}.tmp`)).toBe(false);
    expect(statSync(zipPath).size).toBeGreaterThan(4);
    expect(result.files).toBe(3);

    const directoryInfo = readZipCentralDirectory(zipPath);
    expect(directoryInfo.totalEntries).toBe(directoryInfo.entries.length);
    expect(directoryInfo.entries.map((entry) => entry.name)).toContain('pkg/启动 OiJudge.cmd');

    const validation = validateZip(zipPath, [
      'pkg/index.html',
      'pkg/nested/a.txt',
      'pkg/启动 OiJudge.cmd',
    ]);
    expect(validation.entryCount).toBe(directoryInfo.entries.length);
    expect(validation.requiredCount).toBe(3);

    const unpacked = unzipSync(readFileSync(zipPath));
    expect(strFromU8(unpacked['pkg/index.html'])).toBe('<h1>OiJudge</h1>');
    expect(strFromU8(unpacked['pkg/nested/a.txt'])).toBe('alpha');
    expect(strFromU8(unpacked['pkg/启动 OiJudge.cmd'])).toBe('@echo off\r\n');
  });

  it('reports missing required entries', () => {
    const directory = makeTemporaryDirectory();
    const source = makeSourceTree();
    const zipPath = join(directory, 'release.zip');
    createZipFromDirectory(source, zipPath, { prefix: 'pkg' });

    expect(() => validateZip(zipPath, ['pkg/index.html', 'pkg/missing.exe'])).toThrow(
      /missing 1 required entry[\s\S]*pkg\/missing\.exe/,
    );
  });

  it('rejects an empty source directory', () => {
    const directory = makeTemporaryDirectory();
    const source = join(directory, 'empty-source');
    mkdirSync(source);
    expect(() => createZipFromDirectory(source, join(directory, 'empty.zip'))).toThrow(
      /refusing to create an empty ZIP/,
    );
  });

  it('rejects a truncated archive', () => {
    const directory = makeTemporaryDirectory();
    const source = makeSourceTree();
    const zipPath = join(directory, 'release.zip');
    createZipFromDirectory(source, zipPath, { prefix: 'pkg' });
    const bytes = readFileSync(zipPath);
    writeFileSync(zipPath, bytes.subarray(0, bytes.length - 30));
    expect(() => readZipCentralDirectory(zipPath)).toThrow(/not a ZIP archive/);
  });
});

describe('portable required entries', () => {
  it('names the executable, launcher, server, web and native artifacts', () => {
    const entries = portableRequiredEntries('oi-local-judge-1.0.0-win-x64');
    expect(entries).toContain('oi-local-judge-1.0.0-win-x64/OiJudge.exe');
    expect(entries).toContain('oi-local-judge-1.0.0-win-x64/启动 OiJudge.cmd');
    expect(entries).toContain(
      'oi-local-judge-1.0.0-win-x64/resources/app/apps/server/dist/cli.js',
    );
    expect(entries).toContain(
      'oi-local-judge-1.0.0-win-x64/resources/app/node_modules/fastify/package.json',
    );
  });
});
