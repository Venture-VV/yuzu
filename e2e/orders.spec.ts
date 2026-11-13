// 订单查询与逐行明细（8.0.15，docs/ORDERS_V8015.md 第 2 节）：前台「流水」页的「订单查询」页签。
// 只读，建在结账演示（seed-billing-demo）上：② 会员沈先生与朋友合并结账（A8066 + A8067，会员储值 + 美团券 + 微信）、
// ⑤ 现金结账后反结账（A8071）。演示单据按执行时刻生成，可能落在今天或前一个营业日，所以用能看历史营业日的店主账号查。
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const demo = JSON.parse(readFileSync(new URL('../src/server/demo/billing-expected.json', import.meta.url), 'utf8')) as { member: { name: string; phone: string } };

interface Row {
  kind: 'checkout' | 'refund';
  id: number;
  docNo: string;
  status: 'completed' | 'voided';
  tagCodes: string[];
}

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

/** 列表里的一张单：门店电脑是表格的一行，平板是一张卡片 */
const rowOf = (page: Page, docNo: string) => page.locator(`[data-testid="order-row-${docNo}"]:visible, [data-testid="order-card-${docNo}"]:visible`);
const rows = (page: Page) => page.locator('[data-testid^="order-row-"]:visible, [data-testid^="order-card-"]:visible');

async function find(page: Page, q: string): Promise<Row[]> {
  const res = await page.request.get(`/api/ledger/orders?q=${encodeURIComponent(q)}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { rows: Row[] }).rows;
}

/** 输搜索词，等它同步到地址栏（停顿 250ms 后才查） */
async function type(page: Page, q: string) {
  await page.getByTestId('orders-search').fill(q);
  await expect.poll(() => new URL(page.url()).searchParams.get('oq')).toBe(q);
}

test.describe('订单查询', () => {
  test('页签；按手牌号（整号、只输数字）、结账单号、手机号后 4 位、会员姓名查到同一张单', async ({ page }) => {
    await login(page, 'linlan');
    const found = await find(page, 'A8067');
    const wallet = found.find((r) => r.kind === 'checkout' && r.status === 'completed' && r.tagCodes.includes('A8066'))!;
    expect(wallet, '结账演示 ②（A8066 + A8067）').toBeTruthy();

    await page.goto('/ledger');
    const tabs = page.getByTestId('ledger-tabs');
    await expect(tabs.getByRole('radio', { name: '余额流水' })).toHaveAttribute('aria-checked', 'true');
    await tabs.getByRole('radio', { name: '订单查询' }).click();
    await expect(page).toHaveURL(/tab=orders/);
    await expect(page.getByTestId('orders-scope')).toContainText('没输搜索词时列这个营业日的全部账单');

    for (const q of ['A8067', 'a8067', '8067', wallet.docNo, demo.member.phone.slice(-4), demo.member.phone, '沈先生']) {
      await type(page, q);
      await expect(rowOf(page, wallet.docNo), q).toBeVisible();
      await expect(page.getByTestId('orders-scope')).toContainText('在全部营业日里查');
    }
    // 输整张单号：只有这一张（它没有退款单）
    await type(page, wallet.docNo);
    await expect(rows(page)).toHaveCount(1);
    await expect(rowOf(page, wallet.docNo)).toContainText('A8066');
    await expect(rowOf(page, wallet.docNo)).toContainText('A8067');
    await expect(rowOf(page, wallet.docNo)).toContainText(demo.member.name);
    await expect(rowOf(page, wallet.docNo)).toContainText('已结账');
    await expect(rowOf(page, wallet.docNo)).toContainText('会员储值');

    // 查不到的：空状态写明能输什么
    await type(page, '查无此单ZZZ');
    await expect(page.getByText('没有查到「查无此单ZZZ」的账单')).toBeVisible();

    // 回到余额流水：原来的页面还在
    await tabs.getByRole('radio', { name: '余额流水' }).click();
    await expect(page).not.toHaveURL(/tab=orders/);
    await expect(page.getByLabel('搜索流水')).toBeVisible();
  });

  test('点开看逐行明细：与打印的结账单同样的行，另有所属部门与优惠；收款、合计；已反结账的标得出来', async ({ page }) => {
    await login(page, 'linlan');
    const wallet = (await find(page, 'A8067')).find((r) => r.kind === 'checkout' && r.status === 'completed' && r.tagCodes.includes('A8066'))!;
    const print = (await (await page.request.get(`/api/print/checkouts/${wallet.id}`)).json()) as {
      totalAmount: number;
      bills: { tagCode: string; lines: { name: string; quantity: number }[] }[];
    };

    await page.goto(`/ledger?tab=orders&oq=${wallet.docNo}`);
    await rowOf(page, wallet.docNo).click();
    const drawer = page.getByTestId('order-drawer');
    await expect(page.getByTestId('order-drawer-no')).toHaveText(wallet.docNo);
    // 每张手牌一段，行数与打印的结账单一样
    await expect(drawer.getByTestId('order-bill')).toHaveCount(print.bills.length);
    await expect(drawer.getByTestId('order-line')).toHaveCount(print.bills.reduce((n, b) => n + b.lines.length, 0));
    for (const b of print.bills) {
      const section = drawer.getByTestId('order-bill').filter({ hasText: b.tagCode });
      for (const l of b.lines) await expect(section.getByTestId('order-line').filter({ hasText: l.name }).first()).toBeVisible();
    }
    await expect(drawer.getByTestId('order-lines').first()).toContainText('所属部门');
    await expect(drawer.getByTestId('order-lines').first()).toContainText('优惠');
    await expect(drawer.getByTestId('order-line').filter({ hasText: '门票 · 全日自助餐' })).toContainText('门票');
    const total = `${(print.totalAmount / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    await expect(drawer.getByTestId('order-totals')).toContainText(total);
    const payments = drawer.getByTestId('order-payments');
    await expect(payments).toContainText('会员储值');
    await expect(payments).toContainText('扣前 本金 ¥2,000.00 / 赠金 ¥300.00');
    await expect(payments).toContainText('团购券');
    await expect(payments).toContainText('美团');
    await expect(payments).toContainText('微信');
    await expect(drawer.getByTestId('order-print')).toBeVisible();
    await page.getByRole('button', { name: '关闭' }).click();
    await expect(drawer).toBeHidden();

    // ⑤ A8071：反结账的那一张与重新结账的那一张都列出来
    const again = await find(page, 'A8071');
    const voided = again.find((r) => r.kind === 'checkout' && r.status === 'voided')!;
    expect(voided, '结账演示 ⑤ 反结账的单').toBeTruthy();
    await type(page, 'A8071');
    await expect(rowOf(page, voided.docNo)).toContainText('已反结账');
    await rowOf(page, voided.docNo).click();
    await expect(page.getByTestId('order-drawer-no')).toHaveText(voided.docNo);
    await expect(drawer).toContainText('收款方式记错');
    // 反结账时作废的门票照样在（结账那一刻的明细）
    const voidedPrint = (await (await page.request.get(`/api/print/checkouts/${voided.id}`)).json()) as { bills: { lines: unknown[] }[] };
    await expect(drawer.getByTestId('order-line')).toHaveCount(voidedPrint.bills.reduce((n, b) => n + b.lines.length, 0));
    await expect(drawer.getByTestId('order-line').filter({ hasText: '门票 · 不含餐' })).toHaveCount(1);
  });

  test('导出明细 CSV：导出的是页面上列出来的这几张，一行一个消费项目；店员没有导出、只查当天', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1280, '导出与换账号在门店电脑尺寸执行一次');
    await login(page, 'linlan');
    const wallet = (await find(page, 'A8067')).find((r) => r.kind === 'checkout' && r.status === 'completed' && r.tagCodes.includes('A8066'))!;
    await page.goto(`/ledger?tab=orders&oq=${wallet.docNo}`);
    await expect(rowOf(page, wallet.docNo)).toBeVisible();
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('orders-export').click()]);
    const text = readFileSync((await file.path())!, 'utf8');
    const lines = text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('营业日,时间,单号,类型,状态,手牌 / 桌号,会员 / 称呼,部门,项目,技师,数量,单价,金额,优惠,实收,整单收款方式,经办人,原结账单号');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines.slice(1)) expect(l).toContain(wallet.docNo);
    expect(lines.some((l) => l.includes('A8066') && l.includes('门票'))).toBe(true);
    expect(lines.some((l) => l.includes('A8067') && l.includes('门票'))).toBe(true);

    // 店员：没有「导出流水与日结」、没有「查看历史营业日」
    await page.context().clearCookies();
    await login(page, 'chenyin');
    await page.goto('/ledger?tab=orders&oq=A8067');
    await expect(page.getByTestId('orders-scope')).toContainText('当前岗位只查得到本营业日的单');
    await expect(page.getByTestId('orders-export')).toHaveCount(0);
  });
});
