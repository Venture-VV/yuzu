// 完整收银流程（R1.6）：前台开班 → 接待会员与同行 → 挂账 → 储值 + 团购 + 现金组合结账 → 打印结账单 → 值班经理反结账 →
// 改收现金重新结账 → 交班。依赖 seed-demo、seed-frontdesk-demo、seed-billing-demo（仅独立演示库）。
// 账号：前台 xiaozhou 收银、值班经理 zhangjl 反结账，密码 yuzu2026。每次自动挑空闲手牌与不在店、余额够的演示会员，可重复执行。
// 反结账退的现金算在哪个班次随版本不同（v0.3 从原收款人的班次去掉；R1.2 起原单留在原班次、退款扣反结账人的班次），
// 这里核对与口径无关的部分：两人交班表的应有现金变动合计 = 实际净收现金。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 }); // 刚启动的服务第一次登录可能较慢
}

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true });

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

/** 与页面一致的金额写法：¥1,056.00 */
const yuan = (cents: number) => `¥${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Shift {
  id: number;
  shiftNo: string;
  status: 'open' | 'closed';
  openingCash: number;
  expectedCash: number | null;
  countedCash: number | null;
  summary: { cash: { expected: number } };
}

const currentShift = async (page: Page) => (await getJson<{ shift: Shift | null }>(page, '/api/shifts/current')).shift;

/** 上一次执行中断时可能留下本人未交班的班次：按应有现金交掉，让页面从「开班」开始 */
async function closeLeftoverShift(page: Page) {
  const s = await currentShift(page);
  if (!s) return;
  const expected = s.summary.cash.expected;
  const res = await page.request.post(`/api/shifts/${s.id}/close`, { data: { countedCash: expected, expectedCash: expected, note: 'E2E：清理上次未交的班' } });
  expect(res.ok(), await res.text()).toBe(true);
}

/** 本人还没有当班班次时开一个（备用金 0）。R1.2 起反结账也要先开班；之前的版本开班可选，开了也不影响 */
async function ensureShift(page: Page) {
  const res = await page.request.post('/api/shifts', { data: { openingCash: 0 } });
  expect([200, 409], await res.text()).toContain(res.status());
}

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number; memberId: number | null } | null;
}

const boardTags = async (page: Page) => (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags;

/** 空闲普通柜：从清单末尾挑，避开演示数据里的在店手牌 */
const freeTags = (tags: BoardTag[], zone: BoardTag['zone']) =>
  tags.filter((t) => t.zone === zone && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse();

interface Member {
  id: number;
  name: string;
  phone: string;
  gender: 'male' | 'female' | null;
  status: 'active' | 'frozen';
  principalBalance: number;
  bonusBalance: number;
}

/** seed-demo 的合成会员（手机号 19900001xxx）里挑一位不在店、可用余额够 300 元的 */
async function pickMember(page: Page, tags: BoardTag[]) {
  const inStore = new Set(tags.map((t) => t.visit?.memberId).filter((id): id is number => !!id));
  const list = await getJson<Member[]>(page, '/api/members?q=19900001&limit=50');
  const m = list.find((x) => x.status === 'active' && !inStore.has(x.id) && x.principalBalance + x.bonusBalance >= 50000);
  expect(m, '演示会员（seed-demo）里没有不在店、余额够的').toBeTruthy();
  return m!;
}

/** 会员详情会先作废到期赠金，读到的是可用余额 */
const balance = async (page: Page, id: number) => {
  const m = await getJson<Member>(page, `/api/members/${id}`);
  return { principal: m.principalBalance, bonus: m.bonusBalance };
};

interface CheckoutSummary {
  id: number;
  checkoutNo: string;
  status: 'completed' | 'voided';
  tagCodes: string[];
}

test.describe('完整收银', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');
  test.setTimeout(180_000);

  test('开班 → 接待会员与同行 → 挂账 → 储值 + 团购 + 现金结账 → 打印 → 值班经理反结账 → 改收现金重结 → 交班', async ({ page, browser }) => {
    // ① 前台开班，备用金 500 元
    await login(page, 'xiaozhou');
    await closeLeftoverShift(page);
    await nav(page, '交班').click();
    await expect(page.getByTestId('shift-start')).toBeVisible();
    await page.getByTestId('shift-opening-cash').fill('500');
    await page.getByTestId('shift-start-submit').click();
    await expect(page.getByTestId('shift-open')).toBeVisible();
    const shift = (await currentShift(page))!;
    expect(shift.openingCash).toBe(50000);

    // ② F2 接待：会员 + 同行女宾（自动建同行组）
    await nav(page, '前台').click();
    await expect(page.getByTestId('tag-board')).toBeVisible();
    const tags = await boardTags(page);
    const member = await pickMember(page, tags);
    const memberZone = member.gender ?? 'male';
    const memberTag = freeTags(tags, memberZone)[0]!;
    const friendTag = freeTags(tags, 'female').find((c) => c !== memberTag)!;
    const before = await balance(page, member.id);

    await page.keyboard.press('F2');
    const checkin = page.getByRole('dialog', { name: '接待发牌' });
    await expect(checkin).toBeVisible();
    await checkin.getByRole('radiogroup', { name: '客人类型' }).getByRole('radio', { name: '会员' }).click();
    await checkin.getByLabel('查找会员').fill(member.phone);
    await checkin.getByRole('button').filter({ hasText: member.name }).first().click();
    await expect(checkin.getByTestId('checkin-member')).toContainText(member.name);
    await checkin.getByRole('radiogroup', { name: '第 1 位宾客分区' }).getByRole('radio', { name: memberZone === 'male' ? '男宾' : '女宾' }).click();
    await checkin.getByLabel('第 1 位牌号').fill(memberTag);
    await expect(checkin.getByTestId('guest-row-0')).toContainText('空闲可发');
    await checkin.getByRole('button', { name: '添加同行客人' }).click();
    await checkin.getByRole('radiogroup', { name: '第 2 位宾客分区' }).getByRole('radio', { name: '女宾' }).click();
    await checkin.getByLabel('第 2 位牌号').fill(friendTag);
    await checkin.getByLabel('第 2 位称呼').fill('E2E 同行');
    await expect(checkin.getByTestId('guest-row-1')).toContainText('空闲可发');
    await checkin.getByTestId('checkin-submit').click();
    await expect(page.getByText(`已发牌 ${memberTag}、${friendTag}`)).toBeVisible();

    // ③ F4 挂账：会员加一个搓背
    const panel = page.getByTestId('bill-panel');
    await expect(panel.getByTestId('bill-tag')).toHaveText(memberTag);
    await expect(panel.getByTestId('bill-group')).toContainText(friendTag);
    await page.keyboard.press('F4');
    const add = page.getByRole('dialog').filter({ hasText: '加项目' });
    await add.getByTestId('item-搓背').click();
    await add.getByTestId('add-items-submit').click();
    await expect(panel.getByTestId('bill-total')).toContainText('58.00');

    // ④ 结账：同行两张牌一起结；门票不含餐 12 小时档 499 × 2 + 搓背 58 = 1,056；储值 300 + 美团券 499 + 现金 257
    await panel.getByTestId('action-checkout').click();
    const review = page.getByTestId('checkout-review');
    await expect(review.getByTestId(`checkout-ticket-${memberTag}`)).toContainText('不含餐');
    await expect(review.getByTestId(`checkout-ticket-${friendTag}`)).toContainText('不含餐');
    await expect(page.getByTestId('checkout-total')).toContainText('1,056.00');
    await page.getByTestId('pay-add-wallet').click();
    await expect(page.getByTestId('pay-row-wallet')).toContainText(member.name);
    await page.getByLabel('会员储值金额').fill('300');
    await expect(page.getByTestId('wallet-split')).toBeVisible();
    await page.getByTestId('pay-add-coupon').click();
    await page.getByLabel('团购券金额').fill('499');
    await page.getByLabel('团购平台').selectOption('meituan');
    const couponCode = `E2E${Date.now()}`;
    await page.getByTestId('coupon-code').fill(couponCode);
    await page.getByTestId('pay-add-cash').click(); // 现金默认填剩下的 257
    await page.getByLabel('客人实给现金').fill('300');
    await expect(page.getByTestId('pay-row-cash')).toContainText('找零 ¥43.00');
    await page.getByTestId('checkout-submit').click();
    await expect(page.getByText(/已结清 · /)).toBeVisible();

    // ⑤ 打印结账单：新窗口打开打印页（?auto=1 自动调出打印），再直接打开同一页核对内容
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('checkout-print').click()]);
    const printed = /\/print\/checkout\/(\d+)\?auto=1$/.exec(popup.url());
    expect(printed, popup.url()).toBeTruthy();
    await popup.close().catch(() => {});
    const checkoutId = Number(printed![1]);
    await page.getByTestId('checkout-finish').click();
    const first = await getJson<CheckoutSummary & { totalAmount: number }>(page, `/api/frontdesk/checkouts/${checkoutId}`);
    expect(first.status).toBe('completed');
    expect(first.totalAmount).toBe(105600);
    const after = await balance(page, member.id);
    expect(before.principal + before.bonus - (after.principal + after.bonus)).toBe(30000);
    let board = await boardTags(page);
    for (const code of [memberTag, friendTag]) expect(board.find((t) => t.code === code)!.visit, `${code} 结清后释放`).toBeNull();

    const slip = await page.context().newPage();
    await slip.goto(`/print/checkout/${checkoutId}`);
    const receipt = slip.getByTestId('print-checkout');
    await expect(receipt).toContainText(first.checkoutNo);
    await expect(receipt).toContainText(`手牌 ${memberTag}`);
    await expect(receipt).toContainText(`会员 ${member.name}`);
    await expect(receipt).toContainText('搓背');
    await expect(receipt).toContainText('应收合计¥1,056.00');
    await expect(slip.getByTestId('print-payment-wallet')).toContainText(`会员储值 · ${member.name}¥300.00`);
    await expect(slip.getByTestId('print-payment-wallet')).toContainText(`扣前 本金 ${yuan(before.principal)} / 赠金 ${yuan(before.bonus)}`);
    await expect(slip.getByTestId('print-payment-wallet')).toContainText(`扣后 本金 ${yuan(after.principal)} / 赠金 ${yuan(after.bonus)}`);
    await expect(slip.getByTestId('print-payment-coupon')).toContainText(`美团 · 券码尾号 ${couponCode.slice(-4)}`);
    await expect(slip.getByTestId('print-payment-cash')).toContainText('¥257.00');

    // ⑥ 值班经理在另一台电脑上反结账（客人改用现金支付）：储值退回、团购券作废、两张牌恢复在店
    const managerContext = await browser.newContext();
    try {
      const manager = await managerContext.newPage();
      await login(manager, 'zhangjl');
      await ensureShift(manager);
      const managerBefore = (await currentShift(manager))!;
      await nav(manager, '前台').click();
      await manager.getByTestId('open-checkouts').click();
      const records = manager.getByRole('dialog', { name: '结账记录' });
      await records.getByText(first.checkoutNo).click();
      await records.getByTestId('checkout-void').click();
      await records.getByLabel('反结账原因').fill('E2E：客人改用现金支付');
      await records.getByTestId('checkout-void-confirm').click();
      await expect(manager.getByText(`已反结账 ${first.checkoutNo}`)).toBeVisible();

      expect((await getJson<CheckoutSummary>(page, `/api/frontdesk/checkouts/${checkoutId}`)).status).toBe('voided');
      expect(await balance(page, member.id)).toEqual(before);
      board = await boardTags(page);
      for (const code of [memberTag, friendTag]) expect(board.find((t) => t.code === code)!.visit, `${code} 反结账后恢复在店`).toBeTruthy();
      await slip.reload();
      await expect(slip.getByTestId('print-voided')).toContainText('已反结账（本单作废）');
      await expect(slip.getByTestId('print-voided')).toContainText('E2E：客人改用现金支付');
      await expect(slip.getByTestId('print-payment-wallet')).toContainText('已随反结账撤销，储值已退回');
      await expect(slip.getByTestId('print-payment-coupon')).toContainText('（已作废）');
      await slip.close();

      // ⑦ 前台改收现金重新结账：同样 1,056（门票仍是 12 小时档、搓背还在），客人给 1,100 找零 44
      await page.reload();
      await expect(page.getByTestId('tag-board')).toBeVisible();
      await page.getByTestId(`tag-${memberTag}`).click();
      await expect(panel.getByTestId('bill-tag')).toHaveText(memberTag);
      await panel.getByTestId('action-checkout').click();
      await expect(page.getByTestId('checkout-review').getByTestId(`checkout-ticket-${friendTag}`)).toBeVisible();
      await expect(page.getByTestId('checkout-total')).toContainText('1,056.00');
      await page.getByTestId('pay-add-cash').click();
      await page.getByLabel('客人实给现金').fill('1100');
      await expect(page.getByTestId('pay-row-cash')).toContainText('找零 ¥44.00');
      await page.getByTestId('checkout-submit').click();
      await expect(page.getByText(/已结清 · /)).toBeVisible();
      await page.getByTestId('checkout-finish').click();
      const today = (await getJson<{ today: string }>(page, '/api/auth/me')).today;
      const redone = (await getJson<CheckoutSummary[]>(page, `/api/frontdesk/checkouts?date=${today}`)).find(
        (c) => c.status === 'completed' && c.tagCodes.includes(memberTag) && c.id !== checkoutId,
      );
      expect(redone, '重新结账的单').toBeTruthy();
      board = await boardTags(page);
      for (const code of [memberTag, friendTag]) expect(board.find((t) => t.code === code)!.visit, `${code} 重新结清后释放`).toBeNull();
      expect(await balance(page, member.id)).toEqual(before);

      // ⑧ 交班：实点现金与应有一致
      await nav(page, '交班').click();
      await expect(page.getByTestId('shift-open')).toContainText(shift.shiftNo);
      const open = (await currentShift(page))!;
      await page.getByTestId('shift-counted-cash').fill((open.summary.cash.expected / 100).toFixed(2));
      await expect(page.getByTestId('shift-diff')).toHaveText('与应有一致');
      await page.getByTestId('shift-close').click();
      await expect(page.getByText(`已交班 ${shift.shiftNo}`)).toBeVisible();
      await expect(page.getByTestId('shift-start')).toBeVisible();

      const closed = await getJson<Shift>(page, `/api/shifts/${shift.id}`);
      expect(closed.status).toBe('closed');
      expect(closed.countedCash).toBe(closed.expectedCash);
      // 两人交班表的应有现金变动合计 = 现金净收：第一次收 257、反结账退 257、重结收 1,056
      const managerAfter = (await currentShift(manager))!;
      expect(managerAfter.id).toBe(managerBefore.id);
      expect(closed.expectedCash! - closed.openingCash + (managerAfter.summary.cash.expected - managerBefore.summary.cash.expected)).toBe(105600);
    } finally {
      await managerContext.close();
    }

    const checks = await getJson<{ ok: boolean; label: string }[]>(page, '/api/frontdesk/checks');
    for (const c of checks) expect(c.ok, c.label).toBe(true);
  });
});
