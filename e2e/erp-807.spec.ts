// 8.0.7 供应链收尾与 ERP P2（docs/ERP_V807.md）新页面的浏览器验收：
//   ① 应收与挂账：新增协议单位（编码、名称、额度），列表里看到；切到「账龄与平台回款」两块都在；
//   ② 资产与易耗：手工建两张卡，列表里看到、打开详情有「建卡」的变动记录；
//   ③ 供应商评分、库存「呆滞与临期」能打开；
//   ④ 经营规则「可调的数值」：两个页面同时开着各改一项，后保存的不把先保存的改回去；企业微信推送一行显示机器人地址配没配（CI 没配：「发一条试试」不能点）。
// 依赖演示数据（只在独立演示库）；账号：店主 linlan，密码 yuzu2026。会登记单据，只在门店电脑尺寸执行。
// 每次用新的编码、名称，不改演示数据里已有的档案。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

test.describe('8.0.7 供应链收尾与 ERP P2', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('应收与挂账：新增协议单位，列表里看到；账龄与平台回款两块在', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/erp/receivables');
    await expect(page.getByTestId('receivables-page')).toBeVisible();
    const tag = String(Date.now()).slice(-6);
    await page.getByTestId('ar-account-new').click();
    await page.getByTestId('ar-code').fill(`E2E${tag}`);
    await page.getByTestId('ar-name').fill(`E2E 协议单位${tag}`);
    await page.getByTestId('ar-limit').fill('2000');
    await page.getByTestId('ar-account-save').click();
    await expect(page.getByTestId('ar-accounts')).toContainText(`E2E 协议单位${tag}`);
    await expect(page.getByTestId('ar-accounts')).toContainText('2,000.00');
    // 账龄与平台回款在第二个页签（没有没回的应收时只有一句说明，不出表格）
    await page.getByRole('radio', { name: '账龄与平台回款' }).click();
    await expect(page.getByRole('heading', { name: '账龄', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '平台团购回款' })).toBeVisible();
  });

  test('资产与易耗：手工建两张卡，打开详情有建卡记录', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/erp/assets');
    await expect(page.getByTestId('assets-page')).toBeVisible();
    const name = `E2E 前台电脑${String(Date.now()).slice(-6)}`;
    await page.getByTestId('asset-new').click();
    await page.getByTestId('asset-name').fill(name);
    await page.getByTestId('asset-original').fill('4500');
    await page.getByTestId('asset-qty').fill('2');
    await page.getByTestId('asset-create-confirm').click();
    const rows = page.getByTestId('asset-table').getByRole('row').filter({ hasText: name });
    await expect(rows).toHaveCount(2);
    await rows.first().getByRole('button').first().click();
    // 详情在对话框里：标题是「编号 · 名称」，变动记录里有「建卡」
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(name);
    const detail = page.getByTestId('asset-detail');
    await expect(detail).toContainText('¥4,500.00');
    await expect(detail).toContainText('建卡');
  });

  test('供应商评分、库存的呆滞与临期能打开', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/purchasing/scores');
    await expect(page.getByTestId('scores-page')).toBeVisible();
    await page.goto('/inventory/aging');
    await expect(page.getByTestId('aging-tab')).toBeVisible();
    await expect(page.getByTestId('slow-only')).toBeVisible();
  });

  test('经营规则「可调的数值」：两个页面同时开着各改一项，后保存的不把先保存的改回去', async ({ page }) => {
    await login(page, 'linlan');
    const other = await page.context().newPage();
    try {
      await page.goto('/admin/rules');
      await other.goto('/admin/rules');
      await expect(page.getByTestId('tun-slowMovingDays')).toHaveValue('90');
      await expect(other.getByTestId('tun-expiryRemindDays')).toHaveValue('30');
      await page.getByTestId('tun-slowMovingDays').fill('60');
      await page.getByTestId('tunables-save').click();
      await expect(page.getByText('可调的数值已保存').first()).toBeVisible();
      // 第二个页面打开时呆滞还是 90 天，只改临期提醒、保存：呆滞不能被改回 90
      await other.getByTestId('tun-expiryRemindDays').fill('20');
      await other.getByTestId('tunables-save').click();
      await expect(other.getByText('可调的数值已保存').first()).toBeVisible();
      const s = (await (await page.request.get('/api/settings')).json()) as { slowMovingDays: number; expiryRemindDays: number };
      expect(s).toMatchObject({ slowMovingDays: 60, expiryRemindDays: 20 });
    } finally {
      await other.close();
      const r = await page.request.put('/api/settings', { data: { slowMovingDays: 90, expiryRemindDays: 30 } });
      expect(r.status(), await r.text()).toBe(200);
    }
  });

  test('经营规则「可调的数值」：企业微信推送显示机器人地址配没配', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/admin/rules');
    const row = page.getByTestId('wecom-row');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText('机器人地址');
    const status = (await (await page.request.get('/api/settings/wecom')).json()) as { configured: boolean };
    if (status.configured) await expect(page.getByTestId('wecom-test')).toBeEnabled();
    else await expect(page.getByTestId('wecom-test')).toBeDisabled();
  });
});
