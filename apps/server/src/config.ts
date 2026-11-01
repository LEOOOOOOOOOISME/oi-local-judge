import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  judgeConcurrency: number;
  gxx: string;
  runnerPath: string;
  interactRunnerPath: string;
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  sessionTtlSec: number;
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
  return {
    host: env.OIJ_HOST ?? '0.0.0.0',
    port: Number(env.OIJ_PORT ?? 8787),
    dataDir,
    judgeConcurrency: Math.max(1, Number(env.OIJ_JUDGE_CONCURRENCY ?? 2)),
    gxx: detectGxx(env),
    runnerPath: env.OIJ_RUNNER ?? join(process.cwd(), 'native/runner/out/ojrunner.exe'),
    interactRunnerPath:
      env.OIJ_INTERACT_RUNNER ?? join(process.cwd(), 'native/interact/out/ojinteract.exe'),
    adminUsername: env.OIJ_ADMIN_USERNAME ?? 'admin',
    adminPassword: env.OIJ_ADMIN_PASSWORD ?? 'admin123',
    sessionSecret: env.OIJ_SESSION_SECRET ?? 'dev-only-change-me',
    sessionTtlSec: Number(env.OIJ_SESSION_TTL ?? 8 * 3600),
  };
}

export function ensureDataDirs(dataDir: string): void {
  for (const name of ['db', 'problems', 'submissions', 'tmp', 'logs']) {
    mkdirSync(join(dataDir, name), { recursive: true });
  }
}
