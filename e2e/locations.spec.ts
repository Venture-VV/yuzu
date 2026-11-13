// v0.7.17 第一级实时位置浏览器验收（飞书需求 RQ-004，docs/ROOMMAP.md 第 3 节）。
//   ① 门店电脑（写数据，只跑一次）：样例空间台账与底图（docs/data 的合成样例）→ 后台「空间台账 → 实时位置」打开开关、
//      选接待区、登记刷卡点、设项目所在区域 → 前台发手牌（客人在接待区）→ 平面图区域人数、在场名单、轨迹 →
//      后台模拟刷卡（客人到刷卡点装的房间；结果不明时自动查回、按原内容重新提交、确认作废）→ 平面图房间人数、
//      房间侧栏「在这里」→ 挂账（客人到项目的区域）。
//      结束时撤销这位客人、关掉开关、停用这次的刷卡点、清掉项目的区域。
//   ② 各尺寸（只读，接口用合成数据代替）：人员图层与「在场」名单能看、点人出轨迹、不出现横向滚动。
// 依赖演示数据（仅独立演示库）；账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。全部是合成数据。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';
import type { ActiveFloorplan, FloorplanDetail } from '../src/shared/floorplans';
import type { FloorMapData, FloorMapSpace } from '../src/shared/floormap';
import type { LocationAdmin, LocationPerson, LocationsCurrent, LocationTrackData } from '../src/shared/locations';
import type { RoomBoard } from '../src/shared/rooms';
import type { SpaceLedger } from '../src/shared/spaces';
import { floorplanSampleDxf } from '../src/server/demo/floorplan-sample';

const PASSWORD = 'yuzu2026';
const READER = { code: 'E2E-R2', name: 'E2E 足浴门口' };
const ROOM_RULES = { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 };

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

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number } | null;
}

/** 店主：样例空间台账与底图；T301、T302 归「样例SPA区」，W301、W302 归「样例客房区」；返回两个区域的编号 */
async function prepare(page: Page) {
  let ledger = await getJson<SpaceLedger>(page, '/api/admin/spaces');
  if (!ledger.zones.some((z) => z.name === '样例SPA区')) {
    await send(page, 'post', '/api/admin/spaces/imports', { kind: 'zones', fileName: 'space-zones-sample.csv', csv: csvOf('space-zones-sample.csv'), encoding: 'UTF-8', clientKey: randomUUID() });
  }
  if (!ledger.spaces.some((s) => s.code === 'T301')) {
    await send(page, 'post', '/api/admin/spaces/imports', { kind: 'spaces', fileName: 'space-ledger-sample.csv', csv: csvOf('space-ledger-sample.csv'), encoding: 'UTF-8', clientKey: randomUUID() });
  }
  ledger = await getJson<SpaceLedger>(page, '/api/admin/spaces');
  const spa = ledger.zones.find((z) => z.name === '样例SPA区')!;
  const rooms = ledger.zones.find((z) => z.name === '样例客房区')!;
  for (const [code, zoneId] of [
    ['T301', spa.id],
    ['T302', spa.id],
    ['V312', null],
    ['W301', rooms.id],
    ['W302', rooms.id],
  ] as const) {
    const s = ledger.spaces.find((x) => x.code === code)!;
    const active = code === 'V312' || code.startsWith('T') ? true : s.active;
    if (s.zoneId !== zoneId || s.active !== active) await send(page, 'put', `/api/admin/spaces/${s.id}`, spaceBody(s, { zoneId, active, sellable: true }));
  }
  const plan = await getJson<ActiveFloorplan>(page, '/api/floorplans/active');
  if (!plan.rooms.some((r) => r.code === 'T301')) {
    const dxf = Buffer.from(`999\nE2E 实时位置 ${Date.now()}\n${floorplanSampleDxf(1)}`, 'utf8');
    const up = await send<FloorplanDetail>(page, 'post', '/api/admin/floorplans', {
      fileName: 'E2E 实时位置样例.dxf',
      contentBase64: dxf.toString('base64'),
      note: 'E2E 实时位置',
      sourceKind: 'other',
      receivedOn: new Date().toISOString().slice(0, 10),
    });
    await expect.poll(async () => (await getJson<FloorplanDetail>(page, `/api/admin/floorplans/${up.batch.id}`)).batch.status, { timeout: 60_000 }).toBe('ready');
    const plans = await getJson<{ activeId: number | null; activationSeq: number }>(page, '/api/admin/floorplans');
    await send(page, 'post', `/api/admin/floorplans/${up.batch.id}/activate`, { expectedActiveId: plans.activeId, expectedSeq: plans.activationSeq });
  }
  // 平面图在「客房」页：开启客房功能（收尾时关掉）
  await send(page, 'put', '/api/admin/rooms/rules', ROOM_RULES);
  return { spa: spa.id, rooms: rooms.id };
}

/** 收尾（店主）：撤销客人（作废明细后撤销来访）、关开关、停用这次的刷卡点、清掉项目的区域、关掉客房功能 */
async function cleanup(page: Page, visitId: number | null, itemId: number | null) {
  if (visitId !== null) {
    const v = await getJson<{ status: string; lines: { id: number; status: string }[] }>(page, `/api/frontdesk/visits/${visitId}`);
    if (v.status === 'open') {
      for (const l of v.lines.filter((x) => x.status === 'active')) await send(page, 'post', `/api/frontdesk/lines/${l.id}/void`, { reason: 'E2E：收尾' });
      await send(page, 'post', `/api/frontdesk/visits/${visitId}/cancel`, { reason: 'E2E：收尾' });
    }
  }
  const admin = await getJson<LocationAdmin>(page, '/api/admin/locations');
  for (const r of admin.readers.filter((x) => x.code.startsWith('E2E-') && x.active)) {
    await send(page, 'put', `/api/admin/locations/readers/${r.id}`, { code: r.code, name: r.name, zoneId: r.zoneId, spaceId: r.spaceId, note: r.note, active: false, expectedVersion: r.version });
  }
  if (itemId !== null) await send(page, 'put', '/api/admin/locations/items', { items: [{ id: itemId, zoneId: null }] });
  await send(page, 'put', '/api/admin/locations/rules', { enabled: false, checkinZoneId: null, restZoneId: null });
  await send(page, 'put', '/api/admin/rooms/rules', { ...ROOM_RULES, enabled: false });
}

test.describe('v0.7.17 第一级实时位置', () => {
  test('后台打开开关、登记刷卡点 → 发手牌在接待区 → 平面图人数、名单、轨迹 → 模拟刷卡到房间 → 挂账到项目的区域', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑尺寸执行一次');
    test.setTimeout(240_000);
    let visit: number | null = null;
    let itemId: number | null = null;
    await login(page, 'linlan');
    try {
      const zone = await prepare(page);

      // ① 后台「空间台账 → 实时位置」：打开开关、接待区选样例SPA区；登记刷卡点（装在 V312）；项目所在区域
      await page.goto('/admin/spaces');
      await page.getByTestId('subnav-locations').click();
      const rules = page.getByTestId('locations-rules');
      await rules.getByTestId('locations-enabled').check();
      await rules.getByTestId('locations-checkin-zone').selectOption({ label: '样例SPA区' });
      await rules.getByTestId('locations-rules-save').click();
      await expect(page.getByText('实时位置的设置已保存')).toBeVisible();
      const readers = page.getByTestId('locations-readers');
      if (!(await getJson<LocationAdmin>(page, '/api/admin/locations')).readers.some((r) => r.code === READER.code)) {
        await readers.getByTestId('reader-new').click();
        const dlg = page.getByRole('dialog', { name: '登记刷卡点' });
        await dlg.getByTestId('reader-code').fill(READER.code.toLowerCase());
        await dlg.getByTestId('reader-name').fill(READER.name);
        await dlg.getByRole('radiogroup', { name: '装在哪' }).getByRole('radio', { name: '空间' }).click();
        await dlg.getByTestId('reader-space').selectOption({ label: 'L3 V312 样例足浴 4人间' });
        await dlg.getByTestId('reader-save').click();
        await expect(dlg).toBeHidden();
      } else {
        // 上次收尾停用了：启用
        const r = (await getJson<LocationAdmin>(page, '/api/admin/locations')).readers.find((x) => x.code === READER.code)!;
        if (!r.active) await send(page, 'put', `/api/admin/locations/readers/${r.id}`, { code: r.code, name: r.name, zoneId: r.zoneId, spaceId: r.spaceId, note: r.note, active: true, expectedVersion: r.version });
        await page.reload();
        await page.getByTestId('subnav-locations').click();
      }
      await expect(readers.getByTestId(`reader-${READER.code}`)).toContainText('V312');
      // 项目所在区域：演示价目里第一个不要技师的项目 → 样例客房区
      const catalog = (await getJson<{ items: { id: number; name: string; active: boolean; price: number; technicianRequired?: boolean }[] }>(page, '/api/catalog')).items;
      const item = catalog.find((i) => i.active && !i.technicianRequired)!;
      itemId = item.id;
      const items = page.getByTestId('locations-items');
      await items.getByTestId(`item-zone-select-${item.name}`).selectOption({ label: '样例客房区' });
      await items.getByTestId('item-zones-save').click();
      await expect(page.getByText('已保存 1 个项目的区域')).toBeVisible();

      // ② 前台发手牌：客人在接待区（样例SPA区）
      await relogin(page, 'xiaozhou');
      const tags = await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board');
      const tag = tags.tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse()[0]!;
      await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', guestLabel: 'E2E 实时位置客人' }] });
      visit = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag)!.visit!.id;

      await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '客房' }).click();
      await page.getByRole('radiogroup', { name: '视图' }).getByRole('radio', { name: '平面图' }).click();
      await expect(page.getByTestId('floormap-show-people')).toBeChecked();
      const zoneBadge = page.getByTestId(`map-zone-${zone.spa}`);
      await expect(zoneBadge).toBeVisible();
      await expect(zoneBadge).toContainText('样例SPA区');
      const people = page.getByTestId('floormap-people');
      const me = people.getByTestId(`floormap-person-guest-${tag}`);
      await expect(me).toContainText(`手牌 ${tag}`);
      await expect(me).toContainText('发手牌');
      // 点区域人数：名单只看这个区域，图上描出这个区域
      await zoneBadge.click();
      await expect(people).toContainText('只看 样例SPA区');
      await people.getByTestId('floormap-people-clear-zone').click();
      // 轨迹
      await me.getByTestId('floormap-person-track').click();
      const track = page.getByTestId('track-dialog');
      await expect(track.getByTestId('track-current')).toContainText('样例SPA区');
      await expect(track.getByTestId('track-segments')).toContainText('发手牌');
      await page.keyboard.press('Escape');

      // ③ 后台模拟刷卡（店主）：客人到 V312
      await relogin(page, 'linlan');
      await page.goto('/admin/spaces');
      await page.getByTestId('subnav-locations').click();
      await page.getByTestId(`reader-${READER.code}`).getByTestId('reader-swipe').click();
      const swipe = page.getByRole('dialog').filter({ hasText: `模拟刷卡 · ${READER.code}` });
      await swipe.getByTestId('swipe-value').fill(tag);
      await swipe.getByTestId('swipe-submit').click();
      await expect(swipe).toContainText(`手牌 ${tag} 现在在`);
      await expect(swipe).toContainText('V312');

      // ③b 模拟刷卡的「结果待确认」（Codex 复审 PR #33）
      const events = async () => (await getJson<LocationTrackData>(page, `/api/locations/tracks?visitId=${visit}`)).events.length;
      const before = await events();
      const REPORT = '**/api/locations/report';
      // 回应丢了（服务器其实记上了）：页面上方自动查回，只记一次
      await page.route(REPORT, async (route) => {
        await route.fetch();
        await route.abort('failed');
      });
      await swipe.getByTestId('swipe-value').fill(tag);
      await swipe.getByTestId('swipe-submit').click();
      await expect(page.getByText('已查回：模拟刷卡已登记')).toBeVisible();
      expect(await events()).toBe(before + 1);
      await page.unroute(REPORT);
      // 请求没到服务器：记在本机待确认——对话框里不能再刷；刷新后还在；按原内容重新提交只记一次
      await page.route(REPORT, (route) => route.abort('failed'));
      await swipe.getByTestId('swipe-value').fill(tag);
      await swipe.getByTestId('swipe-submit').click();
      await expect(swipe.getByTestId('swipe-pending')).toBeVisible();
      await expect(swipe.getByTestId('swipe-submit')).toBeDisabled();
      await page.unroute(REPORT);
      await page.keyboard.press('Escape');
      await page.reload();
      const pending = page.getByTestId('erp-pending');
      await expect(pending).toContainText('模拟刷卡结果待确认');
      await expect(pending).toContainText(`${READER.code} ${READER.name} · 手牌 ${tag}`);
      await pending.getByTestId('erp-pending-resend').click();
      await expect(page.getByText('模拟刷卡已登记', { exact: true })).toBeVisible();
      await expect(pending).toHaveCount(0);
      expect(await events()).toBe(before + 2);
      // 再一次没到服务器的：确认作废，之后原请求晚到也不记
      await page.getByTestId('subnav-locations').click();
      await page.getByTestId(`reader-${READER.code}`).getByTestId('reader-swipe').click();
      await page.route(REPORT, (route) => route.abort('failed'));
      await swipe.getByTestId('swipe-value').fill(tag);
      await swipe.getByTestId('swipe-submit').click();
      await expect(swipe.getByTestId('swipe-pending')).toBeVisible();
      await page.unroute(REPORT);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('yuzu.erpPending.v1') ?? '[]') as { type: string; body: unknown }[]);
      const lost = stored.find((x) => x.type === 'location_report')!;
      await page.keyboard.press('Escape');
      await pending.getByTestId('erp-pending-abandon').click();
      await pending.getByTestId('erp-pending-abandon-confirm').click();
      await expect(page.getByText('模拟刷卡已作废', { exact: true })).toBeVisible();
      await expect(pending).toHaveCount(0);
      const late = await page.request.post('/api/locations/report', { data: lost.body });
      expect(late.status()).toBe(409);
      expect(((await late.json()) as { error: { code: string } }).error.code).toBe('OP_ABANDONED');
      expect(await events()).toBe(before + 2);

      await page.goto('/rooms?view=map');
      await expect(page.getByTestId('map-people-V312')).toHaveAttribute('data-count', '1');
      await page.getByTestId('map-space-V312').click();
      await expect(page.getByTestId('floormap-panel-people')).toContainText(`手牌 ${tag}`);
      const current = await getJson<LocationsCurrent>(page, '/api/locations/current');
      expect(current.people.find((p) => p.kind === 'guest' && p.id === visit)).toMatchObject({ spaceCode: 'V312', lastSource: 'reader' });

      // ④ 挂账：客人到项目所在的区域（样例客房区）
      await send(page, 'post', `/api/frontdesk/visits/${visit}/charges`, { clientKey: randomUUID(), lines: [{ itemId: item.id, quantity: 1 }], expectedTotal: item.price });
      await expect(page.getByTestId(`map-zone-${zone.rooms}`)).toBeVisible({ timeout: 12_000 });
      await expect(page.getByTestId('map-people-V312')).toHaveCount(0);
      const t = await getJson<LocationTrackData>(page, `/api/locations/tracks?visitId=${visit}`);
      expect(t.tracks.map((x) => x.spaceCode ?? x.zoneName)).toEqual(['样例SPA区', 'V312', '样例客房区']);
    } finally {
      await relogin(page, 'linlan');
      await cleanup(page, visit, itemId);
    }
  });

  // ② 各尺寸：接口用合成数据（一层、两个区域、几位客人与技师）
  test('人员图层与在场名单：区域人数、房间人数、点人看轨迹，不出现横向滚动', async ({ page }) => {
    const now = new Date().toISOString();
    const W = 4000;
    const H = 2400;
    const box = (x: number, y: number): [number, number][] => [[x, y], [x + 600, y], [x + 600, y + 400], [x, y + 400]];
    const sp = (id: number, code: string, zoneId: number, zoneName: string, businessType: string): FloorMapSpace => ({
      id, code, floorCode: 'L3', floorName: '三层', zoneId, zoneName, businessType, capacity: 2, areaCentiM2: null, displayName: `合成${businessType}`, sellable: true, active: true, aliases: [], roomId: null,
    });
    const spaces = [sp(1, 'T301', 11, '合成SPA区', 'SPA'), sp(2, 'T302', 11, '合成SPA区', 'SPA'), sp(3, 'V312', 12, '合成足浴区', '足浴')];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fafafa"/></svg>`;
    const plan: ActiveFloorplan = {
      batchId: 900101,
      outlineRev: 0,
      activatedAt: now,
      floors: [{ code: 'L3', title: '三层', width: W, height: H, svgBytes: svg.length, pathCount: 0, svgUrl: '/api/floorplans/900101/floors/L3/svg' }],
      rooms: spaces.map((s, i) => ({ floorCode: 'L3', code: s.code, label: `合成 ${s.code}`, status: 'ok', mergedWith: [], closeMm: 600, polygon: box(400 + i * 900, 600), labelAt: [700 + i * 900, 800], areaM2: 24, spaceId: s.id, displayName: s.displayName })) as ActiveFloorplan['rooms'],
    };
    const person = (p: Partial<LocationPerson>): LocationPerson => ({
      kind: 'guest', id: 1, tagCode: 'A001', techNo: null, techName: null, floorId: 3, floorCode: 'L3', floorName: '三层', zoneId: 11, zoneName: '合成SPA区',
      spaceId: null, spaceCode: null, spaceName: null, since: now, lastAt: now, lastSource: 'checkin', ...p,
    });
    const atV312 = { zoneId: 12, zoneName: '合成足浴区', spaceId: 3, spaceCode: 'V312', spaceName: '合成足浴', lastSource: 'session_start' as const };
    const located: LocationsCurrent = {
      serverTime: now,
      enabled: true,
      guestsInStore: 5,
      techniciansOnDuty: 2,
      people: [
        person({ id: 1, tagCode: 'A001' }),
        person({ id: 2, tagCode: 'A002', lastSource: 'consume' }),
        person({ id: 3, tagCode: 'A003', ...atV312 }),
        person({ kind: 'technician', id: 7, tagCode: null, techNo: '07', techName: '合成技师', ...atV312 }),
      ],
    };
    const trackData: LocationTrackData = {
      subject: { kind: 'guest', visitId: 1, visitNo: 'LF0001', tagCode: 'A001', inStore: true, checkedInAt: now },
      current: located.people[0]!,
      tracks: [{ id: 1, floorId: 3, floorCode: 'L3', floorName: '三层', zoneId: 11, zoneName: '合成SPA区', spaceId: null, spaceCode: null, spaceName: null, enteredAt: now, lastAt: now, leftAt: null, eventCount: 1, enterSource: 'checkin', endSource: null }],
      events: [],
      eventsTruncated: false,
    };
    const map: FloorMapData = { serverTime: now, floorplanBatchId: 900101, floorplanRev: 0, spaces, sessions: [], usageTypes: [], usages: [] };
    const board: RoomBoard = {
      rules: { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 } as RoomBoard['rules'],
      rooms: [],
      audit: { date: now.slice(0, 10), done: false, runAt: null, runByName: null, pending: 0, allowed: false },
      counts: { vacant: 0, occupied: 0, dirty: 0, maintenance: 0 },
    };
    const json = (body: unknown) => (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    await login(page, 'xiaozhou');
    // 会话：只把「客房功能开启」改成开着，其余照服务端
    await page.route('**/api/auth/me', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), rooms: true } });
    });
    await page.route('**/api/rooms', json(board));
    await page.route('**/api/floormap', json(map));
    await page.route('**/api/floorplans/active', json(plan));
    await page.route('**/api/floorplans/900101/floors/L3/svg', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }));
    await page.route('**/api/locations/current', json(located));
    await page.route('**/api/locations/tracks?*', json(trackData));
    await page.goto('/rooms?view=map');
    await expect(page.getByTestId('map-zone-11')).toHaveAttribute('data-count', '2');
    await expect(page.getByTestId('map-people-V312')).toHaveAttribute('data-count', '2');
    await expect(page.getByTestId('floormap-people-summary')).toContainText('在店客人 5（有位置 3 · 位置不明 2）');
    const people = page.getByTestId('floormap-people');
    await expect(people.getByTestId('floormap-person-technician-07')).toContainText('技师 07 号 合成技师');
    await people.getByTestId('floormap-person-guest-A001').getByTestId('floormap-person-track').click();
    await expect(page.getByTestId('track-current')).toContainText('合成SPA区');
    await page.keyboard.press('Escape');
    // 找人：回车定位到那间房，房间侧栏列出在这里的人
    await people.getByTestId('floormap-people-search').fill('A003');
    await people.getByTestId('floormap-people-search').press('Enter');
    await expect(page.getByTestId('floormap-panel')).toHaveAttribute('data-code', 'V312');
    await expect(page.getByTestId('floormap-panel-people')).toContainText('手牌 A003');
    // 关掉人员图层
    await page.getByTestId('floormap-show-people').uncheck();
    await expect(page.getByTestId('map-zone-11')).toHaveCount(0);
    await expect(people).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
});
