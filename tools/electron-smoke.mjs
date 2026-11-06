#!/usr/bin/env node
/**
 * End-to-end desktop startup smoke test.
 *
 *   node tools/electron-smoke.mjs                # packaged build if present, else dev
 *   node tools/electron-smoke.mjs --dev          # electron + apps/desktop/dist/main.js
 *   node tools/electron-smoke.mjs --app release/oi-local-judge-1.1.0-rc.6-win-x64
 *   node tools/electron-smoke.mjs --electron <electron.exe> --dev
 *
 * The test launches the real desktop app with an isolated userData directory
 * (`OIJ_DESKTOP_USER_DATA`), waits for `desktop.log` to report the server port
 * and the loaded window, then checks /api/health over both loopback and the
 * detected LAN address before terminating the process tree.
 *
 * Exit code 0 means: window loaded, server started, /api/health 200 locally and
 * over the LAN address. The app is always killed, even on failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { get as httpGetRaw } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { dev: false, app: null, electron: null, flags: null, timeoutMs: 90_000, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dev') options.dev = true;
    else if (arg === '--app') options.app = argv[++i];
    else if (arg === '--electron') options.electron = argv[++i];
    else if (arg === '--flags') options.flags = argv[++i];
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]) * 1000;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function log(message) {
  console.log(`[electron-smoke] ${message}`);
}

function fail(message, detail) {
  console.error(`\n[electron-smoke] FAIL: ${message}`);
  if (detail) console.error(detail);
  process.exitCode = 1;
}

/** Newest release/oi-local-judge-*-win-x64 directory, if any. */
function latestReleaseDir() {
  const releaseRoot = join(REPO_ROOT, 'release');
  if (!existsSync(releaseRoot)) return null;
  const candidates = readdirSync(releaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^oi-local-judge-.*-win-x64$/.test(entry.name))
    .map((entry) => join(releaseRoot, entry.name))
    .filter((dir) => existsSync(join(dir, 'OiJudge.exe')))
    .sort((a, b) => (a < b ? 1 : -1));
  return candidates[0] ?? null;
}

function electronFromNodeModules() {
  const dist = join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  return existsSync(dist) ? dist : null;
}

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolvePromise, reject) => {
    const request = httpGetRaw(url, { timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolvePromise({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    request.on('error', reject);
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  }
}

function tail(text, limit = 4000) {
  return text.length > limit ? text.slice(-limit) : text;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node tools/electron-smoke.mjs [--dev] [--app <dir>] [--electron <exe>] [--flags "<flags>"] [--timeout <seconds>]');
    return;
  }

  const packagedDir = options.app ? resolve(options.app) : options.dev ? null : latestReleaseDir();
  const packaged = Boolean(packagedDir);
  const executable = packaged ? join(packagedDir, 'OiJudge.exe') : options.electron ?? electronFromNodeModules();
  if (!executable || !existsSync(executable)) {
    fail(
      'no Electron executable found',
      packaged
        ? `expected ${executable}`
        : 'run `npm install` (node_modules/electron/dist) or pass --electron <path>.',
    );
    return;
  }

  const devMain = join(REPO_ROOT, 'apps', 'desktop', 'dist', 'main.js');
  if (!packaged && !existsSync(devMain)) {
    fail(`dev entry point is missing: ${devMain}`, 'run `npm run build` first.');
    return;
  }
  if (packaged && !existsSync(join(packagedDir, 'resources', 'app', 'apps', 'desktop', 'dist', 'main.js'))) {
    fail(`packaged app is incomplete: ${packagedDir}`, 'run `npm run build:portable` / `npm run build:release`.');
    return;
  }

  const userData = join(REPO_ROOT, 'runtime', `electron-smoke-${Date.now()}-${process.pid}`);
  mkdirSync(userData, { recursive: true });
  const logPath = join(userData, 'logs', 'desktop.log');

  // A sandboxed CI/agent host needs --no-sandbox for Electron's browser process.
  const flags =
    options.flags ??
    (process.platform === 'win32'
      ? '--no-sandbox --disable-gpu'
      : '--disable-gpu');
  const args = [...flags.split(/\s+/).filter(Boolean)];
  if (!packaged) args.push(devMain);

  const env = { ...process.env, OIJ_DESKTOP_USER_DATA: userData };
  // DSH sets ELECTRON_RUN_AS_NODE for its own Electron host; leaking it makes
  // the app run as plain Node and crash before any window can appear.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  log(`launch: ${executable} ${args.join(' ')}`);
  log(`userData: ${userData}`);

  const child = spawn(executable, args, {
    cwd: packaged ? packagedDir : REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  let exited = false;
  child.on('exit', (code) => {
    exited = true;
    if (code !== 0) output += `\n[process exited with code ${code}]\n`;
  });

  const deadline = Date.now() + options.timeoutMs;
  let port = null;
  let lanUrl = null;
  let windowLoaded = false;
  let startupComplete = false;
  let lastLog = '';

  try {
    while (Date.now() < deadline) {
      if (existsSync(logPath)) {
        lastLog = readFileSync(logPath, 'utf8');
        const portMatch = lastLog.match(/server ready on port (\d+)/);
        if (portMatch) port = Number(portMatch[1]);
        const lanMatch = lastLog.match(/^.*LAN: (http:\/\/[^\s]+)/m);
        if (lanMatch) lanUrl = lanMatch[1];
        windowLoaded = windowLoaded || lastLog.includes('main window loaded');
        startupComplete = startupComplete || lastLog.includes('startup complete');
      }
      if (port && windowLoaded && startupComplete) break;
      if (exited) {
        fail('the desktop app exited before finishing startup', tail(`${output}\n--- desktop.log ---\n${lastLog}`));
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!port) {
      fail('the server never reported a port', tail(`${output}\n--- desktop.log ---\n${lastLog}`));
      return;
    }
    if (!windowLoaded) {
      fail('the main window never finished loading', tail(`${output}\n--- desktop.log ---\n${lastLog}`));
      return;
    }

    const local = await httpGet(`http://127.0.0.1:${port}/api/health`);
    if (local.status !== 200 || !local.body.includes('"ok":true')) {
      fail(`/api/health returned ${local.status}`, local.body);
      return;
    }
    log(`loopback /api/health -> ${local.status}`);

    const home = await httpGet(`http://127.0.0.1:${port}/`);
    if (home.status !== 200 || !/<div id="root">/.test(home.body)) {
      fail(`/ returned ${home.status} without the web application shell`, tail(home.body, 1000));
      return;
    }
    log(`loopback / -> ${home.status} (web UI served)`);

    if (lanUrl) {
      const lan = await httpGet(`${lanUrl.replace(/\/$/, '')}/api/health`);
      if (lan.status !== 200) {
        fail(`LAN /api/health returned ${lan.status}`, lan.body);
        return;
      }
      log(`LAN ${lanUrl} /api/health -> ${lan.status}`);
    } else {
      log('WARNING: no LAN address was reported; LAN reachability not exercised.');
    }

    log('PASS: window loaded, server started, web UI served, /api/health 200.');
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), tail(`${output}\n--- desktop.log ---\n${lastLog}`));
  } finally {
    killTree(child.pid);
    await new Promise((r) => setTimeout(r, 1500));
    // Remove only on success; on failure the log is the evidence.
    if (!process.exitCode && !options.keep) {
      try {
        rmSync(userData, { recursive: true, force: true });
      } catch {
        // Leaving one temporary directory is harmless.
      }
    } else if (process.exitCode) {
      console.error(`[electron-smoke] kept diagnostics: ${userData}`);
    }
  }
}

main().catch((error) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
