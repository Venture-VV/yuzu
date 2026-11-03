// 前台查找框接小程序会员码（v0.7.25，docs/MINIPROGRAM.md MP9）浏览器验收：
//   扫码盒把会员码（16 或 19 位、8 或 9 开头）扫进会员工作台、接待对话框的查找框，yuzu 在本机校验后直接打开 / 选上那位会员；
//   门店系统没配会员码（没有 MP_CODE_SECRET，浏览器验收的环境就是这样）时写明原因、让客人报手机号，不当成手机号去搜。
// 校验通过的路径（签名、时间、绑定）由小程序线的会员码用例覆盖；这里核对页面认得出会员码、出错时写明原因。

import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('会员码', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '只在门店电脑尺寸执行一次');

  test('会员工作台查找框扫到会员码：没配会员码时写明原因（不当手机号搜）', async ({ page }) => {
    await login(page, 'xiaozhou');
    await page.goto('/');
    const search = page.getByRole('textbox', { name: '搜索会员' });
    await search.fill('8000001123456789');
    await expect(page.getByTestId('member-search-status')).toContainText('没有配会员码');
    // 普通的搜索照常
    await search.fill('1990000');
    await expect(page.getByTestId('member-search-status')).toContainText('找到');
  });
});
