#!/usr/bin/env node
/**
 * 为 README 生成真实界面截图。
 *
 * 流程：
 *   1. 在系统临时目录创建隔离 dataDir（绝不使用 runtime/ 或用户数据）；
 *   2. 用 tests/e2e/demo-seed.ts 写入演示数据（题目/比赛/提交/班级/训练/批量任务）；
 *   3. 启动真实的 apps/server/dist/cli.js（随机管理员密码，仅本次运行有效）；
 *   4. Playwright Chromium 以 1440x900 登录并逐页截图；
 *   5. 校验每张图为 PNG 且尺寸 1440x900，停止服务并删除临时数据。
 *
 * 前置：npm run build（需要 apps/server/dist/cli.js 与 apps/web/dist）。
 * 用法：npm run shots:readme [-- --keep-data] [-- --port 8977]
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', 'assets', 'screenshots');
const SERVER_ENTRY = join(ROOT, 'apps', 'server', 'dist', 'cli.js');
const WEB_ENTRY = join(ROOT, 'apps', 'web', 'dist', 'index.html');
const SEED_SCRIPT = join(ROOT, 'tests', 'e2e', 'demo-seed.ts');
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VIEWPORT = { width: 1440, height: 900 };

function parseArgs(argv) {
  const options = {
    port: Number(process.env.OIJ_SHOTS_PORT ?? 8977),
    keepData: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep-data') options.keepData = true;
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node tools/capture-readme-screenshots.mjs [--port 8977] [--keep-data]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0) {
    throw new Error(`invalid port: ${options.port}`);
  }
  return options;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isPortInUse(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = (inUse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(inUse);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1500, () => finish(false));
  });
}

/** 读取 PNG 的 IHDR，返回宽高；用于校验截图尺寸。 */
function readPngSize(path) {
  const buffer = readFileSync(path);
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) {
    throw new Error(`${path} is not a PNG file`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function waitForHealth(baseUrl, child, getLog, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response yet';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with code ${child.exitCode} before /api/health was ready.\n${getLog()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.ok === true) return;
      }
      lastError = `GET /api/health responded ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms (${lastError}).\n${getLog()}`);
}

async function stopServer(child, log) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
  const deadline = Date.now() + 15_000;
  while (child.exitCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode === null) {
    log('server did not exit in time; killing');
    child.kill('SIGKILL');
    await delay(1000);
  }
}

async function removeDataDir(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await delay(250);
    }
  }
  console.warn(`[warn] could not remove temporary data directory: ${dir}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseUrl = `http://127.0.0.1:${options.port}`;

  for (const [label, path] of [
    ['apps/server/dist/cli.js', SERVER_ENTRY],
    ['apps/web/dist/index.html', WEB_ENTRY],
    ['node_modules/tsx', TSX_CLI],
  ]) {
    if (!existsSync(path)) {
      throw new Error(`missing ${label} (${path}); run "npm run build" before capturing screenshots`);
    }
  }
  if (await isPortInUse(options.port)) {
    throw new Error(
      `port ${options.port} is already in use; stop that process or pass --port <free port>`,
    );
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'oij-readme-shots-'));
  const adminUsername = 'readme-demo-admin';
  const adminPassword = `Demo-${randomBytes(12).toString('base64url')}-2026`;
  const env = {
    ...process.env,
    OIJ_DATA_DIR: dataDir,
    OIJ_HOST: '127.0.0.1',
    OIJ_PORT: String(options.port),
    OIJ_ADMIN_USERNAME: adminUsername,
    OIJ_ADMIN_PASSWORD: adminPassword,
    OIJ_SESSION_SECRET: randomBytes(32).toString('hex'),
    OIJ_RANKING_CACHE_MS: '0',
    OIJ_JUDGE_CONCURRENCY: '1',
  };

  let server = null;
  let serverLog = '';
  const getLog = () => serverLog;
  let browser = null;

  try {
    console.log(`[seed] data directory: ${dataDir}`);
    const seed = spawnSync(process.execPath, [TSX_CLI, SEED_SCRIPT], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (seed.status !== 0) {
      throw new Error(`demo seed failed (exit ${seed.status})\n${seed.stdout ?? ''}\n${seed.stderr ?? ''}`);
    }
    const seedPath = join(dataDir, 'seed.json');
    if (!existsSync(seedPath)) throw new Error(`demo seed did not write ${seedPath}`);
    const seedData = JSON.parse(readFileSync(seedPath, 'utf8'));
    console.log(
      `[seed] contest #${seedData.contestId}, class #${seedData.classId}, plan #${seedData.trainingPlanId}, batch #${seedData.batchJobId}`,
    );

    server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    server.stdout?.on('data', (chunk) => {
      serverLog += chunk.toString();
    });
    server.stderr?.on('data', (chunk) => {
      serverLog += chunk.toString();
    });
    await waitForHealth(baseUrl, server, getLog);
    console.log(`[server] ready at ${baseUrl}`);

    mkdirSync(OUT_DIR, { recursive: true });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light',
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const screenshot = async (name, route, { ready, click, settleMs = 400, scrollTo } = {}) => {
      await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
      if (ready) await page.locator(ready).first().waitFor({ state: 'visible', timeout: 45_000 });
      if (click) {
        const tab = page.getByRole('tab', { name: click, exact: true });
        if (await tab.count()) await tab.first().click();
        else await page.getByText(click, { exact: true }).first().click();
        await delay(500);
      }
      await page.waitForFunction(() => document.fonts?.status === 'loaded').catch(() => {});
      if (scrollTo) {
        const target = scrollTo.last ? page.locator(scrollTo.selector).last() : page.locator(scrollTo.selector).first();
        await target
          .evaluate((element, block) => element.scrollIntoView({ block }), scrollTo.block ?? 'center')
          .catch(() => {});
      }
      await delay(settleMs);
      const path = join(OUT_DIR, name);
      await page.screenshot({ path, type: 'png', fullPage: false });
      const size = readPngSize(path);
      if (size.width !== VIEWPORT.width || size.height !== VIEWPORT.height) {
        throw new Error(
          `${name} is ${size.width}x${size.height}, expected ${VIEWPORT.width}x${VIEWPORT.height}`,
        );
      }
      console.log(`[shot] ${name}  ${route}  ${size.width}x${size.height}`);
      return { file: name, route, width: size.width, height: size.height };
    };

    const captured = [];

    // 1. 登录页：截图后再登录，截图里不含任何凭据。
    captured.push(await screenshot('login.png', '/login', { ready: '.login-brand', settleMs: 600 }));

    await page.getByPlaceholder('用户名').fill(adminUsername);
    await page.getByPlaceholder('密码').fill(adminPassword);
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL(/\/contests$/, { timeout: 30_000 });
    await page.locator('.oij-user-name').waitFor({ state: 'visible', timeout: 30_000 });

    // 2. 题面：Markdown + KaTeX（等待公式排版完成）。
    captured.push(
      await screenshot('problem.png', `/problem/${seedData.problemIds[0]}`, {
        ready: '.katex',
        settleMs: 600,
      }),
    );

    // 3. 比赛总览（题目列表、我的提交与比赛信息）。
    captured.push(
      await screenshot('contest.png', `/contest/${seedData.contestId}`, {
        ready: '.oij-card',
        settleMs: 700,
      }),
    );

    // 4. 正式榜。
    captured.push(
      await screenshot('ranking.png', `/contest/${seedData.contestId}/ranking`, {
        ready: '.rank-table tbody tr.ant-table-row',
        settleMs: 700,
      }),
    );

    // 5. 统计仪表盘（ECharts 首帧后再截）。
    await page.goto(`${baseUrl}/contest/${seedData.contestId}/statistics`, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator('.statistics-kpi-row').first().waitFor({ state: 'visible', timeout: 45_000 });
    await page.locator('.statistics-chart-card canvas').first().waitFor({ state: 'visible', timeout: 45_000 });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.statistics-chart-card canvas')].some(
          (canvas) => canvas.width > 0 && canvas.height > 0,
        ),
    );
    await delay(1600);
    {
      const name = 'statistics.png';
      const path = join(OUT_DIR, name);
      await page.screenshot({ path, type: 'png', fullPage: false });
      const size = readPngSize(path);
      if (size.width !== VIEWPORT.width || size.height !== VIEWPORT.height) {
        throw new Error(`${name} is ${size.width}x${size.height}, expected ${VIEWPORT.width}x${VIEWPORT.height}`);
      }
      captured.push({
        file: name,
        route: `/contest/${seedData.contestId}/statistics`,
        width: size.width,
        height: size.height,
      });
      console.log(`[shot] ${name}  /contest/${seedData.contestId}/statistics  ${size.width}x${size.height}`);
    }

    // 6. 批量任务进度（持久化监控页，刷新后可恢复；滚到进度卡与结果表）。
    captured.push(
      await screenshot('batch.png', `/admin/batch/${seedData.batchJobId}`, {
        ready: '.batch-progress',
        settleMs: 700,
        scrollTo: { selector: '.batch-progress', block: 'center' },
      }),
    );

    // 7. 班级与训练：成员进度表（含班级、完成度、逾期状态）与训练题目同屏。
    captured.push(
      await screenshot('class-training.png', `/training-plans/${seedData.trainingPlanId}`, {
        ready: 'text=成员进度',
        settleMs: 700,
        scrollTo: { selector: '.oij-table', block: 'center', last: true },
      }),
    );

    // 8. 管理端：用户管理（演示账号，无真实用户）。
    captured.push(
      await screenshot('admin.png', '/admin/users', {
        ready: '.oij-table tbody tr.ant-table-row',
        settleMs: 600,
      }),
    );

    // 9. 出题：题目编辑页（题面、资产、测试数据与生成的入口）。
    captured.push(
      await screenshot('authoring.png', `/admin/problems/${seedData.problemIds[0]}`, {
        ready: 'text=基本信息',
        settleMs: 800,
      }),
    );

    // 10. 学生个人学习页（学习概览、错题、提交记录和标签掌握度）。
    captured.push(
      await screenshot('learning.png', `/students/${seedData.students[0].id}/learning`, {
        ready: 'text=学习概览',
        settleMs: 800,
      }),
    );

    // 11. 出题数据计划：把“生成几组数据、每组多少分”变成可编辑表格。
    await screenshot('data-plan.png', `/admin/problems/${seedData.problemIds[0]}`, {
      ready: 'text=基本信息',
      click: '数据计划',
      settleMs: 800,
    }).then((shot) => captured.push(shot));

    // 12. 比赛控制台：报名、参赛者、锁题、Hack、班级统计和报告入口。
    captured.push(
      await screenshot('contest-admin.png', `/admin/contests/${seedData.contestId}`, {
        ready: 'text=报名管理',
        settleMs: 800,
      }),
    );

    // 13. 比赛大屏：现场展示排名、倒计时和实时状态。
    captured.push(
      await screenshot('contest-screen.png', `/contest/${seedData.runningContestId}/screen`, {
        ready: '.screen-header',
        settleMs: 800,
      }),
    );

    // 14. 系统页：诊断、运行指标、版本升级与备份。
    captured.push(
      await screenshot('system.png', '/admin/system', {
        ready: 'text=系统诊断',
        settleMs: 800,
      }),
    );

    // 15. 帮助中心：不离开页面就能查任务说明。
    captured.push(
      await screenshot('help.png', '/help', {
        ready: 'text=帮助中心',
        settleMs: 800,
      }),
    );

    if (pageErrors.length > 0) {
      throw new Error(`uncaught page errors:\n${pageErrors.join('\n')}`);
    }

    const manifest = {
      generatedBy: 'tools/capture-readme-screenshots.mjs',
      viewport: VIEWPORT,
      note: '演示数据 + 隔离临时 dataDir；截图不含真实用户、密码或密钥。',
      screenshots: captured,
    };
    writeFileSync(
      join(OUT_DIR, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    console.log('\n[manifest]');
    for (const shot of captured) console.log(`  ${shot.file}  <-  ${shot.route}`);
    console.log(`\n[done] ${captured.length} screenshots written to ${OUT_DIR}`);

    // 临时数据目录清理前先关浏览器，避免 Chromium 缓存句柄残留。
    await context.close();
    await browser.close();
    browser = null;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await stopServer(server, (message) => console.log(`[server] ${message}`));
    if (options.keepData) {
      console.log(`[keep-data] temporary data directory kept at ${dataDir}`);
    } else {
      await removeDataDir(dataDir);
    }
  }
}

main().catch((error) => {
  console.error(`\n[capture failed] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
