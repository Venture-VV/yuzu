// S7 客房浏览器验收（v0.7.4；店主 2026-10-31 定：住客都是洗浴客人，门票必选，房价不含门票）：
//   后台「客房」建房型、房间、开启 → 前台接待一位客人 → 主导航「客房」→ 填手牌入住（收押金）→ 入住单收押金、按原方式退一部分
//   → 换房（原房间待打扫）→ 前台结账：客人还住着客房，结账对话框里直接退房（押金原路退回），房费挂到手牌账单上和门票一起结
//   → 改房态（打扫、维修）→ 夜审对话框 → 看板「客房」；
//   入住响应丢失：刷新后顶部仍提醒待确认，「去处理」回到那间房的入住对话框，查回已生效、只入住一次。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。
// 专用房型、房间（E2E 开头）留着下次沿用；开始时收掉上次中断留下的入住，结束时关闭客房功能，可重复执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { CheckoutDetail } from '../src/shared/checkout';
import type { RoomBoard, RoomsAdmin, StayDetail } from '../src/shared/rooms';
import { ensureShift } from './shift';

const PASSWORD = 'yuzu2026';
const DAILY = { name: 'E2E 标准间', kind: 'daily', price: 28800, blockMinutes: null } as const;
const HOURLY = { name: 'E2E 钟点房', kind: 'hourly', price: 9800, blockMinutes: 180 } as const;
const FLOOR = 'E2E';
const R1 = 'E2E-01';
const R2 = 'E2E-02';
const R3 = 'E2E-03';
const ROOMS = [
  { roomNo: R1, type: DAILY.name },
  { roomNo: R2, type: DAILY.name },
  { roomNo: R3, type: DAILY.name },
  { roomNo: 'E2E-08', type: HOURLY.name },
] as const;
const RULES = { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 };

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number } | null;
}

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

async function relogin(page: Page, username: string) {
  await page.request.post('/api/auth/logout');
  await login(page, username);
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function send<T = unknown>(page: Page, method: 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const res = await page.request[method](url, data === undefined ? {} : { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const tileOf = async (page: Page, roomNo: string) => (await getJson<RoomBoard>(page, '/api/rooms')).rooms.find((r) => r.roomNo === roomNo)!;

/** 收掉洗浴客人的来访（店主）：作废有效明细后撤销；已离店的不动 */
async function clearVisit(page: Page, visitId: number, reason: string) {
  const v = await getJson<{ status: string; lines: { id: number; status: string }[] }>(page, `/api/frontdesk/visits/${visitId}`);
  if (v.status !== 'open') return;
  for (const l of v.lines.filter((x) => x.status === 'active')) await send(page, 'post', `/api/frontdesk/lines/${l.id}/void`, { reason });
  await send(page, 'post', `/api/frontdesk/visits/${visitId}/cancel`, { reason });
}

/** 收掉一间房上还在住的入住单（店主）：在手牌账单上作废房费、退押金后撤销入住，来访一并撤销 */
async function clearStay(page: Page, roomNo: string, reason: string) {
  const t = await tileOf(page, roomNo);
  if (!t?.stay) return;
  const s = await getJson<StayDetail>(page, `/api/rooms/stays/${t.stay.id}`);
  for (const c of s.charges.filter((x) => x.lineStatus === 'active')) await send(page, 'post', `/api/frontdesk/lines/${c.lineId}/void`, { reason });
  // 退押金和收款一样要先开班（现金从当班的钱箱退）
  if (s.depositBalance > 0) await ensureShift(page);
  for (const m of s.depositByMethod.filter((x) => x.balance > 0)) {
    await send(page, 'post', `/api/rooms/stays/${s.id}/refunds`, { clientKey: randomUUID(), method: m.method, amount: m.balance, reason });
  }
  await send(page, 'post', `/api/rooms/stays/${s.id}/cancel`, { reason });
  await clearVisit(page, s.visitId, reason);
}

/** 前台接待一位男宾（接口办理，按默认票种），返回手牌与来访 */
async function checkinGuest(page: Page, label: string) {
  const board = await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board');
  const tag = board.tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse()[0]!;
  await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', guestLabel: label }] });
  const visitId = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag)!.visit!.id;
  return { tag, visitId };
}

/** 店主：专用房型（第一个在后台页面上建）、房间都准备好，开启客房、规则恢复默认；收掉上次中断留下的入住，房间都打扫好 */
async function prepare(page: Page) {
  let admin = await getJson<RoomsAdmin>(page, '/api/admin/rooms');
  if (!admin.types.some((t) => t.name === DAILY.name)) {
    await page.goto('/admin/rooms');
    await expect(page.getByTestId('rooms-rules-card')).toContainText('客房功能');
    await page.getByTestId('rooms-type-new').click();
    await page.getByTestId('rooms-type-name').fill(DAILY.name);
    await page.getByTestId('rooms-type-price').fill(String(DAILY.price / 100));
    await page.getByTestId('rooms-type-save').click();
    await expect(page.getByTestId(`rooms-type-${DAILY.name}`)).toContainText('¥288 / 晚');
    admin = await getJson<RoomsAdmin>(page, '/api/admin/rooms');
  }
  for (const [i, t] of [DAILY, HOURLY].entries()) {
    const old = admin.types.find((x) => x.name === t.name);
    const body = { name: t.name, kind: t.kind, price: t.price, blockMinutes: t.blockMinutes, sortOrder: 9000 + i, active: true };
    if (!old) admin = await send<RoomsAdmin>(page, 'post', '/api/admin/rooms/types', body);
    else if (!old.active || old.price !== t.price || old.sortOrder !== body.sortOrder) admin = await send<RoomsAdmin>(page, 'put', `/api/admin/rooms/types/${old.id}`, body);
  }
  for (const [i, r] of ROOMS.entries()) {
    const old = admin.rooms.find((x) => x.roomNo === r.roomNo);
    const body = { roomNo: r.roomNo, floor: FLOOR, roomTypeId: admin.types.find((t) => t.name === r.type)!.id, sortOrder: i, active: true };
    if (!old) admin = await send<RoomsAdmin>(page, 'post', '/api/admin/rooms/rooms', body);
    else if (!old.active || old.roomTypeId !== body.roomTypeId || old.floor !== FLOOR) admin = await send<RoomsAdmin>(page, 'put', `/api/admin/rooms/rooms/${old.id}`, body);
  }
  await send(page, 'put', '/api/admin/rooms/rules', RULES);
  for (const r of ROOMS) {
    await clearStay(page, r.roomNo, 'E2E：收掉上次留下的');
    const t = await tileOf(page, r.roomNo);
    if (t.status !== 'vacant') await send(page, 'put', `/api/rooms/${t.id}/housekeeping`, { status: 'clean' });
  }
}

/** 收尾：收掉还在住的入住单、房间打扫好（店主）；关闭客房功能 */
async function cleanup(page: Page) {
  for (const r of ROOMS) {
    await clearStay(page, r.roomNo, 'E2E：收尾');
    const t = await tileOf(page, r.roomNo);
    if (t && t.status !== 'vacant') await send(page, 'put', `/api/rooms/${t.id}/housekeeping`, { status: 'clean' });
  }
  const res = await page.request.put('/api/admin/rooms/rules', { data: { ...RULES, enabled: false } });
  expect(res.ok(), await res.text()).toBe(true);
}

test.describe('S7 客房', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改规则的流程只在门店电脑尺寸执行一次');
  test.setTimeout(300_000);

  test('接待 → 入住（押金）→ 收退押金 → 换房 → 前台结账时直接退房、房费随手牌一起结 → 改房态 → 夜审 → 看板', async ({ page }) => {
    /** 这次接待的客人：中途失败时收尾撤销 */
    let visit: number | null = null;
    await login(page, 'linlan');
    try {
      await prepare(page);
      await relogin(page, 'xiaozhou');
      await ensureShift(page);
      const g = await checkinGuest(page, 'E2E 住客');
      visit = g.visitId;

      // ① 主导航「客房」：按楼层的房态看板
      await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '客房' }).click();
      await expect(page).toHaveURL(/\/rooms/);
      const tile1 = page.getByTestId(`room-tile-${R1}`);
      await expect(tile1).toHaveAttribute('data-state', 'vacant');

      // ② 入住 E2E-01：填在店客人的手牌（小写也行），2 人；押金默认不收，这里勾上收现金 ¥200；入住挂第一晚到手牌账单上
      await tile1.click();
      const checkin = page.getByRole('dialog').filter({ hasText: `入住 · ${R1}` });
      await expect(checkin).toContainText('¥288 / 晚');
      await expect(checkin.getByTestId('room-checkin-submit')).toBeDisabled();
      await checkin.getByTestId('room-checkin-tag').fill(g.tag.toLowerCase());
      await checkin.getByTestId('room-checkin-label').fill('E2E 李先生');
      await checkin.getByTestId('room-checkin-guests').fill('2');
      await expect(checkin.getByTestId('room-checkin-with-deposit')).not.toBeChecked();
      await checkin.getByTestId('room-checkin-with-deposit').check();
      await checkin.getByTestId('deposit-amount').fill('200');
      await checkin.getByTestId('room-checkin-submit').click();
      await expect(page.getByText(`${R1} 已入住`)).toBeVisible();
      const detail = page.getByTestId('stay-detail');
      await expect(detail).toContainText(`手牌 ${g.tag}`);
      await expect(detail.getByTestId('stay-charges')).toContainText('一晚');
      await expect(detail.getByTestId('stay-deposit-balance')).toContainText('200.00');
      await expect(tile1).toHaveAttribute('data-state', 'occupied');
      const stayId = (await tileOf(page, R1)).stay!.id;

      // ③ 收押金（微信 ¥100）、退押金（微信 ¥50，写原因）：押金按原收款方式原路退
      await detail.getByTestId('stay-deposit').click();
      const receive = page.getByRole('dialog').filter({ hasText: `收押金 · ${R1}` });
      await receive.getByTestId('deposit-method').selectOption('wechat');
      await receive.getByTestId('deposit-amount').fill('100');
      await receive.getByTestId('stay-deposit-submit').click();
      await expect(page.getByText(`${R1} 已收押金`)).toBeVisible();
      await expect(detail.getByTestId('stay-deposit-balance')).toContainText('300.00');
      await detail.getByTestId('stay-refund').click();
      const refund = page.getByRole('dialog').filter({ hasText: `退押金 · ${R1}` });
      await refund.getByLabel('退回的方式').selectOption('wechat');
      await expect(refund.getByTestId('stay-refund-amount')).toHaveValue(/^100(\.0+)?$/);
      await refund.getByTestId('stay-refund-amount').fill('50');
      await refund.getByTestId('stay-refund-reason').fill('客人要求少押一些');
      await refund.getByTestId('stay-deposit-submit').click();
      await expect(page.getByText(`${R1} 已退押金`)).toBeVisible();
      await expect(detail.getByTestId('stay-deposit-balance')).toContainText('250.00');

      // ④ 换房到 E2E-02（写原因）：原房间待打扫，房价按入住时的不变
      await detail.getByTestId('stay-move').click();
      const move = page.getByRole('dialog').filter({ hasText: `换房 · ${R1}` });
      await move.getByTestId(`stay-move-to-${R2}`).click();
      await move.getByTestId('stay-move-reason').fill('空调坏了');
      await move.getByTestId('stay-move-save').click();
      await expect(page.getByText(`已换到 ${R2}`)).toBeVisible();
      await expect(detail).toContainText('换房记录');
      await page.keyboard.press('Escape');
      await expect(tile1).toHaveAttribute('data-state', 'dirty');
      await expect(page.getByTestId(`room-tile-${R2}`)).toHaveAttribute('data-state', 'occupied');

      // ⑤ 前台结账：客人还住着客房，不能确认结清；在结账对话框里直接退房（押金 ¥250 原路退回），房费随门票一起结
      await page.goto(`/frontdesk?v=${g.visitId}`);
      const panel = page.getByTestId('bill-panel');
      await expect(panel.getByTestId('bill-tag')).toHaveText(g.tag);
      await expect(panel).toContainText(`房费 ${R1}`);
      await panel.getByTestId('action-checkout').click();
      const rooms = page.getByTestId('checkout-rooms');
      await expect(rooms).toContainText(R2);
      await expect(page.getByTestId('checkout-submit')).toBeDisabled();
      await rooms.getByTestId(`checkout-room-close-${R2}`).click();
      const close = page.getByRole('dialog').filter({ hasText: `退房 · ${R2}` });
      await expect(close.getByTestId('stay-close-review')).toContainText('房费已经挂齐');
      await expect(close.getByTestId('stay-close-review')).toContainText('押金 ¥250.00 全部原路退回');
      await close.getByTestId('stay-close-submit').click();
      await expect(page.getByText(`${R2} 已退房`)).toBeVisible();
      await expect(page.getByTestId('checkout-rooms')).toHaveCount(0);
      await page.getByTestId('pay-add-cash').click();
      await page.getByTestId('checkout-submit').click();
      const receipt = page.getByTestId('checkout-receipt');
      await expect(receipt).toContainText(g.tag);
      await page.getByTestId('checkout-finish').click();
      const settled = await getJson<StayDetail>(page, `/api/rooms/stays/${stayId}`);
      expect(settled.status).toBe('checked_out');
      expect(settled.depositBalance).toBe(0);
      expect(settled.deposits.map((d) => [d.kind, d.method, d.amount]).sort()).toEqual(
        [
          ['receive', 'cash', 20000],
          ['receive', 'wechat', 10000],
          ['refund', 'wechat', 5000],
          ['refund', 'cash', 20000],
          ['refund', 'wechat', 5000],
        ].sort(),
      );
      const list = await getJson<{ id: number; tagCodes: string[]; totalAmount: number; status: string }[]>(page, '/api/frontdesk/checkouts');
      const done = list.find((c) => c.tagCodes.includes(g.tag) && c.status === 'completed')!;
      const full = await getJson<CheckoutDetail>(page, `/api/frontdesk/checkouts/${done.id}`);
      expect(full.totalAmount).toBe(full.bills[0]!.amount);
      expect(full.totalAmount - (full.bills[0]!.ticketAmount ?? 0)).toBe(DAILY.price);

      // ⑥ 改房态：E2E-01 打扫好（空闲）；E2E-03 设为维修（写原因）
      await page.goto('/rooms');
      await expect(page.getByTestId(`room-tile-${R2}`)).toHaveAttribute('data-state', 'dirty');
      await page.getByTestId(`room-tile-${R1}`).click();
      const hk = page.getByRole('dialog').filter({ hasText: `改房态 · ${R1}` });
      await hk.getByRole('radio', { name: '已打扫（空闲）' }).click();
      await hk.getByTestId('room-housekeeping-save').click();
      await expect(page.getByText(`${R1} 已改为已打扫`)).toBeVisible();
      await expect(tile1).toHaveAttribute('data-state', 'vacant');
      await page.getByTestId(`room-tile-${R3}`).click();
      // 空闲的房点开是入住；改房态在入住对话框左下角
      await page.getByRole('dialog').filter({ hasText: `入住 · ${R3}` }).getByTestId('room-checkin-housekeep').click();
      const hk3 = page.getByRole('dialog').filter({ hasText: `改房态 · ${R3}` });
      await hk3.getByRole('radio', { name: '维修' }).click();
      await expect(hk3.getByTestId('room-housekeeping-save')).toBeDisabled();
      await hk3.getByTestId('room-maintenance-note').fill('E2E 空调不制冷');
      await hk3.getByTestId('room-housekeeping-save').click();
      await expect(page.getByTestId(`room-tile-${R3}`)).toHaveAttribute('data-state', 'maintenance');
      await expect(page.getByTestId(`room-tile-${R3}`)).toContainText('E2E 空调不制冷');

      // ⑦ 夜审：过了加收一晚的时刻才能做
      await page.getByTestId('rooms-audit').click();
      const audit = page.getByRole('dialog').filter({ hasText: '夜审 · 营业日' });
      const run = audit.getByTestId('room-audit-run');
      if (await run.isEnabled()) {
        await run.click();
        await expect(audit.getByTestId('room-audit-report')).toContainText('夜审完成');
        await audit.getByTestId('room-audit-close').click();
      } else {
        await expect(audit).toContainText('夜审要在 18:00 以后做');
        await page.keyboard.press('Escape');
      }

      // ⑧ 店主看板「客房」：此刻在住、在住押金
      await relogin(page, 'linlan');
      await page.goto('/dashboard/rooms');
      const dash = page.getByTestId('dashboard-rooms');
      await expect(dash.getByTestId('rooms-now')).toContainText('间');
      await expect(dash.getByTestId('rooms-deposit')).toContainText('¥');
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await relogin(page, 'linlan');
      await cleanup(page);
      if (visit !== null) await clearVisit(page, visit, 'E2E：收尾');
    }
  });

  test('入住响应丢失：刷新后顶部仍提醒待确认，「去处理」回到入住对话框，查回已生效、只入住一次', async ({ page }) => {
    let visit: number | null = null;
    await login(page, 'linlan');
    try {
      await prepare(page);
      await relogin(page, 'xiaozhou');
      await ensureShift(page);
      const g = await checkinGuest(page, 'E2E 断网');
      visit = g.visitId;
      // 入住请求真实到达服务器并生效，但浏览器收不到响应；查回也先连不上
      await page.route('**/api/rooms/checkin', async (route) => {
        await route.fetch();
        await route.abort('connectionreset');
      }, { times: 1 });
      await page.route('**/api/frontdesk/ops/*', (route) => route.abort('connectionreset'));
      await page.goto('/rooms');
      await page.getByTestId(`room-tile-${R1}`).click();
      const dialog = page.getByRole('dialog').filter({ hasText: `入住 · ${R1}` });
      await dialog.getByTestId('room-checkin-tag').fill(g.tag);
      await dialog.getByTestId('room-checkin-label').fill('E2E 断网');
      await dialog.getByTestId('room-checkin-submit').click();
      await expect(dialog.getByTestId('pending-op')).toContainText(`房 ${R1}`);
      await expect(dialog.getByTestId('room-checkin-submit')).toBeDisabled();
      // 刷新后顶部提醒仍在 → 去处理：回到 E2E-01 的入住对话框
      await page.reload();
      const banner = page.getByTestId('frontdesk-pending-banner');
      await expect(banner).toContainText(`房 ${R1}`);
      await expect(banner).toContainText('客房入住');
      await banner.getByRole('button', { name: '去处理' }).click();
      await expect(page).toHaveURL(/\/rooms/);
      const again = page.getByRole('dialog').filter({ hasText: `入住 · ${R1}` });
      await expect(again.getByTestId('pending-op')).toContainText(`房 ${R1}`);
      // 网络恢复：查回已生效，只入住一次
      await page.unroute('**/api/frontdesk/ops/*');
      await again.getByTestId('pending-check').click();
      await expect(page.getByText(`${R1} 已入住`)).toBeVisible();
      await expect(page.getByTestId('stay-detail')).toBeVisible();
      await expect(banner).toHaveCount(0);
      const board = await getJson<RoomBoard>(page, '/api/rooms');
      expect(board.rooms.filter((r) => r.roomNo === R1 && r.stay).map((r) => [r.stay!.guestLabel, r.stay!.tagCode])).toEqual([['E2E 断网', g.tag]]);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await relogin(page, 'linlan');
      await cleanup(page);
      if (visit !== null) await clearVisit(page, visit, 'E2E：收尾');
    }
  });
});
