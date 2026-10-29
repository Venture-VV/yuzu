// R1.3 打印：80mm 结账单与交班表。依赖 seed-frontdesk-demo + seed-billing-demo（仅独立演示库），预期见 src/server/demo/billing-expected.json。
// 打印页直接打开（不带 ?auto=1，不调出打印）核对内容；切到打印样式后工具栏隐藏、纸宽 72mm 不溢出；入口按钮在新窗口打开打印页。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

interface Summary {
  id: number;
  checkoutNo: string;
  status: 'completed' | 'voided';
  tagCodes: string[];
  methods: string[] | null;
}

const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** 演示单据所在的营业日：演示数据按执行时刻生成，在营业日切换（06:00）后一小时内执行时会落在前一个营业日 */
async function checkouts(page: Page) {
  const me = (await (await page.request.get('/api/auth/me')).json()) as { today: string; storeName: string };
  for (const date of [me.today, dayBefore(me.today)]) {
    const list = (await (await page.request.get(`/api/frontdesk/checkouts?date=${date}`)).json()) as Summary[];
    if (list.length) return { me, date, list };
  }
  throw new Error('找不到结账演示数据（seed-billing-demo）');
}

/** 打印样式下：工具栏隐藏，纸宽 72mm（272px），内容不横向溢出 */
async function expectPrintLayout(page: Page) {
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('print-now')).toBeHidden();
  const box = await page.getByTestId('print-paper').evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  expect(Math.abs(box.width - 272)).toBeLessThanOrEqual(1);
  expect(box.scroll).toBeLessThanOrEqual(box.width);
  await page.emulateMedia({ media: 'screen' });
}

test.describe('打印', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '打印在门店电脑尺寸执行一次');

  test('结账单：明细、各收款方式、储值扣前扣后余额、签字栏；反结账的单标明作废', async ({ page }) => {
    await login(page, 'linlan');
    const { me, list } = await checkouts(page);
    const wallet = list.find((c) => c.status === 'completed' && (c.methods ?? []).includes('wallet'))!;
    expect(wallet).toBeTruthy();

    await page.goto(`/print/checkout/${wallet.id}`);
    const slip = page.getByTestId('print-checkout');
    await expect(slip).toBeVisible();
    await expect(slip).toContainText(me.storeName);
    await expect(slip).toContainText(wallet.checkoutNo);
    await expect(slip).toContainText('门票 · 全日自助餐（24 小时档）');
    await expect(slip).toContainText('应收合计¥2,396.00');
    await expect(page.getByTestId('print-payment-wallet')).toContainText('扣前 本金 ¥2,000.00 / 赠金 ¥300.00');
    await expect(page.getByTestId('print-payment-wallet')).toContainText('扣后 本金 ¥800.00 / 赠金 ¥300.00');
    await expect(page.getByTestId('print-payment-coupon')).toContainText('券码尾号 0001');
    await expect(slip).toContainText('客人签字');
    // 演示库不是正式服：小票上醒目标出
    await expect(page.getByTestId('print-instance')).toBeVisible();
    await expectPrintLayout(page);

    const voided = list.find((c) => c.status === 'voided')!;
    await page.goto(`/print/checkout/${voided.id}`);
    await expect(page.getByTestId('print-voided')).toContainText('已反结账（本单作废）');
    await expect(page.getByTestId('print-voided')).toContainText('收款方式记错');
    await expect(page.getByTestId('print-checkout')).toContainText('门票 · 不含餐（12 小时档）');
  });

  test('交班表：备用金、各收款方式、应有与实点现金、短款、交接签字', async ({ page }) => {
    await login(page, 'linlan');
    const { date } = await checkouts(page);
    const shifts = (await (await page.request.get(`/api/shifts?date=${date}`)).json()) as { id: number; shiftNo: string; status: string; staffName: string }[];
    const closed = shifts.find((s) => s.status === 'closed' && s.staffName === '陈茵')!;
    await page.goto(`/print/shift/${closed.id}`);
    const slip = page.getByTestId('print-shift');
    await expect(slip).toContainText(closed.shiftNo);
    await expect(slip).toContainText('备用金¥500.00');
    await expect(slip).toContainText('= 应有现金¥1,021.00');
    await expect(slip).toContainText('实点现金¥1,011.00');
    await expect(page.getByTestId('print-shift-diff')).toContainText('短款¥10.00');
    await expect(slip).toContainText('交班人签字');
    await expect(slip).toContainText('接班人签字');
    await expectPrintLayout(page);
  });

  test('入口：结账记录与交班页的「打印」在新窗口打开打印页', async ({ page }) => {
    await login(page, 'chenyin');
    const { me, date, list } = await checkouts(page);
    test.skip(date !== me.today, '演示单据落在前一个营业日，结账记录与交班页只列今天的');
    const wallet = list.find((c) => c.status === 'completed' && (c.methods ?? []).includes('wallet'))!;

    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '前台', exact: true }).click();
    await page.getByTestId('open-checkouts').click();
    const records = page.getByRole('dialog', { name: '结账记录' });
    await records.getByText(wallet.checkoutNo).click();
    const [popup] = await Promise.all([page.waitForEvent('popup'), records.getByTestId('checkout-reprint').click()]);
    expect(popup.url()).toContain(`/print/checkout/${wallet.id}?auto=1`);
    await popup.close().catch(() => {});

    await page.keyboard.press('Escape');
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '交班', exact: true }).click();
    const row = page.getByTestId('shift-list').locator('li').filter({ hasText: '陈茵' });
    await row.getByRole('button').first().click();
    const [shiftPopup] = await Promise.all([page.waitForEvent('popup'), row.getByTestId('shift-print').click()]);
    expect(shiftPopup.url()).toMatch(/\/print\/shift\/\d+\?auto=1$/);
    await shiftPopup.close().catch(() => {});
  });
});
