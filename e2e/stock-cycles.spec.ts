// v0.7.13 Batch 4 收尾浏览器验收：台面日耗品（领到部门即算耗用）、称重（按实际称重收货可多出容差）、
// 按批次对账的登记与撤销、规则总表的新规则。依赖 seed-demo 与 seed-inventory-demo（仅独立演示库）。
// 账号：店主 linlan / 物资经办 lixiao / 采购 zhouyi，密码 yuzu2026。会改演示数据，断言都用相对变化。
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
async function send<T = Record<string, any>>(page: Page, method: 'POST' | 'PUT', url: string, data: unknown, status = [200, 201]): Promise<T> {
  const res = method === 'POST' ? await page.request.post(url, { data }) : await page.request.put(url, { data });
  expect(status, `${url} ${await res.text()}`).toContain(res.status());
  return (await res.json()) as T;
}
const stamp = () => String(Date.now()).slice(-5);

/** 店主用接口准备：按采购单收货（一起验收的是采购周一），返回收货单 */
async function receiveViaPo(page: Page, supplierId: number, materialId: number, purchaseQtyMilli: number, priceCents: number, acceptedMilli?: number) {
  const me = await getJson<{ calendarToday: string }>(page, '/api/auth/me');
  const buyer = (await getJson<{ id: number; displayName: string }[]>(page, '/api/inventory/co-acceptors')).find((s) => s.displayName.startsWith('周一'))!;
  const po = (await send(page, 'POST', '/api/purchase-orders', {
    clientKey: crypto.randomUUID(),
    supplierId,
    orderDate: me.calendarToday,
    approveNow: true,
    lines: [{ materialId, purchaseQtyMilli, priceCents }],
  })).po as { id: number; docNo: string; lines: { id: number; baseQtyMilli: number }[] };
  const qty = acceptedMilli ?? po.lines[0]!.baseQtyMilli;
  const doc = (await send(page, 'POST', '/api/inventory/docs', {
    clientKey: crypto.randomUUID(),
    docType: 'receipt',
    docDate: me.calendarToday,
    supplierId,
    purchaseOrderId: po.id,
    coAcceptorId: buyer.id,
    lines: [{ materialId, poLineId: po.lines[0]!.id, deliveredMilli: qty, acceptedMilli: qty }],
  })).doc as { id: number; docNo: string; amountCents: number; status: string };
  return { po, doc, today: me.calendarToday };
}

test.describe('台面日耗品、称重与对账（v0.7.13）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('台面日耗品：物料档案勾选后，领到部门即算耗用；部门小仓标出、领料单标出「已记部门耗用」', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    const code = `T${stamp()}`;
    // 物料档案里勾选「台面日耗品」
    await page.goto('/inventory/master');
    await page.getByRole('button', { name: '新增物料' }).click();
    const dialog = page.getByRole('dialog', { name: '新增物料' });
    await dialog.getByRole('textbox', { name: '编码', exact: true }).fill(code);
    await dialog.getByRole('textbox', { name: '名称', exact: true }).fill(`E2E 一次性牙刷 ${code}`);
    await dialog.getByRole('textbox', { name: '库存单位', exact: true }).fill('支');
    await dialog.getByRole('textbox', { name: '采购单位', exact: true }).fill('盒');
    await dialog.getByRole('textbox', { name: '1 盒 =', exact: true }).fill('100');
    await dialog.getByRole('checkbox', { name: /台面日耗品/ }).check();
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('row', { name: new RegExp(code) }).getByText('台面日耗品')).toBeVisible();

    const mat = (await getJson<{ id: number; code: string; counterUse: boolean }[]>(page, '/api/inventory/materials')).find((m) => m.code === code)!;
    expect(mat.counterUse).toBe(true);
    const sup = (await getJson<{ id: number; code: string }[]>(page, '/api/inventory/suppliers')).find((s) => s.code === 'S003')!;
    await receiveViaPo(page, sup.id, mat.id, 1000, 3_000); // 1 盒 = 100 支
    const dept = (await getJson<{ id: number; name: string }[]>(page, '/api/inventory/departments')).find((d) => d.name === '浴区')!;
    const me = await getJson<{ calendarToday: string }>(page, '/api/auth/me');
    const issue = (await send(page, 'POST', '/api/inventory/docs', {
      clientKey: crypto.randomUUID(),
      docType: 'issue',
      docDate: me.calendarToday,
      departmentId: dept.id,
      handler: 'E2E 浴区',
      lines: [{ materialId: mat.id, qtyMilli: 30_000 }],
    })).doc as { id: number; lines: { autoConsumed: boolean }[] };
    expect(issue.lines[0]!.autoConsumed).toBe(true);

    // 领料单详情：标出「已记部门耗用」
    await page.goto(`/inventory/docs?doc=${issue.id}`);
    const sheet = page.getByRole('dialog', { name: '库存单据详情' });
    await expect(sheet.getByText('已记部门耗用')).toBeVisible();

    // 本部门小仓：这个物料结存 0，标「台面日耗品 · 领到即耗用」，不提醒补货
    await page.goto(`/erp/dept-stock?dept=${dept.id}`);
    const row = page.getByTestId('dept-stock-list').getByRole('listitem').filter({ hasText: code });
    await expect(row.getByText('台面日耗品 · 领到即耗用')).toBeVisible();
    await expect(row.getByText('该补货了')).toHaveCount(0);
  });

  test('称重：按实际称重收货，可以比采购单多出容差；收货单提示，采购单显示「称重多到」', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    const code = `W${stamp()}`;
    const mat = await send<{ id: number; weighed: boolean }>(page, 'POST', '/api/inventory/materials', {
      code,
      name: `E2E 猪肉 ${code}`,
      inventoryUnit: '斤',
      decimals: 2,
      purchaseUnit: '斤',
      purchaseFactorMilli: 1000,
      weighed: true,
    });
    expect(mat.weighed).toBe(true);
    const sup = (await getJson<{ id: number; code: string }[]>(page, '/api/inventory/suppliers')).find((s) => s.code === 'S003')!;
    // 订 10 斤，实际称了 10.6 斤（容差 10% 以内）
    const { po, doc } = await receiveViaPo(page, sup.id, mat.id, 10_000, 1_800, 10_600);
    expect(doc).toMatchObject({ status: 'confirmed', amountCents: 19_080 });
    await page.goto(`/purchasing?po=${po.id}`);
    await expect(page.getByText(/称重多到 0\.6 斤/)).toBeVisible();

    // 仓库按另一张采购单收货：超过容差时表单直接提示
    const po2 = (await send(page, 'POST', '/api/purchase-orders', {
      clientKey: crypto.randomUUID(),
      supplierId: sup.id,
      orderDate: (await getJson<{ calendarToday: string }>(page, '/api/auth/me')).calendarToday,
      approveNow: true,
      lines: [{ materialId: mat.id, purchaseQtyMilli: 10_000, priceCents: 1_800 }],
    })).po as { id: number };
    await logout(page);
    await login(page, 'lixiao', '库存');
    await page.goto(`/inventory/new/receipt?po=${po2.id}`);
    await expect(page.getByText(/称重的物料按实际称重填，可以比订购数量多出 10%/)).toBeVisible();
    await page.getByLabel('送达数量').fill('11.5');
    await expect(page.getByText(/超出称重容差 10%/)).toBeVisible();
    await page.getByLabel('送达数量').fill('10.8');
    await expect(page.getByText(/超出称重容差/)).toHaveCount(0);
  });

  test('按批次对账：供应商改成按批次后，采购勾选收货单登记已对账；记录里可以撤销', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    // 供应商档案：S003 改成「按批次」对账
    await page.goto('/inventory/master');
    await page.getByRole('radio', { name: '供应商' }).click();
    await page.getByRole('button', { name: /S003/ }).click();
    const supDialog = page.getByRole('dialog', { name: /编辑供应商/ });
    await supDialog.getByRole('radio', { name: '按批次' }).click();
    await expect(supDialog.getByText('只提醒今天以后的收货')).toBeVisible();
    await supDialog.getByRole('button', { name: '保存' }).click();
    await expect(supDialog).toBeHidden();
    const sup = (await getJson<{ id: number; code: string; reconcileCycle: string }[]>(page, '/api/inventory/suppliers')).find((s) => s.code === 'S003')!;
    expect(sup.reconcileCycle).toBe('batch');
    const mat = (await getJson<{ id: number; code: string }[]>(page, '/api/inventory/materials')).find((m) => m.code === 'M011')!;
    const { doc } = await receiveViaPo(page, sup.id, mat.id, 1000, 3_300);
    await logout(page);

    // 采购在「货款 → 对账」勾选这张收货单登记
    await login(page, 'zhouyi', '库存');
    await page.goto('/payables?view=recon');
    await expect(page.getByTestId('recon-view')).toBeVisible();
    await page.getByRole('checkbox', { name: `对账 ${doc.docNo}` }).check();
    await page.getByTestId('recon-batch-register').first().click();
    const dlg = page.getByRole('dialog', { name: /登记已对账/ });
    await expect(dlg.getByText(doc.docNo)).toBeVisible();
    await dlg.getByLabel('备注').fill('E2E 与业务员核对一致');
    await page.getByTestId('recon-batch-submit').click();
    await expect(dlg).toBeHidden();
    await expect(page.getByRole('checkbox', { name: `对账 ${doc.docNo}` })).toHaveCount(0);
    const rec = page.getByTestId('recon-records').getByRole('listitem').filter({ hasText: doc.docNo }).first();
    await expect(rec.getByText('已对账')).toBeVisible();

    // 撤销登记：写原因
    await rec.getByRole('button', { name: '撤销' }).click();
    await page.getByRole('dialog', { name: /撤销对账登记/ }).getByRole('textbox').fill('E2E 金额核错了');
    await page.getByRole('button', { name: '撤销登记' }).click();
    await expect(rec.getByText('已撤销')).toBeVisible();
    // 撤销后这张又回到待对账
    await expect(page.getByRole('checkbox', { name: `对账 ${doc.docNo}` })).toBeVisible();
    await logout(page);

    // 还原成月结（不影响别的用例）
    await login(page, 'linlan', '会员工作台');
    const full = (await getJson<Record<string, unknown>[]>(page, '/api/inventory/suppliers?all=1')).find((s) => s.code === 'S003')!;
    await send(page, 'PUT', `/api/inventory/suppliers/${sup.id}`, { code: full.code, name: full.name, contact: full.contact, phone: full.phone, note: full.note, active: full.active, reconcileCycle: 'monthly' });
  });

  test('规则总表：称重容差与盘点、对账提醒的规则可以改', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    const before = await getJson<Record<string, unknown>>(page, '/api/inventory/settings');
    await page.goto('/admin/rules');
    await expect(page.getByLabel('每月盘点日')).toHaveValue('1');
    await expect(page.getByLabel('称重收货容差（%）')).toHaveValue('10');
    await page.getByLabel('按批次对账宽限天数').fill('5');
    await page.getByRole('button', { name: '保存库存规则' }).click();
    await expect(page.getByText('库存与采购规则已保存')).toBeVisible();
    const after = await getJson<{ batchReconGraceDays: number }>(page, '/api/inventory/settings');
    expect(after.batchReconGraceDays).toBe(5);
    await send(page, 'PUT', '/api/inventory/settings', before);
  });
});
