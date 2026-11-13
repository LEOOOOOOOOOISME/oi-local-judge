import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { join } from 'node:path';
import { readPersistedSettings } from './services/settings.js';
import { loadOrCreateSessionSecret } from './services/secrets.js';

export type WorkerIsolationMode = 'optional' | 'required';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  judgeConcurrency: number;
  gxx: string;
  runnerPath: string;
  interactRunnerPath: string;
  adminUsername: string;
  /** Explicit bootstrap password only (OIJ_ADMIN_PASSWORD); never a default. */
  adminPassword?: string;
  sessionSecret: string;
  sessionTtlSec: number;
  /** Optional built-in HTTPS listener. Both files must be provided together. */
  tlsCertPath?: string;
  tlsKeyPath?: string;
  /** Mark the session cookie Secure (TLS directly or a trusted reverse proxy). */
  secureCookies?: boolean;
  /** optional = run as the service account when no worker account is configured. */
  workerIsolation?: WorkerIsolationMode;
  /** Low-privilege Windows account used by the native runner for contestant code. */
  workerUser?: string;
  workerPassword?: string;
}

export function detectGxx(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OIJ_GXX && existsSync(env.OIJ_GXX)) return env.OIJ_GXX;

  const places = [
    join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages'),
    join(env['ProgramFiles'] ?? 'C:\\Program Files', 'WinLibs', 'mingw64', 'bin', 'g++.exe'),
    'C:\\Program Files (x86)\\Dev-Cpp\\MinGW64\\bin\\g++.exe',
  ];
  const winGetDir = places[0];
  if (winGetDir && existsSync(winGetDir)) {
    for (const name of readdirSync(winGetDir)) {
      if (!name.includes('WinLibs')) continue;
      const candidate = join(winGetDir, name, 'mingw64', 'bin', 'g++.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of places.slice(1)) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return 'g++';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Keep development/runtime data inside the repository when the server is
  // launched from the project root. This avoids writes under %LOCALAPPDATA%,
  // which may be blocked by sandbox/AV policies for the native runner.
  let dataDir = env.OIJ_DATA_DIR;
  if (!dataDir) {
    const packagePath = join(process.cwd(), 'package.json');
    let repoRoot: string | null = null;
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: string };
        if (pkg.name === 'oi-local-judge') repoRoot = process.cwd();
      } catch {
        repoRoot = null;
      }
    }
    dataDir = repoRoot
      ? join(repoRoot, 'runtime')
      : join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OiJudge');
  }

  // Priority: explicit environment variable > persisted settings.json > default.
  // The data directory must be known first so the settings file can be located.
  const persisted = readPersistedSettings(dataDir);
  const defaultConcurrency = Math.min(4, cpus().length);
  // Loopback by default: a fresh install must not expose the OJ (and its data)
  // to the LAN until the operator explicitly opts in with OIJ_HOST=0.0.0.0,
  // OIJ_LAN=1, or the installer's LAN switch. OIJ_LAN is honoured here (not
  // only in the desktop launcher) so CLI and desktop behave identically.
  const lanRequested = env.OIJ_LAN === '1' || env.OIJ_LAN === 'true';
  const host = env.OIJ_HOST ?? (lanRequested ? '0.0.0.0' : (persisted.host ?? '127.0.0.1'));
  const tlsCertPath = env.OIJ_TLS_CERT;
  const tlsKeyPath = env.OIJ_TLS_KEY;
  if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath)) {
    throw new Error('OIJ_TLS_CERT and OIJ_TLS_KEY must be provided together');
  }
  if (tlsCertPath && !existsSync(tlsCertPath)) {
    throw new Error(`OIJ_TLS_CERT does not exist: ${tlsCertPath}`);
  }
  if (tlsKeyPath && !existsSync(tlsKeyPath)) {
    throw new Error(`OIJ_TLS_KEY does not exist: ${tlsKeyPath}`);
  }
  const secureCookies =
    Boolean(tlsCertPath && tlsKeyPath) ||
    env.OIJ_COOKIE_SECURE === '1' ||
    env.OIJ_COOKIE_SECURE === 'true';
  const workerFile = readWorkerFile(dataDir);
  const workerIsolation = resolveWorkerIsolationMode(env);
  const workerUser = env.OIJ_WORKER_USER?.trim() || workerFile.user || undefined;
  const workerPassword = env.OIJ_WORKER_PASSWORD ?? workerFile.password;
  return {
    host,
    port: Number(env.OIJ_PORT ?? persisted.port ?? 8787),
    dataDir,
    judgeConcurrency: Math.max(
      1,
      Number(env.OIJ_JUDGE_CONCURRENCY ?? persisted.judgeConcurrency ?? defaultConcurrency),
    ),
    gxx: env.OIJ_GXX !== undefined ? detectGxx(env) : (persisted.gxx ?? detectGxx(env)),
    runnerPath: env.OIJ_RUNNER ?? join(process.cwd(), 'native/runner/out/ojrunner.exe'),
    interactRunnerPath:
      env.OIJ_INTERACT_RUNNER ?? join(process.cwd(), 'native/interact/out/ojinteract.exe'),
    adminUsername: env.OIJ_ADMIN_USERNAME ?? 'admin',
    adminPassword: env.OIJ_ADMIN_PASSWORD,
    // Generated/persisted on first start; the legacy default is migrated.
    sessionSecret: loadOrCreateSessionSecret(dataDir, env).secret,
    sessionTtlSec: Number(env.OIJ_SESSION_TTL ?? persisted.sessionTtlSec ?? 8 * 3600),
    ...(tlsCertPath && tlsKeyPath ? { tlsCertPath, tlsKeyPath } : {}),
    secureCookies,
    workerIsolation,
    workerUser,
    workerPassword,
  };
}

export function ensureDataDirs(dataDir: string): void {
  for (const name of ['db', 'problems', 'submissions', 'tmp', 'logs']) {
    mkdirSync(join(dataDir, name), { recursive: true });
  }
}

interface WorkerFile {
  username?: unknown;
  user?: unknown;
  password?: unknown;
}

/** Reads the installer-managed worker credentials (ACL-protected worker.json). */
function readWorkerFile(dataDir: string): { user?: string; password?: string } {
  const file = join(dataDir, 'worker.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as WorkerFile;
    const user =
      typeof parsed.username === 'string'
        ? parsed.username
        : typeof parsed.user === 'string'
          ? parsed.user
          : undefined;
    return {
      user: user?.trim() || undefined,
      password: typeof parsed.password === 'string' ? parsed.password : undefined,
    };
  } catch {
    return {};
  }
}

export function resolveWorkerIsolationMode(
  env: NodeJS.ProcessEnv = process.env,
): Config['workerIsolation'] {
  const raw = env.OIJ_WORKER_ISOLATION;
  if (raw === undefined || raw === '') return 'optional';
  if (raw === 'optional' || raw === 'required') return raw;
  // An unknown value must not silently disable isolation.
  throw new Error(`OIJ_WORKER_ISOLATION must be "optional" or "required" (got "${raw}")`);
}

/**
 * Returns a startup error when worker isolation is required but impossible.
 * The caller must refuse to start (fail closed) instead of running contestant
 * code as the service account.
 */
export function workerIsolationIssue(config: Config): string | null {
  const hasUser = typeof config.workerUser === 'string' && config.workerUser.length > 0;
  const hasPassword =
    typeof config.workerPassword === 'string' && config.workerPassword.length > 0;
  if (hasUser !== hasPassword) {
    return 'OIJ_WORKER_USER and OIJ_WORKER_PASSWORD must be provided together';
  }
  if (config.workerIsolation === 'required' && !hasUser) {
    return (
      'OIJ_WORKER_ISOLATION=required but no worker credentials are configured; ' +
      'run install.ps1 -WorkerIsolation or set OIJ_WORKER_USER/OIJ_WORKER_PASSWORD (or worker.json)'
    );
  }
  return null;
}
