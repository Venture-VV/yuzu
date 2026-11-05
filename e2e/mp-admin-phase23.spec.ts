// 后台「微信小程序」第二、三期的几页（小程序线；docs/MP_RECHARGE.md、docs/MP_COUPONS.md、docs/MP_PHASE3.md）浏览器验收：
//   ① 线上充值的设置（开关、可充的套餐、自定义金额、原路退回、单笔上限、每天笔数）走真实接口；页面上的核对，超过前台上限被门店系统拒绝；
//   ② 线上充值的几张列表（演示库里都是空的：拦下这一页的 GET 换成假数据）：原路退回各状态的标记与按钮，重试、已另行处理发出的请求
//      （拦下、核对地址与内容、假装办好）；已付款待处理的单怎么处理（选项与请求）；最近的单、对账、找不到单子的到账；
//   ③ 原路退回的重试结果待确认：刷新后还在、这一笔先不能再点；按原内容重新提交（同一个退款单号）；查回已经办过了自动移除；
//   ④ 领券中心：自建两张券模板，加进来、拿掉、挪先后、每人限领与不限领、停领，保存走真实接口；领取统计与记录用假数据；
//   ⑤ 到期提醒：模板编号与字段名的核对，券快到期、预约到店两种模板，保存走真实接口；统计、网关取消息、最近的消息用假数据；
//   ⑥ 邀请好友：开通、关闭（拨了马上保存，真实接口）；最近的邀请用假数据；
//   ⑦ 扫码点餐：没开餐饮、没配签名密钥时的提示；可点的菜（假的菜）整组勾选、保存走真实接口；桌码、最近的点单用假数据；A4 打印桌码；
//   ⑧ 预约：可约的项目与房间（假的）、待确认与最近的预约（假数据），保存走真实接口；回复丢了自动查回（勾的先后不同也算改上了）；
//   ⑨ 值班经理只看到「会员的微信」，这几页的接口都是 403。
// 依赖 seed-demo（仅独立演示库）。账号：店主 linlan、值班经理 zhangjl，密码 yuzu2026。
// 每页的设置从默认（关着）开始、结束时恢复成默认；写进去的内容带时间；自建的券模板结束时停用，可重复执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type {
  MpAdminData,
  MpBookingAdminData,
  MpBookingAdminOp,
  MpBookingStatus,
  MpCouponAdminData,
  MpCouponClaimAdmin,
  MpFoodAdminData,
  MpInviteAdmin,
  MpInviteAdminData,
  MpInviteState,
  MpRechargeAdminData,
  MpRechargeOrderAdmin,
  MpRefundOrderAdmin,
  MpReminderAdminData,
  MpReminderKind,
  MpReminderMessageAdmin,
  MpReminderStatus,
} from '../src/shared/mp';

const PASSWORD = 'yuzu2026';
/** 本机「结果待确认」记录（src/client/features/mp/mpPending.ts） */
const PENDING_KEY = 'yuzu.mpPending.v1';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

/** 各页设置的默认值（与 src/shared/mp.ts 的 DEFAULT_MP_*_RULES 一致）；不带版本号：不管现在是什么都改回去 */
const DEFAULTS = {
  recharge: { enabled: false, planIds: [], customEnabled: true, maxCents: 1_000_000, dailyLimit: 3, refundAuto: true },
  coupons: { enabled: false, offers: [] },
  reminders: { enabled: false, coupon: null, membership: null, bonus: null, booking: null },
  invites: { enabled: false },
  food: { enabled: false, itemIds: [] },
  bookings: { enabled: false, itemIds: [], spaceIds: [] },
};

async function resetRules(page: Page, tab: keyof typeof DEFAULTS) {
  const res = await page.request.put(`/api/admin/mp/${tab}/rules`, { data: DEFAULTS[tab] });
  expect(res.ok(), `恢复 ${tab} 的设置 → ${res.status()} ${await res.text()}`).toBe(true);
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}
const adminData = (page: Page) => getJson<MpAdminData>(page, '/api/admin/mp');

/** 这一页的 GET 照常请求门店系统，再用 patch 换掉里面（演示库里空着的）列表；只拦 GET，保存照常到门店系统 */
async function patchGet<T>(page: Page, url: string, patch: (real: T) => T) {
  await page.route(url, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: patch((await res.json()) as T) });
  });
}

const openTab = (page: Page, label: string) => page.getByRole('radiogroup', { name: '小程序后台分页' }).getByRole('radio', { name: label, exact: true }).click();
/** 一页的开关（Segmented：关闭 / 开通） */
const switchOf = (page: Page, label: string) => page.getByRole('radiogroup', { name: label });
/** 右下角的提示（Toast 的 aria-live 区域）：只在提示里找，免得认成页面上同样的字（例如「已入账」的标记） */
const toast = (page: Page, text: string | RegExp) => page.locator('[aria-live="polite"]').getByText(text, { exact: true });
const pendingRaw = (page: Page) => page.evaluate((k) => localStorage.getItem(k), PENDING_KEY);
const clearPending = (page: Page) => page.evaluate((k) => localStorage.removeItem(k), PENDING_KEY).catch(() => undefined);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const startsWith = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
/** 大号勾选框（ConfirmCheck）：真正的 checkbox 藏在 label 里（sr-only），点外面的 label */
async function tick(box: Locator, on: boolean) {
  if ((await box.isChecked()) !== on) await box.locator('xpath=..').click();
  await expect(box).toBeChecked({ checked: on });
}

// ── 假数据（只在拦下的 GET 里用；编号从 990000 起，不与演示库的撞）──

const refund = (id: number, memberName: string, p: Partial<MpRefundOrderAdmin>): MpRefundOrderAdmin => ({
  id,
  createdAt: ago(120),
  status: 'failed',
  memberId: id,
  memberName,
  memberNo: `M${id}`,
  memberRefundNo: `TC2026110400${id}`,
  rechargeDocNo: `CZ2026110300${id}`,
  outTradeNo: `MPR20261103E2E0${id}`,
  transactionId: `420000299920261103${id}`,
  outRefundNo: `MPRF20261104E2E0${id}`,
  amount: 10_000,
  wxRefundId: null,
  receivedAccount: null,
  succeededAt: null,
  failCode: null,
  failMessage: null,
  attempts: 1,
  nextTryAt: null,
  handledNote: null,
  handledByName: null,
  handledAt: null,
  ...p,
});

const order = (id: number, memberName: string, p: Partial<MpRechargeOrderAdmin>): MpRechargeOrderAdmin => ({
  id,
  orderNo: `MPR20261104E2E0${id}`,
  status: 'paid',
  memberId: id,
  memberNo: `M${id}`,
  memberName,
  creditedMemberId: null,
  planId: null,
  planName: null,
  amount: 30_000,
  estBonus: 0,
  estLabel: 'L1 汤泉 · 初',
  rechargeId: null,
  rechargeDocNo: null,
  bookedBonus: null,
  bookedLabel: null,
  transactionId: `420000299920261104${id}`,
  paidAt: ago(50),
  bookedAt: null,
  flags: [],
  closedAt: null,
  closeReason: null,
  holdCode: null,
  holdMessage: null,
  heldAt: null,
  resolution: null,
  resolutionNote: null,
  resolvedByName: null,
  resolvedAt: null,
  mock: false,
  createdAt: ago(55),
  expiresAt: ago(40),
  ...p,
});

/** 打印桌码在隐藏的框里调 print()：换成记下要打印的页面（不弹打印框），再当作打印完了（afterprint），看框有没有收掉 */
async function stubFramePrint(page: Page) {
  await page.evaluate(() => {
    const top = window as unknown as { __printed: string[] };
    top.__printed = [];
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')!;
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      get(this: HTMLIFrameElement) {
        const win = desc.get!.call(this) as (Window & { __stubbed?: boolean; Event: typeof Event }) | null;
        if (win && !win.__stubbed) {
          win.__stubbed = true;
          win.print = () => {
            top.__printed.push(win.document.documentElement.outerHTML);
            win.dispatchEvent(new win.Event('afterprint'));
          };
        }
        return win;
      },
    });
  });
}

test.describe('后台「微信小程序」第二、三期的几页（小程序线）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');
  test.setTimeout(120_000);

  test('线上充值：开关、可充的套餐、自定义金额、原路退回、单笔上限与每天笔数（真实接口）；页面上的核对，超过前台上限被拒绝', async ({ page }) => {
    await login(page, 'linlan');
    await resetRules(page, 'recharge');
    const d = await getJson<MpRechargeAdminData>(page, '/api/admin/mp/recharge');
    const plan = d.plans[0]!;
    const v0 = (await adminData(page)).rechargeRules.version;
    // 原路退回的单子固定为没有：卡片上的说明跟着「原路退回」的设置变
    await patchGet<MpRechargeAdminData>(page, '**/api/admin/mp/recharge', (real) => ({ ...real, refunds: [] }));
    await page.goto('/admin/mp');
    try {
      await openTab(page, '线上充值');
      await expect(page.getByText('退储值时，线上充值的那一行选「门店系统原路退回」，门店系统会自己退回到顾客的微信；这里还没有。')).toBeVisible();
      const sw = switchOf(page, '线上充值开关');
      await expect(sw.getByRole('radio', { name: '关闭' })).toHaveAttribute('aria-checked', 'true');
      const planBox = page.getByRole('checkbox', { name: startsWith(plan.name) });
      const custom = page.getByRole('checkbox', { name: /^允许顾客自己填金额/ });
      const refundAuto = page.getByRole('checkbox', { name: /^原路退回：/ });
      const max = page.getByLabel('线上单笔上限', { exact: true });
      const daily = page.getByLabel('每人每天最多几笔');
      const save = page.getByRole('button', { name: '保存线上充值的设置' });
      await expect(planBox).not.toBeChecked();
      await expect(custom).toBeChecked();
      await expect(refundAuto).toBeChecked();
      await expect(max).toHaveValue('10000');
      await expect(daily).toHaveValue('3');

      await sw.getByRole('radio', { name: '开通' }).click();
      await tick(planBox, true);
      await tick(custom, false);
      await tick(refundAuto, false);
      // 页面上先核对：上限只收整元，每天 1–50 笔
      await max.fill('12.5');
      await expect(page.getByText('线上单笔上限请填整元')).toBeVisible();
      await expect(save).toBeDisabled();
      await max.fill('5000');
      await daily.fill('0');
      await expect(page.getByText('每天笔数填 1–50')).toBeVisible();
      await expect(save).toBeDisabled();
      await daily.fill('5');
      await expect(save).toBeEnabled();

      // 超过前台的单笔上限：门店系统拒绝、写原因；第一次就被明确拒绝，不记成待确认，设置没变
      await max.fill(String(Math.floor(d.counterMaxCents / 100) + 1));
      await save.click();
      await expect(toast(page, '没有保存')).toBeVisible();
      await expect(toast(page, /^线上单笔上限不能超过前台的单笔上限/)).toBeVisible();
      expect(await pendingRaw(page)).toBeNull();
      expect((await adminData(page)).rechargeRules.version).toBe(v0);

      await max.fill('5000');
      await save.click();
      await expect(toast(page, '线上充值的设置已保存')).toBeVisible();
      expect((await adminData(page)).rechargeRules).toEqual({
        enabled: true,
        planIds: [plan.id],
        customEnabled: false,
        maxCents: 500_000,
        dailyLimit: 5,
        refundAuto: false,
        version: v0 + 1,
      });
      // 刷新后照保存的显示；原路退回关着，卡片上的说明也变了
      await page.reload();
      await openTab(page, '线上充值');
      await expect(sw.getByRole('radio', { name: '开通' })).toHaveAttribute('aria-checked', 'true');
      await expect(planBox).toBeChecked();
      await expect(custom).not.toBeChecked();
      await expect(refundAuto).not.toBeChecked();
      await expect(max).toHaveValue('5000');
      await expect(daily).toHaveValue('5');
      await expect(page.getByText('原路退回关着：退储值时线上充值的那一行要在商户平台退、填退款单号。')).toBeVisible();
      expect(await pendingRaw(page)).toBeNull();
    } finally {
      await resetRules(page, 'recharge');
    }
  });

  test('线上充值的列表（假数据）：原路退回各状态的标记与按钮，重试、已另行处理发出的请求；已付款待处理的单怎么处理；最近的单、对账', async ({ page }) => {
    await login(page, 'linlan');
    const stamp = String(Date.now() % 100000);
    const state = {
      refunds: [
        refund(990001, 'E2E 苏甲', { status: 'failed', failCode: 'INVALID_REQUEST', failMessage: '微信支付拒绝了这笔退款', attempts: 2 }),
        refund(990002, 'E2E 苏乙', { status: 'new', failCode: 'NOT_ENOUGH', failMessage: '商户号余额不够', nextTryAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
        refund(990003, 'E2E 苏丙', { status: 'abnormal', failCode: 'REFUND_ABNORMAL', failMessage: '退到银行卡没成功' }),
        refund(990004, 'E2E 苏丁', { status: 'processing' }),
        refund(990005, 'E2E 苏戊', { status: 'success', receivedAccount: '支付用户零钱', succeededAt: ago(30) }),
        refund(990006, 'E2E 苏己', { status: 'handled', handledNote: '前台退现金', handledByName: '林岚', handledAt: ago(90) }),
      ],
      held: [
        order(990011, 'E2E 对不上', { status: 'held', planId: 2, planName: '常泡 500', amount: 50_000, holdCode: 'MISMATCH', holdMessage: '到账金额与单子对不上', heldAt: ago(45) }),
        order(990012, 'E2E 入账失败', { status: 'held', planId: 2, planName: '常泡 500', amount: 50_000, holdCode: 'BOOK_FAILED', holdMessage: '入账时出错', heldAt: ago(44) }),
      ],
    };
    const recent = [
      order(990021, 'E2E 入账了', { status: 'paid', planName: '常泡 500', amount: 50_000, estBonus: 2_500, bookedBonus: 3_000, rechargeDocNo: 'CZ20261104E2E', mock: true }),
      order(990022, 'E2E 没付', { status: 'closed', closeReason: 'expired', closedAt: ago(20), paidAt: null }),
      order(990023, 'E2E 另记了', { status: 'handled', flags: ['after_close'], resolution: 'handled', resolutionNote: '商户平台退了', resolvedByName: '林岚' }),
    ];
    await patchGet<MpRechargeAdminData>(page, '**/api/admin/mp/recharge', (real) => ({
      ...real,
      payMode: 'mock',
      payProblem: null,
      held: state.held,
      recent,
      orphans: [{ id: 990031, createdAt: ago(300), outTradeNo: 'MPR20261102E2E0990031', transactionId: '4200002999202611020031', amount: 20_000 }],
      recons: [
        {
          id: 990041,
          billDate: '2026-11-03',
          ok: false,
          wxCount: 3,
          wxAmount: 90_000,
          storeCount: 2,
          storeAmount: 60_000,
          issues: [{ kind: 'NOT_BOOKED', outTradeNo: 'MPR20261103E2E0990041', transactionId: '4200002999202611030041', wxAmount: 30_000, storeAmount: null, note: '查单也没补上' }],
          refunds: [],
          source: 'auto',
          staffName: null,
          createdAt: ago(600),
        },
        { id: 990042, billDate: '2026-11-02', ok: true, wxCount: 1, wxAmount: 30_000, storeCount: 1, storeAmount: 30_000, issues: [], refunds: [], source: 'manual', staffName: '林岚', createdAt: ago(2000) },
      ],
      refunds: state.refunds,
    }));
    // 重试、已另行处理、处理已付款待处理的单：拦下、记下地址与内容，假装门店系统办好了（列表跟着变）
    const sent: { path: string; body: unknown }[] = [];
    await page.route('**/api/admin/mp/refunds/*/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON() as { outRefundNo: string; note?: string };
      sent.push({ path, body });
      const [, , , , , id, act] = path.split('/');
      const r = state.refunds.find((x) => x.id === Number(id))!;
      const after: MpRefundOrderAdmin =
        act === 'handle'
          ? { ...r, status: 'handled', handledNote: body.note ?? null, handledByName: '林岚', handledAt: new Date().toISOString() }
          : r.status === 'new'
            ? { ...r, attempts: r.attempts + 1 }
            : { ...r, status: 'processing', failCode: null, failMessage: null, outRefundNo: `MPRF20261104E2E1${r.id}` };
      state.refunds = state.refunds.map((x) => (x.id === r.id ? after : x));
      await route.fulfill({ json: after });
    });
    await page.route('**/api/admin/mp/recharge/orders/*/resolve', async (route) => {
      const path = new URL(route.request().url()).pathname;
      sent.push({ path, body: route.request().postDataJSON() });
      const o = state.held.find((x) => x.id === Number(path.split('/')[6]))!;
      state.held = state.held.filter((x) => x.id !== o.id);
      await route.fulfill({ json: { ...o, status: 'paid', rechargeDocNo: 'CZ20261104E2E9', resolution: 'rebook_amount' } });
    });
    const row = (name: string) => page.getByTestId('mp-refund-row').filter({ hasText: name });
    const done = (name: string) => page.getByTestId('mp-refund-done').filter({ hasText: name });
    await page.goto('/admin/mp');
    await openTab(page, '线上充值');

    // 模拟微信支付（演示库）：有提示，能按天重新核对
    await expect(page.getByText('模拟微信支付')).toBeVisible();
    await expect(page.getByRole('button', { name: '重新核对' })).toBeVisible();

    // 原路退回：没退成的（要店主看的）在前，处理中的其次，退到了、另行处理了的在最后
    await expect(page.getByTestId('mp-refund-row')).toHaveText([/E2E 苏甲/, /E2E 苏乙/, /E2E 苏丙/, /E2E 苏丁/]);
    await expect(page.getByTestId('mp-refund-done')).toHaveText([/E2E 苏戊/, /E2E 苏己/]);
    // 没能退（有原单）：能重试、能另行处理
    await expect(row('E2E 苏甲').getByText('没能退', { exact: true })).toBeVisible();
    await expect(row('E2E 苏甲')).toContainText('微信支付拒绝了这笔退款');
    await expect(row('E2E 苏甲')).toContainText(`退款单号 ${state.refunds[0]!.outRefundNo}`);
    await expect(row('E2E 苏甲').getByRole('button')).toHaveText(['重试', '已另行处理']);
    // 待申请、带着上次的错：写什么时候自动再试，只能马上再试
    await expect(row('E2E 苏乙').getByText('待申请', { exact: true })).toBeVisible();
    await expect(row('E2E 苏乙')).toContainText('商户号余额不够（');
    await expect(row('E2E 苏乙')).toContainText('自动再试）');
    await expect(row('E2E 苏乙').getByRole('button')).toHaveText(['马上再试']);
    // 退款异常：只能另行处理
    await expect(row('E2E 苏丙').getByText('退款异常', { exact: true })).toBeVisible();
    await expect(row('E2E 苏丙').getByRole('button')).toHaveText(['已另行处理']);
    // 微信处理中：等结果，没有按钮
    await expect(row('E2E 苏丁').getByText('微信处理中', { exact: true })).toBeVisible();
    await expect(row('E2E 苏丁').getByRole('button')).toHaveCount(0);
    // 退到了、另行处理了：退到哪、怎么处理的（谁办的）
    await expect(done('E2E 苏戊').getByText('已退到', { exact: true })).toBeVisible();
    await expect(done('E2E 苏戊')).toContainText('支付用户零钱');
    await expect(done('E2E 苏己').getByText('已另行处理', { exact: true })).toBeVisible();
    await expect(done('E2E 苏己')).toContainText('前台退现金（林岚）');

    // 重试没能退的：带看到的退款单号；门店系统换新单号重新申请、在处理中
    const no1 = state.refunds[0]!.outRefundNo;
    await row('E2E 苏甲').getByRole('button', { name: '重试' }).click();
    await expect(toast(page, '重试了：微信处理中')).toBeVisible();
    await expect(row('E2E 苏甲').getByText('微信处理中', { exact: true })).toBeVisible();
    await expect(row('E2E 苏甲').getByRole('button')).toHaveCount(0);
    // 马上再试：还没退成，照实写（不当作成功）
    await row('E2E 苏乙').getByRole('button', { name: '马上再试' }).click();
    await expect(toast(page, '重试了：待申请')).toBeVisible();
    // 已另行处理：写怎么处理的才能记
    await row('E2E 苏丙').getByRole('button', { name: '已另行处理' }).click();
    const handle = page.getByRole('dialog', { name: '已另行处理' });
    await expect(handle).toContainText(`E2E 苏丙 · ¥100.00 · 退储值单 ${state.refunds[2]!.memberRefundNo}`);
    await expect(handle.getByRole('button', { name: '记已另行处理' })).toBeDisabled();
    const note = `E2E 商户平台转到新银行卡 ${stamp}`;
    await handle.getByLabel('怎么处理的').fill(note);
    await handle.getByRole('button', { name: '记已另行处理' }).click();
    await expect(toast(page, '已记另行处理')).toBeVisible();
    await expect(handle).toHaveCount(0);
    await expect(done('E2E 苏丙')).toContainText(`${note}（林岚）`);
    expect(sent).toEqual([
      { path: '/api/admin/mp/refunds/990001/retry', body: { outRefundNo: no1 } },
      { path: '/api/admin/mp/refunds/990002/retry', body: { outRefundNo: 'MPRF20261104E2E0990002' } },
      { path: '/api/admin/mp/refunds/990003/handle', body: { outRefundNo: 'MPRF20261104E2E0990003', note } },
    ]);

    // 已付款待处理：到账对不上的只能记已另行处理；能入账的三种都有
    const held = page.getByTestId('mp-recharge-held');
    await expect(page.getByText('已付款待处理（2）')).toBeVisible();
    const resolve = page.getByRole('dialog', { name: '处理已付款待处理的线上充值单' });
    const choices = resolve.getByRole('radiogroup', { name: '怎么处理' }).getByRole('radio');
    await held.filter({ hasText: 'E2E 对不上' }).getByRole('button', { name: '处理' }).click();
    await expect(choices).toHaveText(['已另行处理']);
    await expect(resolve.getByText(/到账与单子对不上（或已经退款、入过别的账），不能直接入账/)).toBeVisible();
    await resolve.getByRole('button', { name: '取消' }).click();
    await held.filter({ hasText: 'E2E 入账失败' }).getByRole('button', { name: '处理' }).click();
    await expect(choices).toHaveText(['重新入账', '按金额入账', '已另行处理']);
    await resolve.getByRole('radio', { name: '按金额入账' }).click();
    await expect(resolve.getByText('不按套餐、不发套餐券，赠金照档自动算')).toBeVisible();
    await expect(resolve.getByRole('button', { name: '确认', exact: true })).toBeDisabled();
    const why = `E2E 规则调回来了 ${stamp}`;
    await resolve.getByLabel('原因 / 怎么处理的').fill(why);
    await resolve.getByRole('button', { name: '确认', exact: true }).click();
    await expect(toast(page, '已入账')).toBeVisible();
    await expect(toast(page, '充值单 CZ20261104E2E9')).toBeVisible();
    await expect(page.getByText('已付款待处理（1）')).toBeVisible();
    const resolved = sent.at(-1)!;
    expect(resolved.path).toBe('/api/admin/mp/recharge/orders/990012/resolve');
    expect(resolved.body).toEqual({ clientKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/), action: 'rebook_amount', note: why });

    // 最近的单：状态、模拟、实际赠金与预估、关单原因、店主怎么处理的
    const recentRows = page.getByTestId('mp-recharge-order');
    await expect(recentRows).toHaveCount(3);
    await expect(recentRows.nth(0)).toContainText('已入账');
    await expect(recentRows.nth(0)).toContainText('模拟');
    await expect(recentRows.nth(0)).toContainText('赠 ¥30.00（预估 ¥25.00）');
    await expect(recentRows.nth(1)).toContainText('已关闭');
    await expect(recentRows.nth(1)).toContainText('到期没付');
    await expect(recentRows.nth(2)).toContainText('关单之后才付的');
    await expect(recentRows.nth(2)).toContainText('店主处理：已另行处理（商户平台退了）');
    // 对账：没对上的那天标出来；找不到单子的到账单独提示
    await expect(page.getByText('对账（1 天有没对上的）')).toBeVisible();
    const recons = page.getByTestId('mp-recharge-recon');
    await expect(recons.nth(0)).toContainText('1 笔没对上');
    await expect(recons.nth(0)).toContainText('微信已收款、门店没入账');
    await expect(recons.nth(1)).toContainText('对上了');
    await expect(recons.nth(1)).toContainText('林岚重新核对');
    await expect(page.getByText('1 笔到账找不到单子')).toBeVisible();
    await expect(page.getByText(/商户单号 MPR20261102E2E0990031/)).toBeVisible();
    // 都办好了：本机没有留下待确认
    expect(await pendingRaw(page)).toBeNull();
  });

  test('原路退回的重试、另行处理结果待确认：提示「结果待确认」、刷新后还在、这一笔先不能再点；按原内容重新提交（同一个退款单号）；查回已经办过了自动移除', async ({ page }) => {
    await login(page, 'linlan');
    const r1 = refund(990051, 'E2E 吴甲', { status: 'failed', failCode: 'INVALID_REQUEST', failMessage: '微信支付拒绝了这笔退款' });
    const r2 = refund(990052, 'E2E 吴乙', { status: 'closed', failCode: 'REFUND_CLOSED', failMessage: '微信那边退款关闭了' });
    const r3 = refund(990053, 'E2E 吴丙', { status: 'abnormal', failCode: 'ABNORMAL', failMessage: '退款异常：顾客的银行卡注销了' });
    let refunds = [r1, r2, r3];
    await patchGet<MpRechargeAdminData>(page, '**/api/admin/mp/recharge', (real) => ({ ...real, refunds }));
    let reply: 'lost' | 'ok' = 'lost';
    const sent: { path: string; body: unknown }[] = [];
    await page.route('**/api/admin/mp/refunds/*/retry', async (route) => {
      const path = new URL(route.request().url()).pathname;
      sent.push({ path, body: route.request().postDataJSON() });
      if (reply === 'lost') return route.abort('connectionreset');
      const id = Number(path.split('/')[5]);
      const after: MpRefundOrderAdmin = { ...refunds.find((x) => x.id === id)!, status: 'processing', failCode: null, failMessage: null };
      refunds = refunds.map((x) => (x.id === id ? after : x));
      return route.fulfill({ json: after });
    });
    const pending = page.getByTestId('mp-refund-pending');
    const row = (name: string) => page.getByTestId('mp-refund-row').filter({ hasText: name });
    await page.goto('/admin/mp');
    try {
      await openTab(page, '线上充值');
      // ① 没收到结果：提示「结果待确认」（不是「没有重试」）；上方待确认，这一笔的重试、已另行处理先不能点，别的照常；刷新后还在（查回看到单号、状态都没变）
      await row('E2E 吴甲').getByRole('button', { name: '重试' }).click();
      await expect(toast(page, '重试的结果待确认')).toBeVisible();
      await expect(page.getByText('1 笔原路退回的操作结果待确认')).toBeVisible();
      await expect(pending).toHaveCount(1);
      await expect(pending).toContainText('重试原路退回：E2E 吴甲 ¥100.00');
      await expect(row('E2E 吴甲').getByRole('button', { name: '重试' })).toBeDisabled();
      await expect(row('E2E 吴甲').getByRole('button', { name: '已另行处理' })).toBeDisabled();
      await expect(row('E2E 吴乙').getByRole('button', { name: '重试' })).toBeEnabled();
      await page.reload();
      await openTab(page, '线上充值');
      await expect(pending).toHaveCount(1);
      await expect(row('E2E 吴甲').getByRole('button', { name: '重试' })).toBeDisabled();
      // 按原内容重新提交：同一个地址、同一个退款单号（不会退两次、不会换两次单号）
      reply = 'ok';
      await pending.getByRole('button', { name: '按原内容重新提交' }).click();
      await expect(toast(page, '已办好')).toBeVisible();
      await expect(pending).toHaveCount(0);
      await expect(row('E2E 吴甲').getByText('微信处理中', { exact: true })).toBeVisible();
      const first = { path: '/api/admin/mp/refunds/990051/retry', body: { outRefundNo: r1.outRefundNo } };
      expect(sent).toEqual([first, first]);

      // ② 没收到结果、其实已经办了（门店系统换了新的退款单号重新申请）：刷新后查回看到单号变了，自动移除
      reply = 'lost';
      await row('E2E 吴乙').getByRole('button', { name: '重试' }).click();
      await expect(pending).toHaveCount(1);
      refunds = refunds.map((x) => (x.id === r2.id ? { ...x, status: 'new', outRefundNo: 'MPRF20261104E2E1990052', failCode: null, failMessage: null } : x));
      await page.reload();
      await openTab(page, '线上充值');
      await expect(toast(page, '已查回：已经办过了')).toBeVisible();
      await expect(pending).toHaveCount(0);
      expect(await pendingRaw(page)).toBeNull();

      // ③ 记另行处理没收到结果：提示「结果待确认」、对话框关掉（不会再点一次又记一条），这一笔先不能再点
      const handled: unknown[] = [];
      await page.route('**/api/admin/mp/refunds/*/handle', async (route) => {
        handled.push(route.request().postDataJSON());
        return route.abort('connectionreset');
      });
      await row('E2E 吴丙').getByRole('button', { name: '已另行处理' }).click();
      const dialog = page.getByRole('dialog', { name: '已另行处理' });
      await dialog.getByLabel('怎么处理的').fill('E2E 前台退现金');
      await dialog.getByRole('button', { name: '记已另行处理' }).click();
      await expect(toast(page, '记另行处理的结果待确认')).toBeVisible();
      await expect(dialog).toBeHidden();
      await expect(pending).toHaveCount(1);
      await expect(pending).toContainText('原路退回已另行处理：E2E 吴丙 ¥100.00');
      await expect(row('E2E 吴丙').getByRole('button', { name: '已另行处理' })).toBeDisabled();
      expect(handled).toEqual([{ outRefundNo: r3.outRefundNo, note: 'E2E 前台退现金' }]);
    } finally {
      await clearPending(page);
    }
  });

  test('领券中心：自建两张券模板，加进来、拿掉、挪先后、每人限领与不限领、停领（真实接口）；领取统计与记录（假数据）', async ({ page }) => {
    await login(page, 'linlan');
    const stamp = String(Date.now() % 100000);
    await resetRules(page, 'coupons');
    const make = async (name: string, terms: Record<string, unknown>) => {
      const res = await page.request.post('/api/coupons/templates', { data: { clientKey: randomUUID(), name, kind: 'cash', validity: 'days', validDays: 30, ...terms } });
      expect(res.ok(), `新建券模板 → ${res.status()} ${await res.text()}`).toBe(true);
      return (await res.json()) as { id: number; name: string };
    };
    const a = await make(`E2E领券甲${stamp}`, { faceValue: 500, threshold: 5000, levels: [2, 3] });
    const b = await make(`E2E领券乙${stamp}`, { faceValue: 1000 });
    try {
      const claim = (id: number, memberName: string, seq: number): MpCouponClaimAdmin => ({
        id,
        createdAt: ago(id - 990060),
        memberId: id,
        memberName,
        templateId: b.id,
        templateName: b.name,
        couponCode: `E2EQ${id}`,
        issueNo: `FQ20261104${id}`,
        seq,
      });
      await patchGet<MpCouponAdminData>(page, '**/api/admin/mp/coupons', (real) => ({
        ...real,
        stats: [{ templateId: b.id, total: 12, last7Days: 3 }],
        recent: [claim(990061, 'E2E 林一', 2), claim(990062, 'E2E 林二', 1)],
      }));
      const templates = (await getJson<MpCouponAdminData>(page, '/api/admin/mp/coupons')).templates;
      const ta = templates.find((t) => t.id === a.id)!;
      const v0 = (await adminData(page)).couponRules.version;
      await page.goto('/admin/mp');
      await openTab(page, '领券中心');
      await expect(page.getByText('还没有可领的券：从下面选一张券模板加进来')).toBeVisible();
      const select = page.getByLabel('加一张券');
      const add = page.getByRole('button', { name: '加进来' });
      const offers = page.getByTestId('mp-coupon-offer');
      const rowA = offers.filter({ hasText: a.name });
      const rowB = offers.filter({ hasText: b.name });
      await expect(add).toBeDisabled();
      // 加进来的不再出现在下拉里；拿掉了又回到下拉里
      await select.selectOption(String(a.id));
      await add.click();
      await select.selectOption(String(b.id));
      await add.click();
      await expect(select.locator(`option[value="${a.id}"]`)).toHaveCount(0);
      await rowA.getByRole('button', { name: '从领券中心拿掉' }).click();
      await expect(offers).toHaveCount(1);
      await expect(select.locator(`option[value="${a.id}"]`)).toHaveCount(1);
      await select.selectOption(String(a.id));
      await add.click();
      await expect(offers).toHaveText([new RegExp(b.name), new RegExp(a.name)]);
      // 券的说明照券模板；统计按券模板（乙用假数据）
      await expect(rowA).toContainText(`${ta.summary} · ${ta.validity} · 只给 L2、L3`);
      await expect(rowA).toContainText('已领 0 张 · 近 7 天 0 张');
      await expect(rowB).toContainText('已领 12 张 · 近 7 天 3 张');
      // 新加的默认每人限领 1 张、可领
      await expect(rowA.getByLabel('每人限领几张')).toHaveValue('1');
      await expect(rowA.getByRole('radio', { name: '每人限领', exact: true })).toHaveAttribute('aria-checked', 'true');
      await expect(rowA.getByRole('radio', { name: '可领', exact: true })).toHaveAttribute('aria-checked', 'true');

      // 甲挪到前面（第一张不能再往前、最后一张不能再往后）
      await rowA.getByRole('button', { name: '往前挪' }).click();
      await expect(offers).toHaveText([new RegExp(a.name), new RegExp(b.name)]);
      await expect(rowA.getByRole('button', { name: '往前挪' })).toBeDisabled();
      await expect(rowB.getByRole('button', { name: '往后挪' })).toBeDisabled();
      // 甲不限领：没有张数框，提示没有上限
      await rowA.getByRole('radio', { name: '不限领', exact: true }).click();
      await expect(rowA.getByLabel('每人限领几张')).toHaveCount(0);
      await expect(page.getByText(/不限领的券每点一次领一张，没有上限/)).toBeVisible();
      // 乙每人限领：张数要 1–99 的整数
      const save = page.getByRole('button', { name: '保存领券中心的设置' });
      const perB = rowB.getByLabel('每人限领几张');
      await perB.fill('0');
      await expect(page.getByText('每人限领几张请填 1–99', { exact: true })).toBeVisible();
      await expect(save).toBeDisabled();
      await perB.fill('三');
      await expect(page.getByText(`「${b.name}」每人限领几张请填 1–99`)).toBeVisible();
      await expect(save).toBeDisabled();
      await perB.fill('3');
      // 乙停领：名字后面标「停领」
      await rowB.getByRole('radio', { name: '停领', exact: true }).click();
      await expect(rowB.locator('p').first()).toContainText('停领');
      await switchOf(page, '领券中心开关').getByRole('radio', { name: '开通' }).click();
      await expect(save).toBeEnabled();
      await save.click();
      await expect(toast(page, '领券中心的设置已保存')).toBeVisible();
      expect((await adminData(page)).couponRules).toEqual({
        enabled: true,
        offers: [
          { templateId: a.id, limit: 'unlimited', perMember: 1, active: true },
          { templateId: b.id, limit: 'per_member', perMember: 3, active: false },
        ],
        version: v0 + 1,
      });
      // 刷新后照保存的显示
      await page.reload();
      await openTab(page, '领券中心');
      await expect(offers).toHaveText([new RegExp(a.name), new RegExp(b.name)]);
      await expect(rowA.getByRole('radio', { name: '不限领', exact: true })).toHaveAttribute('aria-checked', 'true');
      await expect(rowB.getByLabel('每人限领几张')).toHaveValue('3');
      await expect(rowB.getByRole('radio', { name: '停领', exact: true })).toHaveAttribute('aria-checked', 'true');
      await expect(switchOf(page, '领券中心开关').getByRole('radio', { name: '开通' })).toHaveAttribute('aria-checked', 'true');

      // 最近的领取（假数据）
      const claims = page.getByTestId('mp-coupon-claim');
      await expect(claims).toHaveCount(2);
      await expect(claims.nth(0)).toContainText('E2E 林一');
      await expect(claims.nth(0)).toContainText(b.name);
      await expect(claims.nth(0)).toContainText('第 2 张');
      await expect(claims.nth(0)).toContainText('E2EQ990061 · FQ20261104990061');
      expect(await pendingRaw(page)).toBeNull();
    } finally {
      await resetRules(page, 'coupons');
      // 自建的券模板停用（模板不能删）
      for (const t of await getJson<({ id: number; version: number } & Record<string, unknown>)[]>(page, '/api/coupons/templates')) {
        if (t.id !== a.id && t.id !== b.id) continue;
        const res = await page.request.put(`/api/coupons/templates/${t.id}`, { data: { ...t, active: false, expectedVersion: t.version } });
        expect(res.ok(), `停用券模板 → ${res.status()} ${await res.text()}`).toBe(true);
      }
    }
  });

  test('到期提醒：模板编号与字段名的核对，券快到期、预约到店两种模板（真实接口）；统计、网关取消息与最近的消息（假数据）', async ({ page }) => {
    await login(page, 'linlan');
    const stamp = String(Date.now() % 100000);
    await resetRules(page, 'reminders');
    const msg = (id: number, kind: MpReminderKind, status: MpReminderStatus, reason: string | null = null): MpReminderMessageAdmin => ({
      id,
      kind,
      memberId: id,
      memberName: `E2E 郑${id % 10}`,
      targetDate: '2026-11-08',
      dueDate: '2026-11-05',
      status,
      reason,
      errcode: status === 'failed' ? 43101 : null,
      attempts: 1,
      createdAt: ago(id - 990070),
      finishedAt: null,
    });
    await patchGet<MpReminderAdminData>(page, '**/api/admin/mp/reminders', (real) => ({
      ...real,
      stats: { consents: 7, byStatus: { sent: 3, failed: 1, unknown: 1, skipped: 1 }, waiting: 2, overdue: 1 },
      lastLeaseAt: ago(10),
      recent: [msg(990071, 'coupon', 'sent'), msg(990072, 'grace', 'failed', '顾客拒收'), msg(990073, 'booking', 'unknown'), msg(990074, 'bonus', 'skipped', '赠金已经用完')],
    }));
    const couponTpl = `E2E-coupon-${stamp}-tpl`;
    const bookingTpl = `E2E-booking-${stamp}-tpl`;
    const v0 = (await adminData(page)).reminderRules.version;
    await page.goto('/admin/mp');
    try {
      await openTab(page, '到期提醒');
      // 统计、网关多久没来取消息、最近的消息（假数据）
      await expect(page.getByText('最近 30 天同意了 7 次 · 已发出 3 · 没发出 1 · 结果不明 1 · 不用发了 1 · 还没到发的时候 2')).toBeVisible();
      await expect(page.getByText(/有 1 条到了那天还没排成消息/)).toBeVisible();
      await expect(page.getByText(/^网关 1[01] 分钟没来取消息了：请看网关是不是开着、连得上门店$/)).toBeVisible();
      const messages = page.getByTestId('mp-reminder-message');
      await expect(messages).toHaveCount(4);
      await expect(messages.nth(0)).toContainText('券快到期');
      await expect(messages.nth(0)).toContainText('已发出');
      await expect(messages.nth(1)).toContainText('进补充期');
      await expect(messages.nth(1)).toContainText('没发出');
      await expect(messages.nth(1)).toContainText('顾客拒收');
      await expect(messages.nth(2)).toContainText('预约到店');
      await expect(messages.nth(2)).toContainText('结果不明');
      await expect(messages.nth(3)).toContainText('赠金快到期');
      await expect(messages.nth(3)).toContainText('不用发了');

      // 四种提醒，默认都不发
      const blocks = page.getByTestId('mp-reminder-template');
      await expect(blocks).toHaveCount(4);
      await expect(blocks.getByRole('radio', { name: '不发', checked: true })).toHaveCount(4);
      const coupon = blocks.filter({ hasText: '券快到期' });
      const booking = blocks.filter({ hasText: '预约到店' });
      const save = page.getByRole('button', { name: '保存到期提醒的设置' });
      const problem = (text: string) => page.getByText(text, { exact: true });
      // 券快到期：用模板就要填对模板编号；默认 thing1 填券名、date2 填到期日
      await coupon.getByRole('radio', { name: '用模板' }).click();
      await expect(problem('「券快到期」的模板编号不对：从微信公众平台「订阅消息 → 我的模板」复制')).toBeVisible();
      await expect(save).toBeDisabled();
      await coupon.getByLabel('模板 ID').fill(couponTpl);
      const keys = coupon.getByLabel('字段名');
      await expect(keys).toHaveCount(2);
      await expect(keys.nth(0)).toHaveValue('thing1');
      await expect(keys.nth(1)).toHaveValue('date2');
      // 字段名照模板详情写；同一个字段名只能填一次
      await keys.nth(1).fill('riqi2');
      await expect(problem('「券快到期」的字段名「riqi2」不对：照模板详情里的写，比如 thing1、date2')).toBeVisible();
      await expect(save).toBeDisabled();
      await keys.nth(1).fill('date2');
      await coupon.getByRole('button', { name: '加一个字段' }).click();
      await keys.nth(2).fill('thing1');
      await expect(problem('「券快到期」同一个字段名只能填一次')).toBeVisible();
      await keys.nth(2).fill('thing3');
      await coupon.getByLabel('这个字段填什么').nth(2).selectOption({ label: '门店名' });
      // 预约到店：默认 thing1、time2；与券用同一个模板不行
      await booking.getByRole('radio', { name: '用模板' }).click();
      await expect(booking.getByLabel('字段名').nth(0)).toHaveValue('thing1');
      await expect(booking.getByLabel('字段名').nth(1)).toHaveValue('time2');
      await booking.getByLabel('模板 ID').fill(couponTpl);
      await expect(problem('每种提醒要用不同的模板')).toBeVisible();
      await expect(save).toBeDisabled();
      await booking.getByLabel('模板 ID').fill(bookingTpl);
      // 加了又去掉的字段不提交
      await booking.getByRole('button', { name: '加一个字段' }).click();
      await expect(booking.getByLabel('字段名')).toHaveCount(3);
      await booking.getByRole('button', { name: '去掉这个字段' }).nth(2).click();
      await expect(booking.getByLabel('字段名')).toHaveCount(2);

      await switchOf(page, '到期提醒开关').getByRole('radio', { name: '开通' }).click();
      await expect(save).toBeEnabled();
      await save.click();
      await expect(toast(page, '到期提醒的设置已保存')).toBeVisible();
      expect((await adminData(page)).reminderRules).toEqual({
        enabled: true,
        coupon: {
          templateId: couponTpl,
          fields: [
            { key: 'thing1', source: 'name' },
            { key: 'date2', source: 'date' },
            { key: 'thing3', source: 'store' },
          ],
        },
        membership: null,
        bonus: null,
        booking: {
          templateId: bookingTpl,
          fields: [
            { key: 'thing1', source: 'name' },
            { key: 'time2', source: 'date' },
          ],
        },
        version: v0 + 1,
      });
      // 刷新后照保存的显示：没填的两种还是「不发」
      await page.reload();
      await openTab(page, '到期提醒');
      await expect(switchOf(page, '到期提醒开关').getByRole('radio', { name: '开通' })).toHaveAttribute('aria-checked', 'true');
      await expect(coupon.getByLabel('模板 ID')).toHaveValue(couponTpl);
      await expect(coupon.getByLabel('字段名')).toHaveCount(3);
      await expect(coupon.getByLabel('这个字段填什么').nth(2)).toHaveValue('store');
      await expect(booking.getByLabel('模板 ID')).toHaveValue(bookingTpl);
      await expect(blocks.filter({ hasText: '赠金快到期' }).getByRole('radio', { name: '不发' })).toHaveAttribute('aria-checked', 'true');
      await expect(blocks.filter({ hasText: '会籍快到期' }).getByRole('radio', { name: '不发' })).toHaveAttribute('aria-checked', 'true');
      expect(await pendingRaw(page)).toBeNull();
    } finally {
      await resetRules(page, 'reminders');
    }
  });

  test('邀请好友：开通、关闭拨了马上保存（真实接口）；最近的邀请（假数据）', async ({ page }) => {
    await login(page, 'linlan');
    await resetRules(page, 'invites');
    const invite = (id: number, state: MpInviteState, inviterName: string, inviteeName: string | null, trial: MpInviteAdmin['trial'] = null): MpInviteAdmin => ({
      id,
      code: `E2E${id}`,
      state,
      createdAt: ago(id - 990080),
      expiresAt: ago(id - 990080 - 7 * 24 * 60),
      inviterId: id,
      inviterName,
      inviteeId: inviteeName ? id + 100 : null,
      inviteeName,
      trial,
      usedAt: trial ? ago(5) : null,
    });
    await patchGet<MpInviteAdminData>(page, '**/api/admin/mp/invites', (real) => ({
      ...real,
      stats: { open: 2, used: 3, revoked: 1, expired: 4 },
      recent: [
        invite(990081, 'open', 'E2E 周一', null),
        invite(990082, 'used', 'E2E 周二', 'E2E 吴二', { label: 'L2 云涧 · 初', startsOn: '2026-11-01', endsOn: '2026-11-30', status: 'active' }),
        invite(990083, 'revoked', 'E2E 周三', null),
        invite(990084, 'expired', 'E2E 周四', null),
      ],
    }));
    const v0 = (await adminData(page)).inviteRules.version;
    await page.goto('/admin/mp');
    try {
      await openTab(page, '邀请好友');
      await expect(page.getByText('最近 30 天：待领取 2 · 已领取 3 · 已收回 1 · 过期 4')).toBeVisible();
      const rows = page.getByTestId('mp-invite');
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(0)).toContainText('E2E 周一');
      await expect(rows.nth(0)).toContainText('待领取');
      await expect(rows.nth(1)).toContainText('E2E 吴二');
      await expect(rows.nth(1)).toContainText('已领取');
      await expect(rows.nth(1)).toContainText('L2 云涧 · 初，2026-11-01 至 2026-11-30');
      await expect(rows.nth(2)).toContainText('已收回');
      await expect(rows.nth(3)).toContainText('过期了');

      // 拨了就保存（没有单独的保存按钮）
      const sw = switchOf(page, '邀请好友开关');
      await expect(sw.getByRole('radio', { name: '关闭' })).toHaveAttribute('aria-checked', 'true');
      await sw.getByRole('radio', { name: '开通' }).click();
      await expect(toast(page, '邀请好友已开通')).toBeVisible();
      await expect(sw.getByRole('radio', { name: '开通' })).toHaveAttribute('aria-checked', 'true');
      expect((await adminData(page)).inviteRules).toEqual({ enabled: true, version: v0 + 1 });
      await sw.getByRole('radio', { name: '关闭' }).click();
      await expect(toast(page, '邀请好友已关闭')).toBeVisible();
      await expect(sw.getByRole('radio', { name: '关闭' })).toHaveAttribute('aria-checked', 'true');
      expect((await adminData(page)).inviteRules).toEqual({ enabled: false, version: v0 + 2 });
      expect(await pendingRaw(page)).toBeNull();
      // 点现在的那一边：不保存（版本号不变、不发请求）
      const puts: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'PUT' && r.url().includes('/api/admin/mp/invites/rules')) puts.push(r.url());
      });
      await sw.getByRole('radio', { name: '关闭' }).click();
      await page.waitForTimeout(500);
      expect(puts).toEqual([]);
      expect((await adminData(page)).inviteRules).toEqual({ enabled: false, version: v0 + 2 });
    } finally {
      await resetRules(page, 'invites');
    }
  });

  test('扫码点餐：没开餐饮、没配签名密钥时的提示；可点的菜整组勾选（真实接口）；桌码与最近的点单（假数据）；A4 打印桌码', async ({ page }) => {
    await login(page, 'linlan');
    await resetRules(page, 'food');
    const me = await getJson<{ storeName: string }>(page, '/api/auth/me');
    const dishes: MpFoodAdminData['dishes'] = [
      { id: 990101, name: 'E2E 宫保鸡丁', group: 'E2E 热菜', price: 3_800, remaining: null, open: false },
      { id: 990102, name: 'E2E 水煮鱼', group: 'E2E 热菜', price: 6_800, remaining: 0, open: false },
      { id: 990103, name: 'E2E 柠檬茶', group: 'E2E 水吧', price: 1_500, remaining: 12, open: false },
    ];
    const tables: MpFoodAdminData['tables'] = [
      { id: 990111, name: 'A1', area: '大厅', code: '710000010123456789' },
      { id: 990112, name: '<B&2>', area: '', code: '710000020987654321' },
      { id: 990113, name: 'E2E 远桌', area: '露台', code: null },
    ];
    const recent: MpFoodAdminData['recent'] = [
      {
        id: 990121,
        createdAt: ago(8),
        memberId: 990121,
        memberName: 'E2E 王一',
        tagCode: 'A012',
        orderNo: 'CP20261104E2E1',
        deliverTo: 'A1',
        total: 7_300,
        lines: [
          { name: 'E2E 宫保鸡丁', quantity: 1, amount: 3_800, note: '少辣' },
          { name: 'E2E 柠檬茶', quantity: 2, amount: 3_000, note: '' },
        ],
      },
      { id: 990122, createdAt: ago(3), memberId: 990122, memberName: 'E2E 王二', tagCode: 'B105', orderNo: null, deliverTo: '', total: 1_500, lines: [{ name: 'E2E 柠檬茶', quantity: 1, amount: 1_500, note: '' }] },
    ];
    // 先照 CI 的演示库：餐饮没开、没配签名密钥、没有进厨房的菜；再换成有菜、有桌台、配了密钥
    let full = false;
    await patchGet<MpFoodAdminData>(page, '**/api/admin/mp/food', (real) =>
      full
        ? { ...real, diningEnabled: true, tableCodeReady: true, dishes, tables, today: { orders: 2, total: 8_800 }, recent }
        : { ...real, diningEnabled: false, tableCodeReady: false, dishes: [], tables: [], recent: [] },
    );
    const v0 = (await adminData(page)).foodRules.version;
    const print = page.getByRole('button', { name: '打印桌码（A4）' });
    const dish = (name: string) => page.getByRole('checkbox', { name: startsWith(name) });
    /** 一组菜名旁边的「这一组都勾上 / 都不勾」 */
    const groupToggle = (group: string) => page.getByText(group, { exact: true }).locator('xpath=..').getByRole('button');
    await page.goto('/admin/mp');
    try {
      await openTab(page, '扫码点餐');
      await expect(page.getByText('餐饮功能还关着')).toBeVisible();
      await expect(page.getByText('门店系统还没配签名密钥')).toBeVisible();
      await expect(page.getByText('还没有进厨房的菜：在后台「餐饮」里把菜挂到出品档口')).toBeVisible();
      await expect(print).toBeDisabled();

      full = true;
      await page.reload();
      await openTab(page, '扫码点餐');
      await expect(page.getByText('勾了 0 道')).toBeVisible();
      await expect(page.getByText('餐饮功能还关着')).toHaveCount(0);
      await expect(page.getByText('门店系统还没配签名密钥')).toHaveCount(0);
      // 一组都勾上、再单个勾、单个去掉；估清的菜写「今天估清」
      await groupToggle('E2E 热菜').click();
      await expect(dish('E2E 宫保鸡丁')).toBeChecked();
      await expect(dish('E2E 水煮鱼 ¥68.00 · 今天估清')).toBeChecked();
      await expect(groupToggle('E2E 热菜')).toHaveText('这一组都不勾');
      await expect(page.getByText('勾了 2 道')).toBeVisible();
      await tick(dish('E2E 柠檬茶'), true);
      await tick(dish('E2E 水煮鱼'), false);
      await expect(groupToggle('E2E 热菜')).toHaveText('这一组都勾上');
      await expect(groupToggle('E2E 水吧')).toHaveText('这一组都不勾');
      await expect(page.getByText('勾了 2 道')).toBeVisible();
      await switchOf(page, '扫码点餐开关').getByRole('radio', { name: '开通' }).click();
      await page.getByRole('button', { name: '保存扫码点餐的设置' }).click();
      await expect(toast(page, '扫码点餐的设置已保存')).toBeVisible();
      expect((await adminData(page)).foodRules).toEqual({ enabled: true, itemIds: [990101, 990103], version: v0 + 1 });
      // 刷新后照保存的勾着
      await page.reload();
      await openTab(page, '扫码点餐');
      await expect(page.getByText('勾了 2 道')).toBeVisible();
      await expect(dish('E2E 宫保鸡丁')).toBeChecked();
      await expect(dish('E2E 水煮鱼')).not.toBeChecked();
      await expect(dish('E2E 柠檬茶')).toBeChecked();
      await expect(switchOf(page, '扫码点餐开关').getByRole('radio', { name: '开通' })).toHaveAttribute('aria-checked', 'true');

      // 桌码：有码的画二维码，编号太大的写生成不了
      const codes = page.getByTestId('mp-table-code');
      await expect(codes).toHaveCount(3);
      await expect(codes.filter({ hasText: 'A1' }).locator('svg')).toHaveCount(1);
      await expect(codes.filter({ hasText: '<B&2>' }).locator('svg')).toHaveCount(1);
      await expect(codes.filter({ hasText: 'E2E 远桌' })).toContainText('桌台编号太大，生成不了');
      await expect(codes.filter({ hasText: 'E2E 远桌' }).locator('svg')).toHaveCount(0);
      // 最近的点单（假数据）
      await expect(page.getByText('今天：2 单 · ¥88.00')).toBeVisible();
      const orders = page.getByTestId('mp-food-order');
      await expect(orders).toHaveCount(2);
      await expect(orders.nth(0)).toContainText('手牌 A012');
      await expect(orders.nth(0)).toContainText('送到 A1');
      await expect(orders.nth(0)).toContainText('出品单 CP20261104E2E1');
      await expect(orders.nth(0)).toContainText('E2E 宫保鸡丁 ×1（少辣）、E2E 柠檬茶 ×2');
      await expect(orders.nth(1)).not.toContainText('送到');

      // A4 打印：一页四张，只印有码的桌；店名、桌名转义；打印完收掉隐藏的框
      await stubFramePrint(page);
      await print.click();
      const printed = await page.evaluate(() => (window as unknown as { __printed: string[] }).__printed);
      expect(printed).toHaveLength(1);
      const html = printed[0]!;
      expect(html).toContain('@page { size: A4 portrait; margin: 12mm; }');
      expect(html.match(/<div class="card">/g)).toHaveLength(2);
      expect(html.match(/<svg class="qr"/g)).toHaveLength(2);
      expect(html).toContain(`<p class="store">${me.storeName}</p>`);
      expect(html).toContain('<p class="table">A1</p>');
      expect(html).toContain('<p class="table">&lt;B&amp;2&gt;</p>');
      expect(html).not.toContain('E2E 远桌');
      expect(html).toContain('打开本店的微信小程序 → 我的 → 点餐 → 扫这张码');
      await expect(page.locator('iframe[aria-hidden="true"]')).toHaveCount(0);
      expect(await pendingRaw(page)).toBeNull();
    } finally {
      await resetRules(page, 'food');
    }
  });

  test('预约：可约的项目与房间（真实接口）；待确认与最近的预约（假数据）；回复丢了自动查回（勾的先后不同也算改上了）', async ({ page }) => {
    await login(page, 'linlan');
    await resetRules(page, 'bookings');
    const r = (await getJson<MpBookingAdminData>(page, '/api/admin/mp/bookings')).bookingRules;
    const op = (id: number, action: 'create' | 'cancel', memberName: string, title: string, status: MpBookingStatus): MpBookingAdminOp => ({
      id,
      createdAt: ago(id - 990200),
      action,
      memberId: id,
      memberName,
      bookingId: id,
      bookingNo: `YY20261104${id}`,
      title,
      startsAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      status,
    });
    await patchGet<MpBookingAdminData>(page, '**/api/admin/mp/bookings', (real) => ({
      ...real,
      items: [
        { id: 990301, name: 'E2E 肩颈按摩', minutes: 60, open: false },
        { id: 990302, name: 'E2E 足底按摩', minutes: 45, open: false },
      ],
      spaces: [{ id: 990401, name: 'E2E 派对房', code: 'E2E-P1', open: false }],
      pending: 2,
      recent: [
        op(990201, 'create', 'E2E 赵一', 'E2E 肩颈按摩 · 12 号技师', 'pending'),
        op(990202, 'create', 'E2E 赵二', 'E2E 派对房', 'confirmed'),
        op(990203, 'cancel', 'E2E 赵三', 'E2E 足底按摩', 'cancelled'),
        op(990204, 'create', 'E2E 赵四', 'E2E 足底按摩', 'no_show'),
      ],
    }));
    const RULES = '**/api/admin/mp/bookings/rules';
    const v0 = (await adminData(page)).bookingRules.version;
    const box = (name: string) => page.getByRole('checkbox', { name: startsWith(name) });
    const save = page.getByRole('button', { name: '保存小程序预约的设置' });
    await page.goto('/admin/mp');
    try {
      await openTab(page, '预约');
      // 待门店确认的（假数据）；主线「预约」的规则照门店系统
      await expect(page.getByText('小程序来的预约还有 2 张待确认')).toBeVisible();
      await expect(page.getByText(`开始前 ${r.confirmLeadMinutes} 分钟还没确认的会自动取消`)).toBeVisible();
      await expect(page.getByText(`现在的规则：${r.openTime}–${r.closeTime}，每 ${r.slotMinutes} 分钟一格，最远 ${r.maxDaysAhead} 天后`)).toBeVisible();
      const ops = page.getByTestId('mp-booking-op');
      await expect(ops).toHaveCount(4);
      await expect(ops.nth(0)).toContainText(/E2E 赵一\s*预约\s*E2E 肩颈按摩 · 12 号技师/);
      await expect(ops.nth(0)).toContainText('YY20261104990201');
      await expect(ops.nth(0)).toContainText('待确认');
      await expect(ops.nth(1)).toContainText('已预约');
      await expect(ops.nth(2)).toContainText(/E2E 赵三\s*取消/);
      await expect(ops.nth(2)).toContainText('已取消');
      await expect(ops.nth(3)).toContainText('爽约');

      // 勾一间房、开通，保存
      await expect(box('E2E 肩颈按摩 60 分钟')).not.toBeChecked();
      await tick(box('E2E 派对房'), true);
      await switchOf(page, '小程序预约开关').getByRole('radio', { name: '开通' }).click();
      await save.click();
      await expect(toast(page, '小程序预约的设置已保存')).toBeVisible();
      expect((await adminData(page)).bookingRules).toEqual({ enabled: true, itemIds: [], spaceIds: [990401], version: v0 + 1 });

      // 回复丢了：先勾后面的项目再勾前面的（门店系统排好先后再存）；查回时不看先后，算改上了，自动移除
      await page.route(RULES, async (route) => {
        if (route.request().method() !== 'PUT') return route.fallback();
        await route.fetch();
        await route.abort('connectionreset');
      });
      await tick(box('E2E 足底按摩'), true);
      await tick(box('E2E 肩颈按摩'), true);
      await save.click();
      await expect(toast(page, '保存结果待确认')).toBeVisible();
      await expect(toast(page, '已查回：已经改上了')).toBeVisible();
      await expect(page.getByTestId('mp-update-pending')).toHaveCount(0);
      await page.unroute(RULES);
      expect((await adminData(page)).bookingRules).toEqual({ enabled: true, itemIds: [990301, 990302], spaceIds: [990401], version: v0 + 2 });
      expect(await pendingRaw(page)).toBeNull();
      // 刷新后照保存的勾着，能接着改
      await page.reload();
      await openTab(page, '预约');
      await expect(switchOf(page, '小程序预约开关').getByRole('radio', { name: '开通' })).toHaveAttribute('aria-checked', 'true');
      await expect(box('E2E 肩颈按摩')).toBeChecked();
      await expect(box('E2E 足底按摩')).toBeChecked();
      await expect(box('E2E 派对房')).toBeChecked();
      await expect(save).toBeEnabled();
    } finally {
      await page.unroute(RULES).catch(() => undefined);
      await clearPending(page);
      await resetRules(page, 'bookings');
    }
  });

  test('值班经理只看到「会员的微信」，第二、三期几页的接口都是 403', async ({ page }) => {
    await login(page, 'zhangjl');
    await page.goto('/admin/mp');
    await expect(page.getByTestId('mp-bindings-search')).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: '小程序后台分页' })).toHaveCount(0);
    // 万一放行了也不改东西：都是关上的内容
    for (const tab of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
      expect((await page.request.get(`/api/admin/mp/${tab}`)).status(), `GET ${tab}`).toBe(403);
      expect((await page.request.put(`/api/admin/mp/${tab}/rules`, { data: DEFAULTS[tab] })).status(), `PUT ${tab}/rules`).toBe(403);
    }
    const outRefundNo = 'MPRF20261104E2E0990001';
    expect((await page.request.post('/api/admin/mp/refunds/990001/retry', { data: { outRefundNo } })).status()).toBe(403);
    expect((await page.request.post('/api/admin/mp/refunds/990001/handle', { data: { outRefundNo, note: 'E2E' } })).status()).toBe(403);
    expect((await page.request.post('/api/admin/mp/recharge/orders/990012/resolve', { data: { clientKey: randomUUID(), action: 'handled', note: 'E2E' } })).status()).toBe(403);
  });
});
