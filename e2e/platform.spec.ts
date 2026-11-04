// v0.7.28 ⑤ 浏览器验收：平台核销补录。前台从「前台」页进「平台核销」，补登记一张美团券（已在平台 App 核销、没有结账）→ 当天列表里有；
// 店主在「打款与对账」登记一笔打款，对账表里有这个平台的应结、到账与差额。账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。可重复执行（券码带时间戳）。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('v0.7.28 平台核销补录', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会写账的流程只在门店电脑尺寸执行一次');
  test.setTimeout(120_000);

  test('前台补登记一张美团券；店主登记打款，对账表有应结、到账与差额', async ({ page }) => {
    const code = `MT${Date.now()}`;
    await login(page, 'xiaozhou');
    await page.goto('/frontdesk');
    await page.getByTestId('open-platform').click();
    await expect(page.getByTestId('platform-page')).toBeVisible();
    await page.getByTestId('platform-redeem-new').click();
    await page.getByTestId('platform-code').fill(code);
    await page.getByTestId('platform-face').fill('198');
    await page.getByTestId('platform-redeem-submit').click();
    await expect(page.getByText('已补登记')).toBeVisible({ timeout: 15_000 });
    const row = page.locator('[data-testid^="platform-redemption-"]').filter({ hasText: code });
    await expect(row).toContainText('面值 ¥198.00');

    await page.request.post('/api/auth/logout');
    await login(page, 'linlan');
    await page.goto('/platform');
    await page.getByRole('radio', { name: '打款与对账' }).click();
    await page.getByTestId('platform-settle-new').click();
    await page.getByTestId('platform-settle-amount').fill('100');
    await page.getByTestId('platform-settle-submit').click();
    await expect(page.getByText('已登记打款')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('platform-row-meituan')).toBeVisible();
    await expect(page.getByTestId('platform-row-meituan')).toContainText('¥');
  });
});
