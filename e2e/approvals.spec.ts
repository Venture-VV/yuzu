// v0.7.30 审批中心的浏览器验收（docs/APPROVALS.md）：
//   ① 店主在「审批规则」里建两级规则（负责人 → 店主），对账付款登记一笔命中的付款；店主在手机尺寸的审批中心逐级同意，第二级同意后付款生效；
//   ② 批量同意：勾两张同一种、不超过 ¥5,000 的付款一起同意；
//   ③ 盘点大差异：没写原因不能提交，写了原因提交后进审批中心，详情里看到账面、实盘、差异与原因。
// 依赖演示数据（只在独立演示库）；账号：店主 linlan、对账付款 qianfen，密码 yuzu2026。会登记单据，只在门店电脑尺寸执行。
// 规则用一个别的用例碰不到的金额区间，用完停用，不影响其他用例的默认规则。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

async function logout(page: Page) {
  await page.request.post('/api/auth/logout');
  await page.context().clearCookies();
}

async function newSupplier(page: Page) {
  const code = `ZA${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  const res = await page.request.post('/api/inventory/suppliers', { data: { code, name: `E2E 审批供应商${code}` } });
  expect(res.status(), await res.text()).toBe(201);
  const list = (await (await page.request.get('/api/inventory/suppliers')).json()) as { id: number; code: string }[];
  return list.find((s) => s.code === code)!;
}

async function prepay(page: Page, supplierId: number, cents: number) {
  const me = (await (await page.request.get('/api/auth/me')).json()) as { calendarToday: string };
  const res = await page.request.post('/api/payables/payments', {
    data: { clientKey: randomUUID(), supplierId, payDate: me.calendarToday, amountCents: cents, method: 'bank_transfer', evidence: '转账流水 E2E', note: '预付货款（E2E）', prepay: true },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).payment as { id: number; docNo: string; status: string };
}

test.describe('审批中心（v0.7.30）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('两级规则：对账付款登记的付款先负责人、再店主；手机上逐级同意，最后一级同意后付款生效', async ({ page }) => {
    await login(page, 'linlan');
    const supplier = await newSupplier(page);
    // 店主建规则：付款 ¥88,888 到 ¥88,889（不含）→ 负责人 → 店主
    await page.goto('/approvals?tab=rules');
    await page.getByTestId('approval-rule-new').click();
    await page.getByTestId('approval-rule-doctype').selectOption('payment');
    await page.getByTestId('approval-rule-min').fill('88888');
    await page.locator('#rule-max').fill('88889');
    await page.getByTestId('approval-rule-add-step').click();
    await expect(page.getByTestId('approval-rule-step-2')).toBeVisible();
    await page.locator('#rule-note').fill('E2E 两级付款');
    await page.getByTestId('approval-rule-save').click();
    await expect(page.getByText('规则已建好').first()).toBeVisible();
    const rule = ((await (await page.request.get('/api/approvals/rules')).json()) as { id: number; version: number; note: string; active: boolean; stepLabels: string[] }[]).find(
      (r) => r.note === 'E2E 两级付款' && r.active,
    )!;
    expect(rule.stepLabels).toEqual(['负责人', '店主']);
    try {
      await logout(page);
      await login(page, 'qianfen');
      const payment = await prepay(page, supplier.id, 8_888_850);
      expect(payment.status).toBe('submitted');
      await logout(page);

      // 店主在手机上审：卡片一列，点开整屏详情，底部固定「同意」「退回」
      await page.setViewportSize({ width: 390, height: 844 });
      await login(page, 'linlan');
      await page.goto('/approvals');
      const card = page.getByTestId(`approval-card-${payment.docNo}`);
      await expect(card).toContainText('第 1/2 级');
      await expect(card).toContainText('负责人');
      await card.getByRole('button').click();
      await expect(page.getByTestId('approval-chain-1')).toContainText('审批中');
      await page.getByTestId('approval-comment').fill('金额核对无误');
      await page.getByTestId('approval-approve').click();
      await expect(page.getByText('已同意第 1 级').first()).toBeVisible();
      await expect(page.getByTestId('approval-chain-1')).toContainText('已同意');
      await expect(page.getByTestId('approval-chain-1')).toContainText('金额核对无误');
      await expect(page.getByTestId('approval-chain-2')).toContainText('审批中');
      await page.getByTestId('approval-approve').click();
      await expect(page.getByText('已同意，单据生效').first()).toBeVisible();
      await expect(page.getByTestId('approval-chain-2')).toContainText('已同意');
      const after = (await (await page.request.get(`/api/payables/payments/${payment.id}`)).json()) as { status: string; approval: { status: string; actions: unknown[] } };
      expect(after.status).toBe('confirmed');
      expect(after.approval).toMatchObject({ status: 'approved' });
      expect(after.approval.actions).toHaveLength(2);
      // 手机宽度不横向滚动
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    } finally {
      const fresh = ((await (await page.request.get('/api/approvals/rules')).json()) as { id: number; version: number }[]).find((r) => r.id === rule.id)!;
      await page.request.post(`/api/approvals/rules/${rule.id}/active`, { data: { version: fresh.version, active: false } });
    }
  });

  test('批量同意：勾选两张同一种、不超过 ¥5,000 的付款一起同意', async ({ page }) => {
    await login(page, 'linlan');
    const supplier = await newSupplier(page);
    await logout(page);
    await login(page, 'qianfen');
    const a = await prepay(page, supplier.id, 123_456);
    const b = await prepay(page, supplier.id, 234_567);
    await logout(page);
    await login(page, 'linlan');
    await page.goto('/approvals');
    await page.getByTestId(`approval-pick-${a.docNo}`).check();
    await page.getByTestId(`approval-pick-${b.docNo}`).check();
    await page.getByTestId('approval-batch').click();
    await page.getByTestId('approval-batch-confirm').click();
    const result = page.getByTestId('approval-batch-result');
    await expect(result).toContainText(a.docNo);
    await expect(result).toContainText(b.docNo);
    await expect(result).not.toContainText('没成功');
    for (const p of [a, b]) {
      expect(((await (await page.request.get(`/api/payables/payments/${p.id}`)).json()) as { status: string }).status).toBe('confirmed');
    }
  });

  test('盘点大差异：没写原因不能提交；写了原因进审批中心，详情里看到账面、实盘、差异与原因', async ({ page }) => {
    await login(page, 'linlan');
    const code = `ZC${String(Date.now()).slice(-6)}`;
    const res = await page.request.post('/api/inventory/materials', {
      data: { code, name: `E2E 盘点物料${code}`, category: 'E2E', inventoryUnit: '包', purchaseUnit: '箱', purchaseFactorMilli: 10_000, refPriceCents: 3_000 },
    });
    expect(res.status(), await res.text()).toBe(201);
    const mat = ((await (await page.request.get('/api/inventory/materials?all=1')).json()) as { id: number; code: string }[]).find((m) => m.code === code)!;
    const me = (await (await page.request.get('/api/auth/me')).json()) as { calendarToday: string };
    const opening = await page.request.post('/api/inventory/docs', {
      data: { clientKey: randomUUID(), docType: 'opening', docDate: me.calendarToday, approveNow: true, lines: [{ materialId: mat.id, qtyMilli: 100_000 }] },
    });
    expect(opening.status(), await opening.text()).toBe(201);

    await page.goto('/inventory/new/count');
    await page.getByLabel('添加物料').fill(code);
    await page.keyboard.press('Enter');
    await page.keyboard.type('80');
    const reason = page.getByTestId(`count-reason-${mat.id}`);
    await expect(reason).toContainText('大差异，必须写原因');
    await expect(page.getByRole('button', { name: /提交确认/ })).toBeDisabled();
    await reason.getByLabel(/差异原因/).selectOption('damaged');
    await reason.getByLabel(/差异说明/).fill('库房漏水泡坏');
    await page.getByRole('button', { name: /提交确认/ }).click();
    await expect(page.getByText('已提交，等待负责人确认')).toBeVisible();

    await page.goto('/approvals');
    const card = page.locator('[data-testid^="approval-card-"]').filter({ hasText: `E2E 盘点物料${code}` });
    await expect(card).toContainText('盘点差异');
    await card.getByRole('button').click();
    const lines = page.getByTestId('approval-lines');
    await expect(lines).toContainText('大差异');
    await expect(lines).toContainText('损坏');
    await expect(lines).toContainText('库房漏水泡坏');
    await expect(lines).toContainText('-20%');
    await page.getByTestId('approval-approve').click();
    await expect(page.getByText('已同意，单据生效').first()).toBeVisible();
    const stock = ((await (await page.request.get(`/api/inventory/materials/${mat.id}`)).json()) as { stockMilli: number }).stockMilli;
    expect(stock).toBe(80_000);
  });
});
