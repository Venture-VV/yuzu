// 收银完善（v0.7.20，飞书 RQ-006）浏览器验收：
//   ① 退款单：值班经理在「结账记录」里对已结的单按项部分退款（退现金、记到原单的钱箱），看到退款单、打印凭条、作废；
//   ② 结账用券：店主建一个代金券模板、发给一位演示会员，前台结账时在「券抵扣」里选这张券，结账单写明券抵扣，券变成已用。
// 依赖 seed-demo 与 seed-frontdesk-demo（仅独立演示库）。账号：店主 linlan、前台 xiaozhou、值班经理 zhangjl，密码 yuzu2026。
// 每次挑空闲手牌、新建模板与券，可重复执行；临时开的班结束时按应有现金交掉。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function postJson<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number; memberId: number | null } | null;
}

const freeTags = async (page: Page, zone: BoardTag['zone']) =>
  (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags
    .filter((t) => t.zone === zone && t.kind === 'normal' && t.active && !t.locked && !t.visit)
    .map((t) => t.code)
    .reverse();

/** 本人还没有当班班次时开一个（备用金 0）；返回是否是这里开的（结束时交掉） */
async function openShiftIfNeeded(page: Page) {
  const res = await page.request.post('/api/shifts', { data: { openingCash: 0 } });
  expect([200, 409], await res.text()).toContain(res.status());
  return res.status() === 200;
}

async function closeMyShift(page: Page, note: string) {
  const { shift } = await getJson<{ shift: { id: number; summary: { cash: { expected: number } } } | null }>(page, '/api/shifts/current');
  if (!shift) return;
  const expected = shift.summary.cash.expected;
  const res = await page.request.post(`/api/shifts/${shift.id}/close`, { data: { countedCash: expected, expectedCash: expected, note } });
  expect(res.ok(), await res.text()).toBe(true);
}

interface CheckoutDetail {
  id: number;
  checkoutNo: string;
  status: 'completed' | 'voided';
  totalAmount: number;
  payments: { method: string; amount: number; ref: string | null }[];
  refunds: { id: number; refundNo: string; status: 'completed' | 'voided'; amount: number }[];
}

test.describe('收银完善（v0.7.20）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');
  test.setTimeout(120_000);

  test('退款单：结账记录里按项退一项现金，看到退款单与凭条；当班作废后不再算退款', async ({ page }) => {
    await login(page, 'zhangjl');
    const opened = await openShiftIfNeeded(page);
    try {
      // 准备：一位散客挂两项手动金额，现金结清
      const tag = (await freeTags(page, 'male'))[2]!;
      const checkin = await postJson<{ visits: { id: number }[] }>(page, '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male' }] });
      const visitId = checkin.visits[0]!.id;
      await postJson(page, `/api/frontdesk/visits/${visitId}/charges`, {
        clientKey: randomUUID(),
        lines: [],
        customLines: [
          { name: 'E2E 退款按摩', amount: 6800 },
          { name: 'E2E 退款饮料', amount: 1200 },
        ],
        expectedTotal: 8000,
      });
      const preview = await getJson<{ totalAmount: number }>(page, `/api/frontdesk/checkout-preview?ids=${visitId}`);
      const paid = await postJson<{ id: number; checkoutNo: string }>(page, '/api/frontdesk/checkouts', {
        clientKey: randomUUID(),
        visitIds: [visitId],
        expectedTotal: preview.totalAmount,
        payments: [{ method: 'cash', amount: preview.totalAmount }],
      });
      const shiftCash = async () => (await getJson<{ shift: { summary: { cash: { expected: number; refundSlip?: number } } } }>(page, '/api/shifts/current')).shift.summary.cash;
      const before = await shiftCash();

      // 结账记录 → 打开这张单 → 部分退款
      await page.goto('/frontdesk');
      await page.getByTestId('open-checkouts').click();
      const dialog = page.getByRole('dialog', { name: '结账记录' });
      await dialog.getByTestId('checkout-records').getByRole('button').filter({ hasText: paid.checkoutNo }).click();
      await dialog.getByTestId('checkout-refund').click();
      const panel = dialog.getByTestId('refund-panel');
      await expect(panel.getByTestId('refund-items')).toContainText('E2E 退款按摩');
      await expect(panel.getByTestId('refund-confirm')).toBeDisabled();
      await panel.getByTestId('refund-item-E2E 退款按摩').check();
      await expect(panel.getByLabel('E2E 退款按摩退的金额')).toHaveValue('68');
      // 金额改小到 50：退款方式自动跟着分配到现金
      await panel.getByLabel('E2E 退款按摩退的金额').fill('50');
      await expect(panel.getByLabel('现金退款')).toHaveValue('50');
      await expect(panel.getByTestId('refund-drawer')).toContainText('原单收款的班次');
      await panel.getByLabel('退款原因').fill('E2E：按摩没做完');
      await panel.getByTestId('refund-confirm').click();
      await expect(page.getByText(/已开退款单 /)).toBeVisible();
      await expect(panel).toHaveCount(0);

      const after = await getJson<CheckoutDetail>(page, `/api/frontdesk/checkouts/${paid.id}`);
      expect(after.refunds).toHaveLength(1);
      const refund = after.refunds[0]!;
      expect(refund).toMatchObject({ status: 'completed', amount: 5000 });
      const list = dialog.getByTestId('refunds-list');
      await expect(list).toContainText(refund.refundNo);
      await expect(list).toContainText('E2E：按摩没做完');
      // 有退款单的结账单不能再反结账
      await expect(dialog.getByTestId('checkout-void')).toHaveCount(0);
      await expect(dialog.getByText('这张单已有退款单，不能再反结账')).toBeVisible();
      // 交班表：退款单退的现金扣减应有现金
      const now = await shiftCash();
      expect(now.refundSlip).toBe((before.refundSlip ?? 0) + 5000);
      expect(now.expected).toBe(before.expected - 5000);

      // 退款凭条
      const slip = await page.context().newPage();
      await slip.goto(`/print/refund/${refund.id}`);
      const printed = slip.getByTestId('print-refund');
      await expect(printed).toContainText(refund.refundNo);
      await expect(printed).toContainText(paid.checkoutNo);
      await expect(printed).toContainText('E2E 退款按摩');
      await expect(printed).toContainText('¥50.00');
      await slip.close();

      // 返回列表：这一天的退款单里能看到
      await dialog.getByRole('button', { name: '← 返回列表' }).click();
      await expect(dialog.getByTestId('day-refunds')).toContainText(refund.refundNo);
      await expect(dialog.getByTestId('checkout-records')).toContainText('已退 ¥50.00');
      await dialog.getByTestId('day-refunds').getByRole('button').filter({ hasText: refund.refundNo }).click();

      // 当班作废：写原因
      await dialog.getByTestId(`refund-void-${refund.refundNo}`).click();
      await dialog.getByLabel('作废退款单原因').fill('E2E：金额登记错了');
      await dialog.getByTestId('refund-void-confirm').click();
      await expect(page.getByText(`已作废退款单 ${refund.refundNo}`)).toBeVisible();
      await expect(dialog.getByTestId('refunds-list')).toContainText('已作废');
      // 作废后又能反结账了
      await expect(dialog.getByTestId('checkout-void')).toBeVisible();
      const end = await shiftCash();
      expect(end.refundSlip ?? 0).toBe(before.refundSlip ?? 0);
      expect(end.expected).toBe(before.expected);
      const voidedSlip = await page.context().newPage();
      await voidedSlip.goto(`/print/refund/${refund.id}`);
      await expect(voidedSlip.getByTestId('print-refund-voided')).toBeVisible();
      await voidedSlip.close();
    } finally {
      if (opened) await closeMyShift(page, 'E2E：退款单流程临时开的班');
    }
  });

  test('结账用券：店主发给会员一张满 100 减 20 的代金券，前台结账时选这张券抵扣，券变成已用', async ({ page }) => {
    // ① 店主建模板、发券
    await login(page, 'linlan');
    const template = await postJson<{ id: number }>(page, '/api/coupons/templates', {
      clientKey: randomUUID(),
      name: `E2E 满100减20 ${Date.now() % 10000}`,
      kind: 'cash',
      faceValue: 2000,
      threshold: 10000,
      validity: 'days',
      validDays: 30,
    });
    const board = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags;
    const inStore = new Set(board.map((t) => t.visit?.memberId).filter((id): id is number => !!id));
    const members = await getJson<{ id: number; name: string; phone: string; status: string; gender: 'male' | 'female' | null }[]>(page, '/api/members?q=19900001&limit=50');
    const member = members.filter((m) => m.status === 'active' && !inStore.has(m.id)).at(-1);
    expect(member, '演示会员（seed-demo）里没有不在店的').toBeTruthy();
    const issued = await postJson<{ coupons: { id: number; code: string }[] }>(page, `/api/members/${member!.id}/coupons`, {
      clientKey: randomUUID(),
      templateId: template.id,
      quantity: 1,
      reason: 'E2E：结账用券',
    });
    const code = issued.coupons[0]!.code;
    await page.request.post('/api/auth/logout');

    // ② 前台接待这位会员，结账时用券
    await login(page, 'xiaozhou');
    const opened = await openShiftIfNeeded(page);
    let visitId: number | null = null;
    try {
      const zone = member!.gender ?? 'male';
      const tag = (await freeTags(page, zone))[3]!;
      const checkin = await postJson<{ visits: { id: number }[] }>(page, '/api/frontdesk/checkins', {
        clientKey: randomUUID(),
        guests: [{ tagCode: tag, zone, memberId: member!.id }],
      });
      visitId = checkin.visits[0]!.id;
      const preview = await getJson<{ totalAmount: number; storeCoupons: { code: string; usable: boolean; amount: number }[] }>(
        page,
        `/api/frontdesk/checkout-preview?ids=${visitId}`,
      );
      expect(preview.totalAmount, '门票够 100 元门槛').toBeGreaterThanOrEqual(10000);
      expect(preview.storeCoupons.find((c) => c.code === code)).toMatchObject({ usable: true, amount: 2000 });

      await page.goto(`/frontdesk?v=${visitId}`);
      const bill = page.getByTestId('bill-panel');
      await expect(bill.getByTestId('bill-tag')).toHaveText(tag);
      await bill.getByTestId('action-checkout').click();
      await expect(page.getByTestId('checkout-total')).toBeVisible();
      await page.getByTestId('pay-add-store_coupon').click();
      const options = page.getByTestId('store-coupon-options');
      await expect(options.getByTestId(`store-coupon-${code}`)).toContainText('¥20.00');
      await options.getByTestId(`store-coupon-${code}`).click();
      await expect(page.getByTestId('store-coupon-picked')).toContainText('抵 ¥20.00');
      // 用了券就不能再加优惠 / 免单
      await expect(page.getByTestId('pay-add-discount')).toBeDisabled();
      await page.getByTestId('pay-add-cash').click(); // 现金默认填剩下的
      await page.getByTestId('checkout-submit').click();
      await expect(page.getByText(/已结清 · /)).toBeVisible();
      await page.getByTestId('checkout-finish').click();
      visitId = null;

      const list = await getJson<{ id: number; tagCodes: string[] }[]>(page, '/api/frontdesk/checkouts');
      const done = await getJson<CheckoutDetail>(page, `/api/frontdesk/checkouts/${list.find((c) => c.tagCodes.includes(tag))!.id}`);
      expect(done.payments.find((p) => p.method === 'store_coupon')).toMatchObject({ amount: 2000 });
      expect(done.payments.find((p) => p.method === 'cash')!.amount).toBe(preview.totalAmount - 2000);
      const slip = await page.context().newPage();
      await slip.goto(`/print/checkout/${done.id}`);
      await expect(slip.getByTestId('print-checkout')).toContainText('券抵扣');
      await slip.close();
      await page.request.post('/api/auth/logout');

      // ③ 店主在会员的券里看到这张已用
      await login(page, 'linlan');
      const mine = await getJson<{ coupons: { code: string; state: string; checkoutNo: string | null }[] }>(page, `/api/members/${member!.id}/coupons`);
      expect(mine.coupons.find((c) => c.code === code)).toMatchObject({ state: 'used', checkoutNo: done.checkoutNo });
      await page.request.post('/api/auth/logout');
      await login(page, 'xiaozhou');
    } finally {
      if (visitId) await page.request.post(`/api/frontdesk/visits/${visitId}/cancel`, { data: { reason: 'E2E：收尾' } });
      if (opened) await closeMyShift(page, 'E2E：结账用券临时开的班');
    }
  });
});
