// 8.0.21 浏览器验收：开票申请（docs/FINANCE_V8021.md 第 3 节，CW-B）。可重复执行（每次新开一张结账单）。
// 依赖演示数据（仅独立演示库），账号：值班经理 zhangjl、店主 linlan，密码 yuzu2026。
//   · 前台 → 结账记录 → 打开一张现金结的单 →「开票」：可开金额是现金实收，填单位抬头、税号提交；再打开看到「申请中」；
//   · ERP → 开票：申请中里有这一张 → 登记已开（填号码）→ 已开；前台那张单上看得到发票号码。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const stamp = String(Date.now()).slice(-8);

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}
async function json<T>(page: Page, method: 'get' | 'post', url: string, data?: unknown): Promise<T> {
  const r = await page.request[method](url, data === undefined ? undefined : { data });
  expect(r.ok(), `${url} → ${r.status()} ${await r.text()}`).toBe(true);
  return (await r.json()) as T;
}

test.describe('8.0.21 开票申请', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行');
  });

  test('前台结账记录申请开票 → ERP 登记已开 → 前台看得到发票号码', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, 'zhangjl');
    const shift = await page.request.post('/api/shifts', { data: { openingCash: 0 } });
    expect([200, 409]).toContain(shift.status());
    // 一位散客，挂一项手动金额，现金结清
    const board = await json<{ tags: { code: string; zone: string; kind: string; active: boolean; locked: boolean; visit: unknown }[] }>(page, 'get', '/api/frontdesk/board');
    const tag = board.tags.find((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit)!.code;
    const checkin = await json<{ visits: { id: number }[] }>(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male' }] });
    const visitId = checkin.visits[0]!.id;
    await json(page, 'post', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines: [], customLines: [{ name: `E2E 开票按摩${stamp}`, amount: 6800 }], expectedTotal: 6800 });
    const preview = await json<{ totalAmount: number }>(page, 'get', `/api/frontdesk/checkout-preview?ids=${visitId}`);
    const paid = await json<{ id: number; checkoutNo: string }>(page, 'post', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [visitId], expectedTotal: preview.totalAmount, payments: [{ method: 'cash', amount: preview.totalAmount }] });

    await page.goto('/frontdesk');
    await page.getByTestId('open-checkouts').click();
    const records = page.getByRole('dialog', { name: '结账记录' });
    await records.getByTestId('checkout-records').getByRole('button').filter({ hasText: paid.checkoutNo }).click();
    await records.getByTestId(`invoice-request-checkout-${paid.id}`).click();
    const dialog = page.getByTestId('invoice-request-dialog');
    await expect(dialog).toContainText(`可开金额 ¥${(preview.totalAmount / 100).toFixed(2).replace(/\.00$/, '')}`);
    await dialog.getByRole('radio', { name: '单位' }).click();
    await dialog.getByTestId('ir-title').fill(`验收开票单位${stamp}`);
    await dialog.getByTestId('ir-tax').fill('91440300MA5XXXXX1A');
    await page.getByTestId('invoice-request-submit').click();
    await expect(page.getByText('已提交开票申请')).toBeVisible();
    await expect(dialog.getByTestId('invoice-request-active')).toContainText('申请中');

    // ERP → 开票（店主）
    await login(page, 'linlan');
    await page.goto('/erp/sales-invoices');
    const row = page.getByRole('button').filter({ hasText: `验收开票单位${stamp}` });
    await row.click();
    const sheet = page.getByTestId('sales-invoice-sheet');
    await expect(sheet).toContainText(paid.checkoutNo);
    await sheet.getByTestId('sales-invoice-issue').click();
    await page.getByTestId('si-no').fill(`2644${stamp}00000001`);
    await page.getByTestId('sales-invoice-issue-confirm').click();
    await expect(page.getByText('已登记开出')).toBeVisible();
    await expect(sheet).toContainText(`2644${stamp}00000001`);
    await page.keyboard.press('Escape');
    await page.getByTestId('sales-invoice-view-issued').click();
    await expect(page.getByRole('button').filter({ hasText: `验收开票单位${stamp}` })).toContainText('已开');

    // 前台那张单上看得到发票号码
    const info = await json<{ active: { status: string; invoiceNo: string } }>(page, 'get', `/api/invoice-requests/source?type=checkout&id=${paid.id}`);
    expect(info.active).toMatchObject({ status: 'issued', invoiceNo: `2644${stamp}00000001` });
  });
});
