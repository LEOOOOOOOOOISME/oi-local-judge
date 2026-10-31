// Production smoke test against the Fastify-served web build.
// Usage: start the server, then `node tools/e2e-prod-smoke.mjs`.
import { chromium } from '@playwright/test';

const base = process.env.OIJ_BASE ?? 'http://127.0.0.1:8790';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});

await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
await page.getByPlaceholder('用户名').fill('admin');
await page.getByPlaceholder('密码').fill('admin123');
await page.getByRole('button', { name: /登录/ }).click();
await page.waitForURL('**/contests', { timeout: 10_000 });
const title = await page.title();
const contestsText = await page.locator('body').innerText();

await page.goto(`${base}/contest/1`, { waitUntil: 'networkidle' });
const contestText = await page.locator('body').innerText();

const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
);

console.log(
  JSON.stringify(
    {
      title,
      afterLogin: page.url(),
      contestsHasDemo: /演示赛/.test(contestsText),
      contestHasProblem: /A\+B/.test(contestText),
      horizontalOverflow: overflow,
      pageErrors: errors,
    },
    null,
    2,
  ),
);
await browser.close();
