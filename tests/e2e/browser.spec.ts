import { test, expect } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 浏览器验收：不依赖 Electron，直接启动真实 server，用 Chromium 走一遍
 * 登录 + 帮助 + 系统运维 + 班级 + 训练计划 + 学习统计页面。
 *
 * 前置：先 `npm run build`（需要 apps/server/dist/cli.js 与 apps/web/dist）。
 * 固定端口 8899，数据目录使用系统临时目录，测试结束后整个进程树会被清理。
 */

const PORT = 8899;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123';
const SERVER_ENTRY = join(process.cwd(), 'apps/server/dist/cli.js');

test.use({ browserName: 'chromium' });

let server: ChildProcess | null = null;
let dataDir: string | null = null;
let serverLog = '';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 尝试连接端口：连得上说明被占用。 */
function isPortInUse(port: number): Promise<boolean> {
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
function findWindowsPortOwners(port: number): number[] {
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

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response yet';
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) {
      throw new Error(
        `server exited with code ${server.exitCode} before /api/health was ready.\n${serverLog}`,
      );
    }
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
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
    `server did not become healthy within ${timeoutMs}ms (${lastError}).\n${serverLog}`,
  );
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
async function removeDataDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await delay(200);
    }
  }
}

async function stopServer(): Promise<void> {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return;
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

test.beforeAll(async () => {
  expect(
    existsSync(SERVER_ENTRY),
    `missing ${SERVER_ENTRY}; run "npm run build" before the browser E2E test`,
  ).toBe(true);

  if (await isPortInUse(PORT)) {
    const owners = findWindowsPortOwners(PORT);
    const ownerText = owners.length > 0 ? ` (pid ${owners.join(', ')})` : '';
    throw new Error(
      `port ${PORT} is already in use${ownerText}; ` +
        `stop that process (taskkill /PID <pid> /T /F) or free the port before running the browser E2E test`,
    );
  }

  dataDir = mkdtempSync(join(tmpdir(), 'oij-browser-e2e-'));
  server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OIJ_DATA_DIR: dataDir,
      OIJ_HOST: '127.0.0.1',
      OIJ_PORT: String(PORT),
      OIJ_ADMIN_USERNAME: ADMIN_USERNAME,
      OIJ_ADMIN_PASSWORD: ADMIN_PASSWORD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.stdout?.on('data', (chunk: Buffer) => {
    serverLog += chunk.toString();
  });
  server.stderr?.on('data', (chunk: Buffer) => {
    serverLog += chunk.toString();
  });
  server.on('error', (error) => {
    serverLog += `\n[spawn error] ${error.message}`;
  });

  await waitForHealth(30_000);
});

test.afterAll(async () => {
  await stopServer();
  await waitForPortFree(PORT, 10_000);
  if (dataDir) {
    await removeDataDir(dataDir);
    dataDir = null;
  }
});

test('admin can log in and open help, system, class, training and learning pages', async ({
  page,
}) => {
  const httpErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 500) {
      httpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  const expectNoHttpErrors = () => {
    expect(httpErrors, `unexpected 5xx responses: ${httpErrors.join('; ')}`).toEqual([]);
  };

  await test.step('登录页通过表单登录 admin/admin123', async () => {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle('OiJudge · 本地 OI 评测');
    await expect(page.locator('.login-brand')).toContainText('OiJudge');

    await page.getByPlaceholder('用户名').fill(ADMIN_USERNAME);
    await page.getByPlaceholder('密码').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();

    await expect(page).toHaveURL(/\/contests$/, { timeout: 15_000 });
    await expect(page.locator('h1.page-title')).toHaveText('比赛');
    await expect(page.locator('.oij-user-name')).toHaveText('Administrator');
    expectNoHttpErrors();
  });

  await test.step('帮助中心可以打开并渲染文档', async () => {
    await page.goto(`${BASE_URL}/help`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1.page-title')).toHaveText('帮助中心');
    await expect(page.getByPlaceholder('搜索标题、分类或正文')).toBeVisible();
    await expect(page.locator('.help-doc-title')).toBeVisible();
    expectNoHttpErrors();
  });

  await test.step('系统运维页可以打开并完成诊断', async () => {
    await page.goto(`${BASE_URL}/admin/system`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1.page-title')).toHaveText('系统运维');
    await expect(page.getByRole('tab', { name: '诊断' })).toBeVisible();
    await expect(page.getByText('整体状态', { exact: true })).toBeVisible({ timeout: 20_000 });
    expectNoHttpErrors();
  });

  await test.step('班级页可以打开', async () => {
    await page.goto(`${BASE_URL}/classes`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1.page-title')).toHaveText('班级');
    await expect(page.getByRole('button', { name: '创建班级' })).toBeVisible();
    await expect(page.getByRole('button', { name: '刷新' })).toBeVisible();
    expectNoHttpErrors();
  });

  await test.step('训练计划页可以打开', async () => {
    await page.goto(`${BASE_URL}/training-plans`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1.page-title')).toHaveText('训练计划');
    await expect(page.getByRole('button', { name: '创建训练计划' })).toBeVisible();
    expectNoHttpErrors();
  });

  await test.step('学习统计页可以通过导航打开', async () => {
    await page.getByRole('link', { name: '我的学习' }).click();
    await expect(page).toHaveURL(/\/students\/\d+\/learning$/);
    await expect(page.locator('h1.page-title')).toContainText('学习统计');
    await expect(page.getByText('学习概览', { exact: true })).toBeVisible({ timeout: 20_000 });
    expectNoHttpErrors();
  });

  expect(pageErrors, `uncaught page errors: ${pageErrors.join('; ')}`).toEqual([]);
});
