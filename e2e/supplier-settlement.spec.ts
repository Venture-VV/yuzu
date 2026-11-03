// v0.7.12 供应商结算（飞书需求 RQ-002 第二步）浏览器验收：退货待供应商确认 → 采购登记同意 → 退货余额核销与供应商退款；
// 批量导入供应商。依赖 seed-demo 与 seed-inventory-demo（仅独立演示库）。
// 账号：店主 linlan / 物资经办 lixiao / 采购 zhouyi / 对账付款 qianfen，密码 yuzu2026。会改演示数据，断言都用相对变化。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string, landing: RegExp | string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: landing })).toBeVisible({ timeout: 30_000 });
}

const logout = (page: Page) => page.request.post('/api/auth/logout');
const getJson = async <T>(page: Page, url: string) => (await (await page.request.get(url)).json()) as T;
async function post<T = Record<string, any>>(page: Page, url: string, data: unknown, status = [200, 201]): Promise<T> {
  const res = await page.request.post(url, { data });
  expect(status, `${url} ${await res.text()}`).toContain(res.status());
  return (await res.json()) as T;
}

/** 店主用接口准备：S003 的 M011 按采购单收货（每张 2 桶，单价自定），收货由周一（采购）一起验收 */
async function ownerSetup(page: Page) {
  const me = await getJson<{ calendarToday: string }>(page, '/api/auth/me');
  const today = me.calendarToday;
  const suppliers = await getJson<{ id: number; code: string; name: string }[]>(page, '/api/inventory/suppliers');
  const sup = suppliers.find((s) => s.code === 'S003')!;
  const materials = await getJson<{ id: number; code: string }[]>(page, '/api/inventory/materials');
  const mat = materials.find((m) => m.code === 'M011')!;
  const buyer = (await getJson<{ id: number; displayName: string }[]>(page, '/api/inventory/co-acceptors')).find((s) => s.displayName.startsWith('周一'))!;
  const receive = async (priceCents: number) => {
    const po = (await post(page, '/api/purchase-orders', { clientKey: crypto.randomUUID(), supplierId: sup.id, orderDate: today, approveNow: true, lines: [{ materialId: mat.id, purchaseQtyMilli: 2000, priceCents }] })).po;
    return (await post(page, '/api/inventory/docs', {
      clientKey: crypto.randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId: sup.id,
      purchaseOrderId: po.id,
      coAcceptorId: buyer.id,
      lines: [{ materialId: mat.id, poLineId: po.lines[0].id, deliveredMilli: po.lines[0].baseQtyMilli, acceptedMilli: po.lines[0].baseQtyMilli }],
    })).doc as { id: number; docNo: string; amountCents: number; lines: { id: number; qtyMilli: number }[] };
  };
  return { today, sup, receive };
}

test.describe('供应商结算：退货待供应商确认、退货余额核销与退款', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('退货 → 采购登记供应商同意 → 退货余额核销一部分、其余登记供应商退款', async ({ page }) => {
    // ── 店主用接口准备：采购单、按单收货（已付清），再退 2 个 ──
    await login(page, 'linlan', '会员工作台');
    const { today, sup, receive } = await ownerSetup(page);
    const paid = await receive(5_000);
    const pay = (await post(page, '/api/payables/payments', {
      clientKey: crypto.randomUUID(),
      supplierId: sup.id,
      payDate: today,
      amountCents: paid.amountCents,
      method: 'bank_transfer',
      evidence: 'E2E 付清',
      approveNow: true,
      allocations: [{ kind: 'receipt', targetId: paid.id, amountCents: paid.amountCents }],
    })).payment;
    expect(pay.status).toBe('confirmed');
    const fresh = await receive(4_000); // 还没付的新货款，用来核销
    const ret = (await post(page, '/api/inventory/docs', {
      clientKey: crypto.randomUUID(),
      docType: 'supplier_return',
      docDate: today,
      sourceDocId: paid.id,
      note: 'E2E 质量问题',
      lines: [{ sourceLineId: paid.lines[0]!.id, qtyMilli: paid.lines[0]!.qtyMilli / 2 }],
      approveNow: true,
    })).doc as { id: number; docNo: string; status: string; amountCents: number };
    // 演示库的免确认门槛是 0：店主「提交并确认」后进入等供应商确认
    expect(ret.status).toBe('awaiting_supplier');
    await logout(page);

    // ── 采购在单据详情登记「供应商已同意」──
    await login(page, 'zhouyi', '库存');
    await page.goto(`/inventory/docs?doc=${ret.id}`);
    const sheet = page.getByRole('dialog', { name: '库存单据详情' });
    await expect(sheet.getByText('等供应商确认：库存、货款都还没动')).toBeVisible();
    await sheet.getByTestId('supplier-agree').click();
    await page.getByLabel('对方联系人或说明').fill('E2E 业务员同意');
    await page.getByTestId('supplier-agree-submit').click();
    await expect(page.getByText('供应商已同意：退货生效，已出库扣款')).toBeVisible();
    // 原收货单已经付清：整笔是退货余额
    await expect(sheet.getByTestId('return-credit')).toContainText('还可以抵扣 / 退款');
    await logout(page);

    // ── 对账付款在对账单的「可抵扣」：核销一半到新货款，其余登记供应商退款 ──
    await login(page, 'qianfen', '库存');
    await page.goto(`/payables?view=statement&supplier=${sup.id}`);
    const credit = page.getByTestId(`credit-${ret.docNo}`);
    await expect(credit).toBeVisible();
    await credit.getByRole('button', { name: '核销' }).click();
    const half = ret.amountCents / 2;
    await page.getByLabel(`核销 ${fresh.docNo}`).fill((half / 100).toFixed(2));
    await page.getByTestId('offset-submit').click();
    await expect(page.getByText('已核销').first()).toBeVisible();
    await expect(credit).toContainText(`¥${(half / 100).toFixed(2)}`);
    await credit.getByRole('button', { name: '登记退款' }).click();
    await page.getByLabel('凭据说明').fill('E2E 到账');
    await page.getByTestId('refund-submit').click();
    await expect(page.getByText('已登记供应商退款')).toBeVisible();
    await expect(page.getByTestId(`credit-${ret.docNo}`)).toHaveCount(0);
    await expect(page.getByTestId('credits-section')).toContainText('核销与供应商退款记录');

    // 账实与往来自检全 ✓
    const checks = await getJson<{ key: string; ok: boolean; detail: string }[]>(page, '/api/inventory/checks');
    for (const c of checks) expect(c.ok, `${c.key} ${c.detail}`).toBe(true);
  });

  test('核销的响应丢了：自动查回只登记一次；请求没发出去：刷新后仍待确认、不能登记新的核销，按原内容重新提交只登记一次', async ({ page }) => {
    // ── 店主用接口准备：一笔还没付的货款，与一笔 20 元的预付款（可抵扣）──
    await login(page, 'linlan', '会员工作台');
    const { today, sup, receive } = await ownerSetup(page);
    const fresh = await receive(3_000);
    const prepaid = (await post(page, '/api/payables/payments', {
      clientKey: crypto.randomUUID(),
      supplierId: sup.id,
      payDate: today,
      amountCents: 2_000,
      method: 'bank_transfer',
      evidence: 'E2E 定金',
      note: 'E2E 先付定金',
      prepay: true,
      approveNow: true,
      allocations: [],
    })).payment as { docNo: string; status: string };
    expect(prepaid.status).toBe('confirmed');
    await logout(page);

    await login(page, 'qianfen', '库存');
    const offsetsOf = async () =>
      (await getJson<{ credit: { docNo: string }; status: string }[]>(page, `/api/payables/offsets?supplierId=${sup.id}`)).filter(
        (o) => o.credit.docNo === prepaid.docNo && o.status === 'confirmed',
      ).length;
    const isPost = (url: URL) => url.pathname === '/api/payables/offsets';
    const openOffset = async (amount: string) => {
      await page.goto(`/payables?view=statement&supplier=${sup.id}`);
      await page.getByTestId(`credit-${prepaid.docNo}`).getByRole('button', { name: '核销' }).click();
      await page.getByLabel(`核销 ${fresh.docNo}`).fill(amount);
    };

    // ① 服务器已登记、响应丢了：页面记下待确认后马上按原编号查回，只登记一次
    await openOffset('5.00');
    await page.route(isPost, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      await route.abort('internetdisconnected');
    });
    await page.getByTestId('offset-submit').click();
    await expect(page.getByText('已查回：核销已登记')).toBeVisible({ timeout: 15_000 });
    await page.unroute(isPost);
    await expect(page.getByTestId('erp-pending')).toHaveCount(0);
    expect(await offsetsOf()).toBe(1);

    // ② 请求没发出去：刷新后仍显示「结果待确认」，这时不能登记新的核销；按原内容重新提交只登记一次
    await openOffset('6.00');
    await page.route(isPost, (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
    await page.getByTestId('offset-submit').click();
    await expect(page.getByTestId('erp-pending')).toContainText('核销结果待确认');
    await page.unroute(isPost);
    await page.reload();
    await expect(page.getByTestId('erp-pending')).toContainText(prepaid.docNo);
    await page.getByTestId(`credit-${prepaid.docNo}`).getByRole('button', { name: '核销' }).click();
    await expect(page.getByTestId('offset-submit')).toBeDisabled();
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    await page.getByTestId('erp-pending-resend').click();
    await expect(page.getByTestId('erp-pending')).toHaveCount(0);
    expect(await offsetsOf()).toBe(2);
    const checks = await getJson<{ key: string; ok: boolean; detail: string }[]>(page, '/api/inventory/checks');
    for (const c of checks) expect(c.ok, `${c.key} ${c.detail}`).toBe(true);
  });

  test('登记付款结果待确认（v0.7.22）：刷新后仍在、不能另起一笔；按原内容重新提交只登记一次；作废后原请求晚到也不登记', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    const { sup, receive } = await ownerSetup(page);
    const first = await receive(4_100);
    const second = await receive(4_200);
    await logout(page);

    await login(page, 'qianfen', '库存');
    const paymentsOf = async (docNo: string) =>
      (await getJson<{ status: string; allocations: { docNo: string }[] }[]>(page, `/api/payables/payments?supplierId=${sup.id}`)).filter(
        (p) => p.status !== 'voided' && p.allocations.some((a) => a.docNo === docNo),
      ).length;
    const isPost = (url: URL) => url.pathname === '/api/payables/payments';
    const fillPayment = async (docNo: string) => {
      await page.goto(`/payables/pay?supplier=${sup.id}`);
      await page.getByLabel(`核销 ${docNo}`).check();
      await page.fill('#pay-ev', '流水尾号 7022');
    };
    const submit = page.getByRole('button', { name: '登记付款', exact: true });

    // ① 请求没发出去：结果待确认记在本机，刷新后仍在；这时不能另起一笔；按原内容重新提交只登记一次
    await fillPayment(first.docNo);
    await page.route(isPost, (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
    await submit.click();
    await expect(page.getByTestId('erp-pending')).toContainText('供应商付款结果待确认');
    await page.unroute(isPost);
    await page.reload();
    await expect(page.getByTestId('erp-pending')).toContainText(first.docNo);
    await page.getByLabel(`核销 ${second.docNo}`).check();
    await page.fill('#pay-ev', '流水尾号 7023');
    await expect(page.getByText('上一笔付款结果待确认，请先在上方查回、按原内容重新提交或作废')).toBeVisible();
    await expect(submit).toBeDisabled();
    await page.getByTestId('erp-pending-resend').click();
    await expect(page).toHaveURL(/view=payments/);
    await expect(page.getByTestId('erp-pending')).toHaveCount(0);
    expect(await paymentsOf(first.docNo)).toBe(1);

    // ② 请求没发出去、之后确认作废：原请求（同一编号、同样内容）晚到也不登记
    await fillPayment(second.docNo);
    await page.route(isPost, (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
    await submit.click();
    await expect(page.getByTestId('erp-pending')).toContainText(second.docNo);
    await page.unroute(isPost);
    const original = await page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('yuzu.erpPending.v1') ?? '[]') as { type: string; url: string; body: unknown }[];
      return list.find((op) => op.type === 'payment')!;
    });
    await page.getByTestId('erp-pending-abandon').click();
    await page.getByTestId('erp-pending-abandon-confirm').click();
    await expect(page.getByTestId('erp-pending')).toHaveCount(0);
    const late = await page.request.post(original.url, { data: original.body });
    expect(late.status()).toBe(409);
    expect(((await late.json()) as { error: { code: string } }).error.code).toBe('OP_ABANDONED');
    expect(await paymentsOf(second.docNo)).toBe(0);
    // 作废后可以重新填写登记（新的操作编号）
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page).toHaveURL(/view=payments/);
    expect(await paymentsOf(second.docNo)).toBe(1);
    const checks = await getJson<{ key: string; ok: boolean; detail: string }[]>(page, '/api/inventory/checks');
    for (const c of checks) expect(c.ok, `${c.key} ${c.detail}`).toBe(true);
  });

  test('登记付款已经提交、回复却是服务器出错（500）：按结果待确认处理、不能另起一笔，查回就是已登记的那一笔（v0.7.23，Codex 在 main v0.7.22 上报的 P1）', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    const { sup, receive } = await ownerSetup(page);
    const doc = await receive(4_300);
    await logout(page);

    await login(page, 'qianfen', '库存');
    const paymentsOf = async (docNo: string) =>
      (await getJson<{ status: string; allocations: { docNo: string }[] }[]>(page, `/api/payables/payments?supplierId=${sup.id}`)).filter(
        (p) => p.status !== 'voided' && p.allocations.some((a) => a.docNo === docNo),
      ).length;
    const isPost = (url: URL) => url.pathname === '/api/payables/payments';
    const isLookup = (url: URL) => url.pathname.startsWith('/api/erp/ops/');
    await page.goto(`/payables/pay?supplier=${sup.id}`);
    await page.getByLabel(`核销 ${doc.docNo}`).check();
    await page.fill('#pay-ev', '流水尾号 7023');
    // 请求真的发到服务端、登记成功（201），回到页面的却是 500（例如登记后读结果时出错）；查回暂时也连不上
    await page.route(isPost, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const res = await route.fetch();
      expect(res.status()).toBe(201);
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL', message: '服务器出了点问题，操作可能未完成，请通过单号或流水核对结果' } }),
      });
    });
    await page.route(isLookup, (route) => route.abort('internetdisconnected'));
    const submit = page.getByRole('button', { name: '登记付款', exact: true });
    await submit.click();
    await expect(page.getByTestId('erp-pending')).toContainText('供应商付款结果待确认');
    await expect(page.getByText('付款没有登记')).toHaveCount(0);
    expect(await paymentsOf(doc.docNo)).toBe(1);
    // 原来这时记录被删、按钮可用，再点一次就用新编号又登记一笔
    await expect(page.getByText('上一笔付款结果待确认，请先在上方查回、按原内容重新提交或作废')).toBeVisible();
    await expect(submit).toBeDisabled();
    // 查回：就是已经登记的那一笔，只登记了一次
    await page.unroute(isLookup);
    await page.unroute(isPost);
    await page.getByTestId('erp-pending-check').click();
    await expect(page).toHaveURL(/view=payments/);
    await expect(page.getByTestId('erp-pending')).toHaveCount(0);
    expect(await paymentsOf(doc.docNo)).toBe(1);
  });

  test('批量导入供应商：预览 → 写入；同一个文件不能再写', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    await page.goto('/payables/import');
    const code = `E${Date.now().toString().slice(-6)}`;
    const csv = `编码,名称,结算方式\n${code},E2E 导入供应商,现付\n`;
    await page.getByTestId('import-file').setInputFiles({ name: 'e2e-suppliers.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    // 预览还没回来时不能换文件、换类型（不能让上一个文件的预览配着新文件写入）
    const isPreview = (url: URL) => url.pathname === '/api/payables/imports/preview';
    await page.route(isPreview, async (route) => {
      await new Promise((r) => setTimeout(r, 1_500));
      await route.continue();
    });
    await page.getByRole('button', { name: '预览' }).click();
    await expect(page.getByTestId('import-file')).toBeDisabled();
    await expect(page.getByTestId('import-preview')).toContainText('全部可以导入');
    await page.unroute(isPreview);
    await expect(page.getByTestId('import-file')).toBeEnabled();
    await page.getByTestId('import-apply').click();
    await expect(page.getByText('已导入 1 行供应商')).toBeVisible();
    const suppliers = await getJson<{ code: string; settlement: string }[]>(page, '/api/inventory/suppliers?all=1');
    expect(suppliers.find((s) => s.code === code)).toMatchObject({ settlement: 'cash' });
    // 同一个文件再预览：提示已经导入过，不能再写
    await page.getByTestId('import-file').setInputFiles({ name: 'e2e-suppliers.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await page.getByRole('button', { name: '预览' }).click();
    await expect(page.getByText(/这个文件已经在/)).toBeVisible();
    await expect(page.getByTestId('import-apply')).toBeDisabled();
  });
});

test.describe('平板布局', () => {
  test('货款的核销与退款、导入页无横向溢出', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    for (const url of ['/payables', '/payables?view=settlements', '/payables/import', '/payables/pay']) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, url).toBeLessThanOrEqual(1);
    }
  });
});
