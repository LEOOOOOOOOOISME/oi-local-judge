import { test, expect } from '@playwright/test';
import {
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  startTestServer,
  type TestServer,
} from './server-harness';

/**
 * 浏览器验收：不依赖 Electron，直接启动真实 server，用 Chromium 走一遍
 * 登录 + 帮助 + 系统运维 + 班级 + 训练计划 + 学习统计页面。
 *
 * 前置：先 `npm run build`（需要 apps/server/dist/cli.js 与 apps/web/dist）。
 * 固定端口 8899，数据目录使用系统临时目录，测试结束后整个进程树会被清理。
 */

const PORT = 8899;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_USERNAME = E2E_ADMIN_USERNAME;
const ADMIN_PASSWORD = E2E_ADMIN_PASSWORD;

test.use({ browserName: 'chromium' });

let server: TestServer | null = null;

test.beforeAll(async () => {
  server = await startTestServer({
    port: PORT,
    dataDirPrefix: 'oij-browser-e2e-',
    env: {
      OIJ_ADMIN_USERNAME: ADMIN_USERNAME,
      OIJ_ADMIN_PASSWORD: ADMIN_PASSWORD,
    },
  });
});

test.afterAll(async () => {
  await server?.stop();
  server = null;
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

  let contestId = 0;

  await test.step('通过 admin API 创建比赛用于统计页冒烟', async () => {
    const now = Date.now();
    const response = await page.request.post(`${BASE_URL}/api/admin/contests`, {
      data: {
        name: 'E2E 统计冒烟',
        startAt: now,
        endAt: now + 60 * 60 * 1000,
      },
    });
    expect(response.status()).toBe(201);
    const body = (await response.json()) as { ok: boolean; data: { id: number } };
    expect(body.ok).toBe(true);
    contestId = body.data.id;
    expect(contestId).toBeGreaterThan(0);
    expectNoHttpErrors();
  });

  await test.step('比赛统计页可以打开', async () => {
    await page.goto(`${BASE_URL}/contest/${contestId}/statistics`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('h1.page-title')).toHaveText('E2E 统计冒烟 · 比赛统计', {
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: '导出分析 PDF' })).toBeVisible();
    expectNoHttpErrors();
  });

  await test.step('批量评测页可以打开', async () => {
    await page.goto(`${BASE_URL}/admin/batch`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1.page-title')).toHaveText('批量评测');
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
