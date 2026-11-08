// 8.0.3 费用预算与进项发票台账浏览器验收（docs/BUDGET_INVOICES.md）：
//   店主建一个部门，在「费用预算」给办公用品设 100 元 → 登记报销（专票、150 元办公用品）：页面提示超预算、台账里没有这张发票会自动登记
//   → 报销单标「超预算」、写明超了多少、待店主同意（店主在详情里同意）、关联台账发票 → 发票台账里标已认证（所属期本月）
//   → 台账里直接登记一张普票（不用认证）→ 再登记一张专票，在「待认证」里勾选、一次标已认证。
// 依赖演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。只在门店电脑尺寸执行。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

test.describe('费用预算与发票台账', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('设预算 → 超预算报销自动登记发票 → 台账认证、直接登记、批量标认证', async ({ page }) => {
    await login(page, 'linlan');
    const run = Date.now().toString(36).slice(-6).toUpperCase();
    // 每次用新部门：预算与已占用不受之前跑过的影响。排在最后、跑完清掉额度并停用——
    // 之后的用例（费用报销、采购台账……）按「第一个部门」登记报销，不能碰到这里设的额度
    const deptName = `预算E2E${run}`;
    await page.request.post('/api/inventory/departments', { data: { name: deptName, sortOrder: 900 } });
    const depts = (await (await page.request.get('/api/inventory/departments')).json()) as { id: number; name: string }[];
    const dept = depts.find((d) => d.name === deptName)!;
    expect(dept).toBeTruthy();
    try {
      await budgetsAndInvoices(page, dept, run);
    } finally {
      const grid = (await (await page.request.get('/api/erp/expenses/budgets')).json()) as {
        month: string;
        rows: { departmentId: number; cells: { category: string; budgetCents: number | null }[] }[];
      };
      const cells = (grid.rows.find((r) => r.departmentId === dept.id)?.cells ?? [])
        .filter((c) => c.budgetCents !== null)
        .map((c) => ({ departmentId: dept.id, category: c.category, amountCents: null, seenCents: c.budgetCents }));
      if (cells.length > 0) expect((await page.request.put('/api/erp/expenses/budgets', { data: { month: grid.month, cells } })).ok()).toBe(true);
      expect((await page.request.put(`/api/inventory/departments/${dept.id}`, { data: { name: deptName, active: false, sortOrder: 900 } })).ok()).toBe(true);
    }
  });
});

async function budgetsAndInvoices(page: Page, dept: { id: number; name: string }, run: string) {
  // ① 费用预算：办公用品 100 元、运费 200 元
  await page.goto('/erp/expenses/budgets');
  await expect(page.getByTestId('budgets-page')).toBeVisible();
  // 门店营业时区的本月（页面默认显示本月）
  const month = await page.getByTestId('budget-month').inputValue();
  expect(month).toMatch(/^\d{4}-\d{2}$/);
  await page.getByTestId('budget-edit').click();
  await page.getByTestId(`budget-cell-${dept.id}-office-input`).fill('100');
  await page.getByTestId(`budget-cell-${dept.id}-freight-input`).fill('200');
  await page.getByTestId('budget-save').click();
  const cell = page.getByTestId(`budget-cell-${dept.id}-office`);
  await expect(cell).toContainText('100.00');
  await expect(cell).toHaveAttribute('data-level', 'ok');
  const freight = page.getByTestId(`budget-cell-${dept.id}-freight`);
  await expect(freight).toContainText('200.00');

  // ①b 改额度的过程中别人改了另一格、页面又刷新了：保存只送自己改的格子，别人改的不会被悄悄改回去（Codex 自动审查 c2c4a12）
  await page.getByTestId('budget-edit').click();
  const other = await page.request.put('/api/erp/expenses/budgets', {
    data: { month, cells: [{ departmentId: dept.id, category: 'freight', amountCents: 30_000, seenCents: 20_000 }] },
  });
  expect(other.ok()).toBe(true);
  // 等页面上的额度过期（5 秒）、切回窗口时自动刷新
  const refetched = page.waitForResponse((r) => r.url().includes(`/api/erp/expenses/budgets?month=${month}`) && r.request().method() === 'GET');
  await page.waitForTimeout(5_500);
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await refetched;
  await page.getByTestId(`budget-cell-${dept.id}-low_value-input`).fill('50');
  await page.getByTestId('budget-save').click();
  await expect(page.getByTestId(`budget-cell-${dept.id}-low_value`)).toContainText('50.00');
  await expect(freight).toContainText('300.00');

  // ② 登记报销：专票 150 元办公用品 → 超预算；台账里没有这张发票
  const invoiceNo = `ZP${run}`;
  await page.goto(`/erp/expenses/new?department=${dept.id}`);
  await expect(page.getByTestId('claim-form')).toBeVisible();
  await expect(page.getByTestId('ex-dept')).toHaveValue(String(dept.id));
  await page.getByTestId('ex-purpose').selectOption('办公');
  await page.getByTestId('ex-invoice').selectOption({ label: '增值税专用发票' });
  await page.getByTestId('ex-tax').selectOption('1300');
  await page.getByTestId('ex-invoice-no').fill(invoiceNo);
  const ledger = page.getByTestId('claim-invoice-ledger');
  await expect(ledger).toContainText('台账里还没有这张增值税专用发票');
  await page.getByTestId('ex-invoice-issuer').fill('E2E 文具店');
  await page.getByTestId('ex-channel').selectOption('self');
  await page.getByTestId('ex-channel-note').fill('楼下文具店');
  await page.getByTestId('line-name-0').fill('打印纸');
  await page.getByTestId('line-cat-0').selectOption('office');
  await page.getByTestId('line-unit-0').fill('箱');
  await page.getByTestId('line-amount-0').fill('150');
  await expect(page.getByTestId('claim-budget-office')).toHaveAttribute('data-level', 'over');
  await expect(page.getByTestId('claim-budget-office')).toContainText('超出 ¥50.00');
  await expect(page.getByTestId('claim-over-budget')).toBeVisible();
  await expect(page.getByTestId('claim-approval-hint')).toContainText('超预算');
  await page.getByTestId('claim-submit').click();

  await expect(page).toHaveURL(/\/erp\/expenses\?claim=\d+/);
  const claimSheet = page.getByTestId('claim-sheet');
  await expect(claimSheet).toContainText('超预算');
  await expect(page.getByTestId('claim-budget-check')).toContainText('超出 ¥50.00');
  // 门槛以内超预算：不再登记即确认，走「超预算报销」一级店主；店主在详情里同意
  await expect(claimSheet).toContainText('待确认');
  await page.getByTestId('claim-approve').click();
  await expect(claimSheet).toContainText('已确认');
  const link = page.getByTestId('claim-invoice-link');
  await expect(link).toContainText('E2E 文具店');
  await expect(link).toContainText('待认证');

  // ③ 发票台账：这张专票待认证，标已认证（所属期本月）
  await link.click();
  await expect(page).toHaveURL(/\/erp\/invoices\?invoice=\d+/);
  const sheet = page.getByTestId('invoice-sheet');
  await expect(sheet).toContainText('E2E 文具店');
  await expect(sheet).toContainText('报销');
  await expect(page.getByTestId('invoice-anomalies')).toHaveCount(0);
  await page.getByTestId('invoice-cert-status').selectOption('certified');
  await expect(page.getByTestId('invoice-cert-period')).toHaveValue(month);
  await page.getByTestId('invoice-cert-save').click();
  await expect(page.getByTestId('invoice-cert')).toContainText(`认证：已认证 · 所属期 ${month}`);
  await page.keyboard.press('Escape');
  await page.getByTestId('invoice-view-certified').click();
  await page.getByTestId('invoice-search').fill(invoiceNo);
  await expect(page.getByTestId(`invoice-row-${invoiceNo}`)).toContainText(`已认证 · ${month}`);

  // ④ 台账里直接登记一张普票：不用认证
  const normalNo = `PP${run}`;
  await page.getByTestId('invoice-new').click();
  await page.getByTestId('inv-kind').selectOption('vat_normal');
  await page.getByTestId('inv-no').fill(normalNo);
  await page.getByTestId('inv-issuer').fill('路边餐馆');
  await page.getByTestId('inv-total').fill('88');
  await page.getByTestId('inv-rate').selectOption('100');
  await page.getByTestId('invoice-create-submit').click();
  await expect(page.getByTestId('invoice-sheet')).toContainText('路边餐馆');
  await expect(page.getByText(normalNo, { exact: true })).toBeVisible();
  await expect(page.getByTestId('invoice-cert')).toContainText('认证：不用认证');
  await page.keyboard.press('Escape');

  // ⑤ 再登记一张专票，在「待认证」里勾选、一次标已认证
  const specialNo = `ZQ${run}`;
  await page.getByTestId('invoice-new').click();
  await page.getByTestId('inv-kind').selectOption('vat_special');
  await page.getByTestId('inv-no').fill(specialNo);
  await page.getByTestId('inv-issuer').fill('E2E 五金店');
  await page.getByTestId('inv-total').fill('226');
  await page.getByTestId('inv-rate').selectOption('1300');
  await page.getByTestId('invoice-create-submit').click();
  await expect(page.getByTestId('invoice-cert')).toContainText('认证：待认证');
  await page.keyboard.press('Escape');
  await page.getByTestId('invoice-view-pending').click();
  await page.getByTestId('invoice-search').fill(specialNo);
  const row = page.getByTestId(`invoice-row-${specialNo}`);
  await expect(row).toContainText('待认证');
  await page.getByTestId('invoice-pick-all').check();
  await page.getByTestId('invoice-certify-batch').click();
  await expect(page.getByTestId('invoice-certify-period')).toHaveValue(month);
  await page.getByTestId('invoice-certify-submit').click();
  await expect(row).toHaveCount(0);
  await page.getByTestId('invoice-view-certified').click();
  await expect(page.getByTestId(`invoice-row-${specialNo}`)).toContainText(`已认证 · ${month}`);

  // ⑥ 详情开着的时候别人改了认证、页面又刷新了：保存按打开时的版本核对，不拿旧表单盖掉别人的修改（Codex 自动审查 84f5fe5）
  await page.getByTestId(`invoice-row-${specialNo}`).getByRole('button').click();
  await expect(page.getByTestId('invoice-cert')).toContainText('认证：已认证');
  const invoiceId = Number(new URL(page.url()).searchParams.get('invoice'));
  const seen = (await (await page.request.get(`/api/erp/invoices/${invoiceId}`)).json()) as { certVersion: number };
  const otherCert = await page.request.post(`/api/erp/invoices/${invoiceId}/cert`, { data: { status: 'pending', period: null, note: '另一个人改回待认证', version: seen.certVersion } });
  expect(otherCert.ok()).toBe(true);
  const refreshed = page.waitForResponse((r) => r.url().endsWith(`/api/erp/invoices/${invoiceId}`) && r.request().method() === 'GET');
  await page.waitForTimeout(5_500);
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await refreshed;
  await page.locator('#inv-cert-note').fill('E2E 核对过');
  await page.getByTestId('invoice-cert-save').click();
  await expect(page.getByTestId('invoice-cert')).toContainText('认证刚被别人改过');
  await expect(page.getByTestId('invoice-cert')).toContainText('认证：待认证');
  await expect(page.getByTestId('invoice-cert-status')).toHaveValue('pending');
  const after = (await (await page.request.get(`/api/erp/invoices/${invoiceId}`)).json()) as { certStatus: string; certNote: string };
  expect(after).toMatchObject({ certStatus: 'pending', certNote: '另一个人改回待认证' });
  await page.keyboard.press('Escape');

  const checks = (await (await page.request.get('/api/erp/expenses/checks')).json()) as { label: string; ok: boolean }[];
  for (const c of checks) expect(c.ok, c.label).toBe(true);
}
