// 「待确认」标记（R1.3）：店主签认经营规则后，在「管理 → 经营规则」选择隐藏，所有页面不再显示「待确认」；只影响显示，不改规则。
// 依赖演示数据（店主 linlan、前台 xiaozhou，密码 yuzu2026）；结束时恢复为显示，可重复执行。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('「待确认」标记', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '改规则的流程只在门店电脑尺寸执行一次');

  test('店主选择隐藏后，日结页不再显示「待确认」；改回显示后恢复', async ({ page }) => {
    await login(page, 'linlan');
    try {
      await page.goto('/settlement');
      await expect(page.getByRole('heading', { name: '日结' })).toBeVisible();
      await expect(page.getByText('待确认', { exact: true }).first()).toBeVisible();

      await page.goto('/admin/rules');
      await page.getByRole('radiogroup', { name: '「待确认」标记' }).getByRole('radio', { name: '隐藏（店主已签认）' }).click();
      await page.getByRole('button', { name: '保存规则' }).click();
      await expect(page.getByText('经营规则已保存')).toBeVisible();
      await expect(page.getByText('店主已签认经营规则，「待确认」标记已隐藏')).toBeVisible();

      await page.goto('/settlement');
      await expect(page.getByRole('heading', { name: '日结' })).toBeVisible();
      await expect(page.getByText(/营业日每天 \d{2}:00 切换/)).toBeVisible();
      await expect(page.getByText('待确认', { exact: true })).toHaveCount(0);
    } finally {
      expect((await page.request.put('/api/settings', { data: { hidePendingMarks: false } })).ok()).toBe(true);
    }
    await page.goto('/settlement');
    await expect(page.getByText('待确认', { exact: true }).first()).toBeVisible();
  });
});
