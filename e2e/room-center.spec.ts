// 8.1.16 房态中心浏览器验收（《浴族系统需求汇总》房态中心 1–4，docs/ROOM_CENTER_V8115.md 第 11 节）：
//   主导航「房态 → 房态中心」→ 总览、按房型的页签、各状态的数量（点一下只看这一种）→ 点空闲的 SPA 房卡片登记（键盘式读卡器刷手牌带出客人、
//   点钟指定技师、出单员工号、现在开始）→ 卡片上是客人、技师、计时、金额 → 房间详情里换房（单与计时不变，原来的房间转待清）→ 下钟 → 退房
//   （先看结账预览，账没结的确认客人带手牌在店）→ 清洁完成的响应丢了：结果待确认、刷新后顶部提醒「去处理」回到那间房、查回只生效一次 →
//   维修（原因、预计完成时间）→ 恢复 → 派对房点卡片开单、结束使用、清洁完成 → 大厅标待清 → 旧地址 /rooms 跳到房态中心 → 后台的房型配置。
//   另一条只读的在各个尺寸跑：总览、页签、卡片、房间详情、登记对话框都不横向滚动。
// 只在独立演示库跑（CI 的五套 seed 或 demo-prepare 都行），数据自己备、可以重复跑：空间台账里没有专用的 4 个空间（三层的 Q391–Q394）就导入；
// 专用的技师项目、技师（R98，开始时上牌、结束时下牌）没有就建；开始时把这几间房收拾成空闲，结束时客人结账离店。
// 账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { BoardTag } from '../src/shared/frontdesk';
import type { RoomCard, RoomCenterBoard, RoomCheckoutPreview } from '../src/shared/room-center';
import type { SpaceLedger } from '../src/shared/spaces';
import { expectFits } from './fits';
import { clickNav } from './nav';

const PASSWORD = 'yuzu2026';
const [SPA1, SPA2, PARTY, HALL] = ['Q391', 'Q392', 'Q393', 'Q394'] as const;
const SPACES = [
  [SPA1, 'SPA', '1', 'E2E 房态 SPA 一号'],
  [SPA2, 'SPA', '1', 'E2E 房态 SPA 二号'],
  [PARTY, '派对房', '', 'E2E 房态派对房'],
  [HALL, '休息大厅', '30', 'E2E 房态休息大厅'],
] as const;
const ITEM = { name: 'E2E 房态足疗', category: 'E2E 房态', price: 9800, durationMinutes: 60, technicianRequired: true };
const TECH = { techNo: 'R98', name: 'E2E 房态技师' };

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
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

const boardOf = (page: Page) => getJson<RoomCenterBoard>(page, '/api/room-center');
const cardOf = async (page: Page, code: string) => (await boardOf(page)).rooms.find((r) => r.code === code)!;
const on = (r: RoomCard, action: string) => `/api/room-center/rooms/${r.spaceId}/${action}`;

/** 店主：专用的 4 个空间、技师项目、技师（上牌）；技师功能关着的打开。返回技师功能原来开没开 */
async function ensureData(page: Page): Promise<boolean> {
  const ledger = await getJson<SpaceLedger>(page, '/api/admin/spaces');
  const missing = SPACES.filter(([code]) => !ledger.spaces.some((s) => s.code === code));
  if (missing.length) {
    // 三层（演示库的空间台账有 L1–L3 三个楼层），区域字母 Q，不分区域
    const rows = missing.map(([code, type, cap, name]) => `L3,Q,${code},${type},${cap},${name},,${name},E2E`);
    const csv = ['楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注', ...rows].join('\r\n');
    await send(page, 'post', '/api/admin/spaces/imports', { kind: 'spaces', fileName: 'e2e-room-center-spaces.csv', csv, encoding: 'UTF-8', clientKey: randomUUID() });
  }
  const items = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items;
  const item = items.find((i) => i.name === ITEM.name);
  if (!item) await send(page, 'post', '/api/items', ITEM);
  else if (!item.active) await send(page, 'put', `/api/items/${item.id}`, { ...ITEM, active: true });
  const admin = await getJson<{ rules: { enabled: boolean }; technicians: { id: number; techNo: string; active: boolean }[] }>(page, '/api/admin/technicians');
  if (!admin.rules.enabled) await send(page, 'put', '/api/admin/technicians/rules', { enabled: true });
  if (!admin.technicians.some((t) => t.techNo === TECH.techNo)) await send(page, 'post', '/api/admin/technicians', { ...TECH, gender: 'female', grade: 'standard' });
  return admin.rules.enabled;
}

const techOf = async (page: Page) => (await getJson<{ technicians: { id: number; techNo: string; state: string }[] }>(page, '/api/clockroom')).technicians.find((t) => t.techNo === TECH.techNo)!;

/** 店主：把专用的 4 间房收拾成空闲（上次中断留下的：下钟、取消派钟、退房、撤单、恢复、清洁完成） */
async function releaseRooms(page: Page) {
  for (const code of [SPA1, SPA2, PARTY, HALL]) {
    let r = await cardOf(page, code);
    for (const s of r.guests.flatMap((g) => g.sessions)) {
      if (s.status === 'serving') await send(page, 'post', `/api/clockroom/sessions/${s.id}/finish`);
      if (s.status === 'waiting') await send(page, 'post', `/api/clockroom/sessions/${s.id}/void`, { reason: 'E2E：收掉上次留下的' });
    }
    r = await cardOf(page, code);
    if (r.guests.some((g) => g.registrationId !== null)) {
      const p = await getJson<RoomCheckoutPreview>(page, on(r, 'checkout-preview'));
      await send(page, 'post', on(r, 'checkout'), { clientKey: randomUUID(), expectedVersion: p.version, seenUnpaid: p.unpaidTotal, inHouse: true });
    }
    if (r.usage) await send(page, 'post', `/api/usages/${r.usage.id}/cancel`, { clientKey: randomUUID(), reason: 'E2E：收掉上次留下的' });
    r = await cardOf(page, code);
    if (r.status === 'maintenance') await send(page, 'post', on(r, 'restore'), { clientKey: randomUUID(), expectedVersion: r.version, note: '' });
    r = await cardOf(page, code);
    if (r.status === 'dirty') await send(page, 'post', on(r, 'cleaned'), { clientKey: randomUUID(), expectedVersion: r.version });
    expect((await cardOf(page, code)).status, `${code} 收拾好了`).toMatch(/^(free|booked)$/);
  }
}

/** 前台接待一位男宾（接口办理，按默认票种），返回手牌、手牌的编号与来访 */
async function checkinGuest(page: Page, label: string) {
  const board = await getJson<{ tags: (BoardTag & { id: number })[] }>(page, '/api/frontdesk/board');
  const tag = board.tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).reverse()[0]!;
  await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag.code, zone: 'male', guestLabel: label }] });
  const visitId = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag.code)!.visit!.id;
  return { tag: tag.code, tagId: tag.id, visitId };
}

/** 收尾：这几位客人在收银台结账离店（没开班的临时开一个，结完交掉） */
async function payAndLeave(page: Page, visitIds: number[]) {
  const open = [];
  for (const id of visitIds) {
    const v = await getJson<{ status: string }>(page, `/api/frontdesk/visits/${id}`);
    if (v.status === 'open') open.push(id);
  }
  if (!open.length) return;
  const opened = (await page.request.post('/api/shifts', { data: { openingCash: 0 } })).status() === 200;
  for (const id of open) {
    const preview = await getJson<{ totalAmount: number }>(page, `/api/frontdesk/checkout-preview?ids=${id}`);
    await send(page, 'post', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [id], expectedTotal: preview.totalAmount, payments: [{ method: 'cash', amount: preview.totalAmount }] });
  }
  if (opened) {
    const { shift } = await getJson<{ shift: { id: number; summary: { cash: { expected: number } } } }>(page, '/api/shifts/current');
    const expected = shift.summary.cash.expected;
    await send(page, 'post', `/api/shifts/${shift.id}/close`, { countedCash: expected, expectedCash: expected, note: 'E2E：房态中心流程临时开的班' });
  }
}

/** 键盘式读卡器：很快地把卡号一个键一个键打进来、以回车结束（按键落在现在有光标的地方；写法同 frontdesk-risk.spec.ts） */
async function swipe(page: Page, uid: string) {
  await page.evaluate((code) => {
    const target = document.activeElement ?? document.body;
    for (const key of [...code, 'Enter']) target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }, uid);
}

const fits = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

test.describe('8.1.16 房态中心', () => {
  // 点不到的按钮早点报出来（不等到整条用例超时）
  test.use({ actionTimeout: 20_000 });
  test('登记 → 换房 → 下钟 → 退房 → 清洁完成（结果待确认）→ 维修 / 恢复 → 派对房开单 → 大厅标待清；旧地址跳转、后台房型', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '会登记单据，只在门店电脑尺寸执行一次');
    test.setTimeout(300_000);
    const visits: number[] = [];
    let techWasOn = true;
    let card: { tagId: number; uid: string } | null = null;
    await login(page, 'linlan');
    try {
      techWasOn = await ensureData(page);
      await releaseRooms(page);
      const g1 = await checkinGuest(page, 'E2E 房态一');
      visits.push(g1.visitId);
      const g2 = await checkinGuest(page, 'E2E 房态二');
      visits.push(g2.visitId);
      // 第一位客人的手牌绑一个芯片号：登记时用键盘式读卡器刷
      card = { tagId: g1.tagId, uid: `E2E${randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()}` };
      await send(page, 'put', `/api/frontdesk/tags/${card.tagId}/card`, { cardUid: card.uid });
      await relogin(page, 'xiaozhou');
      const tech = await techOf(page);
      if (tech.state !== 'on') await send(page, 'post', `/api/clockroom/technicians/${tech.id}/state`, { action: 'sign_in' });
      const spaKey = (await cardOf(page, SPA1)).categoryKey;

      // ① 主导航「房态 → 房态中心」：总览（每个房型各几间），点 SPA 房的页签；数量点一下只看这一种
      await clickNav(page, '房态中心');
      await expect(page).toHaveURL(/\/room-center/);
      await expect(page.getByTestId('rc-overview')).toBeVisible();
      await expect(page.getByTestId(`rc-summary-${spaKey}`)).toContainText('SPA 房');
      await page.getByTestId(`rc-tab-${spaKey}`).click();
      await expect(page.getByTestId(`rc-tab-${spaKey}`)).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(new RegExp(`tab=${spaKey}`));
      const room1 = page.getByTestId(`rc-room-${SPA1}`);
      await expect(room1).toHaveAttribute('data-status', 'free');
      await page.getByTestId('rc-count-free').click();
      await expect(page).toHaveURL(/status=free/);
      await expect(room1).toBeVisible();
      await page.getByTestId('rc-count-free').click();
      await expect(page).not.toHaveURL(/status=/);

      // ② 点空闲的 SPA 房卡片登记：键盘式读卡器刷手牌带出客人；项目、点钟指定技师、出单员（默认自己的登录名）；必填的没填不能提交
      await page.getByTestId(`rc-open-${SPA1}`).click();
      const reg = page.getByRole('dialog').filter({ hasText: `登记 · ${SPA1}` });
      await expect(reg.getByTestId('rc-register')).toBeVisible();
      await expect(reg.getByTestId('rc-register-submit')).toBeDisabled();
      await reg.getByTestId('rc-register-tag').focus();
      await swipe(page, card.uid.toLowerCase());
      await expect(reg.getByTestId('rc-register-tag')).toHaveValue(g1.tag);
      await expect(reg.getByTestId('rc-register-guest')).toContainText('E2E 房态一');
      await reg.getByTestId(`rc-register-item-${ITEM.name}`).click();
      await reg.getByRole('radiogroup', { name: '上钟方式' }).getByRole('radio', { name: /点钟/ }).click();
      await reg.getByTestId(`rc-register-tech-${TECH.techNo}`).click();
      await expect(reg.getByTestId('rc-register-total')).toContainText('98.00');
      await reg.getByTestId('rc-register-note').fill('E2E 靠窗');
      await reg.getByTestId('rc-register-submit').click();
      await expect(page.getByText(`${SPA1} 已登记`)).toBeVisible();
      await expect(room1).toHaveAttribute('data-status', 'in_use');
      await expect(room1.getByTestId('rc-guest')).toContainText('E2E 房态一');
      await expect(room1.getByTestId('rc-tech')).toContainText(TECH.name);
      await expect(room1.getByTestId('rc-elapsed')).toContainText('已用');
      await expect(room1.getByTestId('rc-amount')).toContainText('98.00');

      // ③ 房间详情：换房到 Q392——单与计时不变，原来的房间转待清
      await page.getByTestId(`rc-detail-${SPA1}`).click();
      const detail1 = page.getByTestId('rc-room-dialog');
      await expect(detail1.getByTestId(`rc-guest-${g1.tag}`)).toContainText('出单员 xiaozhou');
      await detail1.getByTestId('rc-act-move').click();
      const move = page.getByRole('dialog').filter({ hasText: `换房 · ${SPA1}` });
      await move.getByTestId(`rc-move-to-${SPA2}`).click();
      await move.getByTestId('rc-move-note').fill('E2E 空调不凉');
      await move.getByTestId('rc-move-submit').click();
      await expect(page.getByText(`已换到 ${SPA2}`)).toBeVisible();
      await expect(room1).toHaveAttribute('data-status', 'dirty');
      const room2 = page.getByTestId(`rc-room-${SPA2}`);
      await expect(room2).toHaveAttribute('data-status', 'in_use');
      const session = (await cardOf(page, SPA2)).guests[0]!.sessions[0]!;

      // ④ 下钟、退房：先看结账预览（这次登记的明细、手牌账单没结），确认客人带手牌继续在店；退了转待清
      await page.getByTestId(`rc-detail-${SPA2}`).click();
      await page.getByTestId('rc-room-dialog').getByTestId(`rc-finish-${session.sessionNo}`).click();
      await expect(page.getByTestId('rc-room-dialog').getByTestId(`rc-session-${session.sessionNo}`)).toContainText('已下钟');
      await page.getByTestId('rc-room-dialog').getByTestId('rc-act-checkout').click();
      const out = page.getByRole('dialog').filter({ hasText: `退房 · ${SPA2}` });
      await expect(out.getByTestId(`rc-checkout-guest-${g1.tag}`)).toContainText(ITEM.name);
      await expect(out.getByTestId('rc-checkout-submit')).toBeDisabled();
      await out.getByTestId('rc-checkout-inhouse').click();
      await out.getByTestId('rc-checkout-submit').click();
      await expect(page.getByText(`${SPA2} 已退房，转待清`)).toBeVisible();
      await expect(room2).toHaveAttribute('data-status', 'dirty');

      // ⑤ 清洁完成的响应丢了（请求到了、已生效）：结果待确认；刷新后顶部提醒「去处理」回到这间房，查回已生效、只做一次
      const cleanedBefore = (await getJson<{ rows: { kind: string | null }[] }>(page, on(await cardOf(page, SPA2), 'history'))).rows.filter((r) => r.kind === 'cleaned').length;
      await page.route(
        '**/api/room-center/rooms/*/cleaned',
        async (route) => {
          await route.fetch();
          await route.abort('connectionreset');
        },
        { times: 1 },
      );
      await page.route('**/api/room-center/ops/*', (route) => route.abort('connectionreset'));
      await page.getByTestId(`rc-detail-${SPA2}`).click();
      await page.getByTestId('rc-room-dialog').getByTestId('rc-act-cleaned').click();
      await expect(page.getByTestId('rc-room-dialog').getByTestId('pending-op')).toContainText(`房 ${SPA2}`);
      // 这间房上「改房态」那一类的动作先锁住（请求其实已经生效，看板重新取了以后这间房可能已经是空闲：维修按钮两种状态下都在）
      await expect(page.getByTestId('rc-room-dialog').getByTestId('rc-act-maintenance')).toBeDisabled();
      await page.reload();
      const banner = page.getByTestId('frontdesk-pending-banner');
      await expect(banner).toContainText(`房 ${SPA2}`);
      await expect(banner).toContainText('改房态');
      await banner.getByRole('button', { name: '去处理' }).click();
      await expect(page).toHaveURL(/\/room-center/);
      const again = page.getByTestId('rc-room-dialog');
      await expect(again.getByTestId('pending-op')).toContainText(`房 ${SPA2}`);
      await page.unroute('**/api/room-center/ops/*');
      await again.getByTestId('pending-check').click();
      await expect(page.getByText(`房 ${SPA2} 的改房态已生效`)).toBeVisible();
      await expect(banner).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(room2).toHaveAttribute('data-status', 'free');
      const cleanedAfter = (await getJson<{ rows: { kind: string | null }[] }>(page, on(await cardOf(page, SPA2), 'history'))).rows.filter((r) => r.kind === 'cleaned').length;
      expect(cleanedAfter).toBe(cleanedBefore + 1);

      // ⑥ Q391 清洁完成；维修（原因 + 预计完成时间）→ 卡片写原因 → 恢复
      await page.getByTestId(`rc-detail-${SPA1}`).click();
      await page.getByTestId('rc-room-dialog').getByTestId('rc-act-cleaned').click();
      await expect(page.getByText(`${SPA1} 清洁完成，可以用了`)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(room1).toHaveAttribute('data-status', 'free');
      await page.getByTestId(`rc-detail-${SPA1}`).click();
      await page.getByTestId('rc-room-dialog').getByTestId('rc-act-maintenance').click();
      const mt = page.getByRole('dialog').filter({ hasText: `维修 · ${SPA1}` });
      await expect(mt.getByTestId('rc-maintenance-submit')).toBeDisabled();
      await mt.getByTestId('rc-maintenance-reason').fill('E2E 空调漏水');
      await mt.getByTestId('rc-maintenance-submit').click();
      await expect(room1).toHaveAttribute('data-status', 'maintenance');
      await expect(room1).toContainText('E2E 空调漏水');
      await page.getByTestId(`rc-open-${SPA1}`).click();
      await page.getByTestId('rc-room-dialog').getByTestId('rc-act-restore').click();
      await page
        .getByRole('dialog')
        .filter({ hasText: `恢复 · ${SPA1}` })
        .getByTestId('rc-restore-submit')
        .click();
      await expect(room1).toHaveAttribute('data-status', 'free');

      // ⑦ 派对房：点空闲的卡片开单（使用单）→ 在用 → 结束使用 → 待清 → 清洁完成
      const partyKey = (await cardOf(page, PARTY)).categoryKey;
      await page.getByTestId(`rc-tab-${partyKey}`).click();
      const party = page.getByTestId(`rc-room-${PARTY}`);
      await expect(party).toHaveAttribute('data-status', 'free');
      await page.getByTestId(`rc-open-${PARTY}`).click();
      const open = page.getByRole('dialog').filter({ hasText: `开单 · ${PARTY}` });
      await open.getByTestId('usage-open-tag').fill(g2.tag);
      await open.getByTestId('usage-open-submit').click();
      await expect(party).toHaveAttribute('data-status', 'in_use');
      await expect(party.getByTestId('rc-guest')).toContainText(g2.tag);
      await page.getByTestId(`rc-detail-${PARTY}`).click();
      await page.getByTestId('rc-room-dialog').getByTestId('rc-act-usage-end').click();
      await page.getByTestId('usage-close-submit').click();
      await expect(party).toHaveAttribute('data-status', 'dirty');
      await page.getByTestId(`rc-detail-${PARTY}`).click();
      await page.getByTestId('rc-room-dialog').getByTestId('rc-act-cleaned').click();
      await page.keyboard.press('Escape');
      await expect(party).toHaveAttribute('data-status', 'free');

      // ⑧ 大厅：没有业务单据，只标待清、清洁完成；房间历史里都有
      await page.getByTestId('rc-tab-all').click();
      const hall = page.getByTestId(`rc-room-${HALL}`);
      await page.getByTestId(`rc-detail-${HALL}`).click();
      await page.getByTestId('rc-room-dialog').getByTestId('rc-act-dirty').click();
      const dirty = page.getByRole('dialog').filter({ hasText: `标为待清 · ${HALL}` });
      await dirty.getByTestId('rc-dirty-note').fill('E2E 客人洒了水');
      await dirty.getByTestId('rc-dirty-submit').click();
      await expect(hall).toHaveAttribute('data-status', 'dirty');
      await expect(hall).toContainText('E2E 客人洒了水');
      await page.getByTestId(`rc-detail-${HALL}`).click();
      const hallDetail = page.getByTestId('rc-room-dialog');
      await expect(hallDetail.getByTestId('rc-history')).toContainText('客人洒了水');
      await hallDetail.getByTestId('rc-act-cleaned').click();
      await page.keyboard.press('Escape');
      await expect(hall).toHaveAttribute('data-status', 'free');
      await fits(page);

      // ⑨ 原来的「客房」页：地址跳到房态中心（平面图 → 「视图 → 平面图」，房态看板 → 「客房」页签）
      await page.goto('/rooms?view=map');
      await expect(page).toHaveURL(/\/room-center\?view=map/);
      await expect(page.getByRole('radiogroup', { name: '视图' }).getByRole('radio', { name: '平面图' })).toHaveAttribute('aria-checked', 'true');
      await page.goto('/rooms');
      await expect(page).toHaveURL(/\/room-center\?tab=hotel/);
      await expect(page.getByTestId('room-center')).toHaveAttribute('data-tab', /^c\d+$/);

      // ⑩ 店主：后台「空间台账 → 房态中心房型」；房态中心顶上的「房型配置」带过去
      await relogin(page, 'linlan');
      await page.goto('/room-center');
      await page.getByTestId('rc-admin-link').click();
      await expect(page).toHaveURL(/\/admin\/spaces\/room-categories/);
      await expect(page.getByTestId('room-categories')).toContainText('SPA 房');
      await page.getByTestId('room-category-edit-SPA 房').click();
      const dlg = page.getByTestId('room-category-dialog');
      await expect(dlg.getByTestId('room-category-type-SPA')).toHaveAttribute('aria-pressed', 'true');
      // 客房这一类只管「客房」业态：来源改成客房时保存不了
      await dlg.getByTestId('room-category-source-hotel').click();
      await expect(page.getByTestId('room-category-save')).toBeDisabled();
      await page.keyboard.press('Escape');
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await relogin(page, 'linlan');
      await releaseRooms(page);
      await payAndLeave(page, visits);
      if (card) await send(page, 'put', `/api/frontdesk/tags/${card.tagId}/card`, { cardUid: null });
      const tech = await techOf(page);
      if (tech && (tech.state === 'on' || tech.state === 'rest')) await page.request.post(`/api/clockroom/technicians/${tech.id}/state`, { data: { action: 'sign_out' } });
      if (!techWasOn) await send(page, 'put', '/api/admin/technicians/rules', { enabled: false });
    }
  });

  test('各尺寸：总览、页签、卡片、房间详情、登记对话框都不横向滚动（只读）', async ({ page }) => {
    await login(page, 'linlan');
    const techWasOn = await ensureData(page);
    try {
      await page.goto('/room-center');
      await expect(page.getByTestId('rc-overview')).toBeVisible();
      await expectFits(page);
      const spaKey = (await cardOf(page, SPA1)).categoryKey;
      await page.getByTestId(`rc-tab-${spaKey}`).click();
      await expect(page.getByTestId(`rc-room-${SPA1}`)).toBeVisible();
      await expectFits(page);
      // 房间详情（大厅：动作、历史）
      await page.getByTestId('rc-tab-all').click();
      await page.getByTestId(`rc-detail-${HALL}`).click();
      await expect(page.getByTestId('rc-room-dialog')).toBeVisible();
      await expectFits(page);
      await page.keyboard.press('Escape');
      // 登记对话框（空闲的 SPA 房；不提交）
      if ((await cardOf(page, SPA2)).status === 'free') {
        await page.getByTestId(`rc-open-${SPA2}`).click();
        await expect(page.getByTestId('rc-register')).toBeVisible();
        await expectFits(page);
        await expect(page.getByTestId('rc-register-submit')).toBeInViewport();
        await page.keyboard.press('Escape');
      }
      // 平面图视图（没有在用底图时写明）
      await page.getByRole('radiogroup', { name: '视图' }).getByRole('radio', { name: '平面图' }).click();
      await expect(page).toHaveURL(/view=map/);
      await fits(page);
    } finally {
      if (!techWasOn) await send(page, 'put', '/api/admin/technicians/rules', { enabled: false });
    }
  });
});
