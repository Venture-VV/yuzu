// v0.7.16 房态图浏览器验收（飞书需求 RQ-004 第三段，docs/ROOMMAP.md）。
//   ① 门店电脑（写数据，只跑一次）：样例空间台账（docs/data 的合成样例）+ 样例底图启用 + W301 挂客房房间 →
//      钟房派钟选房间 T301 → 「客房 → 平面图」：各空间的状态色与图例、技师房的钟、业态筛选、搜索定位、缩放 →
//      点 W301 开房 → 在住 → 查房 → 退房 → 待打扫 → 打扫好了 → 空闲；钟房换房间到 T302，平面图跟着变。
//      结束时收掉这次的钟单与客人、W301 取消挂接、停用 W301 / W302（台账里没有在用的「客房」时新建房间不要求选空间）、关闭客房与技师功能。
//   ② 各尺寸（只读，接口用合成数据代替）：单层 300 个空间 2 秒内画完；滚轮、按钮缩放，拖动平移；点房间出侧栏；不出现横向滚动。
// 依赖演示数据（仅独立演示库）；账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。全部是合成数据。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';
import type { ClockroomBoard } from '../src/shared/clockroom';
import type { ActiveFloorplan, FloorplanDetail } from '../src/shared/floorplans';
import type { FloorMapData, FloorMapSpace } from '../src/shared/floormap';
import type { RoomBoard, RoomBoardRoom, RoomsAdmin, StayDetail } from '../src/shared/rooms';
import type { SpaceLedger } from '../src/shared/spaces';
import { floorplanSampleDxf } from '../src/server/demo/floorplan-sample';
import { ensureShift } from './shift';

const PASSWORD = 'yuzu2026';
const ITEM = 'E2E 平面图足疗';
const TECH = { techNo: 'E7', name: 'E2E 小平', gender: 'female', grade: 'standard' } as const;
const ROOM_TYPE = 'E2E 平面图大床房';
const RULES = { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 };

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
const csvOf = (file: string) => readFileSync(new URL(`../docs/data/${file}`, import.meta.url), 'utf8').replace(/^﻿/, '');

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number } | null;
}

/** 空间编辑的请求体：读到的字段与版本号，再改 patch 里的 */
const spaceBody = (s: SpaceLedger['spaces'][number], patch: Record<string, unknown> = {}) => ({
  floorId: s.floorId,
  zoneId: s.zoneId,
  businessType: s.businessType,
  capacity: s.capacity,
  areaCentiM2: s.areaCentiM2,
  displayName: s.displayName,
  nameEn: s.nameEn,
  sellable: s.sellable,
  sourceLabel: s.sourceLabel,
  note: s.note,
  active: s.active,
  version: s.version,
  ...patch,
});

/** 店主：样例空间台账、样例底图（在用）、W301 挂房间、客房与技师功能、专用项目与技师；返回这次接待的客人 */
async function prepare(page: Page) {
  // 样例台账（合成）：没有就导入；W301、W302 上次收尾时停用了，这里启用
  let ledger = await getJson<SpaceLedger>(page, '/api/admin/spaces');
  if (!ledger.zones.some((z) => z.name === '样例SPA区')) {
    await send(page, 'post', '/api/admin/spaces/imports', { kind: 'zones', fileName: 'space-zones-sample.csv', csv: csvOf('space-zones-sample.csv'), encoding: 'UTF-8', clientKey: randomUUID() });
  }
  if (!ledger.spaces.some((s) => s.code === 'T301')) {
    await send(page, 'post', '/api/admin/spaces/imports', { kind: 'spaces', fileName: 'space-ledger-sample.csv', csv: csvOf('space-ledger-sample.csv'), encoding: 'UTF-8', clientKey: randomUUID() });
  }
  ledger = await getJson<SpaceLedger>(page, '/api/admin/spaces');
  for (const code of ['T301', 'T302', 'V312', 'W301', 'W302', 'X201']) {
    const s = ledger.spaces.find((x) => x.code === code)!;
    if (!s.active || !s.sellable) await send(page, 'put', `/api/admin/spaces/${s.id}`, spaceBody(s, { active: true, sellable: true }));
  }
  ledger = await getJson<SpaceLedger>(page, '/api/admin/spaces');
  const w301 = ledger.spaces.find((x) => x.code === 'W301')!;

  // 样例底图：在用的那一批没有样例编码时上传第一版（带时间戳，摘要不同）、转换完启用
  const active = await getJson<ActiveFloorplan>(page, '/api/floorplans/active');
  if (!active.rooms.some((r) => r.code === 'T301')) {
    const dxf = Buffer.from(`999\nE2E 平面图 ${Date.now()}\n${floorplanSampleDxf(1)}`, 'utf8');
    const up = await send<FloorplanDetail>(page, 'post', '/api/admin/floorplans', { fileName: 'E2E 平面图样例.dxf', contentBase64: dxf.toString('base64'), note: 'E2E 房态图' });
    await expect.poll(async () => (await getJson<FloorplanDetail>(page, `/api/admin/floorplans/${up.batch.id}`)).batch.status, { timeout: 60_000 }).toBe('ready');
    await send(page, 'post', `/api/admin/floorplans/${up.batch.id}/activate`, { expectedActiveId: active.batchId });
  }

  // 客房：开启；专用房型；W301 挂一间房（上次收尾取消挂接、停用的那一间重新挂上）
  await send(page, 'put', '/api/admin/rooms/rules', RULES);
  let admin = await getJson<RoomsAdmin>(page, '/api/admin/rooms');
  if (!admin.types.some((t) => t.name === ROOM_TYPE)) admin = await send<RoomsAdmin>(page, 'post', '/api/admin/rooms/types', { name: ROOM_TYPE, kind: 'daily', price: 26800 });
  const type = admin.types.find((t) => t.name === ROOM_TYPE)!;
  const linked = admin.rooms.find((r) => r.spaceCode === 'W301');
  const old = admin.rooms.find((r) => r.roomNo === 'E2E-W301');
  if (!linked) {
    const body = { roomNo: '', floor: '3', roomTypeId: type.id, sortOrder: 0, active: true, spaceId: w301.id, linkReason: 'E2E 房态图重新挂上' };
    admin = old ? await send<RoomsAdmin>(page, 'put', `/api/admin/rooms/rooms/${old.id}`, body) : await send<RoomsAdmin>(page, 'post', '/api/admin/rooms/rooms', body);
  }
  const room = admin.rooms.find((r) => r.spaceCode === 'W301')!;
  // 上次中断留下的入住、房态
  const tile = (await getJson<RoomBoard>(page, '/api/rooms')).rooms.find((r) => r.id === room.id)!;
  if (tile.stay) await clearStay(page, tile.stay.id, 'E2E：收掉上次留下的');
  const after = (await getJson<RoomBoard>(page, '/api/rooms')).rooms.find((r) => r.id === room.id)!;
  if (after.status !== 'vacant') await send(page, 'put', `/api/rooms/${room.id}/housekeeping`, { status: 'clean' });

  // 技师：专用项目、E7 号技师，开启技师功能
  let item = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items.find((i) => i.name === ITEM);
  const itemBody = { name: ITEM, category: 'E2E 技师', price: 16800, durationMinutes: 60 };
  if (!item || !item.active) {
    await (item ? send(page, 'put', `/api/items/${item.id}`, { ...itemBody, active: true }) : send(page, 'post', '/api/items', itemBody));
    item = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items.find((i) => i.name === ITEM)!;
  }
  await send(page, 'put', '/api/admin/technicians/items', { items: [{ id: item.id, required: true }] });
  const roster = (await getJson<{ technicians: { id: number; techNo: string; name: string; gender: string; active: boolean }[] }>(page, '/api/admin/technicians')).technicians;
  const t = roster.find((x) => x.techNo === TECH.techNo);
  if (!t) await send(page, 'post', '/api/admin/technicians', TECH);
  else if (!t.active) await send(page, 'put', `/api/admin/technicians/${t.id}`, { name: t.name, gender: t.gender, grade: TECH.grade, skills: [], active: true });
  // 只开技师功能，其余技师规则（价格跟等级等）不动，免得影响之后的技师、钟房用例
  await send(page, 'put', '/api/admin/technicians/rules', { enabled: true });
  return { roomId: room.id };
}

/** 收掉一张入住单（店主）：作废房费、退押金后撤销入住 */
async function clearStay(page: Page, stayId: number, reason: string) {
  const s = await getJson<StayDetail>(page, `/api/rooms/stays/${stayId}`);
  if (s.status !== 'open') return;
  for (const c of s.charges.filter((x) => x.lineStatus === 'active')) await send(page, 'post', `/api/frontdesk/lines/${c.lineId}/void`, { reason });
  if (s.depositBalance > 0) await ensureShift(page);
  for (const m of s.depositByMethod.filter((x) => x.balance > 0)) await send(page, 'post', `/api/rooms/stays/${s.id}/refunds`, { clientKey: randomUUID(), method: m.method, amount: m.balance, reason });
  await send(page, 'post', `/api/rooms/stays/${s.id}/cancel`, { reason });
}

/** 收掉洗浴客人的来访（店主）：作废有效明细（钟单跟着取消）后撤销 */
async function clearVisit(page: Page, visitId: number, reason: string) {
  const v = await getJson<{ status: string; lines: { id: number; status: string }[] }>(page, `/api/frontdesk/visits/${visitId}`);
  if (v.status !== 'open') return;
  for (const l of v.lines.filter((x) => x.status === 'active')) await send(page, 'post', `/api/frontdesk/lines/${l.id}/void`, { reason });
  await send(page, 'post', `/api/frontdesk/visits/${visitId}/cancel`, { reason });
}

/** 收尾（店主）：E7 下牌（不留在轮钟队列里）；W301 的房间取消挂接、停用；W301、W302 停用；关闭客房与技师功能 */
async function cleanup(page: Page) {
  const board = await page.request.get('/api/clockroom');
  const e7 = board.ok() ? ((await board.json()) as ClockroomBoard).technicians.find((t) => t.techNo === TECH.techNo) : undefined;
  if (e7 && e7.state !== 'off') await send(page, 'post', `/api/clockroom/technicians/${e7.id}/state`, { action: 'sign_out' });
  const admin = await getJson<RoomsAdmin>(page, '/api/admin/rooms');
  const room = admin.rooms.find((r) => r.spaceCode === 'W301');
  if (room) {
    const tile = (await getJson<RoomBoard>(page, '/api/rooms')).rooms.find((r) => r.id === room.id);
    if (tile?.stay) await clearStay(page, tile.stay.id, 'E2E：收尾');
    await send(page, 'put', `/api/admin/rooms/rooms/${room.id}`, { roomNo: 'E2E-W301', floor: room.floor, roomTypeId: room.roomTypeId, sortOrder: room.sortOrder, active: false, spaceId: null, linkReason: 'E2E 房态图收尾' });
  }
  const ledger = await getJson<SpaceLedger>(page, '/api/admin/spaces');
  for (const code of ['W301', 'W302']) {
    const s = ledger.spaces.find((x) => x.code === code);
    if (s?.active) await send(page, 'put', `/api/admin/spaces/${s.id}`, spaceBody(s, { active: false }));
  }
  for (const [url, data] of [
    ['/api/admin/rooms/rules', { ...RULES, enabled: false }],
    ['/api/admin/technicians/rules', { enabled: false }],
  ] as const) {
    const res = await page.request.put(url, { data });
    expect(res.ok(), await res.text()).toBe(true);
  }
}

const space = (page: Page, code: string) => page.getByTestId(`map-space-${code}`);

test.describe('v0.7.16 房态图', () => {
  test('派钟选房间 → 平面图状态色与图例、筛选、搜索、缩放 → 点房间开房、查房、退房、打扫 → 钟房换房间', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑尺寸执行一次');
    test.setTimeout(240_000);
    let visit: number | null = null;
    await login(page, 'linlan');
    try {
      const { roomId } = await prepare(page);
      await relogin(page, 'xiaozhou');
      await ensureShift(page);
      // 前台：E7 上牌；接待一位女宾
      const board0 = await getJson<ClockroomBoard>(page, '/api/clockroom');
      const e7 = board0.technicians.find((t) => t.techNo === TECH.techNo)!;
      for (const s of board0.sessions.filter((x) => x.technicianId === e7.id)) await send(page, 'post', `/api/clockroom/sessions/${s.id}/void`, { reason: 'E2E：上一轮没走完' });
      if (e7.state === 'off') await send(page, 'post', `/api/clockroom/technicians/${e7.id}/state`, { action: 'sign_in' });
      if (e7.state === 'rest') await send(page, 'post', `/api/clockroom/technicians/${e7.id}/state`, { action: 'back' });
      const tags = await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board');
      const tag = tags.tags.filter((t) => t.zone === 'female' && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse()[0]!;
      await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'female', guestLabel: 'E2E 平面图客人' }] });
      visit = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag)!.visit!.id;

      // ① 钟房派点钟给 E7，选房间 T301（列表按楼层分组、写占用）
      await page.goto('/clockroom');
      await page.getByTestId('clock-dispatch').click();
      const dispatch = page.getByRole('dialog', { name: '派钟' });
      await dispatch.getByTestId('dispatch-tag').fill(tag);
      await dispatch.getByTestId(`dispatch-item-${ITEM}`).click();
      await dispatch.getByRole('radiogroup', { name: '上钟方式' }).getByRole('radio', { name: '点钟' }).click();
      await dispatch.getByTestId(`dispatch-tech-${TECH.techNo}`).click();
      const roomSelect = dispatch.getByTestId('dispatch-room');
      await expect(roomSelect.locator('option', { hasText: 'T301 · 样例 SPA 1人间 · 空闲' })).toHaveCount(1);
      await expect(roomSelect.locator('option', { hasText: 'W301' })).toHaveCount(0);
      await roomSelect.selectOption({ label: 'T301 · 样例 SPA 1人间 · 空闲' });
      await dispatch.getByTestId('dispatch-submit').click();
      await expect(dispatch).toBeHidden();
      const serving = page.getByTestId(/^clock-serving-/).filter({ hasText: tag });
      await expect(serving.getByTestId(/^clock-room-/)).toHaveText('T301 · 样例 SPA 1人间');

      // ② 客房 → 平面图：默认编码最多的 L3；状态色与图例一致
      await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '客房' }).click();
      await page.getByRole('radiogroup', { name: '视图' }).getByRole('radio', { name: '平面图' }).click();
      await expect(page).toHaveURL(/view=map/);
      const map = page.getByTestId('floormap');
      await expect(map.getByRole('radiogroup', { name: '楼层' }).getByRole('radio', { name: 'L3 三层平面图' })).toHaveAttribute('aria-checked', 'true');
      await expect(space(page, 'T301')).toHaveAttribute('data-state', 'serving');
      await expect(space(page, 'T301')).toContainText('1/1');
      await expect(space(page, 'T302')).toHaveAttribute('data-state', 'vacant');
      await expect(space(page, 'V312')).toHaveAttribute('data-state', 'vacant');
      await expect(space(page, 'W301')).toHaveAttribute('data-state', 'vacant');
      await expect(space(page, 'W302')).toHaveAttribute('data-state', 'unlinked');
      await expect(space(page, 'T303')).toHaveAttribute('data-state', 'missing');
      const legend = page.getByTestId('floormap-legend');
      for (const label of ['空闲', '在住', '待上钟', '服务中', '待打扫', '维修', '未挂接', '其他业态', '停用 / 不可售', '台账里没有']) await expect(legend).toContainText(label);
      await expect(page.getByTestId('floormap-legend-serving')).toContainText('1');
      // 台账里有、图上没有：U310
      await expect(page.getByTestId('floormap-off-drawing')).toContainText('U310');
      // 底图是在用那一批的 SVG
      const href = await page.getByTestId('floormap-canvas').locator('image').getAttribute('href');
      expect((await page.request.get(href!)).headers()['content-type']).toContain('image/svg+xml');

      // ③ 技师房：点开看这间房里的钟，链到钟房
      await space(page, 'T301').click();
      const panel = page.getByTestId('floormap-panel');
      await expect(panel).toHaveAttribute('data-code', 'T301');
      await expect(panel.getByTestId('floormap-sessions')).toContainText(TECH.techNo);
      await expect(panel.getByTestId('floormap-sessions')).toContainText(tag);
      await expect(panel.getByTestId('floormap-to-clockroom')).toBeVisible();

      // ④ 业态筛选、只看空闲、搜索定位、缩放
      await page.getByTestId('floormap-type-客房').click();
      await expect(space(page, 'T301')).toHaveAttribute('data-dim', 'true');
      await expect(space(page, 'W301')).toHaveAttribute('data-dim', 'false');
      await page.getByTestId('floormap-type-客房').click();
      await page.getByTestId('floormap-vacant-only').check();
      await expect(space(page, 'T301')).toHaveAttribute('data-dim', 'true');
      await expect(space(page, 'V312')).toHaveAttribute('data-dim', 'false');
      await page.getByTestId('floormap-vacant-only').uncheck();
      await page.getByTestId('floormap-search').fill('样例足浴');
      await page.getByTestId('floormap-search').press('Enter');
      await expect(panel).toHaveAttribute('data-code', 'V312');
      await expect(page.getByTestId('floormap-zoom')).not.toHaveAttribute('data-zoom', '1.00');
      await page.getByTestId('floormap-fit').click();
      await expect(page.getByTestId('floormap-zoom')).toHaveAttribute('data-zoom', '1.00');
      await page.getByTestId('floormap-zoom-in').click();
      await expect(page.getByTestId('floormap-zoom')).toHaveAttribute('data-zoom', '1.50');
      await page.getByTestId('floormap-fit').click();
      await page.getByTestId('floormap-search').fill('');
      // 二层：派对房只显示业态
      await map.getByRole('radiogroup', { name: '楼层' }).getByRole('radio', { name: 'L2 二层平面图' }).click();
      await expect(space(page, 'X201')).toHaveAttribute('data-state', 'other');
      await space(page, 'X201').click();
      await expect(panel).toContainText('派对房');
      await map.getByRole('radiogroup', { name: '楼层' }).getByRole('radio', { name: 'L3 三层平面图' }).click();

      // ⑤ 客房 W301：开房（原来的入住对话框）→ 在住 → 查房 → 退房 → 待打扫 → 打扫好了 → 空闲
      await space(page, 'W301').click();
      await expect(panel).toHaveAttribute('data-state', 'vacant');
      await panel.getByTestId('floormap-checkin').click();
      const checkin = page.getByRole('dialog').filter({ hasText: '入住 · W301' });
      await checkin.getByTestId('room-checkin-tag').fill(tag);
      await checkin.getByTestId('room-checkin-submit').click();
      await expect(page.getByText('W301 已入住')).toBeVisible();
      await expect(page.getByTestId('stay-detail')).toContainText(`手牌 ${tag}`);
      await page.keyboard.press('Escape');
      await expect(space(page, 'W301')).toHaveAttribute('data-state', 'occupied');
      await expect(panel.getByTestId('floormap-stay-info')).toContainText(tag);
      await panel.getByTestId('floormap-stay').click();
      await expect(page.getByTestId('stay-detail')).toContainText(`手牌 ${tag}`);
      await page.keyboard.press('Escape');
      await panel.getByTestId('floormap-close').click();
      const close = page.getByRole('dialog').filter({ hasText: '退房 · W301' });
      await expect(close.getByTestId('stay-close-review')).toBeVisible();
      await close.getByTestId('stay-close-submit').click();
      await expect(page.getByText('W301 已退房')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(space(page, 'W301')).toHaveAttribute('data-state', 'dirty');
      await expect(panel).toHaveAttribute('data-state', 'dirty');
      await panel.getByTestId('floormap-housekeep').click();
      const hk = page.getByRole('dialog').filter({ hasText: '改房态 · W301' });
      await hk.getByRole('radio', { name: '已打扫（空闲）' }).click();
      await hk.getByTestId('room-housekeeping-save').click();
      await expect(space(page, 'W301')).toHaveAttribute('data-state', 'vacant');
      expect((await getJson<RoomBoard>(page, '/api/rooms')).rooms.find((r) => r.id === roomId)!.status).toBe('vacant');

      // ⑥ 钟房换房间：T301 → T302；平面图 5 秒内跟着变（不刷新页面）
      const rooms = page.url();
      await page.goto('/clockroom');
      await page.getByTestId(/^clock-serving-/).filter({ hasText: tag }).getByTestId(/^clock-room-/).click();
      const roomDialog = page.getByRole('dialog').filter({ hasText: '换房间' });
      await roomDialog.getByTestId('room-dialog-select').selectOption({ label: 'T302 · 样例 SPA 2人间 · 空闲' });
      await roomDialog.getByTestId('room-dialog-save').click();
      await expect(page.getByTestId(/^clock-serving-/).filter({ hasText: tag }).getByTestId(/^clock-room-/)).toHaveText('T302 · 样例 SPA 2人间');
      await page.goto(rooms);
      await expect(space(page, 'T302')).toHaveAttribute('data-state', 'serving');
      await expect(space(page, 'T302')).toContainText('1/2');
      await expect(space(page, 'T301')).toHaveAttribute('data-state', 'vacant');
      // 下钟后 5 秒内变回空闲
      const s = (await getJson<ClockroomBoard>(page, '/api/clockroom')).sessions.find((x) => x.visitId === visit)!;
      await send(page, 'post', `/api/clockroom/sessions/${s.id}/finish`);
      await expect(space(page, 'T302')).toHaveAttribute('data-state', 'vacant', { timeout: 12_000 });
      const events = await getJson<{ kind: string; text: string }[]>(page, '/api/clockroom/events');
      expect(events.find((e) => e.kind === 'room')!.text).toBe('房间 T301 · 样例 SPA 1人间 → T302 · 样例 SPA 2人间');
    } finally {
      await relogin(page, 'linlan');
      if (visit !== null) await clearVisit(page, visit, 'E2E：收尾');
      await cleanup(page);
    }
  });
});

// ───────────────────────── 各尺寸：合成的 300 个空间（接口用合成数据代替，只读） ─────────────────────────

const COLS = 20;
const ROWS = 15;
const CELL = { w: 600, h: 400, gap: 60 };
const W = COLS * (CELL.w + CELL.gap) + CELL.gap;
const H = ROWS * (CELL.h + CELL.gap) + CELL.gap;
const codeOf = (i: number) => `Z3${String(i + 1).padStart(3, '0')}`;
const TYPES = ['客房', 'SPA', '足浴', '按摩', '派对房'] as const;

function synthetic() {
  const now = new Date().toISOString();
  const spaces: FloorMapSpace[] = [];
  const rooms: RoomBoardRoom[] = [];
  const planRooms: ActiveFloorplan['rooms'] = [];
  const sessions: FloorMapData['sessions'] = [];
  for (let i = 0; i < COLS * ROWS; i += 1) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = CELL.gap + col * (CELL.w + CELL.gap);
    const y = CELL.gap + row * (CELL.h + CELL.gap);
    const code = codeOf(i);
    const businessType = TYPES[i % TYPES.length]!;
    spaces.push({ id: i + 1, code, floorCode: 'L3', floorName: '三层', zoneName: null, businessType, capacity: businessType === '足浴' ? 4 : 1, areaCentiM2: 2400, displayName: `合成${businessType}${i + 1}`, sellable: true, active: i % 37 !== 0, aliases: [], roomId: businessType === '客房' ? 1000 + i : null });
    planRooms.push({ floorCode: 'L3', code, label: `合成 ${code}`, status: 'ok', mergedWith: [], closeMm: 600, polygon: [[x, y], [x + CELL.w, y], [x + CELL.w, y + CELL.h], [x, y + CELL.h]], labelAt: [x + CELL.w / 2, y + CELL.h / 2], areaM2: 24, spaceId: i + 1, displayName: `合成${businessType}${i + 1}` });
    if (businessType === '客房') {
      const status = (['vacant', 'occupied', 'dirty', 'maintenance'] as const)[Math.floor(i / 5) % 4]!;
      rooms.push({ id: 1000 + i, roomNo: code, spaceName: `合成客房${i + 1}`, spaceId: i + 1, floor: '3', typeName: '合成大床房', kind: 'daily', price: 28800, blockMinutes: null, status, maintenanceNote: null, stay: null });
    }
    if ((businessType === 'SPA' || businessType === '足浴') && i % 3 === 0) {
      sessions.push({ id: i + 1, sessionNo: `ZD${i}`, spaceId: i + 1, techNo: String(i), techName: `合成技师${i}`, tagCode: `A${i}`, itemName: '合成项目', clocks: 1, minutes: 60, status: i % 2 ? 'serving' : 'waiting', createdAt: now, startedAt: i % 2 ? now : null, plannedEnd: null });
    }
  }
  const lines: string[] = [];
  for (let c = 0; c <= COLS; c += 1) lines.push(`<path d="M${c * (CELL.w + CELL.gap) + CELL.gap / 2} 0V${H}"/>`);
  for (let r = 0; r <= ROWS; r += 1) lines.push(`<path d="M0 ${r * (CELL.h + CELL.gap) + CELL.gap / 2}H${W}"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><g fill="none" stroke="#333" stroke-width="12">${lines.join('')}</g></svg>`;
  const plan: ActiveFloorplan = { batchId: 900001, activatedAt: now, floors: [{ code: 'L3', title: '三层', width: W, height: H, svgBytes: svg.length, pathCount: lines.length, svgUrl: '/api/floorplans/900001/floors/L3/svg' }], rooms: planRooms };
  const fm: FloorMapData = { serverTime: now, floorplanBatchId: 900001, spaces, sessions };
  const board: RoomBoard = {
    rules: { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 } as RoomBoard['rules'],
    rooms,
    audit: { date: now.slice(0, 10), done: false, runAt: null, runByName: null, pending: 0, allowed: false },
    counts: { vacant: 0, occupied: 0, dirty: 0, maintenance: 0 },
  };
  return { plan, fm, board, svg };
}

async function mockMap(page: Page) {
  const data = synthetic();
  const json = (body: unknown) => (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  // 会话：只把「客房功能开启」改成开着，其余照服务端
  await page.route('**/api/auth/me', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), rooms: true } });
  });
  await page.route('**/api/rooms', json(data.board));
  await page.route('**/api/floormap', json(data.fm));
  await page.route('**/api/floorplans/active', json(data.plan));
  await page.route('**/api/floorplans/900001/floors/L3/svg', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: data.svg }));
  return data;
}

test.describe('v0.7.16 房态图 · 各尺寸', () => {
  test('单层 300 个空间 2 秒内画完；缩放平移；点房间出侧栏；不横向滚动', async ({ page }) => {
    await login(page, 'xiaozhou');
    await mockMap(page);
    await page.goto('/rooms');
    await expect(page.getByRole('radiogroup', { name: '视图' })).toBeVisible();
    const t0 = Date.now();
    await page.getByRole('radiogroup', { name: '视图' }).getByRole('radio', { name: '平面图' }).click();
    await expect(page.locator('[data-testid^="map-space-"]')).toHaveCount(COLS * ROWS);
    await expect(page.getByTestId('floormap-legend')).toBeVisible();
    const elapsed = Date.now() - t0;
    test.info().annotations.push({ type: '300 个空间首屏', description: `${elapsed} ms` });
    expect(elapsed).toBeLessThan(2000);
    // 着色：客房按看板、技师房按钟单（服务中优先）、停用灰色、其他业态
    await expect(space(page, codeOf(5))).toHaveAttribute('data-state', 'occupied');
    await expect(space(page, codeOf(10))).toHaveAttribute('data-state', 'dirty');
    await expect(space(page, codeOf(21))).toHaveAttribute('data-state', 'serving');
    await expect(space(page, codeOf(6))).toHaveAttribute('data-state', 'waiting');
    await expect(space(page, codeOf(1))).toHaveAttribute('data-state', 'vacant');
    await expect(space(page, codeOf(37))).toHaveAttribute('data-state', 'off');
    await expect(space(page, codeOf(4))).toHaveAttribute('data-state', 'other');

    // 页面不横向滚动
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    // 缩放：按钮、滚轮（以鼠标为中心）
    const zoom = page.getByTestId('floormap-zoom');
    await page.getByTestId('floormap-zoom-in').click();
    await expect(zoom).toHaveAttribute('data-zoom', '1.50');
    await page.getByTestId('floormap-fit').click();
    await expect(zoom).toHaveAttribute('data-zoom', '1.00');
    const box = (await page.getByTestId('floormap-canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -120);
    await expect.poll(async () => Number(await zoom.getAttribute('data-zoom'))).toBeGreaterThan(1.2);
    await page.getByTestId('floormap-fit').click();
    // 流畅：在页面里连续 30 帧，每帧一次滚轮缩放，平均每帧不超过 50 毫秒（300 个空间都在图上）
    const perFrame = await page.evaluate(async () => {
      const svg = document.querySelector('[data-testid="floormap-canvas"] svg')!;
      const r = svg.getBoundingClientRect();
      const frame = () => new Promise((done) => requestAnimationFrame(done));
      await frame();
      const t = performance.now();
      for (let i = 0; i < 30; i += 1) {
        svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true, cancelable: true }));
        await frame();
      }
      return (performance.now() - t) / 30;
    });
    test.info().annotations.push({ type: '滚轮缩放每帧', description: `${perFrame.toFixed(1)} ms` });
    expect(perFrame).toBeLessThan(50);
    await expect.poll(async () => Number(await zoom.getAttribute('data-zoom'))).toBeGreaterThan(3);
    // 拖动平移：底图跟着移动，松开后不算点击
    const before = await page.getByTestId('floormap-view').getAttribute('transform');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 6 });
    await page.mouse.up();
    expect(await page.getByTestId('floormap-view').getAttribute('transform')).not.toBe(before);
    await expect(page.getByTestId('floormap-panel')).toHaveCount(0);
    await page.getByTestId('floormap-fit').click();

    // 点房间出侧栏（窄屏在图下面）
    await space(page, codeOf(5)).click();
    const panel = page.getByTestId('floormap-panel');
    await expect(panel).toHaveAttribute('data-code', codeOf(5));
    await expect(panel).toContainText('在住');
    await panel.scrollIntoViewIfNeeded();
    await expect(panel).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
});
