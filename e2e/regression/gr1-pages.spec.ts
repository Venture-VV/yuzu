// 测试会话 · G-R1 页面回归：HANDOFF_GR1 第 6 节里还没有浏览器用例覆盖的页面行为（店主 2026-10-29 签认的 R1.2 规则）。
//   S1 充值确认页：没开班时出现开班提示、不能入账，就地开班后可以入账；
//   S1 反结账：现金单默认从收银员的钱箱退（跨钱箱退款，店主 2026-10-30 定），退款与「反结账、从本班钱箱退」记在收银员的交班表；
//      扫码单没开班时反结账区出现开班提示、不能确认，就地开班后反结账，退款提醒列在值班经理的交班表；
//   R6 反结账后重结：账单与结账对话框写明门票按第一次结账的时刻计算；
//   R7 结账记录：值班经理可以看前一晚的单，店员只看本营业日；
//   O1 「其他」收款不写备注不能结清；
//   D9 日结营业口径分列应收、优惠、净营业额、实收；看板写明应收与优惠。
// 依赖四套演示数据（仅独立演示库）；会改数据，只在门店电脑尺寸执行；每次自动挑空闲手牌、先交掉上次留下的班次，可重复执行。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true });

interface Shift {
  id: number;
  summary: { cash: { expected: number } };
}
const currentShift = async (page: Page) => ((await (await page.request.get('/api/shifts/current')).json()) as { shift: Shift | null }).shift;

/** 交掉本人未交班的班次（应有现金为负时实点 0），让页面从「没有开班」开始 */
async function closeOpenShift(page: Page) {
  const s = await currentShift(page);
  if (!s) return;
  const expected = s.summary.cash.expected;
  const res = await page.request.post(`/api/shifts/${s.id}/close`, { data: { countedCash: Math.max(0, expected), expectedCash: expected, note: 'E2E：从没有开班开始' } });
  expect(res.ok(), await res.text()).toBe(true);
}

async function ensureShift(page: Page) {
  const res = await page.request.post('/api/shifts', { data: { openingCash: 0 } });
  expect([200, 409], await res.text()).toContain(res.status());
}

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  locked: boolean;
  active: boolean;
  visit: { id: number } | null;
}

/** 接待一位散客（默认票种「不含餐」），返回手牌号与来访 */
async function newGuest(page: Page) {
  const tags = ((await (await page.request.get('/api/frontdesk/board')).json()) as { tags: BoardTag[] }).tags;
  const code = tags.find((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit)!.code;
  const res = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: crypto.randomUUID(), guests: [{ tagCode: code, zone: 'male' }] } });
  expect(res.status(), await res.text()).toBe(201);
  return { code, visitId: ((await res.json()) as { visits: { id: number }[] }).visits[0]!.id };
}

async function openBill(page: Page, code: string) {
  await page.goto('/frontdesk');
  await expect(page.getByTestId('tag-board')).toBeVisible();
  await page.getByTestId(`tag-${code}`).click();
  await expect(page.getByTestId('bill-tag')).toHaveText(code);
}

/** 开班提示里登记备用金 0 后开班，提示随之消失 */
async function startShiftInGate(scope: Pick<Page, 'getByTestId'>) {
  const gate = scope.getByTestId('shift-gate');
  await gate.getByLabel('备用金').fill('0');
  await gate.getByTestId('shift-start-submit').click();
  await expect(scope.getByTestId('shift-gate')).toHaveCount(0);
}

test.describe('G-R1 页面回归', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');

  test('S1 充值：没开班时确认页出现开班提示、不能入账；就地开班后可以入账', async ({ page }) => {
    await login(page, 'xiaozhou');
    await closeOpenShift(page);
    await page.goto('/');
    await page.getByLabel('搜索会员').fill('黎明月');
    await page.getByRole('option').filter({ hasText: '黎明月' }).first().click();
    await expect(page.getByText('可用余额').first()).toBeVisible();
    await page.getByRole('button', { name: /^充值/ }).click();
    await page.getByRole('button', { name: /常泡 500/ }).click();
    await page.getByRole('button', { name: '支付宝' }).click();
    await page.getByRole('button', { name: '下一步：核对收款' }).click();
    await expect(page.getByTestId('shift-gate')).toContainText('充值前要先开班');
    await page.getByText('我已核实').click();
    await expect(page.getByRole('button', { name: /确认入账/ })).toBeDisabled();
    await startShiftInGate(page);
    await expect(page.getByRole('button', { name: /确认入账/ })).toBeEnabled();
    await page.getByRole('button', { name: /确认入账/ }).click();
    await expect(page.getByText('充值已入账')).toBeVisible();
  });

  test('S1 反结账：现金单默认从收银员的钱箱退、退款记在收银员的交班表；扫码单没开班时不能确认、就地开班后反结账；R6 重结的门票按第一次结账的时刻', async ({ page, browser }) => {
    // 前台收银员结两张 499：一张现金、一张微信
    await login(page, 'xiaozhou');
    await ensureShift(page);
    // 两位客人先都接待（各拿一张手牌），再分别结账：反结账恢复在店时两张牌都还空着
    const guests = [await newGuest(page), await newGuest(page)];
    const pay = async (guest: { code: string; visitId: number }, method: 'cash' | 'wechat') => {
      const res = await page.request.post('/api/frontdesk/checkouts', {
        data: { clientKey: crypto.randomUUID(), visitIds: [guest.visitId], expectedTotal: 49900, payments: [{ method, amount: 49900, ...(method === 'wechat' ? { ref: '尾号 E2E1' } : {}) }] },
      });
      expect(res.status(), await res.text()).toBe(200);
      return { guest, checkout: (await res.json()) as { id: number; checkoutNo: string } };
    };
    const cash = await pay(guests[0]!, 'cash');
    const wechat = await pay(guests[1]!, 'wechat');

    // 值班经理在另一台电脑上反结账：先从没有开班开始
    const managerContext = await browser.newContext();
    try {
      const manager = await managerContext.newPage();
      await login(manager, 'zhangjl');
      await closeOpenShift(manager);
      await nav(manager, '前台').click();
      await manager.getByTestId('open-checkouts').click();
      const records = manager.getByRole('dialog', { name: '结账记录' });

      // 现金单：跨钱箱退款（店主 2026-10-30 定），默认从原收款人（收银员）的钱箱退，不用自己开班
      await records.getByText(cash.checkout.checkoutNo).click();
      await records.getByTestId('checkout-void').click();
      await expect(records.getByTestId('refund-drawer').getByRole('radio', { checked: true })).toContainText('原单收款的班次');
      await expect(records.getByTestId('shift-gate')).toHaveCount(0);
      await records.getByLabel('反结账原因').fill('E2E：收款方式记错');
      await records.getByTestId('checkout-void-confirm').click();
      await expect(manager.getByText(`已反结账 ${cash.checkout.checkoutNo}`)).toBeVisible();
      await records.getByRole('button', { name: '← 返回列表' }).click();

      // 扫码单：不选钱箱，仍要反结账人先开班；就地开班后反结账
      await records.getByText(wechat.checkout.checkoutNo).click();
      await records.getByTestId('checkout-void').click();
      await expect(records.getByTestId('shift-gate')).toContainText('反结账前要先开班');
      await records.getByLabel('反结账原因').fill('E2E：客人要求退款');
      await expect(records.getByTestId('checkout-void-confirm')).toBeDisabled();
      await startShiftInGate(records);
      await expect(records.getByTestId('checkout-void-confirm')).toBeEnabled();
      await records.getByTestId('checkout-void-confirm').click();
      await expect(manager.getByText(`已反结账 ${wechat.checkout.checkoutNo}`)).toBeVisible();
      await manager.keyboard.press('Escape');
      await expect(records).toHaveCount(0);

      // 值班经理的交班表：扫码单按原收款方式列出退款提醒，不扣现金
      await nav(manager, '交班').click();
      await expect(manager.getByTestId('shift-refunds')).toContainText(wechat.checkout.checkoutNo);
      await expect(manager.getByTestId('shift-refunds')).toContainText('退款按原收款方式');
      await expect(manager.getByTestId('shift-refunds')).not.toContainText(cash.checkout.checkoutNo);
    } finally {
      await managerContext.close();
    }

    // 收银员的交班表：现金单的退款记在这里，写明是值班经理反结账的，现金从应有现金里扣掉
    await nav(page, '交班').click();
    await expect(page.getByTestId('shift-refunds')).toContainText(cash.checkout.checkoutNo);
    await expect(page.getByTestId('shift-refunds')).toContainText('反结账、从本班钱箱退');
    await expect(page.getByTestId('shift-cash-formula')).toContainText('反结账退现金');

    // 客人恢复在店；重结时门票按第一次结账的时刻
    await openBill(page, cash.guest.code);
    await expect(page.getByTestId('bill-panel')).toContainText('按第一次结账');
    await page.getByTestId('bill-panel').getByTestId('action-checkout').click();
    await expect(page.getByTestId('ticket-frozen')).toContainText('按第一次结账');
  });

  test('R7 结账记录：值班经理可以切到前一晚，店员只看本营业日', async ({ page }) => {
    await login(page, 'zhangjl');
    const me = (await (await page.request.get('/api/auth/me')).json()) as { today: string };
    await nav(page, '前台').click();
    await page.getByTestId('open-checkouts').click();
    const records = page.getByRole('dialog', { name: '结账记录' });
    await expect(records).toContainText(`营业日 ${me.today}`);
    await records.getByTestId('checkout-records-date').getByRole('button', { name: '前一晚的单' }).click();
    await expect(records).not.toContainText(`营业日 ${me.today}`);
    await page.keyboard.press('Escape');

    await page.request.post('/api/auth/logout');
    await login(page, 'xiaozhou');
    await nav(page, '前台').click();
    await page.getByTestId('open-checkouts').click();
    const clerkRecords = page.getByRole('dialog', { name: '结账记录' });
    await expect(clerkRecords).toContainText(`营业日 ${me.today}`);
    await expect(clerkRecords.getByRole('button', { name: '前一晚的单' })).toHaveCount(0);
    await expect(clerkRecords.getByRole('button', { name: '前一天' })).toHaveCount(0);
  });

  test('O1 「其他」收款不写备注不能结清，写上备注后可以', async ({ page }) => {
    await login(page, 'xiaozhou');
    await ensureShift(page);
    const guest = await newGuest(page);
    await openBill(page, guest.code);
    await page.getByTestId('bill-panel').getByTestId('action-checkout').click();
    await expect(page.getByTestId('checkout-review')).toBeVisible();
    await page.getByTestId('pay-add-other').click();
    const row = page.getByTestId('pay-row-other');
    await expect(row).toContainText('「其他」收款请在备注里写明收的是什么');
    await expect(page.getByTestId('checkout-submit')).toBeDisabled();
    await row.getByPlaceholder('写明收的是什么（必填）').fill('老客户挂账，明天转账');
    await expect(page.getByTestId('checkout-submit')).toBeEnabled();
  });

  test('D9 日结分列应收、优惠、净营业额、实收；看板写明应收与优惠', async ({ page }) => {
    await login(page, 'linlan');
    // 本营业日先有一张带优惠的结账单（营业日刚切换、还没有单据时日结不显示营业口径）
    await ensureShift(page);
    const guest = await newGuest(page);
    const grant = await page.request.post('/api/auth/authorize', {
      data: { username: 'zhangjl', password: PASSWORD, purpose: 'checkout_discount', scope: { visitIds: [guest.visitId], amount: 100, reason: 'E2E 抹零' } },
    });
    expect(grant.status(), await grant.text()).toBe(200);
    const paid = await page.request.post('/api/frontdesk/checkouts', {
      data: {
        clientKey: crypto.randomUUID(),
        visitIds: [guest.visitId],
        expectedTotal: 49900,
        payments: [
          { method: 'discount', amount: 100, grantId: ((await grant.json()) as { grantId: string }).grantId },
          { method: 'cash', amount: 49800 },
        ],
      },
    });
    expect(paid.status(), await paid.text()).toBe(200);
    await nav(page, '日结').click();
    const breakdown = page.getByTestId('settlement-breakdown');
    for (const label of ['应收（结账 − 反结账）', '优惠 / 免单（当场授权）', '净营业额（应收 − 优惠）', '实收（现金、扫码、银行卡、其他）']) {
      await expect(breakdown).toContainText(label);
    }
    await nav(page, '看板').click();
    await expect(page.getByTestId('dashboard')).toContainText('今日净营业额（应收 − 优惠）');
    await expect(page.getByTestId('dashboard-discount')).toContainText('优惠');
  });
});
