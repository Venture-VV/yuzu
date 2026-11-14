// 8.0.21 浏览器验收：供应商门户（docs/FINANCE_V8021.md 第 7 节，CW-F）。可重复执行（供应商、物料、单据都是现造的）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
//   · 询价单详情「请供应商在线报价」：选一家、生成报价链接 → 供应商（另一个没登录的浏览器）打开链接填单价、付款条件、姓名提交
//     → 回到询价单，报价里有这一家、标「供应商链接」；
//   · 已确认的采购单发订单确认链接 → 供应商确认、写承诺到货日 → 采购单详情显示「供应商已确认，承诺 X 到」
//     → 再发发货预告链接、供应商报一批 → 采购单详情列出这一批。
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const tag = String(Date.now()).slice(-6);

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

let seq = 0;
async function setup(page: Page) {
  // 同一个文件里两个用例各建一套：编号带序号，不撞号
  seq += 1;
  const sCode = `ZS${tag}${seq}`;
  const mCode = `ZSM${tag}${seq}`;
  expect((await page.request.post('/api/inventory/suppliers', { data: { code: sCode, name: `E2E 门户供应商${tag}-${seq}` } })).status()).toBe(201);
  const sup = ((await (await page.request.get('/api/inventory/suppliers')).json()) as { id: number; code: string; name: string }[]).find((s) => s.code === sCode)!;
  const res = await page.request.post('/api/inventory/materials', {
    data: { code: mCode, name: `E2E 门户物料${tag}-${seq}`, category: 'E2E', inventoryUnit: '包', purchaseUnit: '箱', purchaseFactorMilli: 10_000, refPriceCents: 3_000, defaultSupplierId: sup.id },
  });
  expect(res.status(), await res.text()).toBe(201);
  const mat = ((await (await page.request.get('/api/inventory/materials?all=1')).json()) as { id: number; code: string; name: string }[]).find((m) => m.code === mCode)!;
  const me = (await (await page.request.get('/api/auth/me')).json()) as { calendarToday: string };
  return { sup, mat, today: me.calendarToday };
}

async function supplierPage(browser: Browser, url: string) {
  const context = await browser.newContext(); // 供应商：没登录
  const p = await context.newPage();
  await p.goto(url);
  return { p, close: () => context.close() };
}

test.describe('8.0.21 供应商门户', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行');
  });

  test('报价链接：询价单上生成 → 供应商在链接里报价 → 报价里有这一家、标「供应商链接」', async ({ page, browser }) => {
    test.setTimeout(90_000);
    await login(page);
    const { sup, mat, today } = await setup(page);
    const made = await page.request.post('/api/purchase-sourcing', { data: { clientKey: randomUUID(), title: `门户询价${tag}`, needBy: today, lines: [{ materialId: mat.id, purchaseQtyMilli: 5_000 }] } });
    expect(made.status(), await made.text()).toBe(201);
    const ev = (await made.json()).event as { id: number; docNo: string };

    await page.goto(`/purchasing/sourcing/${ev.id}`);
    const card = page.getByTestId('sourcing-supplier-links');
    await card.getByTestId('supplier-link-supplier').selectOption(String(sup.id));
    await card.getByTestId('supplier-link-create').click();
    const url = (await card.getByTestId('supplier-link-url').textContent())!.trim();
    expect(url).toMatch(/\/s\/[A-Za-z0-9_-]+$/);
    await expect(card.getByTestId('supplier-links')).toContainText('等回复');

    const s = await supplierPage(browser, url);
    await expect(s.p.getByTestId('supplier-public-title')).toHaveText(sup.name);
    await expect(s.p.getByText(mat.name)).toBeVisible();
    await s.p.locator('[data-testid^="sp-price-"]').first().fill('28.5');
    await s.p.getByTestId('sp-terms').fill('月结 30 天');
    await s.p.getByTestId('sp-name').fill('王经理');
    await s.p.getByTestId('sp-submit').click();
    await expect(s.p.getByTestId('sp-quoted')).toContainText('货款 ¥142.50');
    await s.close();

    await page.reload();
    await expect(page.getByTestId('sourcing-detail')).toContainText(sup.name);
    await expect(page.getByTestId('sourcing-detail')).toContainText('供应商链接');
    await expect(page.getByTestId('sourcing-supplier-links').getByTestId('supplier-links')).toContainText('已回复 1 次');
  });

  test('订单确认与发货预告：供应商确认承诺到货日 → 采购单上看得到；发货预告报一批 → 列在采购单上', async ({ page, browser }) => {
    test.setTimeout(90_000);
    await login(page);
    const { sup, mat, today } = await setup(page);
    const created = await page.request.post('/api/purchase-orders', {
      data: { clientKey: randomUUID(), orderDate: today, action: 'submit', supplierId: sup.id, lines: [{ materialId: mat.id, purchaseQtyMilli: 2_000, priceCents: 3_000 }] },
    });
    expect(created.status(), await created.text()).toBe(201);
    let po = (await created.json()).po as { id: number; docNo: string; status: string };
    if (po.status !== 'approved') po = (await (await page.request.post(`/api/purchase-orders/${po.id}/approve`, { data: {} })).json()) as typeof po;
    expect(po.status).toBe('approved');

    await page.goto(`/purchasing?po=${po.id}`);
    const card = page.getByTestId('po-supplier-card');
    await expect(card).toContainText('供应商还没确认');
    await card.getByTestId('po-supplier-link-create').click();
    const url = (await card.getByTestId('supplier-link-url').textContent())!.trim();

    const s = await supplierPage(browser, url);
    await expect(s.p.getByText(po.docNo)).toBeVisible();
    await s.p.getByTestId('sp-promised').fill(today);
    await s.p.getByTestId('sp-name').fill('李');
    await s.p.getByTestId('sp-submit').click();
    await expect(s.p.getByTestId('sp-confirmed')).toContainText(`承诺 ${today} 到货`);
    await s.close();

    await page.reload();
    await expect(page.getByTestId('po-supplier-confirmed')).toContainText(`承诺 ${today} 到`);
    // 发货预告
    await page.getByTestId('po-supplier-link-create').click();
    const url2 = (await page.getByTestId('po-supplier-card').getByTestId('supplier-link-url').textContent())!.trim();
    const s2 = await supplierPage(browser, url2);
    await s2.p.locator('[data-testid^="sp-qty-"]').first().fill('1');
    await s2.p.getByTestId('sp-name').fill('李');
    await s2.p.getByTestId('sp-submit').click();
    await expect(s2.p.getByTestId('sp-notices')).toContainText(`${mat.name} 1箱`);
    await s2.close();
    await page.reload();
    await expect(page.getByTestId('po-delivery-notices')).toContainText(`${mat.name} 1箱`);
  });
});
