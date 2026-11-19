// 8.1.15 发卡台与收银台（docs/DESKS_V8115.md）的浏览器验收：
//   ① 主导航里「前台」分成「发卡台」「收银台」两个；
//   ② 发卡台：手牌卡片与客人卡上认得出会员档阶与基础权益（VIP 柜、手上的券）；加项目、作废、换牌都在；没有预结账、结账、结账记录，F9 不开结账；
//   ③ 从客人卡「去收银台结账」：待结账清单上这张牌标着「签赠」；账单只读（没有加项目、作废、换牌，F4 不开加项目）；
//      「权益与优惠」里这张签赠写着渠道、发放人、授权人、事由；
//   ④ 结账选这张签赠券：结账单与小票的「优惠与赠送」写明签赠、发放人、授权人，「收款」里只有现金；结完这张牌从待结账清单里走了。
// 依赖演示数据（seed-demo、seed-frontdesk-demo：店主 linlan、值班经理 zhangjl，密码 yuzu2026）。会登记单据，只在门店电脑尺寸执行；
// 每次新建一位会员与一个签赠券类型，不改演示数据里已有的档案。三台目标设备上的版面在 e2e/target-devices.spec.ts。
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
  visit: { id: number; memberId: number | null; memberGradeLabel: string | null; coupons: number; gifts: number } | null;
}

const boardTags = async (page: Page) => (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags;
const freeTags = async (page: Page) =>
  (await boardTags(page))
    .filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit)
    .map((t) => t.code)
    .reverse();

/** 新会员充到给定金额（赠金按档自动算：先按 0 提交，服务端回 BONUS_CHANGED 时按它给的赠金重提） */
async function memberWith(page: Page, name: string, phone: string, paid: number) {
  const m = await postJson<{ id: number }>(page, '/api/members', { name, phone, gender: 'male' });
  const body = { idempotencyKey: randomUUID(), memberId: m.id, planId: null, paidAmount: paid, bonusAmount: 0, bonusMode: 'auto', paymentMethod: 'wechat', paymentConfirmed: true };
  let r = await page.request.post('/api/recharges', { data: body });
  if (r.status() === 409) {
    const err = (await r.json()) as { error: { code: string; details?: { bonusCents?: number } } };
    expect(err.error.code).toBe('BONUS_CHANGED');
    r = await page.request.post('/api/recharges', { data: { ...body, idempotencyKey: randomUUID(), bonusAmount: err.error.details!.bonusCents } });
  }
  expect(r.ok(), await r.text()).toBe(true);
  return m.id;
}

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

test.describe('8.1.15 发卡台与收银台', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('发卡台认会员等级、加项目、换牌，不结账 → 收银台只读、看得到签赠与经办人 → 结账单与小票写明赠送与经办人', async ({ page }) => {
    test.setTimeout(240_000);
    const stamp = String(Date.now()).slice(-6);
    const memberName = `E2E 望岳${stamp}`;
    const giftName = `E2E 发卡签赠 ${stamp}`;
    await login(page, 'linlan');

    // 先开班（充值、结账都是收款，要在班次里）；用例自己开的班，结束时交掉
    const opened = await openShiftIfNeeded(page);
    let visitId: number | null = null;
    try {
      // 准备（接口）：一位 L4 会员（充 5 万）、一个签赠券类型（代金券 ¥20）、发给他一张（授权人张经理、渠道管家部）
      const memberId = await memberWith(page, memberName, `193${String(Date.now()).slice(-8)}`, 50_000_00);
      const type = await postJson<{ id: number }>(page, '/api/gifts/types', {
        clientKey: randomUUID(),
        name: giftName,
        kind: 'cash',
        faceValue: 2000,
        validity: 'days',
        validDays: 30,
        segment: '浴区',
        content: '抵 20 元消费（E2E）',
        rules: '',
      });
      const authorizers = await getJson<{ id: number; name: string }[]>(page, '/api/gifts/authorizers');
      const zhang = authorizers.find((a) => a.name === '张经理')!;
      expect(zhang, '演示数据里的值班经理张经理').toBeTruthy();
      const issued = await postJson<{ coupons: { id: number; code: string }[] }>(page, '/api/gifts/issues', {
        clientKey: randomUUID(),
        memberId,
        templateId: type.id,
        quantity: 1,
        channel: '管家部',
        reason: 'E2E：老客户回馈',
        authorizedBy: zhang.id,
      });
      const coupon = issued.coupons[0]!;
      const me = (await getJson<{ staff: { displayName: string } }>(page, '/api/auth/me')).staff;

      // ① 主导航：发卡台、收银台两个入口，没有「前台」
      const nav = page.getByRole('navigation', { name: '主导航' });
      await expect(nav.getByRole('link', { name: '发卡台', exact: true })).toBeVisible();
      await expect(nav.getByRole('link', { name: '收银台', exact: true })).toBeVisible();
      await expect(nav.getByRole('link', { name: '前台', exact: true })).toHaveCount(0);

      // ② 发卡台：接待这位会员（接口），手牌卡片上有档阶
      const [tag, tag2] = await freeTags(page);
      const checkin = await postJson<{ visits: { id: number }[] }>(page, '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', memberId }] });
      visitId = checkin.visits[0]!.id;
      expect((await boardTags(page)).find((t) => t.code === tag)!.visit).toMatchObject({ memberGradeLabel: 'L4 望岳 · 初', coupons: 1, gifts: 1 });
      await nav.getByRole('link', { name: '发卡台', exact: true }).click();
      await expect(page.getByRole('heading', { name: '发卡台 · 在店手牌' })).toBeVisible();
      await expect(page.getByTestId(`tag-${tag}-grade`)).toHaveText('L4');
      await page.getByTestId(`tag-${tag}`).click();
      const panel = page.getByTestId('bill-panel');
      await expect(panel).toHaveAttribute('data-desk', 'issue');
      await expect(panel.getByTestId('bill-tag')).toHaveText(tag!);
      // 会员等级识别：档阶、能用几级 VIP 柜、手上的券
      await expect(panel).toContainText('L4 望岳');
      const rights = panel.getByTestId('member-entitlements');
      await expect(rights).toContainText('VIP 柜 2 级及以下');
      await expect(rights).toContainText('券 1 张（签赠 1）');
      // 发卡台不结账：没有预结账、结账、结账记录；F9 不开结账
      await expect(panel.getByTestId('action-checkout')).toHaveCount(0);
      await expect(panel.getByTestId('action-preview')).toHaveCount(0);
      await expect(page.getByTestId('open-checkouts')).toHaveCount(0);
      await page.keyboard.press('F9');
      await expect(page.getByTestId('checkout-total')).toHaveCount(0);
      // 加项目、作废、换牌都在发卡台
      await page.keyboard.press('F4');
      const add = page.getByRole('dialog').filter({ hasText: '加项目' });
      await add.getByTestId('item-搓背').click();
      await add.getByTestId('add-items-submit').click();
      await expect(panel.getByTestId('bill-total')).toContainText('58.00');
      await expect(panel.getByRole('button', { name: '作废 搓背' })).toBeVisible();
      await panel.getByTestId('action-swap').click();
      const swap = page.getByRole('dialog').filter({ hasText: '换牌 ·' });
      await swap.locator('#swap-code').fill(tag2!);
      await swap.getByRole('button', { name: '顾客要求换柜' }).click();
      await swap.getByTestId('swap-submit').click();
      await expect(panel.getByTestId('bill-tag')).toHaveText(tag2!);
      await expect(panel.getByTestId('bill-total')).toContainText('58.00');

      // ③ 去收银台：带着这张手牌过去；清单上标着签赠；账单只读
      await panel.getByTestId('go-cashier').click();
      await expect(page).toHaveURL(/\/cashier/);
      await expect(page.getByRole('heading', { name: '收银台 · 待结账' })).toBeVisible();
      await expect(panel).toHaveAttribute('data-desk', 'cashier');
      await expect(panel.getByTestId('bill-tag')).toHaveText(tag2!);
      const row = page.getByTestId(`queue-${tag2}`);
      await expect(row).toContainText(memberName);
      await expect(row).toContainText('L4');
      await expect(page.getByTestId(`queue-${tag2}-gift`)).toContainText('签赠 1');
      await expect(panel.getByTestId('cashier-readonly-hint')).toContainText('收银台只看不改');
      for (const id of ['action-add', 'action-swap', 'action-more', 'bill-ticket-change']) await expect(panel.getByTestId(id), id).toHaveCount(0);
      await expect(panel.getByRole('button', { name: /^作废 / })).toHaveCount(0);
      await expect(panel).toContainText('搓背');
      await page.keyboard.press('F4');
      await expect(page.getByRole('dialog').filter({ hasText: '加项目' })).toHaveCount(0);
      // 权益与优惠：这张签赠能抵多少、谁发的、谁授权的、为什么
      const perks = panel.getByTestId('bill-perks');
      const giftRow = perks.getByTestId('bill-perk-gift');
      await expect(giftRow).toContainText(giftName);
      await expect(giftRow).toContainText('可抵 ¥20.00');
      await expect(perks.getByTestId('bill-perk-gift-operators')).toHaveText(`管家部 · 发放 ${me.displayName} · 授权 张经理 · E2E：老客户回馈`);

      // ④ 结账：选这张签赠券，其余现金
      await panel.getByTestId('action-checkout').click();
      await expect(page.getByTestId('checkout-total')).toBeVisible();
      await page.getByTestId('pay-add-store_coupon').click();
      await page.getByTestId('store-coupon-options').getByTestId(`store-coupon-${coupon.code}`).click();
      await expect(page.getByTestId('store-coupon-picked')).toContainText('抵 ¥20.00');
      await page.getByTestId('pay-add-cash').click();
      await page.getByTestId('checkout-submit').click();
      await expect(page.getByText(/已结清 · /)).toBeVisible();
      visitId = null;
      // 结账单：「优惠与赠送」写明签赠与经办人
      const receiptPerk = page.getByTestId('checkout-receipt').getByTestId('checkout-perks').getByTestId('checkout-perk-gift');
      await expect(receiptPerk).toContainText('签赠');
      await expect(receiptPerk).toContainText(giftName);
      await expect(receiptPerk).toContainText(`发放 ${me.displayName} · 授权 张经理`);
      await expect(page.getByTestId('checkout-receipt').getByTestId('checkout-perks')).toContainText('共优惠');
      // 小票：「优惠与赠送」一栏在「应收合计」后面；「收款」里只有现金
      // （「打印」开的窗口打完自己关，这里取出结账单号另开一页看）
      const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('checkout-print').click()]);
      const checkoutId = Number(/\/print\/checkout\/(\d+)/.exec(popup.url())![1]);
      await popup.close().catch(() => {});
      const slip = await page.context().newPage();
      await slip.goto(`/print/checkout/${checkoutId}`);
      await expect(slip.getByTestId('print-checkout')).toBeVisible();
      const printed = slip.getByTestId('print-perks');
      await expect(printed).toContainText('优惠与赠送');
      await expect(printed.getByTestId('print-perk-gift')).toContainText(`签赠 · ${giftName}`);
      await expect(printed.getByTestId('print-perk-gift')).toContainText(`管家部 · 发放 ${me.displayName} · 授权 张经理`);
      await expect(printed.getByTestId('print-perk-gift')).toContainText('E2E：老客户回馈');
      await expect(printed).toContainText('共优惠¥20.00');
      await expect(slip.getByTestId('print-payment-cash')).toBeVisible();
      await expect(slip.getByTestId('print-payment-store_coupon')).toHaveCount(0);
      await slip.close();
      await page.getByTestId('checkout-finish').click();
      // 结完：这张牌不在待结账清单里了
      await expect(page.getByTestId(`queue-${tag2}`)).toHaveCount(0);
    } finally {
      if (visitId) await page.request.post(`/api/frontdesk/visits/${visitId}/cancel`, { data: { reason: 'E2E：收尾' } });
      if (opened) await closeMyShift(page, 'E2E：发卡台与收银台临时开的班');
    }
  });

  test('收银台：输牌号直接选中、按条件筛待结账清单；没有选手牌时提示从清单里选', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/cashier');
    await expect(page.getByTestId('cashier-queue')).toBeVisible();
    await expect(page.getByTestId('cashier-empty')).toBeVisible();
    // 演示数据里在店未结的手牌都在清单里
    const open = (await boardTags(page)).filter((t) => t.visit);
    expect(open.length).toBeGreaterThan(0);
    const first = open[0]!.code;
    await expect(page.getByTestId(`queue-${first}`)).toBeVisible();
    // 输完整牌号回车：选中这张、右边出账单（只读）
    await page.getByTestId('tag-search').fill(first);
    await page.keyboard.press('Enter');
    const panel = page.getByTestId('bill-panel');
    await expect(panel.getByTestId('bill-tag')).toHaveText(first);
    await expect(panel).toHaveAttribute('data-desk', 'cashier');
    await expect(panel.getByTestId('action-checkout')).toBeVisible();
    await expect(panel.getByTestId('action-add')).toHaveCount(0);
    // 回发卡台处理：带着这张牌过去
    await panel.getByTestId('go-issue').click();
    await expect(page).toHaveURL(/\/frontdesk/);
    await expect(page.getByTestId('bill-panel')).toHaveAttribute('data-desk', 'issue');
    await expect(page.getByTestId('bill-panel').getByTestId('bill-tag')).toHaveText(first);
  });
});
