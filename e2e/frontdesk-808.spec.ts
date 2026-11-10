// 8.0.8 前台整改的浏览器验收（docs/FRONTDESK_V808.md）：
//   · 钟房（A01、B01）：前台加项目时把护理项目「交给钟房派钟」→ 钟房「待派钟」→ 补派给点钟技师（不另挂一笔）→ 按状态筛出上钟中的技师；
//   · 餐饮（A05、B02、B06）：桌台点单下架时点单页只有手牌；服务员退小额的菜写原因直接退，大额的请值班经理当场授权（弹窗里看得到菜名、金额与原因）
//     → 「退菜记录」写明怎么批的 →「台账」按分类筛；
//   · 客房（B04、B07）：改房态先确认「从哪到哪」、可写备注 → 撤回上一次修改 →「房间详情」里有两条房态记录（撤回过的标出来）；
//   · 后台新建项目（A01）：名称或分类含「护理」默认「需要技师」，手动改过的按选的保存（拦下保存请求，不写演示库）。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan、前台 xiaozhou、值班经理 zhangjl，密码 yuzu2026。
// 专用项目、技师、房型、房间（E2E 808 开头）留着下次沿用；开始时收掉上次中断留下的，结束时把技师、餐饮、客房功能恢复关闭，可重复执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { ClockroomBoard } from '../src/shared/clockroom';
import type { DiningAdmin } from '../src/shared/dining';
import type { RoomBoard, RoomsAdmin } from '../src/shared/rooms';

const PASSWORD = 'yuzu2026';

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

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number } | null;
}

/** 前台接待一位客人（接口办理，按默认票种），返回手牌与来访 */
async function checkinGuest(page: Page, zone: 'male' | 'female', label: string) {
  const board = await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board');
  const tag = board.tags.filter((t) => t.zone === zone && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse()[0]!;
  await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone, guestLabel: label }] });
  const visitId = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag)!.visit!.id;
  return { tag, visitId };
}

/** 收掉一位客人（店主）：钟单退钟、作废有效明细后撤销来访；已离店的不动 */
async function clearVisit(page: Page, visitId: number, reason: string) {
  const clock = await page.request.get('/api/clockroom');
  if (clock.ok()) {
    for (const s of ((await clock.json()) as ClockroomBoard).sessions.filter((x) => x.visitId === visitId)) {
      await send(page, 'post', `/api/clockroom/sessions/${s.id}/void`, { reason });
    }
  }
  const v = await getJson<{ status: string; lines: { id: number; status: string }[] }>(page, `/api/frontdesk/visits/${visitId}`);
  if (v.status !== 'open') return;
  for (const l of v.lines.filter((x) => x.status === 'active')) await send(page, 'post', `/api/frontdesk/lines/${l.id}/void`, { reason });
  await send(page, 'post', `/api/frontdesk/visits/${visitId}/cancel`, { reason });
}

/** 还开着的、带这个标签的客人（上一轮中断留下的）都收掉 */
async function clearGuests(page: Page, label: string) {
  const board = await getJson<{ tags: { visit: { id: number; guestLabel: string } | null }[] }>(page, '/api/frontdesk/board');
  for (const t of board.tags.filter((x) => x.visit?.guestLabel === label)) await clearVisit(page, t.visit!.id, 'E2E：收掉上次留下的');
}

async function ensureItem(page: Page, body: { name: string; category: string; price: number }) {
  type Items = { items: { id: number; name: string; active: boolean }[] };
  let item = (await getJson<Items>(page, '/api/catalog?all=1')).items.find((i) => i.name === body.name);
  if (!item || !item.active) {
    await (item ? send(page, 'put', `/api/items/${item.id}`, { ...body, active: true }) : send(page, 'post', '/api/items', body));
    item = (await getJson<Items>(page, '/api/catalog?all=1')).items.find((i) => i.name === body.name)!;
  }
  return item.id;
}

test.describe('8.0.8 前台整改', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改规则的流程只在门店电脑尺寸执行一次');
  test.setTimeout(240_000);

  test('钟房：前台把护理项目交给钟房 → 待派钟补派点钟技师（不另挂一笔）→ 按状态筛出上钟中的技师（A01、B01）', async ({ page }) => {
    const ITEM = { name: 'E2E 808 护理', category: 'E2E 808 护理', price: 12800 };
    // E7、E8、E9 别的用例在用
    const TECH = { techNo: 'E6', name: 'E2E 小陈', gender: 'female', grade: 'standard' } as const;
    const LABEL = 'E2E 808 护理客人';
    await login(page, 'linlan');
    try {
      const itemId = await ensureItem(page, ITEM);
      await send(page, 'put', '/api/admin/technicians/items', { items: [{ id: itemId, required: true }] });
      const roster = (await getJson<{ technicians: { id: number; techNo: string; name: string; gender: string; grade: string; skills: string[]; active: boolean }[] }>(page, '/api/admin/technicians')).technicians;
      const old = roster.find((x) => x.techNo === TECH.techNo);
      if (!old) await send(page, 'post', '/api/admin/technicians', TECH);
      else if (!old.active || old.skills.length > 0) await send(page, 'put', `/api/admin/technicians/${old.id}`, { name: old.name, gender: old.gender, grade: old.grade, skills: [], active: true });
      // 不强制选技师：前台能「交给钟房派钟」
      await send(page, 'put', '/api/admin/technicians/rules', { enabled: true, requireTechnician: false });
      await clearGuests(page, LABEL);
      const tech = (await getJson<ClockroomBoard>(page, '/api/clockroom')).technicians.find((t) => t.techNo === TECH.techNo)!;
      if (tech.suspendedAt) await send(page, 'post', `/api/clockroom/technicians/${tech.id}/state`, { action: 'resume' });
      if (tech.state === 'off' || tech.state === 'leave') await send(page, 'post', `/api/clockroom/technicians/${tech.id}/state`, { action: 'sign_in' });
      if (tech.state === 'rest') await send(page, 'post', `/api/clockroom/technicians/${tech.id}/state`, { action: 'back' });
      const guest = await checkinGuest(page, 'female', LABEL);
      await relogin(page, 'xiaozhou');

      // ① 前台加项目：点护理项目 → 选技师那一步点「交给钟房派钟」→ 挂账
      await page.goto(`/frontdesk?v=${guest.visitId}`);
      const panel = page.getByTestId('bill-panel');
      await expect(panel.getByTestId('bill-tag')).toHaveText(guest.tag);
      await panel.getByTestId('action-add').click();
      const add = page.getByRole('dialog').filter({ hasText: `加项目 · ${guest.tag}` });
      await add.getByTestId(`item-${ITEM.name}`).click();
      await add.getByTestId('tech-none').click();
      await add.getByTestId('add-items-submit').click();
      await expect(add).toBeHidden();

      // ② 钟房：待派钟里有这一条；补派点钟给 E6、立即上钟
      await page.goto('/clockroom');
      const pending = page.getByTestId('clock-pending').locator('[data-testid^="clock-pending-"]').filter({ hasText: guest.tag });
      await expect(pending).toContainText(ITEM.name);
      await pending.getByRole('button', { name: '派钟' }).click();
      const dispatch = page.getByRole('dialog', { name: '派钟 · 前台已点' });
      await dispatch.getByRole('radiogroup', { name: '上钟方式' }).getByRole('radio', { name: '点钟' }).click();
      await dispatch.getByTestId(`dispatch-tech-${TECH.techNo}`).click();
      await dispatch.getByTestId('dispatch-submit').click();
      await expect(dispatch).toBeHidden();
      await expect(page.getByTestId(/^clock-serving-/).filter({ hasText: guest.tag })).toContainText(TECH.techNo);
      await expect(page.getByTestId('clock-pending').locator('[data-testid^="clock-pending-"]').filter({ hasText: guest.tag })).toHaveCount(0);
      // 账单上还是一笔护理（补派不另挂），记上了技师
      const bill = await getJson<{ lines: { name: string; status: string; technician: { techNo: string } | null }[] }>(page, `/api/frontdesk/visits/${guest.visitId}`);
      expect(bill.lines.filter((l) => l.status === 'active' && l.name.startsWith(ITEM.name)).map((l) => l.technician?.techNo)).toEqual([TECH.techNo]);

      // ③ 按状态筛：上钟中有 E6，空闲待钟里没有
      await page.getByTestId('clock-filter-serving').click();
      await expect(page.getByTestId('clock-filtered-serving')).toContainText(TECH.name);
      await page.getByTestId('clock-filter-idle').click();
      await expect(page.getByTestId('clock-filtered-idle')).not.toContainText(TECH.name);
      await page.getByTestId('clock-filter-all').click();
      await expect(page.getByTestId('clock-queue')).toBeVisible();

      await relogin(page, 'linlan');
      await clearVisit(page, guest.visitId, 'E2E：收尾');
    } finally {
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      const res = await page.request.put('/api/admin/technicians/rules', { data: { enabled: false, requireTechnician: true } });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });

  test('餐饮：桌台点单下架只剩手牌；小额直接退、大额请值班经理当场授权；退菜记录写明怎么批的；台账按分类筛（A05、B02、B06）', async ({ page }) => {
    const JUICE = { name: 'E2E 808 鲜榨橙汁', category: 'E2E 808 饮品', price: 2800 };
    const SEAFOOD = { name: 'E2E 808 海鲜拼盘', category: 'E2E 808 热菜', price: 16800 };
    const STATION = 'E2E 808 厨房';
    const LABEL = 'E2E 808 点单客人';
    await login(page, 'linlan');
    try {
      const juiceId = await ensureItem(page, JUICE);
      const seafoodId = await ensureItem(page, SEAFOOD);
      let admin = await getJson<DiningAdmin>(page, '/api/admin/dining');
      const st = admin.stations.find((s) => s.name === STATION);
      if (!st) admin = await send<DiningAdmin>(page, 'post', '/api/admin/dining/stations', { name: STATION });
      else if (!st.active) admin = await send<DiningAdmin>(page, 'put', `/api/admin/dining/stations/${st.id}`, { name: STATION, sortOrder: st.sortOrder, active: true });
      const stationId = admin.stations.find((s) => s.name === STATION)!.id;
      await send(page, 'put', '/api/admin/dining/items', { items: [{ id: juiceId, stationId }, { id: seafoodId, stationId }] });
      await send(page, 'put', '/api/admin/dining/rules', { enabled: true, trackServed: true, warnMinutes: 15, tablesEnabled: false, voidFreeCents: 5000 });
      await clearGuests(page, LABEL);
      // 店主替客人点了两道（不是服务员自己点的，服务员不能按「本人 15 分钟内」退）
      const guest = await checkinGuest(page, 'male', LABEL);
      await send(page, 'post', '/api/dining/orders', {
        clientKey: randomUUID(),
        visitId: guest.visitId,
        lines: [
          { itemId: juiceId, quantity: 1 },
          { itemId: seafoodId, quantity: 1 },
        ],
        expectedTotal: JUICE.price + SEAFOOD.price,
      });
      await relogin(page, 'xiaozhou');

      // ① 点单页：桌台点单下架，只有手牌下单
      await page.goto('/dining/order');
      await expect(page.getByTestId('dining-tag-only')).toBeVisible();
      await page.getByTestId('dining-tag').fill(guest.tag);
      await page.getByTestId('dining-find').click();
      await expect(page.getByTestId('dining-guest')).toContainText(LABEL);
      const pending = page.getByTestId('dining-pending');

      // ② ¥28 的果汁：小额，写原因直接退
      await pending.getByTestId(`dining-pending-${JUICE.name}`).getByRole('button', { name: '退菜' }).click();
      const v1 = page.getByRole('dialog').filter({ hasText: `退菜 · ${JUICE.name}` });
      await expect(v1.getByTestId('dish-void-tier')).toContainText('小额');
      await v1.locator('#reason-text').fill('E2E 客人点错了');
      await v1.getByTestId('dish-void-confirm').click();
      await expect(page.getByText(`${JUICE.name} 已退`)).toBeVisible();

      // ③ ¥168 的海鲜：要值班经理当场授权，授权弹窗里看得到菜名、金额与原因
      await pending.getByTestId(`dining-pending-${SEAFOOD.name}`).getByRole('button', { name: '退菜' }).click();
      const v2 = page.getByRole('dialog').filter({ hasText: `退菜 · ${SEAFOOD.name}` });
      await expect(v2.getByTestId('dish-void-tier')).toContainText('请值班经理及以上当场授权');
      await expect(v2.getByTestId('dish-void-confirm')).toHaveCount(0);
      await v2.locator('#reason-text').fill('E2E 等太久不要了');
      await v2.getByTestId('dish-void-authorize').click();
      const auth = page.getByRole('dialog').filter({ hasText: '当场授权 · 退菜（超过小额上限）' });
      await expect(auth).toContainText(SEAFOOD.name);
      await expect(auth).toContainText('金额 ¥168.00');
      await expect(auth).toContainText('原因：E2E 等太久不要了');
      await auth.getByLabel('授权人账号').fill('zhangjl');
      await auth.getByLabel('授权人密码').fill(PASSWORD);
      await auth.getByTestId('authorize-submit').click();
      await expect(page.getByText(`${SEAFOOD.name} 已退`)).toBeVisible();
      await expect(pending.locator(`[data-testid="dining-pending-${SEAFOOD.name}"]`)).toHaveCount(0);

      // ③b 改单：服务端已经退掉、回复丢了（Codex 审查 b4a83d9）——再点一次就完成，菜放回购物车，不会卡在「已作废」
      await send(page, 'post', '/api/dining/orders', { clientKey: randomUUID(), visitId: guest.visitId, lines: [{ itemId: juiceId, quantity: 1 }], expectedTotal: JUICE.price });
      await page.getByTestId('dining-find').click();
      const again = pending.getByTestId(`dining-pending-${JUICE.name}`);
      await again.getByRole('button', { name: '改', exact: true }).click();
      const v3 = page.getByRole('dialog').filter({ hasText: `改单 · ${JUICE.name}` });
      await page.route('**/api/frontdesk/lines/*/void', async (route) => {
        await route.fetch();
        await route.abort('failed');
      }, { times: 1 });
      await v3.getByTestId('dish-void-confirm').click();
      await expect(v3).toContainText('可能已经生效');
      await v3.getByTestId('dish-void-confirm').click();
      await expect(page.getByText(`${JUICE.name} 已退，放回了购物车`)).toBeVisible();
      await expect(page.getByTestId('dining-cart')).toContainText(JUICE.name);

      // ④ 退菜记录：两条，分别是「小额直接退」「当场授权（张经理）」
      await page.getByTestId('dining-tab-voids').click();
      const voids = page.getByTestId('dining-voids');
      await expect(voids.locator('tr').filter({ hasText: JUICE.name }).first()).toContainText('小额直接退');
      await expect(voids.locator('tr').filter({ hasText: SEAFOOD.name }).first()).toContainText('当场授权（');
      await expect(voids.locator('tr').filter({ hasText: SEAFOOD.name }).first()).toContainText('E2E 等太久不要了');

      // ⑤ 台账：只看这一类，退了的标「已退」；导出与页面同样的条件、最后一行是合计
      await page.getByTestId('dining-tab-ledger').click();
      const ledger = page.getByTestId('dining-ledger');
      await ledger.getByTestId(`dining-ledger-cat-${JUICE.category}`).click();
      await expect(ledger.locator('tbody tr').first()).toContainText(JUICE.name);
      await expect(ledger.locator('tbody tr').filter({ hasText: SEAFOOD.name })).toHaveCount(0);
      await expect(ledger.locator('tbody tr').filter({ hasText: JUICE.name }).first()).toContainText('已退');
      const today = (await getJson<{ today: string }>(page, '/api/business-day')).today;
      const csv = await page.request.get(`/api/dining/ledger/export?from=${today}&to=${today}&status=all&categories=${encodeURIComponent(JUICE.category)}`);
      expect(csv.ok()).toBe(true);
      const rows = (await csv.text()).replace(/^﻿/, '').trim().split(/\r?\n/);
      expect(rows.at(-1)!.startsWith('合计')).toBe(true);
      expect(rows.slice(1, -1).every((r) => r.includes(JUICE.category))).toBe(true);

      await relogin(page, 'linlan');
      await clearVisit(page, guest.visitId, 'E2E：收尾');
    } finally {
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      const res = await page.request.put('/api/admin/dining/rules', { data: { enabled: false, tablesEnabled: false, voidFreeCents: 5000 } });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });

  test('客房：改房态先确认、写备注 → 撤回上一次修改 → 房间详情里有两条房态记录（B04、B07）', async ({ page }) => {
    const TYPE = { name: 'E2E 808 大床房', kind: 'daily', price: 32800, blockMinutes: null };
    const ROOM = 'E2E8-01';
    const RULES = { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 };
    await login(page, 'linlan');
    try {
      let admin = await getJson<RoomsAdmin>(page, '/api/admin/rooms');
      const t = admin.types.find((x) => x.name === TYPE.name);
      if (!t) admin = await send<RoomsAdmin>(page, 'post', '/api/admin/rooms/types', { ...TYPE, sortOrder: 9100 });
      else if (!t.active) admin = await send<RoomsAdmin>(page, 'put', `/api/admin/rooms/types/${t.id}`, { ...TYPE, sortOrder: 9100, active: true });
      const typeId = admin.types.find((x) => x.name === TYPE.name)!.id;
      const r = admin.rooms.find((x) => x.roomNo === ROOM);
      if (!r) admin = await send<RoomsAdmin>(page, 'post', '/api/admin/rooms/rooms', { roomNo: ROOM, floor: 'E2E8', roomTypeId: typeId });
      else if (!r.active) admin = await send<RoomsAdmin>(page, 'put', `/api/admin/rooms/rooms/${r.id}`, { roomNo: ROOM, floor: 'E2E8', roomTypeId: typeId, sortOrder: 0, active: true });
      await send(page, 'put', '/api/admin/rooms/rules', RULES);
      const tile = (await getJson<RoomBoard>(page, '/api/rooms')).rooms.find((x) => x.roomNo === ROOM)!;
      if (tile.status !== 'vacant') await send(page, 'put', `/api/rooms/${tile.id}/housekeeping`, { status: 'clean' });
      await relogin(page, 'xiaozhou');

      // ① 空闲的房：入住对话框左下角「改房态」→ 选待打扫、写备注 → 确认「从哪到哪」→ 看板马上变
      await page.goto('/rooms');
      await page.getByTestId(`room-tile-${ROOM}`).click();
      await page.getByRole('dialog').filter({ hasText: `入住 · ${ROOM}` }).getByTestId('room-checkin-housekeep').click();
      const hk = page.getByRole('dialog').filter({ hasText: `改房态 · ${ROOM}` });
      await hk.getByRole('radio', { name: '待打扫' }).click();
      await hk.getByTestId('room-maintenance-note').fill('E2E 换床品');
      await hk.getByTestId('room-housekeeping-save').click();
      await expect(hk.getByTestId('room-housekeeping-review')).toContainText(`${ROOM}：已打扫（空闲） → 待打扫`);
      await expect(hk.getByTestId('room-housekeeping-review')).toContainText('E2E 换床品');
      await hk.getByTestId('room-housekeeping-confirm').click();
      await expect(page.getByTestId(`room-tile-${ROOM}`)).toHaveAttribute('data-state', 'dirty');

      // ② 改错了：撤回上一次修改 → 回到空闲
      await page.getByTestId(`room-tile-${ROOM}`).click();
      const hk2 = page.getByRole('dialog').filter({ hasText: `改房态 · ${ROOM}` });
      await expect(hk2.getByTestId('room-housekeeping-last')).toContainText('E2E 换床品');
      await hk2.getByTestId('room-housekeeping-revert').click();
      await hk2.getByTestId('room-housekeeping-revert-confirm').click();
      await expect(page.getByText(`${ROOM} 已撤回到「已打扫」`)).toBeVisible();
      await expect(page.getByTestId(`room-tile-${ROOM}`)).toHaveAttribute('data-state', 'vacant');

      // ③ 房间详情：房态记录有这两条（最新的在上面），撤回过的那条标「已撤回」
      await page.getByTestId('rooms-detail').click();
      const detail = page.getByTestId('room-detail');
      await detail.getByTestId('room-detail-room').selectOption({ label: `${ROOM} · ${TYPE.name}` });
      await detail.getByTestId('room-detail-filter-housekeeping').click();
      const entries = detail.locator('[data-testid^="room-detail-entry-hk-"]');
      await expect(entries.first()).toContainText('待打扫 → 已打扫');
      await expect(entries.first()).toContainText('撤回');
      await expect(entries.nth(1)).toContainText('已打扫 → 待打扫');
      await expect(entries.nth(1)).toContainText('已撤回');
      await expect(entries.nth(1)).toContainText('E2E 换床品');
    } finally {
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      const res = await page.request.put('/api/admin/rooms/rules', { data: { ...RULES, enabled: false } });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });

  test('后台新建项目：名称或分类含「护理」默认「需要技师」，手动改成「不需要」照样按选的保存（A01，Codex 审查 f14210c）', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/admin/catalog');
    // 只核对表单发出去的内容：拦下保存请求，不往演示库里写
    const sent: { name: string; technicianRequired: boolean }[] = [];
    await page.route('**/api/items', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      sent.push(route.request().postDataJSON() as { name: string; technicianRequired: boolean });
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'E2E_STOP', message: '浏览器用例拦下，不保存' } }) });
    });
    await page.getByRole('button', { name: '新增项目' }).click();
    const dialog = page.getByRole('dialog');
    const needs = dialog.getByRole('radiogroup', { name: '需要技师' });
    // 名称还没写：默认不需要
    await expect(needs.getByRole('radio', { name: '不需要' })).toHaveAttribute('aria-checked', 'true');
    await dialog.locator('#c-name').fill('E2E 808 头部护理');
    await expect(needs.getByRole('radio', { name: '需要技师' })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog).toContainText('名称或分类含「护理」，默认需要技师');
    await dialog.getByLabel('标准价').fill('128');
    await dialog.getByTestId('item-save').click();
    await expect(dialog).toContainText('浏览器用例拦下，不保存');
    expect(sent.at(-1)).toMatchObject({ name: 'E2E 808 头部护理', technicianRequired: true });
    // 手动改成「不需要」：照选的发出去，改名也不再跟着变
    await needs.getByRole('radio', { name: '不需要' }).click();
    await dialog.locator('#c-name').fill('E2E 808 足部护理');
    await expect(needs.getByRole('radio', { name: '不需要' })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByTestId('item-save').click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent.at(-1)).toMatchObject({ name: 'E2E 808 足部护理', technicianRequired: false });
    await page.unroute('**/api/items');
  });
});
