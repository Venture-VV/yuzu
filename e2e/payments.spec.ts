// v0.7.32 付款流的浏览器验收（docs/PAYMENTS.md）：
//   ① 一份已签署的采购合同（接口准备：起草、财务 → 法务 → 负责人审完、签署）：合同详情的「付款计划」列出四段，预付段可付；
//   ② 在预付段点「申请付款」，表单带出合同与节点，按「照常能申请的」填金额，提交走审批中心；在申请详情里审两级（财务、负责人）；
//   ③ 对账付款的人（这里是店主）登记付款：还没有收货单，整笔记为预付款，申请变「已付清」，合同的预付段「付清」；
//   ④ 合同详情登记验收（合格）与质量问题（未处理 → 已处理），验收段变可付；质保段的提前申请要写原因，单据类型是「提前付款」（三级）；
//   ⑤ ERP「付款」：发票登记分到采购单，三单「不齐」的财务放行；质保金台账、本周应付（填可用资金算缺口）；应付总览单独一列没到期的质保金。
// 依赖演示数据（只在独立演示库）；账号：店主 linlan，密码 yuzu2026。会登记单据，只在门店电脑尺寸执行。
// 每次用新的供应商、物料编码，不改演示数据里已有的档案。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { LEGAL_ITEM_KEYS } from '../src/shared/contracts';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

test.describe('付款流（v0.7.32）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('合同付款计划 → 付款申请两级审批 → 登记付款（预付）→ 验收与质量问题 → 提前付款 → 发票、三单放行、质保金、本周应付', async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, 'linlan');
    const me = (await (await page.request.get('/api/auth/me')).json()) as { calendarToday: string };
    const today = me.calendarToday;
    const tag = String(Date.now()).slice(-6);
    const supCode = `Z${tag}${Math.floor(Math.random() * 90 + 10)}`;
    expect((await page.request.post('/api/inventory/suppliers', { data: { code: supCode, name: `E2E 付款供应商${supCode}` } })).status()).toBe(201);
    const supplier = ((await (await page.request.get('/api/inventory/suppliers')).json()) as { id: number; code: string; name: string }[]).find((s) => s.code === supCode)!;
    const matCode = `ZP${tag}${Math.floor(Math.random() * 90 + 10)}`;
    const mres = await page.request.post('/api/inventory/materials', {
      data: { code: matCode, name: `E2E 付款物料${matCode}`, category: 'E2E', inventoryUnit: '包', purchaseUnit: '箱', purchaseFactorMilli: 10_000, refPriceCents: 5_000 },
    });
    expect(mres.status(), await mres.text()).toBe(201);
    const material = ((await (await page.request.get('/api/inventory/materials?all=1')).json()) as { id: number; code: string }[]).find((m) => m.code === matCode)!;

    // 准备：一份 ¥1,000 的采购合同（预付 20%、到货 20%、验收 50%、质保 10%），审完、签署
    const created = await page.request.post('/api/erp/contracts', {
      data: {
        clientKey: randomUUID(),
        category: 'purchase',
        supplierId: supplier.id,
        counterparty: '',
        content: {
          title: `E2E 付款流合同${tag}`,
          startDate: today,
          endDate: addDays(today, 365),
          totalCents: 100_000,
          taxRateBp: 1300,
          freightBearer: 'supplier',
          unloadingBearer: 'supplier',
          paymentTerms: [
            { stage: 'prepay', percentBp: 2000, condition: '签订后 7 天内' },
            { stage: 'delivery', percentBp: 2000, condition: '到货后' },
            { stage: 'acceptance', percentBp: 5000, condition: '验收合格后' },
            { stage: 'warranty', percentBp: 1000, condition: '质保期满' },
          ],
          warranty: { basis: 'acceptance', months: 12 },
          acceptance: { method: '按样品验收', signer: '仓库经办', penalty: '不合格退换' },
          note: '',
          lines: [{ materialId: material.id, itemName: '', spec: '', unit: '', priceCents: 5_000, taxRateBp: 1300, qtyMilli: 20_000 }],
        },
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    let c = (await created.json()).contract as { id: number; contractNo: string; version: number; approval: { requestId: number } | null };
    const submitted = await page.request.post(`/api/erp/contracts/${c.id}/submit`, { data: { version: c.version } });
    expect(submitted.ok(), await submitted.text()).toBe(true);
    c = await submitted.json();
    const rid = c.approval!.requestId;
    for (const [level, extra] of [
      [1, {}],
      [2, { checklist: LEGAL_ITEM_KEYS.map((key) => ({ key, verdict: 'pass', note: '' })) }],
      [3, {}],
    ] as const) {
      const r = await page.request.post(`/api/approvals/${rid}/approve`, { data: { level, comment: '', ...extra } });
      expect(r.ok(), await r.text()).toBe(true);
    }
    c = await (await page.request.get(`/api/erp/contracts/${c.id}`)).json();
    const signed = await page.request.post(`/api/erp/contracts/${c.id}/sign`, { data: { version: c.version, signedOn: today, ourSignatory: '林岚', theirSignatory: '王经理' } });
    expect(signed.ok(), await signed.text()).toBe(true);

    // ① 合同详情的付款计划
    await page.goto(`/erp/contracts/${c.id}`);
    const plan = page.getByTestId('contract-payment-plan');
    await expect(plan).toBeVisible();
    await expect(plan.getByTestId('plan-stage-prepay')).toContainText('合同');
    await expect(plan.getByTestId('plan-stage-acceptance')).toContainText('还没登记验收');
    await expect(plan.getByTestId('plan-request-prepay')).toHaveText(/申请付款/);

    // ② 申请预付款
    await plan.getByTestId('plan-request-prepay').click();
    await expect(page).toHaveURL(/\/erp\/payments\/requests\/new\?contract=\d+&stage=prepay$/);
    await expect(page.getByTestId('request-stage-plan')).toContainText('照常能申请');
    await page.getByRole('button', { name: /按照常能申请的填/ }).click();
    await expect(page.getByTestId('request-amount')).toHaveValue('200.00');
    await page.getByTestId('request-purpose').fill('预付款');
    await page.getByTestId('request-submit').click();
    await expect(page.getByText('付款申请已提交，等审批').first()).toBeVisible();
    await expect(page).toHaveURL(/\/erp\/payments\/requests\/\d+$/);
    const requestId = Number(/\/requests\/(\d+)$/.exec(page.url())![1]);
    const detail = async () => (await (await page.request.get(`/api/erp/payments/requests/${requestId}`)).json()) as { requestNo: string; status: string; paidCents: number };
    const req = await detail();
    expect(req.status).toBe('submitted');
    await expect(page.getByTestId('approval-level-1')).toContainText('财务');
    await expect(page.getByTestId('approval-level-2')).toContainText('负责人');
    // 店主在每一级都能审：第 1 级、第 2 级
    for (const n of [1, 2]) {
      await page.getByTestId(`review-open-${req.requestNo}`).click();
      await page.getByTestId('review-approve').click();
      await expect(page.getByText(n === 1 ? '已同意第 1 级' : '已同意，审批通过').first()).toBeVisible();
    }
    await expect(page.getByTestId('payment-request-detail')).toContainText('待付款');

    // ③ 登记付款：还没有收货单，整笔记为预付款
    await page.getByTestId('request-pay').click();
    await expect(page.getByTestId('pay-amount')).toHaveValue('200.00');
    await expect(page.getByRole('dialog')).toContainText('整笔记为预付款');
    await page.getByTestId('pay-evidence').fill('流水尾号 8899');
    await page.getByTestId('pay-confirm').click();
    await expect(page.getByText('付款已登记').first()).toBeVisible();
    await expect.poll(async () => (await detail()).status).toBe('paid');
    await expect(page.getByTestId('request-payments')).toContainText('记为预付款 ¥200.00');

    // ④ 验收（合格）与质量问题
    await page.goto(`/erp/contracts/${c.id}`);
    await expect(plan.getByTestId('plan-stage-prepay')).toContainText('付清');
    await plan.getByTestId('acceptance-new').click();
    await expect(page.getByTestId('acceptance-signer')).toHaveValue('仓库经办');
    await page.getByTestId('acceptance-result').selectOption('pass');
    await page.getByTestId('acceptance-confirm').click();
    await expect(page.getByText('已登记验收（合格）').first()).toBeVisible();
    await expect(plan.getByTestId('plan-stage-acceptance')).toContainText('验收合格');
    await expect(plan.getByTestId('warranty-state')).toContainText(`${today} 起`);
    await plan.getByTestId('quality-new').click();
    await page.getByTestId('quality-description').fill('有 2 箱破损');
    await page.getByTestId('quality-confirm').click();
    await expect(page.getByText('已登记质量问题').first()).toBeVisible();
    await expect(plan.getByTestId('quality-list')).toContainText('未处理');
    const issueId = Number((await plan.getByTestId('quality-list').locator('[data-testid^="quality-resolve-"]').first().getAttribute('data-testid'))!.split('-').pop());
    await plan.getByTestId(`quality-resolve-${issueId}`).click();
    await page.getByTestId('quality-resolution').fill('已换货');
    await page.getByTestId('quality-resolve-confirm').click();
    await expect(page.getByText('质量问题已标记处理').first()).toBeVisible();
    await expect(plan.getByTestId('quality-list')).toContainText('已处理');

    // 质保段还没到期：提前申请要写原因，单据类型「提前付款」、三级
    await plan.getByTestId('plan-request-warranty').click();
    await page.getByTestId('request-amount').fill('50');
    await expect(page.getByTestId('request-early-reason')).toBeVisible();
    await page.getByTestId('request-purpose').fill('质保金');
    await expect(page.getByTestId('request-submit')).toBeDisabled();
    await page.getByTestId('request-early-reason').fill('供应商资金周转，先付一半');
    await expect(page.getByTestId('request-submit')).toHaveText(/提前付款/);
    await page.getByTestId('request-submit').click();
    await expect(page.getByText('付款申请已提交，等审批').first()).toBeVisible();
    await expect(page.getByTestId('payment-request-detail')).toContainText('提前付款');
    await expect(page.getByTestId('approval-level-3')).toContainText('店主');

    // ⑤ 发票与三单：一张已确认的采购单（没收货）登记发票 → 「不齐」→ 财务放行
    const po = await page.request.post('/api/purchase-orders', {
      data: { clientKey: randomUUID(), supplierId: supplier.id, orderDate: today, approveNow: true, lines: [{ materialId: material.id, purchaseQtyMilli: 2_000, priceCents: 5_000 }] },
    });
    expect(po.status(), await po.text()).toBe(201);
    const poNo = (await po.json()).po.docNo as string;
    await page.goto('/erp/payments?tab=invoices');
    await page.getByTestId('invoice-new').click();
    await page.getByTestId('invoice-supplier').selectOption(String(supplier.id));
    const invoiceNo = `FP${tag}`;
    await page.getByTestId('invoice-no').fill(invoiceNo);
    await page.getByTestId('invoice-total').fill('100');
    await page.getByTestId(`invoice-split-${poNo}`).fill('100');
    await page.getByTestId('invoice-confirm').click();
    await expect(page.getByText('发票已登记').first()).toBeVisible();
    await expect(page.getByTestId(`invoice-row-${invoiceNo}`)).toContainText(poNo);
    await page.getByTestId('payments-tab-three-way').click();
    const row = page.getByTestId(`three-way-row-${poNo}`);
    await expect(row).toContainText('不齐');
    await row.getByTestId(`three-way-release-${poNo}`).click();
    await page.getByTestId('three-way-release-dialog-reason').fill('供应商先开票，货下周到');
    await page.getByTestId('three-way-release-dialog-confirm').click();
    await expect(page.getByText('已放行').first()).toBeVisible();
    await page.getByTestId('three-way-filter-all').click();
    await expect(page.getByTestId(`three-way-row-${poNo}`)).toContainText('已放行');

    // 质保金台账、本周应付
    await page.getByTestId('payments-tab-warranty').click();
    await expect(page.getByTestId(`warranty-row-${c.contractNo}`)).toContainText('未到期');
    await page.getByTestId('payments-tab-weekly').click();
    await expect(page.getByTestId('weekly-payables')).toContainText('第 1 周');
    await page.getByTestId('weekly-funds').fill('1');
    await expect(page.getByTestId('weekly-gap')).toBeVisible();

    // 应付总览：没到期的质保金单独一列
    await page.goto('/payables');
    await expect(page.getByTestId(`warranty-held-${supCode}`)).toBeVisible();
  });
});
