// 8.1.20 出入库台账（docs/ERP_V8120.md）的浏览器验收：
//   物资经办在「库管入库」页右上角看到「导入出入库台账」「导出台账」「下载模板」三个入口；下载新模板（旧模板地址已停用）；
//   导入一份合成的台账（一种物料一行：入库 2、同一天出库 1 给一个部门，备注里带时间，每次文件内容不同）→ 预览没有问题 →
//   导入生成 1 张库管入库、1 张部门领料；再从导入页导出这个月的台账，标题写着「系统导出」。
// 依赖演示数据（seed-demo 与 seed-inventory-demo：物资 lixiao，密码 yuzu2026）。会登记单据，只在门店电脑尺寸执行。
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

const csvOf = (rows: string[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');

test.describe('8.1.20 出入库台账', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('库管入库页右上角三个入口；下载模板、导入一份台账生成入库与领料、导出台账', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page, 'lixiao');
    await page.goto('/inventory/direct/new');
    const actions = page.getByTestId('ledger-actions');
    await expect(actions.getByTestId('ledger-import-link')).toHaveText('导入出入库台账');
    await expect(actions.getByTestId('ledger-export-link')).toHaveText('导出台账');
    await expect(actions.getByTestId('ledger-template-link')).toHaveText('下载模板');

    const tpl = await page.request.get('/api/inventory/ledger/template');
    expect(tpl.headers()['content-type']).toContain('spreadsheetml');
    expect((await page.request.get('/api/inventory/direct-receipts/template')).status()).toBe(410);

    const suppliers = (await (await page.request.get('/api/inventory/suppliers')).json()) as { name: string; active: boolean }[];
    const mats = (await (await page.request.get('/api/inventory/materials')).json()) as { name: string; code: string; active: boolean; tracked: boolean; expiryTracked?: boolean }[];
    const depts = (await (await page.request.get('/api/inventory/departments')).json()) as { name: string; active: boolean }[];
    const supplier = suppliers.find((s) => s.active)!;
    const mat = mats.find((m) => m.active && m.tracked && !m.expiryTracked && m.name === '抽纸') ?? mats.find((m) => m.active && m.tracked && !m.expiryTracked)!;
    const dept = depts.find((d) => d.active)!;

    await actions.getByTestId('ledger-import-link').click();
    await expect(page.getByTestId('ledger-import')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByTestId('ledger-template').click();
    await download;

    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const stamp = `E2E ${Date.now()}`;
    const csv = csvOf([
      [`宝安店仓库出入库记录（${today.slice(0, 4)}年）`],
      ['序号', '日期', '供应商', '物料名称', '规格', '库位', '上期库存量', '入库', '', '出库', '', '', '库存量', '单价', '备注'],
      ['', '', '', '', '', '', '', '日期', '数量', '日期', '数量', '领料人及部门', '', '', ''],
      ['1', today, supplier.name, mat.name, '', 'E2E-1', '', today, '2', today, '1', `${dept.name} 测试`, '', '8', stamp],
    ]);
    await page.getByTestId('ledger-import-file').setInputFiles({ name: '出入库台账.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await page.getByTestId('ledger-import-preview').click();
    const result = page.getByTestId('ledger-import-preview-result');
    await expect(result).toContainText('1 行都能导入：1 张库管入库');
    await expect(result).toContainText('1 张部门领料');
    await page.getByTestId('ledger-import-apply').click();
    const done = page.getByTestId('ledger-import-done');
    await expect(done).toContainText('已导入 1 行：1 张库管入库');
    await expect(done.getByRole('button')).toHaveCount(2);

    const exported = await page.request.get(`/api/inventory/ledger/export?month=${today.slice(0, 7)}`);
    expect(exported.status()).toBe(200);
    expect(exported.headers()['content-type']).toContain('spreadsheetml');
  });
});
