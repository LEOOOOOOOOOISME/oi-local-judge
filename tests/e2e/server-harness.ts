import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Playwright E2E 共用的真实 server 启动/清理工具。
 *
 * 前置：先 `npm run build`（需要 apps/server/dist/cli.js 与 apps/web/dist）。
 * 每个 spec 使用自己的端口与临时数据目录；测试结束后整个进程树会被清理。
 */

export const SERVER_ENTRY = join(process.cwd(), 'apps/server/dist/cli.js');

/** Fixed E2E administrator, created through OIJ_ADMIN_PASSWORD. */
export const E2E_ADMIN_USERNAME = 'admin';
export const E2E_ADMIN_PASSWORD = 'E2e-Admin-Pass-2026';

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 尝试连接端口：连得上说明被占用。 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1500, () => finish(false));
  });
}

/** Windows 下查出监听端口的 PID，便于报告占用者。 */
export function findWindowsPortOwners(port: number): number[] {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('netstat', ['-ano', '-p', 'TCP'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return [];
  const pids = new Set<number>();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.includes(`:${port}`) || !line.toUpperCase().includes('LISTENING')) continue;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) return true;
    await delay(200);
  }
  return false;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Windows 上文件可能短时间被占用，删除临时数据目录时重试。 */
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await delay(200);
    }
  }
}

export interface StartTestServerOptions {
  port: number;
  /** 系统临时目录前缀，便于识别残留目录。 */
  dataDirPrefix: string;
  /** 追加/覆盖传给 server 进程的环境变量。 */
  env?: Record<string, string>;
  /** 启动健康检查的超时时间。 */
  healthTimeoutMs?: number;
}

export interface TestServer {
  readonly baseUrl: string;
  readonly port: number;
  readonly dataDir: string;
  /** server stdout/stderr 累计日志，启动失败时用于报告。 */
  getLog(): string;
  stop(): Promise<void>;
}

/**
 * 启动一个真实的 OiJudge server：临时 dataDir + 指定端口。
 * 端口被占用时直接失败并报告 PID（不要误杀不相干进程）。
 */
export async function startTestServer(options: StartTestServerOptions): Promise<TestServer> {
  const {
    port,
    dataDirPrefix,
    env,
    healthTimeoutMs = 30_000,
  } = options;
  const baseUrl = `http://127.0.0.1:${port}`;

  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `missing ${SERVER_ENTRY}; run "npm run build" before the browser E2E test`,
    );
  }

  if (await isPortInUse(port)) {
    const owners = findWindowsPortOwners(port);
    const ownerText = owners.length > 0 ? ` (pid ${owners.join(', ')})` : '';
    throw new Error(
      `port ${port} is already in use${ownerText}; ` +
        `stop that process (taskkill /PID <pid> /T /F) or free the port before running the browser E2E test`,
    );
  }

  const dataDir = mkdtempSync(join(tmpdir(), dataDirPrefix));
  let log = '';
  let stopped = false;
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OIJ_DATA_DIR: dataDir,
      OIJ_HOST: '127.0.0.1',
      OIJ_PORT: String(port),
      OIJ_ADMIN_USERNAME: E2E_ADMIN_USERNAME,
      OIJ_ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  child.on('error', (error) => {
    log += `\n[spawn error] ${error.message}`;
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) {
      if (process.platform === 'win32' && child.pid) {
        // node 会派生子进程（评测/定时任务），必须连同进程树一起结束。
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
        await waitForExit(child, 5000);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      await waitForExit(child, 10_000);
    }
    await waitForPortFree(port, 10_000);
    await removeDir(dataDir);
  };

  const tryHealth = async (): Promise<void> => {
    const deadline = Date.now() + healthTimeoutMs;
    let lastError = 'no response yet';
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `server exited with code ${child.exitCode} before /api/health was ready.\n${log}`,
        );
      }
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) {
          const body = (await response.json()) as { ok?: boolean };
          if (body.ok === true) return;
        }
        lastError = `GET /api/health responded ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(200);
    }
    throw new Error(
      `server did not become healthy within ${healthTimeoutMs}ms (${lastError}).\n${log}`,
    );
  };

  try {
    await tryHealth();
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    baseUrl,
    port,
    dataDir,
    getLog: () => log,
    stop,
  };
}
