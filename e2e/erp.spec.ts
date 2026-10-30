// v0.7.3 ERP 独立工作区浏览器验收（店主 2026-10-30 定，见 docs/ERP.md）：
//   门店主导航没有库存、采购、货款、待办 → 店主从用户菜单「进入 ERP」→ ERP 首页的模块 → 营业数据（只读）
//   → 模块设置关掉「采购」：导航不显示、页面提示没有开启、接口拒绝 → 重新开启恢复；
//   物资经办登录直接进 ERP 的库存，没有营业数据与模块设置；开了餐饮时，物资经办的「返回门店」进餐饮的厨房出品屏。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan、物资经办 lixiao，密码 yuzu2026。结束时把模块开关恢复为全部开启。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  // 刚启动的服务第一次登录可能较慢；门店账号进主导航，只用 ERP 的账号进 ERP
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

const erpNav = (page: Page) => page.getByRole('navigation', { name: 'ERP 导航' });

test.describe('ERP 工作区', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改模块开关的流程只在门店电脑尺寸执行一次');

  test('店主从用户菜单进 ERP，看营业数据；关掉「采购」后导航、页面、接口都拦下，重新开启恢复', async ({ page }) => {
    await login(page, 'linlan');
    try {
      // 门店主导航里没有库存、采购、货款、待办
      const main = page.getByRole('navigation', { name: '主导航' });
      await expect(main.getByRole('link', { name: '会员', exact: true })).toBeVisible();
      for (const name of ['库存', '采购', '货款', '待办']) await expect(main.getByRole('link', { name, exact: true })).toHaveCount(0);

      await page.getByTestId('user-menu').click();
      await page.getByTestId('user-menu-erp').click();
      await expect(page).toHaveURL(/\/erp$/);
      for (const k of ['inventory', 'purchasing', 'payables', 'approvals', 'revenue']) await expect(page.getByTestId(`erp-card-${k}`)).toBeVisible();

      // 营业数据（只读）：与经营总览同一口径
      await erpNav(page).getByRole('link', { name: '营业数据', exact: true }).click();
      await expect(page.getByTestId('erp-revenue-net')).toBeVisible();
      await expect(page.getByTestId('erp-revenue-days')).toBeVisible();
      const me = (await (await page.request.get('/api/auth/me')).json()) as { today: string };
      const from = new Date(Date.parse(`${me.today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
      const [erp, exec] = await Promise.all([
        page.request.get(`/api/erp/revenue?from=${from}&to=${me.today}`).then((r) => r.json()),
        page.request.get(`/api/reports/executive?from=${from}&to=${me.today}`).then((r) => r.json()),
      ]);
      expect(erp.kpis.net).toBe(exec.kpis.net);
      expect(erp.trend).toEqual(exec.trend);

      // 模块设置：关掉采购
      await erpNav(page).getByRole('link', { name: '模块设置', exact: true }).click();
      await page.getByTestId('erp-switch-purchasing').getByRole('radio', { name: '关闭' }).click();
      await page.getByTestId('erp-modules-save').click();
      await expect(page.getByText('ERP 模块设置已保存')).toBeVisible();
      await expect(erpNav(page).getByRole('link', { name: '采购', exact: true })).toHaveCount(0);
      await page.goto('/purchasing');
      await expect(page.getByTestId('erp-module-off')).toContainText('采购');
      const blocked = await page.request.get('/api/purchase-orders');
      expect(blocked.status()).toBe(403);
      expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('ERP_MODULE_DISABLED');
      // 库存、货款照常
      await page.goto('/payables');
      await expect(page.getByTestId('erp-module-off')).toHaveCount(0);
      await expect(erpNav(page).getByRole('link', { name: '应付货款', exact: true })).toBeVisible();

      // 重新开启
      await page.goto('/erp/modules');
      await page.getByTestId('erp-switch-purchasing').getByRole('radio', { name: '开启' }).click();
      await page.getByTestId('erp-modules-save').click();
      await expect(page.getByText('ERP 模块设置已保存')).toBeVisible();
      await expect(erpNav(page).getByRole('link', { name: '采购', exact: true })).toBeVisible();
      expect((await page.request.get('/api/purchase-orders')).status()).toBe(200);

      // 返回门店
      await page.getByTestId('erp-exit').click();
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    } finally {
      const res = await page.request.put('/api/erp/modules', { data: { modules: { inventory: true, purchasing: true, payables: true, approvals: true, revenue: true } } });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });

  test('物资经办登录直接进 ERP 的库存：没有门店导航、营业数据与模块设置', async ({ page }) => {
    await login(page, 'lixiao');
    await expect(page).toHaveURL(/\/inventory/);
    await expect(page.getByTestId('erp-shell')).toBeVisible();
    await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
    for (const name of ['营业数据', '模块设置', '应付货款']) await expect(erpNav(page).getByRole('link', { name, exact: true })).toHaveCount(0);
    expect((await page.request.get('/api/erp/revenue?from=2026-01-01&to=2026-01-01')).status()).toBe(403);
    await page.goto('/erp/modules');
    await expect(page).toHaveURL(/\/erp$/);
    // 门店那边没有权限的页面直接打开：回到首页，也就是 ERP 的库存（不停在只有外壳、提示没有权限的页面；测试服 E2E 报告）
    for (const url of ['/ledger', '/settlement', '/shift', '/frontdesk']) {
      await page.goto(url);
      await expect(page, url).toHaveURL(/\/inventory/);
      await expect(page.getByTestId('erp-shell')).toBeVisible();
    }
  });

  test('开了餐饮时，物资经办在 ERP 点「返回门店」进餐饮的厨房出品屏，不会被送回 ERP', async ({ page }) => {
    await login(page, 'linlan');
    const dining = (await (await page.request.get('/api/admin/dining')).json()) as { rules: { enabled: boolean } };
    if (!dining.rules.enabled) expect((await page.request.put('/api/admin/dining/rules', { data: { enabled: true } })).ok()).toBe(true);
    try {
      await page.request.post('/api/auth/logout');
      await login(page, 'lixiao');
      await expect(page).toHaveURL(/\/inventory/);
      await page.getByTestId('erp-exit').click();
      await expect(page).toHaveURL(/\/dining/);
      await expect(page.getByTestId('dining-tab-kitchen')).toBeVisible();
      await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '餐饮', exact: true })).toBeVisible();
    } finally {
      if (!dining.rules.enabled) {
        await page.request.post('/api/auth/logout');
        await login(page, 'linlan');
        expect((await page.request.put('/api/admin/dining/rules', { data: { enabled: false } })).ok()).toBe(true);
      }
    }
  });
});
