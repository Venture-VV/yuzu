// 8.1.15 发卡台与收银台（docs/DESKS_V8115.md）的浏览器验收：
//   ① 主导航里「前台」分成「发卡台」「收银台」两个；
//   ② 发卡台：手牌卡片与客人卡上认得出会员档阶与基础权益（VIP 柜、手上的券）；加项目、作废、换牌都在；没有预结账、结账、结账记录，F9 不开结账；
//   ③ 从客人卡「去收银台结账」：待结账清单上这张牌标着「签赠」；账单只读（没有加项目、作废、换牌，F4 不开加项目）；
//      「权益与优惠」里这张签赠写着渠道、发放人、授权人、事由；
//   ④ 结账选这张签赠券：结账单与小票的「优惠与赠送」写明签赠、发放人、授权人，「收款」里只有现金；结完这张牌从待结账清单里走了。
//   ⑤ 前台 1 细化（第 7 节，YB2、YB3、YB5–YB8）：收银台的预结账分列——每张手牌与合计都分门票、餐饮、客房、服务、优惠、押金
//      （分列的数字用合成的返回，不用真的去点餐、住客房；真数据的押金在 tests/desks.test.ts），四种屏幕放得下；
//      两个台的入口按权限显示（临时改前台店员的岗位权限，用完改回去）。
// 依赖演示数据（seed-demo、seed-frontdesk-demo：店主 linlan、前台 xiaozhou、值班经理 zhangjl，密码 yuzu2026）。会登记单据，只在门店电脑尺寸执行；
// 每次新建一位会员与一个签赠券类型，不改演示数据里已有的档案。三台目标设备上的版面在 e2e/target-devices.spec.ts。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { CheckoutPreview } from '../src/shared/checkout';
import type { PreviewBill } from '../src/shared/frontdesk';

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

/** 预结账两个接口的地址（都带 ?ids=） */
const PREVIEW_URL = /\/api\/frontdesk\/preview\?/;
const PRICED_URL = /\/api\/frontdesk\/checkout-preview\?/;
const PREVIEW_COLUMNS = ['ticket', 'dining', 'room', 'service', 'discount', 'deposit'] as const;

/**
 * 预结账的分列用合成的数字（真的返回上改几个字段，不用真的去点餐、住客房）：
 * 餐饮 2 条 ¥98（一份套餐 + 一条加料）、客房 1 晚 ¥288、服务 3 条 ¥246（搓澡 68 + 技师 128 + 其他 50）、门票 ¥499，
 * 会员折扣省 ¥11.76，可用的券 2 张（签赠 1 张）、不能用的 1 张，在住客房 8301 还押着 ¥250。
 */
async function synthesizePreview(page: Page, tagCode: string) {
  const lines: PreviewBill['visits'][number]['bySource'] = [
    { source: 'bath', amountCents: 6800, lineCount: 1 },
    { source: 'dining', amountCents: 9800, lineCount: 2 },
    { source: 'therapist', amountCents: 12800, lineCount: 1 },
    { source: 'room', amountCents: 28800, lineCount: 1 },
    { source: 'other', amountCents: 5000, lineCount: 1 },
  ];
  const linesAmount = lines.reduce((n, l) => n + l.amountCents, 0);
  await page.route(PREVIEW_URL, async (route) => {
    const res = await route.fetch();
    const real = (await res.json()) as PreviewBill;
    const json: PreviewBill = {
      ...real,
      visits: real.visits.map((v) => ({ ...v, amountCents: linesAmount, bySource: lines, deposit: { amountCents: 25000, rooms: ['8301'] } })),
      totalCents: linesAmount * real.visits.length,
      bySource: lines.map(({ source, amountCents }) => ({ source, amountCents })),
      depositCents: 25000 * real.visits.length,
    };
    await route.fulfill({ response: res, json });
  });
  const coupon = (couponId: number, usable: boolean, gift: boolean): NonNullable<CheckoutPreview['storeCoupons']>[number] => ({
    couponId,
    code: `E2E${couponId}`,
    templateName: '合成的券',
    summary: '抵 ¥20',
    memberId: 1,
    memberName: '分列会员',
    validTo: '2099-12-31',
    usable,
    amount: usable ? 2000 : 0,
    reason: usable ? null : '还没到能用的日子',
    gift: gift ? { segment: '浴区', authorizerName: '张经理', channel: '管家部', reason: '合成', issuerName: '管家' } : null,
  });
  await page.route(PRICED_URL, async (route) => {
    const res = await route.fetch();
    const real = (await res.json()) as CheckoutPreview;
    const ticket = {
      typeId: 1,
      name: '不含餐',
      segments: 1,
      tierLabel: '12 小时档',
      amount: 49900,
      stayMinutes: 5,
      nextJumpAt: new Date(Date.now() + 3_600_000).toISOString(),
      nextAmount: 99800,
      endAt: null,
    };
    const json: CheckoutPreview = {
      ...real,
      visits: real.visits.map((v) => ({ ...v, linesAmount, ticket, needsTicket: false, amount: linesAmount + ticket.amount })),
      totalAmount: (linesAmount + ticket.amount) * real.visits.length,
      memberDiscounts: [
        {
          memberId: 1,
          memberName: '分列会员',
          tagCode,
          benefitId: 1,
          code: 'E2E',
          name: '餐饮折扣',
          version: 1,
          rate: 88,
          stateLabel: 'L2 观澜',
          target: 'bill',
          base: 9800,
          amount: 1176,
          companions: [],
        },
      ],
      storeCoupons: [coupon(1, true, false), coupon(2, true, true), coupon(3, false, false)],
    };
    await route.fulfill({ response: res, json });
  });
}

/** 收银台选中一张在店的手牌、打开预结账 */
async function openPreview(page: Page, visitId: number, code: string) {
  await page.goto(`/cashier?v=${visitId}`);
  const panel = page.getByTestId('bill-panel');
  await expect(panel.getByTestId('bill-tag')).toHaveText(code);
  await panel.getByTestId('action-preview').click();
  const preview = page.getByTestId('preview');
  await expect(preview.getByTestId('preview-columns')).toBeVisible();
  return preview;
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

  test('收银台的预结账分列：每张手牌与合计都分门票、餐饮、客房、服务、优惠、押金；押金只显示、不进应收；四种屏幕放得下', async ({ page, browser, baseURL }) => {
    test.setTimeout(180_000);
    await login(page, 'linlan');
    const code = (await freeTags(page))[0]!;
    const { visits } = await postJson<{ visits: { id: number }[] }>(page, '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
    const visitId = visits[0]!.id;
    try {
      // ── 合成的数字：六列都有内容 ──
      await synthesizePreview(page, code);
      const preview = await openPreview(page, visitId, code);
      for (const prefix of [`preview-${code}`, 'preview-col']) {
        const cell = (c: string) => preview.getByTestId(`${prefix}-${c}`);
        await expect(cell('ticket')).toContainText('¥499.00');
        await expect(cell('dining')).toContainText('¥98.00');
        await expect(cell('dining')).toContainText('2 项');
        await expect(cell('room')).toContainText('¥288.00');
        await expect(cell('room')).toContainText('1 项');
        await expect(cell('service')).toContainText('¥246.00');
        await expect(cell('service')).toContainText('3 项，含其他 ¥50.00');
        await expect(cell('discount')).toContainText('−¥11.76');
        await expect(cell('deposit')).toContainText('¥250.00');
      }
      await expect(preview.getByTestId(`preview-${code}-ticket`)).toContainText('不含餐 · 12 小时档');
      await expect(preview.getByTestId(`preview-${code}-discount`)).toContainText('L2 观澜 8.8 折');
      await expect(preview.getByTestId(`preview-${code}-deposit`)).toContainText('客房 8301，退房时退');
      await expect(preview.getByTestId('preview-col-discount')).toContainText('会员折扣，自动带上');
      await expect(preview.getByTestId('preview-col-deposit')).toContainText('退房时退，不在这里抵');
      // 优惠：会自动带上的会员折扣写明是谁的、哪一项、省多少；券只写有几张可用（不能用的不数）
      await expect(preview.getByTestId('preview-perks')).toContainText('分列会员 的「餐饮折扣」（L2 观澜 8.8 折）结账时自动带上，省 ¥11.76');
      await expect(preview.getByTestId('preview-perks')).toContainText('另有 2 张券可用（其中签赠 1 张），结账时由收银员选');
      // 押金只显示：应收 = 明细 632 + 门票 499，不含押着的 250；带上会员折扣后 1,119.24
      await expect(preview.getByTestId('preview-deposit-note')).toContainText('客房 8301 还押着 ¥250.00，退房时退，不在手牌结账里抵');
      await expect(preview).toContainText('明细 ¥632.00 + 门票 ¥499.00');
      await expect(preview.getByTestId('preview-total')).toHaveText('¥1,131.00');
      await expect(preview.getByTestId('preview-after-discount')).toContainText('¥1,119.24');
      await expect(preview).toContainText('这还不是结账单');
      // 门店电脑上六列排成一行；列名不小于 12 像素、金额不小于 16 像素；「去结账」不矮于 44 像素
      const tops = await Promise.all(PREVIEW_COLUMNS.map(async (c) => Math.round((await preview.getByTestId(`preview-col-${c}`).boundingBox())!.y)));
      expect(new Set(tops).size, `六列的上沿 ${tops.join(',')}`).toBe(1);
      const sizes = await preview
        .getByTestId('preview-col-dining')
        .locator('p')
        .evaluateAll((ps) => ps.map((el) => parseFloat(getComputedStyle(el).fontSize)));
      expect(sizes).toHaveLength(3);
      expect(sizes[0]).toBeGreaterThanOrEqual(12);
      expect(sizes[1]).toBeGreaterThanOrEqual(16);
      expect(sizes[2]).toBeGreaterThanOrEqual(12);
      expect((await page.getByTestId('preview-checkout').boundingBox())!.height).toBeGreaterThanOrEqual(44);

      // ── 四种屏幕（docs/DEVICES.md）：页面不横向滚动，六格都在屏幕里、金额不被格子截掉，「去结账」在屏幕里 ──
      for (const d of [
        { name: '1920×1080', viewport: { width: 1920, height: 1080 }, mobile: false },
        { name: '1280×720', viewport: { width: 1280, height: 720 }, mobile: false },
        { name: '360×800', viewport: { width: 360, height: 800 }, mobile: true },
        { name: '1355×903', viewport: { width: 1355, height: 903 }, mobile: false },
      ]) {
        const ctx = await browser.newContext({ baseURL, viewport: d.viewport, hasTouch: true, isMobile: d.mobile, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
        try {
          const p = await ctx.newPage();
          await login(p, 'linlan');
          await synthesizePreview(p, code);
          const dlg = await openPreview(p, visitId, code);
          await expect(dlg.getByTestId('preview-col-deposit')).toContainText('¥250.00');
          expect(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${d.name} 页面不横向滚动`).toBe(true);
          for (const c of PREVIEW_COLUMNS) {
            const cell = dlg.getByTestId(`preview-col-${c}`);
            await cell.scrollIntoViewIfNeeded();
            const box = (await cell.boundingBox())!;
            expect(box.x, `${d.name} ${c} 左边`).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width, `${d.name} ${c} 右边`).toBeLessThanOrEqual(d.viewport.width + 1);
            expect(await cell.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${d.name} ${c} 金额放得下`).toBe(true);
          }
          const go = (await p.getByTestId('preview-checkout').boundingBox())!;
          expect(go.height, `${d.name} 去结账的高度`).toBeGreaterThanOrEqual(44);
          expect(go.x + go.width, `${d.name} 去结账在屏幕里`).toBeLessThanOrEqual(d.viewport.width + 1);
          expect(go.y + go.height, `${d.name} 去结账在屏幕里`).toBeLessThanOrEqual(d.viewport.height + 1);
        } finally {
          await ctx.close();
        }
      }

      // ── 真的数据：这位散客刚进店、什么都没挂——三列明细与押金是横线，没有折扣也没有券；应收与接口一致 ──
      await page.unroute(PREVIEW_URL);
      await page.unroute(PRICED_URL);
      const real = await openPreview(page, visitId, code);
      for (const c of ['dining', 'room', 'service', 'deposit']) await expect(real.getByTestId(`preview-col-${c}`)).toContainText('—');
      await expect(real.getByTestId('preview-perks')).toContainText('没有能自动带上的会员折扣。没有可用的券。');
      await expect(real.getByTestId('preview-deposit-note')).toHaveCount(0);
      await expect(real.getByTestId('preview-after-discount')).toHaveCount(0);
      const priced = await getJson<CheckoutPreview>(page, `/api/frontdesk/checkout-preview?ids=${visitId}`);
      await expect(real.getByTestId('preview-total')).toHaveText(`¥${(priced.totalAmount / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    } finally {
      await postJson(page, `/api/frontdesk/visits/${visitId}/cancel`, { reason: '浏览器用例收尾' });
    }
  });

  test('两个台的入口按权限显示：去掉「结账收款」只剩发卡台，去掉「接待发牌」只剩收银台；只有查看的两个都看得到，连查看都没有的都看不到', async ({ page, browser, baseURL }) => {
    test.setTimeout(180_000);
    await login(page, 'linlan');
    const matrix = await getJson<{ effective: Record<string, string[]> }>(page, '/api/admin/permissions');
    const clerk = matrix.effective.clerk!;
    for (const perm of ['frontdesk.read', 'frontdesk.operate', 'frontdesk.checkout']) expect(clerk, '前台店员默认三项都有').toContain(perm);
    const setClerk = async (drop: string[]) => {
      const res = await page.request.put('/api/admin/permissions', { data: { roles: { clerk: clerk.filter((x) => !drop.includes(x)) } } });
      expect(res.ok(), await res.text()).toBe(true);
    };
    // 前台店员小周在另一个浏览器里；每改一次岗位权限重新登录一次
    const ctx = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const staff = await ctx.newPage();
    const link = (name: string) => staff.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true });
    const sees = async (issue: boolean, cashier: boolean) => {
      await staff.request.post('/api/auth/logout');
      await login(staff, 'xiaozhou');
      await expect(link('发卡台')).toHaveCount(issue ? 1 : 0);
      await expect(link('收银台')).toHaveCount(cashier ? 1 : 0);
    };
    try {
      await sees(true, true);
      expect((await getJson<{ staff: { role: string } }>(staff, '/api/auth/me')).staff.role).toBe('clerk');

      await setClerk(['frontdesk.checkout']);
      await sees(true, false);
      // 入口只管主导航：地址直接打开收银台照旧进得去（按「查看在店手牌」），里面没有结账的按钮可用
      await staff.goto('/cashier');
      await expect(staff.getByTestId('cashier-queue')).toBeVisible();

      await setClerk(['frontdesk.operate']);
      await sees(false, true);
      await staff.goto('/frontdesk');
      await expect(staff.getByTestId('tag-board')).toBeVisible();

      await setClerk(['frontdesk.operate', 'frontdesk.checkout']);
      await sees(true, true);

      await setClerk(['frontdesk.read', 'frontdesk.operate', 'frontdesk.checkout']);
      await sees(false, false);
    } finally {
      const back = await page.request.put('/api/admin/permissions', { data: { roles: { clerk } } });
      expect(back.ok(), await back.text()).toBe(true);
      await ctx.close();
    }
    // 改回去以后两个入口都回来了
    const again = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    try {
      const p = await again.newPage();
      await login(p, 'xiaozhou');
      const nav = p.getByRole('navigation', { name: '主导航' });
      await expect(nav.getByRole('link', { name: '发卡台', exact: true })).toHaveCount(1);
      await expect(nav.getByRole('link', { name: '收银台', exact: true })).toHaveCount(1);
    } finally {
      await again.close();
    }
  });
});
