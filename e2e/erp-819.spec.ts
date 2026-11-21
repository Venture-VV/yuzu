// 8.1.9 ERP 供应链（docs/ERP_V819.md）的浏览器验收：
//   ① 零采备用金：店主在 ERP 设置里填总额 → 采购经办申用、提交报销（未补单）→ 店主在「费用报销」按这笔申用登记报销（钱从零采备用金来）
//      → 报销单确认后面板上这笔是「已报销」、剩余可用加回；
//   ② 库管入库：物资经办在库存页点「库管入库」，不选采购单，直接选物料、填单价，确认入库，单据上标「库管入库」；
//   （8.1.9 的③「导入入库台账」8.1.20 起换成出入库台账，用例在 e2e/erp-8120.spec.ts。）
// 依赖演示数据（seed-demo 与 seed-inventory-demo：店主 linlan、采购 zhouyi、物资 lixiao，密码 yuzu2026）。会登记单据，只在门店电脑尺寸执行；
// 每次用新的说明与金额，不改演示数据里已有的档案。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

test.describe('8.1.9 ERP 供应链', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('零采备用金：申用 → 提交报销 → 财务按申用登记报销 → 自动回补', async ({ browser }) => {
    test.setTimeout(150_000);
    const tag = String(Date.now()).slice(-6);
    // 店主：总额设大一些（之前没跑完的申用也放得下）
    const bossCtx = await browser.newContext();
    const boss = await bossCtx.newPage();
    await login(boss, 'linlan');
    await boss.goto('/erp/settings/expenses');
    await expect(boss.getByTestId('pool-settings')).toBeVisible();
    await boss.getByTestId('pool-total-input').fill('500000');
    await boss.getByTestId('pool-settings-save').click();
    await expect(boss.getByText('零采备用金的设置已保存')).toBeVisible();

    // 采购经办：申用
    const buyerCtx = await browser.newContext();
    const buyer = await buyerCtx.newPage();
    await login(buyer, 'zhouyi');
    await buyer.goto('/erp/pool');
    await expect(buyer.getByTestId('pool-summary')).toBeVisible();
    await expect(buyer.getByTestId('pool-total')).toContainText('500,000.00');
    await buyer.getByTestId('pool-new').click();
    const dialog = buyer.getByTestId('pool-use-dialog');
    await dialog.getByLabel('用途说明').fill(`E2E 前台补货 ${tag}`);
    await dialog.getByLabel('采购内容').fill(`网购：一次性拖鞋 2 箱（${tag}）`);
    await buyer.getByTestId('pool-amount').fill('123.45');
    await buyer.getByTestId('pool-use-save').click();
    await expect(buyer.getByText('已申用')).toBeVisible();
    const row = buyer
      .getByTestId('pool-table')
      .locator('tr[data-testid^="pool-use-"]')
      .filter({ hasText: `E2E 前台补货 ${tag}` });
    await expect(row).toContainText('待报销');
    await expect(row).toContainText('¥123.45');
    const useId = Number((await row.getAttribute('data-testid'))!.replace('pool-use-', ''));
    expect(useId).toBeGreaterThan(0);

    // 提交报销：未补单
    // 宽屏是表格（窄屏的卡片也在页面里、藏着）：按表格找
    const table = buyer.getByTestId('pool-table');
    await table.getByTestId(`pool-submit-${useId}`).click();
    await buyer.getByTestId('pool-backfill-pending').check();
    await buyer.getByTestId('pool-submit-save').click();
    await expect(row).toContainText('已提交报销');
    await expect(row).toContainText('等财务登记报销单');

    // 店主（有登记报销的权限）：钱从「零采备用金」来，勾这笔申用。
    // 先把零采备用金模块关掉：关之前已经提交报销的申用，财务照样能选「零采备用金」登记报销（Codex 审查 785ca18）
    const modules = async (on: boolean) => expect((await boss.request.put('/api/erp/modules', { data: { modules: { pettyPool: on } } })).ok()).toBe(true);
    await modules(false);
    try {
      await boss.goto('/erp/expenses/new');
      await expect(boss.getByTestId('claim-form')).toBeVisible();
      await boss.getByRole('radio', { name: '零采备用金' }).click();
      await expect(boss.getByTestId(`ex-pool-use-${useId}`)).toBeVisible();
    } finally {
      await modules(true);
    }
    await boss.reload();
    await expect(boss.getByTestId('claim-form')).toBeVisible();
    await boss.getByRole('radio', { name: '零采备用金' }).click();
    await boss.getByTestId(`ex-pool-use-${useId}`).check();
    await expect(boss.getByTestId('ex-pool-uses')).toContainText('申用共 ¥123.45');
    if (!(await boss.getByTestId('ex-dept').inputValue())) await boss.getByTestId('ex-dept').selectOption({ index: 1 });
    await boss.getByTestId('ex-purpose').selectOption({ index: 1 });
    await boss.getByTestId('ex-invoice').selectOption({ label: '无票' });
    await boss.getByTestId('ex-channel').selectOption('self');
    await boss.getByTestId('ex-channel-note').fill('网购平台');
    await boss.getByTestId('line-name-0').fill('一次性拖鞋');
    await boss.getByTestId('line-cat-0').selectOption('low_value');
    await boss.getByTestId('line-unit-0').fill('箱');
    await boss.getByTestId('line-amount-0').fill('120');
    await boss.getByTestId('claim-submit').click();
    await expect(boss).toHaveURL(/\/erp\/expenses\?claim=\d+/);
    const claimSheet = boss.getByTestId('claim-sheet');
    await expect(claimSheet).toContainText('已确认');
    await expect(boss.getByTestId('claim-pool-uses')).toContainText('¥123.45');

    // 采购经办：这笔已报销，挂着那张报销单
    await buyer.reload();
    const after = buyer.getByTestId('pool-table').getByTestId(`pool-use-${useId}`);
    await expect(after).toContainText('已报销');
    await expect(after).toContainText('已确认');
    await bossCtx.close();
    await buyerCtx.close();
  });

  test('库管入库：不选采购单，直接选物料、填单价，确认入库', async ({ page }) => {
    await login(page, 'lixiao');
    await page.goto('/inventory');
    await page.getByTestId('inv-direct-new').click();
    await expect(page).toHaveURL(/\/inventory\/direct\/new/);
    await expect(page.getByRole('heading', { name: /库管入库/ })).toBeVisible();
    await expect(page.getByLabel('采购单')).toHaveCount(0);
    await page.locator('#supplier').selectOption({ index: 1 });
    await page.getByLabel('添加物料').fill('抽纸');
    await page.keyboard.press('Enter');
    await page.keyboard.type('3');
    await page.getByLabel(/^单价（元\//).fill('12.5');
    await page.getByRole('button', { name: /确认收货/ }).click();
    await expect(page.getByRole('heading', { name: '库管入库已生效' })).toBeVisible();
    await page.getByRole('button', { name: '查看单据' }).click();
    await expect(page).toHaveURL(/\/inventory\/docs\?doc=\d+/);
    const docId = Number(new URL(page.url()).searchParams.get('doc'));
    const doc = (await (await page.request.get(`/api/inventory/docs/${docId}`)).json()) as { status: string; direct: boolean; noPo: boolean };
    expect(doc).toMatchObject({ status: 'confirmed', direct: true, noPo: true });
    await expect(page.getByText('库管入库').first()).toBeVisible();
  });
});
