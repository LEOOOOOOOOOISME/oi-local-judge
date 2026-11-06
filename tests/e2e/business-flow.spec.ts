import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './server-harness';

/**
 * 业务流程验收：管理员建班 → 添加学生 → 学生登录看到班级。
 *
 * 前置：先 `npm run build`（需要 apps/server/dist/cli.js 与 apps/web/dist）。
 * 固定端口 8900（与 browser.spec.ts 的 8899 错开），临时数据目录，
 * 测试结束后整个进程树会被清理。
 */

const PORT = 8900;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123';
const STUDENT_USERNAME = 'e2e_student';
const STUDENT_PASSWORD = 'student123';
const CLASS_NAME = 'E2E 班级';

test.use({ browserName: 'chromium' });

let server: TestServer | null = null;

test.beforeAll(async () => {
  server = await startTestServer({
    port: PORT,
    dataDirPrefix: 'oij-business-e2e-',
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

test('admin creates class, adds student, and student sees it', async ({ page }) => {
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

  let classId = 0;

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

  await test.step('通过 admin API 创建学生用户', async () => {
    const response = await page.request.post(`${BASE_URL}/api/admin/users`, {
      data: {
        username: STUDENT_USERNAME,
        password: STUDENT_PASSWORD,
        role: 'contestant',
      },
    });
    expect(response.status()).toBe(201);
    const body = (await response.json()) as { ok: boolean; data: { id: number } };
    expect(body.ok).toBe(true);
    expect(body.data.id).toBeGreaterThan(0);
    expectNoHttpErrors();
  });

  await test.step('UI 创建班级并关闭 allowContest', async () => {
    await page.goto(`${BASE_URL}/classes`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1.page-title')).toHaveText('班级');

    await page.getByRole('button', { name: '创建班级' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('例如：高一(1)班').fill(CLASS_NAME);

    const allowContestSwitch = dialog.getByRole('switch');
    await expect(allowContestSwitch).toHaveAttribute('aria-checked', 'true');
    await allowContestSwitch.click();
    await expect(allowContestSwitch).toHaveAttribute('aria-checked', 'false');

    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page).toHaveURL(/\/classes\/\d+$/, { timeout: 15_000 });

    const match = page.url().match(/\/classes\/(\d+)$/);
    classId = Number(match?.[1]);
    expect(classId).toBeGreaterThan(0);

    await expect(page.locator('h1.page-title')).toHaveText(CLASS_NAME);
    await expect(page.getByText('不允许参赛', { exact: true }).first()).toBeVisible();
    expectNoHttpErrors();
  });

  await test.step('在班级详情添加学生', async () => {
    await page.getByRole('button', { name: '添加成员' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('输入已注册用户的用户名').fill(STUDENT_USERNAME);
    await dialog.getByRole('button', { name: '添加', exact: true }).click();

    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(
      page.getByRole('row', { name: new RegExp(STUDENT_USERNAME) }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('成员（2）', { exact: true })).toBeVisible();
    expectNoHttpErrors();
  });

  await test.step('退出管理员登录', async () => {
    await page.locator('.oij-user-button').click();
    await page.getByRole('menuitem', { name: '退出登录' }).click();
    // 退出后可能被在途请求的 401 重定向带到 /login?next=...，两种都接受。
    await expect(page).toHaveURL(/\/login(?:\?|$)/, { timeout: 15_000 });
    expectNoHttpErrors();
  });

  await test.step('学生通过表单登录', async () => {
    // 重新打开干净的登录页，避免沿用管理员退出时携带的 next 参数。
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByPlaceholder('用户名')).toBeVisible();
    await page.getByPlaceholder('用户名').fill(STUDENT_USERNAME);
    await page.getByPlaceholder('密码').fill(STUDENT_PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();

    await expect(page).toHaveURL(/\/contests$/, { timeout: 15_000 });
    await expect(page.locator('.oij-user-name')).toHaveText(STUDENT_USERNAME);
    expectNoHttpErrors();
  });

  await test.step('学生能在班级列表看到班级', async () => {
    await page.goto(`${BASE_URL}/classes`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1.page-title')).toHaveText('班级');
    await expect(
      page.getByRole('link', { name: CLASS_NAME, exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    expectNoHttpErrors();
  });

  await test.step('学生打开班级详情并看到自己', async () => {
    await page.getByRole('link', { name: CLASS_NAME, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/classes/${classId}$`));
    await expect(page.locator('h1.page-title')).toHaveText(CLASS_NAME);
    await expect(page.getByText('不允许参赛', { exact: true }).first()).toBeVisible();

    const selfRow = page.getByRole('row', { name: new RegExp(STUDENT_USERNAME) });
    await expect(selfRow).toBeVisible({ timeout: 15_000 });
    await expect(selfRow.getByText('我', { exact: true })).toBeVisible();
    await expect(page.getByText('成员（2）', { exact: true })).toBeVisible();

    // 学生身份标签可见，且没有管理按钮。
    await expect(selfRow.getByText('学生', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '添加成员' })).toHaveCount(0);
    expectNoHttpErrors();
  });

  expect(pageErrors, `uncaught page errors: ${pageErrors.join('; ')}`).toEqual([]);
});
