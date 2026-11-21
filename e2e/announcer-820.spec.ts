// 8.2.0 P03（docs/YUZU_REQ_V820.md 第 4 节）：
//   4-1 「排位播报」从钟房移出，与钟房同级（技师组里两项平级）；老地址跳到新页面并提示；播报页有播报条、排位与手动叫号、播报记录；
//   5-3 岗位权限的第一个页签叫「设立岗位」，老的 ?tab=positions 照旧打开它，页面上不再有「新岗位（按部门）」。
// 依赖演示数据（店主 linlan，密码 yuzu2026）。手动叫号会记一条叫号（只追加，不动别的数据），只在门店电脑跑。
import { expect, test, type Page } from '@playwright/test';
import { navLink } from './nav';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('8.2.0 排位播报独立菜单；设立岗位', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '只在门店电脑尺寸跑一次');

  test('技师组里钟房与排位播报平级；老地址跳到新页面；手动叫号进播报记录', async ({ page }) => {
    await login(page);
    await page.goto('/');
    const nav = page.getByTestId('nav-domain-technicians');
    await expect(nav.locator('[data-nav-item="排位播报"]')).toHaveCount(1);
    const items = await nav.locator('[data-nav-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-nav-item')));
    expect(items.indexOf('排位播报')).toBe(items.indexOf('钟房') + 1);
    await (await navLink(page, '排位播报')).click();
    await expect(page).toHaveURL(/\/announcer$/);
    await expect(page.getByTestId('announcer-bar')).toBeVisible();
    // 钟房里没有播报条了，只有一条提示指过来
    await page.goto('/clockroom');
    await expect(page.getByTestId('announcer-bar')).toHaveCount(0);
    await expect(page.getByTestId('clock-announcer-moved')).toBeVisible();
    // 老地址
    await page.goto('/clockroom/announcer');
    await expect(page).toHaveURL(/\/announcer\?moved=1$/);
    await expect(page.getByTestId('announcer-moved')).toContainText('排位播报换了地方');
    // 手动叫号：排在队里的第一位，播报记录里多一条「手动叫号」
    await expect(page.getByTestId('announcer-queue')).toBeVisible();
    const first = page.getByTestId('announcer-queue').locator('li').first();
    const hasQueue = (await first.count()) > 0;
    test.skip(!hasQueue, '演示库里现在没有在岗的技师');
    const rows = page.getByTestId('announcer-log-row');
    const before = await rows.count();
    await first.getByRole('button', { name: '叫号' }).click();
    await expect(rows).toHaveCount(Math.min(before + 1, 50));
    await expect(rows.first()).toContainText('手动叫号');
  });

  test('岗位权限的第一个页签叫「设立岗位」，老的 ?tab=positions 照旧打开它', async ({ page }) => {
    await login(page);
    await page.goto('/admin/permissions?tab=positions');
    await expect(page.getByRole('radio', { name: '设立岗位' })).toBeChecked();
    await expect(page.getByText('新岗位（按部门）')).toHaveCount(0);
    await page.getByRole('radio', { name: '分部门岗位职权配置' }).click();
    await expect(page).toHaveURL(/tab=catalog/);
  });
});
