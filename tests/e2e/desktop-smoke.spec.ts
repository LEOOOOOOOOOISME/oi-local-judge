import { test, expect, _electron as electron } from '@playwright/test';
import { join } from 'node:path';

test('desktop window loads local server', async () => {
  const app = await electron.launch({
    args: [join(process.cwd(), 'apps/desktop/dist/main.js')],
  });
  const page = await app.firstWindow();
  await expect(page).toHaveTitle('OiJudge');
  await expect(page.locator('body')).toContainText('OiJudge');
  await app.close();
});
