import { test, expect } from '@playwright/test';
import {
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  startTestServer,
  type TestServer,
} from './server-harness';

/**
 * 客观题作答 E2E：真实 server + 真实浏览器。
 *
 * 覆盖：管理员登录 → 通过 admin API 建一套临时客观题（单选/多选/判断/填空）
 * → 浏览器打开题目 → 操作四类控件 → 提交 → 结果页满分且每题 AC。
 *
 * 前置：先 `npm run build`（需要 apps/server/dist/cli.js 与 apps/web/dist）。
 * 固定端口 8898，与 browser.spec.ts 的 8899、business-flow.spec.ts 的 8900 错开；
 * 数据目录使用系统临时目录，测试结束后整个 server 进程树与 dataDir 被清理。
 */

const PORT = 8898;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_USERNAME = E2E_ADMIN_USERNAME;
const ADMIN_PASSWORD = E2E_ADMIN_PASSWORD;
const PROBLEM_TITLE = 'E2E 客观题作答';
const TOTAL_SCORE = 50;

const objective = {
  questions: [
    {
      id: 1,
      kind: 'single' as const,
      stem: '单选题：下列哪个汉字是“乙”？',
      options: [
        { key: 'A', text: '甲' },
        { key: 'B', text: '乙' },
        { key: 'C', text: '丙' },
      ],
      answers: ['B'],
      points: 10,
    },
    {
      id: 2,
      kind: 'multiple' as const,
      stem: '多选题：下列哪些是偶数？',
      options: [
        { key: 'A', text: '二' },
        { key: 'B', text: '三' },
        { key: 'C', text: '四' },
      ],
      answers: ['A', 'C'],
      points: 15,
      partial: true,
    },
    {
      id: 3,
      kind: 'judge' as const,
      stem: '判断题：地球是圆的。',
      answers: ['true'],
      points: 10,
    },
    {
      id: 4,
      kind: 'fill' as const,
      stem: '填空题：请填写圆周率（保留两位小数）。',
      answers: ['3.14'],
      points: 15,
      ignoreCase: true,
      ignoreWhitespace: true,
    },
  ],
};

test.use({ browserName: 'chromium' });

let server: TestServer | null = null;

test.beforeAll(async () => {
  server = await startTestServer({
    port: PORT,
    dataDirPrefix: 'oij-objective-e2e-',
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

test('admin creates an objective problem, answers it in the browser and gets full score', async ({
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

  let displayId = '';

  await test.step('管理员通过表单登录', async () => {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle('OiJudge · 本地 OI 评测');
    await page.getByPlaceholder('用户名').fill(ADMIN_USERNAME);
    await page.getByPlaceholder('密码').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();

    await expect(page).toHaveURL(/\/contests$/, { timeout: 15_000 });
    await expect(page.locator('.oij-user-name')).toHaveText('Administrator');
    expectNoHttpErrors();
  });

  await test.step('通过 admin API 创建临时客观题并断言 Y 编号', async () => {
    const response = await page.request.post(`${BASE_URL}/api/admin/problems`, {
      data: {
        title: PROBLEM_TITLE,
        type: 'objective',
        timeMs: 1000,
        memoryMb: 64,
        difficulty: 2,
        tags: ['E2E', '客观题'],
        statement: '<p>E2E 临时客观题：请完成单选、多选、判断与填空。</p>',
        objective,
      },
    });
    expect(response.status()).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      data: { id: number; displayId: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.id).toBeGreaterThan(0);
    expect(body.data.displayId).toMatch(/^Y\d+$/);
    displayId = body.data.displayId;
    expectNoHttpErrors();
  });

  await test.step('题目页展示客观题信息、题号导航与四类控件', async () => {
    await page.goto(`${BASE_URL}/problem/${displayId}`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.locator('h1.page-title')).toHaveText(`${displayId} ${PROBLEM_TITLE}`);
    await expect(page.locator('.page-title-tags')).toContainText('客观题');
    await expect(page.locator('.page-subtitle')).toContainText('共 4 题 · 总分 50 分');

    const answerCard = page.locator('.objective-answer-card');
    await expect(answerCard).toBeVisible();
    await expect(answerCard.locator('.ant-card-head')).toContainText('作答');
    await expect(answerCard).toContainText('共 4 题 · 总分 50 分');

    const nav = page.locator('.objective-nav');
    await expect(nav).toBeVisible();
    await expect(nav.locator('.objective-nav-title')).toHaveText('答题卡');
    await expect(nav.locator('.objective-nav-item')).toHaveCount(4);
    await expect(nav.locator('.objective-nav-item').first()).toHaveText('1');
    await expect(nav.locator('.objective-nav-item').last()).toHaveText('4');

    const q1 = page.locator('.objective-question[data-question-id="1"]');
    const q2 = page.locator('.objective-question[data-question-id="2"]');
    const q3 = page.locator('.objective-question[data-question-id="3"]');
    const q4 = page.locator('.objective-question[data-question-id="4"]');

    await expect(q1).toContainText('第 1 题');
    await expect(q1).toContainText('单选');
    await expect(q1).toContainText('本题共 10 分');
    await expect(q1.locator('.objective-option')).toHaveCount(3);

    await expect(q2).toContainText('多选');
    await expect(q2).toContainText('部分给分');
    await expect(q2).toContainText('本题共 15 分');
    await expect(q2.locator('.objective-option')).toHaveCount(3);

    await expect(q3).toContainText('判断');
    await expect(q3.locator('.objective-option')).toHaveCount(2);

    await expect(q4).toContainText('填空');
    await expect(q4.locator('.objective-fill-input input')).toBeVisible();
    expectNoHttpErrors();
  });

  await test.step('作答单选、多选、判断与填空', async () => {
    const q1 = page.locator('.objective-question[data-question-id="1"]');
    const q2 = page.locator('.objective-question[data-question-id="2"]');
    const q3 = page.locator('.objective-question[data-question-id="3"]');
    const q4 = page.locator('.objective-question[data-question-id="4"]');

    // 单选：点击“乙”。
    await q1.locator('.objective-option').filter({ hasText: '乙' }).click();
    await expect(q1).toContainText('已作答');
    await expect(q1.locator('.ant-radio-wrapper-checked')).toHaveCount(1);

    // 多选：勾选“二”和“四”。
    await q2.locator('.objective-option').filter({ hasText: '二' }).click();
    await q2.locator('.objective-option').filter({ hasText: '四' }).click();
    await expect(q2.locator('.ant-checkbox-wrapper-checked')).toHaveCount(2);
    await expect(q2).toContainText('已作答');

    // 判断：选择“正确”。
    await q3.locator('.objective-option').filter({ hasText: '正确' }).click();
    await expect(q3.locator('.ant-radio-wrapper-checked')).toHaveCount(1);
    await expect(q3).toContainText('已作答');

    // 填空：填写圆周率。
    await q4.locator('.objective-fill-input input').fill('3.14');
    await expect(q4).toContainText('已作答');

    const submitBar = page.locator('.objective-submit-bar');
    await expect(submitBar).toContainText('已答 4 / 4 题');
    await expect(submitBar).toContainText('总分 50 分');
    await expect(submitBar.getByRole('button', { name: '提交答案' })).toBeEnabled();

    const nav = page.locator('.objective-nav');
    await expect(nav.locator('.objective-nav-progress')).toHaveText('已答 4 / 4');
    await expect(nav.locator('.objective-nav-item.is-answered')).toHaveCount(3);
    await expect(nav.locator('.objective-nav-item.is-current')).toHaveCount(1);
    expectNoHttpErrors();
  });

  await test.step('提交答案并断言满分结果页', async () => {
    await page.locator('.objective-submit-bar').getByRole('button', { name: '提交答案' }).click();

    await expect(page).toHaveURL(/\/submissions\/\d+$/, { timeout: 15_000 });
    const submissionId = Number(page.url().match(/\/submissions\/(\d+)$/)?.[1]);
    expect(submissionId).toBeGreaterThan(0);

    await expect(page.locator('h1.page-title')).toHaveText(`提交 #${submissionId}`);
    await expect(page.locator('.verdict-hero .verdict-lg')).toHaveText('AC', {
      timeout: 30_000,
    });
    await expect(page.locator('.verdict-hero-score')).toHaveText(`${TOTAL_SCORE}分`);
    await expect(page.getByText('题目结果 (4)', { exact: true })).toBeVisible();
    await expect(page.getByText('客观题', { exact: true }).first()).toBeVisible();

    const rows = page.locator('.oij-table tbody tr');
    await expect(rows).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) {
      const row = rows.nth(index);
      await expect(row).toContainText(`第 ${index + 1} 题`);
      await expect(row.locator('.verdict')).toHaveText('AC');
    }
    const resultScores = await rows.locator('.score-value').allTextContents();
    expect(resultScores).toEqual(['10', '15', '10', '15']);
    expectNoHttpErrors();
  });

  expect(pageErrors, `uncaught page errors: ${pageErrors.join('; ')}`).toEqual([]);
});
