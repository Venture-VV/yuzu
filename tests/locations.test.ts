// v0.7.17 · 飞书需求 RQ-004 第一级实时位置（docs/ROOMMAP.md 第 3 节）：后台开关与区域、刷卡点（版本号）、项目所在区域；
// 业务动作推导（发牌、挂账、开房换房退房、上下钟、换房间、技师上下牌、结账、撤销来访、补录不推导）；上报即定位
// （操作编号原样重发、内容不同拒绝、迟到的只记不改、同一个人第一次同时两条）；轨迹段与当前位置；开关关着只清不记；
// 位置写不进去业务照常；权限；自检。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocationAdmin, LocationPerson, LocationReportResult, LocationsCurrent, LocationTrackData } from '../src/shared/locations';
import type { SpaceLedger } from '../src/shared/spaces';
import { locationChecks } from '../src/server/modules/locations';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let manager: string; // 客户经理：没有「看实时位置」
let boss: string; // 店总：能配、能上报
let duty: string; // 值班经理：能补录
const zone: Record<string, number> = {};
const Z = (name: string) => zone[name]!;
const item: Record<string, number> = {};
const itemId = (name: string) => item[name]!;
const tech: Record<string, number> = {};
const room: Record<string, number> = {};
let tagNo = 0;

const ZONES_CSV = [
  '楼层,区域名(中文),区域名(英文),备注',
  'L1,合成接待区,Reception,合成样例',
  'L1,合成水吧区,Water bar,合成样例',
  'L2,合成餐厅区,Restaurant,合成样例',
  'L3,合成足浴区,Foot spa,合成样例',
  'L3,合成技师休息区,Staff rest,合成样例',
].join('\r\n');
const SPACES_CSV = [
  '楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注',
  'L3,F,F301,足浴,2,合成足浴 2人间,,合成 F301,',
  'L3,F,F302,足浴,2,合成足浴 2人间,,合成 F302,',
  'L3,G,G301,客房,2,合成客房,,合成客房 G301,',
  'L3,G,G302,客房,2,合成客房,,合成客房 G302,',
  'L1,W,W101,水吧,10,合成水吧,,合成水吧 W101,',
].join('\r\n');

const ledger = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/spaces')).body as SpaceLedger;
const spaceId = async (code: string) => (await ledger()).spaces.find((s) => s.code === code)!.id;
const setZone = async (code: string, zoneName: string) => {
  const s = (await ledger()).spaces.find((x) => x.code === code)!;
  const r = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/spaces/${s.id}`, {
    floorId: s.floorId,
    zoneId: zone[zoneName],
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
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const admin = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/locations')).body as LocationAdmin;
const rules = (body: Record<string, unknown>, cookie = ctx.owner) => api(ctx.app, cookie, 'PUT', '/api/admin/locations/rules', body);
const enter = async () => {
  tagNo += 1;
  const code = `L${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { visitId: r.body.visits[0].id as number, tagCode: code };
};
const post = (visitId: number, lines: { itemId: number; quantity: number }[], expectedTotal: number, extra: Record<string, unknown> = {}, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines, expectedTotal, ...extra });
const report = (body: Record<string, unknown>, cookie = ctx.owner) =>
  api(ctx.app, cookie, 'POST', '/api/locations/report', { opId: randomUUID(), source: 'reader', ...body }) as Promise<{ status: number; body: LocationReportResult & { error: { code: string } } }>;
const current = async (cookie = ctx.clerk) => (await api(ctx.app, cookie, 'GET', '/api/locations/current')).body as LocationsCurrent;
const guestAt = async (visitId: number): Promise<LocationPerson | undefined> => (await current()).people.find((p) => p.kind === 'guest' && p.id === visitId);
const techAt = async (id: number): Promise<LocationPerson | undefined> => (await current()).people.find((p) => p.kind === 'technician' && p.id === id);
const track = async (q: string) => {
  const r = await api(ctx.app, ctx.clerk, 'GET', `/api/locations/tracks?${q}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as LocationTrackData;
};
const pay = async (visitId: number) => {
  const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: preview.totalAmount,
    payments: [{ method: 'cash', amount: preview.totalAmount }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const dispatch = (body: Record<string, unknown>) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', { clientKey: randomUUID(), quantity: 1, startNow: true, itemId: itemId('足疗'), tier: 'standard', expectedTotal: 19800, callType: 'designated', ...body });
const sessionOf = async (visitId: number) =>
  ((await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom')).body.sessions as { id: number; visitId: number; status: string; spaceVersion: number }[]).find((s) => s.visitId === visitId)!;
const allChecksOk = async () => {
  for (const c of await locationChecks(ctx.sql)) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
};
const eventCount = async () => (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM location_events`)[0]!.n;

beforeAll(async () => {
  ctx = await setup();
  for (const [username, displayName, role] of [
    ['am', '客户经理', 'account_manager'],
    ['boss', '店总', 'store_manager'],
    ['duty', '值班经理', 'duty_manager'],
  ] as const) {
    await createStaff(ctx.sql, { username, displayName, role, password: PASSWORD, mustChangePassword: false });
  }
  manager = await login(ctx.app, 'am');
  boss = await login(ctx.app, 'boss');
  duty = await login(ctx.app, 'duty');
  for (const [kind, csv] of [
    ['zones', ZONES_CSV],
    ['spaces', SPACES_CSV],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', { kind, fileName: `${kind}.csv`, csv, encoding: 'UTF-8', clientKey: randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  for (const z of (await ledger()).zones) zone[z.name] = z.id;
  await setZone('F301', '合成足浴区');
  await setZone('F302', '合成足浴区');
  await setZone('W101', '合成水吧区');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'L', from: 1, to: 60, width: 3, zone: 'male' })).status).toBe(200);
  for (const [name, category, price, extra] of [
    ['果汁', '饮品', 2800, {}],
    ['茶', '饮品', 1800, {}],
    ['炒饭', '简餐', 3800, {}],
    ['毛巾', '其他', 500, {}],
    ['足疗', '足疗', 19800, { durationMinutes: 90, technicianRequired: true }],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
  for (const no of ['01', '02']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name: `技师${no}`, gender: 'female', grade: 'standard' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(200);
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '合成大床房', kind: 'daily', price: 30000 });
  expect(t.status, JSON.stringify(t.body)).toBe(200);
  for (const code of ['G301', 'G302']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo: '', floor: '3', roomTypeId: t.body.types[0].id, spaceId: await spaceId(code) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    room[code] = r.body.rooms.find((x: { roomNo: string }) => x.roomNo === code).id;
  }
});
afterAll(async () => ctx.close());

describe('开关、刷卡点与项目所在区域（后台）', () => {
  it('默认关：不推导、刷卡拒绝；店主、店总能配，店员不能；区域停用的不能选', async () => {
    expect((await admin()).rules).toEqual({ enabled: false, checkinZoneId: null, restZoneId: null });
    expect((await current()).enabled).toBe(false);
    const g = await enter();
    expect(await guestAt(g.visitId)).toBeUndefined();
    expect(await eventCount()).toBe(0);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/locations')).status).toBe(403);
    expect((await rules({ enabled: true }, ctx.clerk)).status).toBe(403);
    expect((await rules({ checkinZoneId: 999999 })).body.error.code).toBe('ZONE_INACTIVE');
    const r = await rules({ enabled: true, checkinZoneId: Z('合成接待区') }, boss);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as LocationAdmin).rules).toEqual({ enabled: true, checkinZoneId: Z('合成接待区'), restZoneId: null });
    // 只改提交的字段
    expect(((await rules({ restZoneId: Z('合成技师休息区') })).body as LocationAdmin).rules).toEqual({ enabled: true, checkinZoneId: Z('合成接待区'), restZoneId: Z('合成技师休息区') });
  });

  it('刷卡点：区域或空间二选一，编号唯一，修改带版本号，停用后刷卡拒绝', async () => {
    const bad = await api(ctx.app, ctx.owner, 'POST', '/api/admin/locations/readers', { code: 'R00', name: '两个都填', zoneId: Z('合成接待区'), spaceId: await spaceId('W101') });
    expect(bad.status).toBe(400);
    for (const [code, name, where] of [
      ['r01', '合成接待 1', { zoneId: Z('合成接待区'), spaceId: null }],
      ['R02', '合成水吧 1', { zoneId: null, spaceId: await spaceId('W101') }],
      ['R03', '合成餐厅 1', { zoneId: Z('合成餐厅区'), spaceId: null }],
    ] as const) {
      const r = await api(ctx.app, boss, 'POST', '/api/admin/locations/readers', { code, name, ...where });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/locations/readers', { code: 'R01', name: '重复', zoneId: Z('合成接待区'), spaceId: null })).body.error.code).toBe('READER_CODE_TAKEN');
    const a = await admin();
    expect(a.readers.map((r) => r.code)).toEqual(['R01', 'R02', 'R03']);
    const r02 = a.readers.find((r) => r.code === 'R02')!;
    // 装在空间上：楼层、区域跟着空间
    expect(r02.place).toMatchObject({ floorCode: 'L1', zoneName: '合成水吧区', spaceCode: 'W101' });
    const body = { code: 'R02', name: '合成水吧 一号', zoneId: null, spaceId: r02.spaceId, note: '', active: true };
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/locations/readers/${r02.id}`, { ...body, expectedVersion: r02.version })).status).toBe(200);
    // 迟到的旧修改（还带着旧版本号）被拒绝
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/locations/readers/${r02.id}`, { ...body, name: '旧的', expectedVersion: r02.version })).body.error.code).toBe('READER_STALE');
    expect((await admin()).readers.find((r) => r.code === 'R02')!.name).toBe('合成水吧 一号');
  });

  it('项目所在区域：逐个设、清掉；区域不存在拒绝；记审计', async () => {
    const r = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/locations/items', {
      items: [
        { id: item['果汁'], zoneId: Z('合成水吧区') },
        { id: item['茶'], zoneId: Z('合成水吧区') },
        { id: item['炒饭'], zoneId: Z('合成餐厅区') },
        { id: item['足疗'], zoneId: Z('合成足浴区') },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const items = (r.body as LocationAdmin).items;
    expect(items.find((i) => i.id === item['果汁'])!.zoneId).toBe(Z('合成水吧区'));
    expect(items.find((i) => i.id === item['毛巾'])!.zoneId).toBeNull();
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/locations/items', { items: [{ id: item['毛巾'], zoneId: 999999 }] })).body.error.code).toBe('ZONE_INACTIVE');
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/locations/items', { items: [{ id: item['毛巾'], zoneId: null }] })).status).toBe(403);
    const [audit] = await ctx.sql<{ detail: { summary: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'items_zone_updated' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.summary).toContain('果汁 → 合成水吧区');
  });
});

describe('业务动作推导位置', () => {
  it('发手牌在接待区；挂账按项目的区域（几个区域按项目多的，一样多按先挂的；没配的不推导）；轨迹按进入—离开分段', async () => {
    const g = await enter();
    expect(await guestAt(g.visitId)).toMatchObject({ tagCode: g.tagCode, zoneName: '合成接待区', floorCode: 'L1', spaceCode: null, lastSource: 'checkin' });
    // 没配区域的项目不推导
    expect((await post(g.visitId, [{ itemId: itemId('毛巾'), quantity: 1 }], 500)).status).toBe(200);
    expect((await guestAt(g.visitId))!.zoneName).toBe('合成接待区');
    // 一样多（各一个）：先挂的那个区域
    expect((await post(g.visitId, [{ itemId: itemId('炒饭'), quantity: 1 }, { itemId: itemId('果汁'), quantity: 1 }], 6600)).status).toBe(200);
    expect(await guestAt(g.visitId)).toMatchObject({ zoneName: '合成餐厅区', lastSource: 'consume' });
    // 项目多的区域：果汁 + 茶（水吧）比炒饭（餐厅）多
    expect((await post(g.visitId, [{ itemId: itemId('炒饭'), quantity: 3 }, { itemId: itemId('果汁'), quantity: 1 }, { itemId: itemId('茶'), quantity: 1 }], 3800 * 3 + 2800 + 1800)).status).toBe(200);
    expect((await guestAt(g.visitId))!.zoneName).toBe('合成水吧区');
    // 同一个区域再消费：续在同一段
    expect((await post(g.visitId, [{ itemId: itemId('茶'), quantity: 1 }], 1800)).status).toBe(200);
    const t = await track(`visitId=${g.visitId}`);
    expect(t.subject).toMatchObject({ kind: 'guest', tagCode: g.tagCode, inStore: true });
    expect(t.tracks.map((x) => [x.zoneName, x.eventCount, x.leftAt === null])).toEqual([
      ['合成接待区', 1, false],
      ['合成餐厅区', 1, false],
      ['合成水吧区', 2, true],
    ]);
    expect(t.tracks[0]!.enterSource).toBe('checkin');
    expect(t.tracks[0]!.endSource).toBe('consume');
    expect(t.events.map((e) => e.source)).toEqual(['checkin', 'consume', 'consume', 'consume']);
    expect(t.events[1]!.refText).toBe('炒饭');
    await allChecksOk();
  });

  it('客房开房、换房在那间房；退房后位置不明（不在图上），再退别的房不动', async () => {
    const g = await enter();
    const s = await api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkin', { clientKey: randomUUID(), guests: 1, roomId: room['G301'], expectedRate: 30000, tagCode: g.tagCode });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(await guestAt(g.visitId)).toMatchObject({ spaceCode: 'G301', floorCode: 'L3', lastSource: 'room_checkin' });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.body.id}/move`, { toRoomId: room['G302'], reason: '客人嫌吵' })).status).toBe(200);
    expect(await guestAt(g.visitId)).toMatchObject({ spaceCode: 'G302', lastSource: 'room_move' });
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/rooms/stays/${s.body.id}/checkout-preview`)).body;
    const close = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.body.id}/close`, { clientKey: randomUUID(), expectedDue: preview.dueAmount, expectedDeposits: preview.depositByMethod });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect(await guestAt(g.visitId)).toBeUndefined();
    const t = await track(`visitId=${g.visitId}`);
    expect(t.current).toBeNull();
    expect(t.events.at(-1)).toMatchObject({ kind: 'left', source: 'room_close' });
    expect(t.events.at(-1)!.place!.spaceCode).toBe('G302');
    expect(t.tracks.every((x) => x.leftAt !== null)).toBe(true);
    // 在店客人里位置不明的照样算在店
    const c = await current();
    expect(c.guestsInStore).toBeGreaterThan(c.people.filter((p) => p.kind === 'guest').length);
    await allChecksOk();
  });

  it('上钟：技师与客人在钟单的房间；在钟上换房间一起到新房间；下钟技师回休息区、客人不动；结账客人离店', async () => {
    for (const no of ['01', '02']) expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech[no]}/state`, { action: 'sign_in' })).status).toBe(200);
    // 上牌：在技师休息区
    expect(await techAt(tech['01']!)).toMatchObject({ techNo: '01', zoneName: '合成技师休息区', lastSource: 'sign_in' });
    const g = await enter();
    const d = await dispatch({ visitId: g.visitId, technicianId: tech['01'], spaceId: await spaceId('F301') });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    // 派钟马上上钟：房间比项目的区域（足浴区）更准
    expect(await guestAt(g.visitId)).toMatchObject({ spaceCode: 'F301', zoneName: '合成足浴区', lastSource: 'session_start' });
    expect(await techAt(tech['01']!)).toMatchObject({ spaceCode: 'F301', lastSource: 'session_start' });
    const s = await sessionOf(g.visitId);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s.id}/space`, { spaceId: await spaceId('F302'), expectedVersion: s.spaceVersion })).status).toBe(200);
    expect((await guestAt(g.visitId))!.spaceCode).toBe('F302');
    expect(await techAt(tech['01']!)).toMatchObject({ spaceCode: 'F302', lastSource: 'session_room' });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s.id}/finish`, {})).status).toBe(200);
    expect(await techAt(tech['01']!)).toMatchObject({ zoneName: '合成技师休息区', spaceCode: null, lastSource: 'session_end' });
    expect((await guestAt(g.visitId))!.spaceCode).toBe('F302');
    const tt = await track(`technicianId=${tech['01']}`);
    expect(tt.subject).toMatchObject({ kind: 'technician', techNo: '01' });
    expect(tt.tracks.map((x) => x.spaceCode ?? x.zoneName)).toEqual(['合成技师休息区', 'F301', 'F302', '合成技师休息区']);
    await pay(g.visitId);
    expect(await guestAt(g.visitId)).toBeUndefined();
    const t = await track(`visitId=${g.visitId}`);
    expect(t.subject).toMatchObject({ inStore: false });
    expect(t.events.at(-1)).toMatchObject({ kind: 'gone', source: 'checkout' });
    expect(t.events.at(-1)!.refText).toMatch(/^JZ/);
    await allChecksOk();
  });

  it('结账时一起下钟：先记客人离店、再记技师回休息区；技师下牌离店，上牌回休息区', async () => {
    const g = await enter();
    expect((await dispatch({ visitId: g.visitId, technicianId: tech['02'], spaceId: await spaceId('F301') })).status).toBe(200);
    expect((await techAt(tech['02']!))!.spaceCode).toBe('F301');
    await pay(g.visitId);
    expect(await guestAt(g.visitId)).toBeUndefined();
    expect(await techAt(tech['02']!)).toMatchObject({ zoneName: '合成技师休息区', lastSource: 'session_end' });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech['02']}/state`, { action: 'sign_out' })).status).toBe(200);
    expect(await techAt(tech['02']!)).toBeUndefined();
    expect((await track(`technicianId=${tech['02']}`)).events.at(-1)).toMatchObject({ kind: 'gone', source: 'sign_out' });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech['02']}/state`, { action: 'sign_in' })).status).toBe(200);
    expect(await techAt(tech['02']!)).toMatchObject({ zoneName: '合成技师休息区', lastSource: 'sign_in' });
    await allChecksOk();
  });

  it('撤销来访离店；补录的接待、挂账不推导', async () => {
    const g = await enter();
    expect((await guestAt(g.visitId))!.zoneName).toBe('合成接待区');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${g.visitId}/cancel`, { reason: '开错手牌' })).status).toBe(200);
    expect(await guestAt(g.visitId)).toBeUndefined();
    expect((await track(`visitId=${g.visitId}`)).events.at(-1)).toMatchObject({ kind: 'gone', source: 'visit_cancel' });
    // 补录：按纸质单的实际时间办理，那时候的位置早已过时
    tagNo += 1;
    const code = `L${String(tagNo).padStart(3, '0')}`;
    const inAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    const b = await api(ctx.app, duty, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }], backfill: { slipNo: 'P-0001', at: inAt } });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const vid = b.body.visits[0].id as number;
    expect((await post(vid, [{ itemId: itemId('果汁'), quantity: 1 }], 2800, { backfill: { slipNo: 'P-0001', at: new Date(Date.now() - 3600_000).toISOString() } }, duty)).status).toBe(200);
    expect(await guestAt(vid)).toBeUndefined();
    expect((await track(`visitId=${vid}`)).events).toEqual([]);
    await allChecksOk();
  });
});

describe('上报即定位', () => {
  it('刷卡：客人到刷卡点的区域或空间；原样重发返回原结果、不重复记；同一个编号内容不同拒绝', async () => {
    const g = await enter();
    const opId = randomUUID();
    const body = { opId, readerCode: 'r02', tagCode: g.tagCode.toLowerCase() };
    const first = await report(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ applied: true, replayed: false });
    expect(first.body.current).toMatchObject({ spaceCode: 'W101', zoneName: '合成水吧区', lastSource: 'reader' });
    const before = await eventCount();
    const again = await report(body);
    expect(again.body).toMatchObject({ eventId: first.body.eventId, replayed: true });
    expect(await eventCount()).toBe(before);
    expect((await report({ ...body, readerCode: 'R01' })).body.error.code).toBe('OP_KEY_REUSED');
    const t = await track(`visitId=${g.visitId}`);
    expect(t.events.at(-1)).toMatchObject({ source: 'reader', readerCode: 'R02', readerName: '合成水吧 一号', tagCode: g.tagCode, staffName: '测试店主' });
  });

  it('迟到的刷卡（比最近一次位置还早）只记事件、不改当前位置与轨迹；时刻超出时间窗拒绝', async () => {
    const g = await enter();
    expect((await report({ readerCode: 'R03', tagCode: g.tagCode })).body.current!.zoneName).toBe('合成餐厅区');
    const late = await report({ readerCode: 'R02', tagCode: g.tagCode, at: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect(late.body).toMatchObject({ applied: false });
    expect(late.body.current!.zoneName).toBe('合成餐厅区');
    const t = await track(`visitId=${g.visitId}`);
    expect(t.tracks.map((x) => x.zoneName)).toEqual(['合成接待区', '合成餐厅区']);
    expect(t.events.find((e) => !e.applied)!.readerCode).toBe('R02');
    expect((await report({ readerCode: 'R02', tagCode: g.tagCode, at: new Date(Date.now() + 10 * 60_000).toISOString() })).body.error.code).toBe('REPORT_TIME');
    expect((await report({ readerCode: 'R02', tagCode: g.tagCode, at: new Date(Date.now() - 25 * 3600_000).toISOString() })).body.error.code).toBe('REPORT_TIME');
    await allChecksOk();
  });

  it('定位上报（第二级预留）：报空间或区域，带坐标、精度、设备编号；技师按工号报', async () => {
    const g = await enter();
    const r = await report({ source: 'position', spaceCode: 'f302', tagCode: g.tagCode, x: 12_000, y: 3_500, accuracy: 300, deviceId: 'UWB-合成-01' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.current!.spaceCode).toBe('F302');
    const [e] = await ctx.sql<{ xMm: number; yMm: number; accuracyMm: number; deviceId: string; source: string }[]>`
      SELECT x_mm, y_mm, accuracy_mm, device_id, source FROM location_events WHERE id = ${r.body.eventId}`;
    expect(e).toEqual({ xMm: 12_000, yMm: 3_500, accuracyMm: 300, deviceId: 'UWB-合成-01', source: 'position' });
    expect((await report({ source: 'position', zoneId: Z('合成水吧区'), technicianNo: '01' })).body.current).toMatchObject({ kind: 'technician', techNo: '01', zoneName: '合成水吧区' });
    // 格式：手牌与工号二选一；刷卡要刷卡点；定位要空间或区域
    expect((await report({ readerCode: 'R01' })).status).toBe(400);
    expect((await report({ readerCode: 'R01', tagCode: g.tagCode, technicianNo: '01' })).status).toBe(400);
    expect((await report({ source: 'position', tagCode: g.tagCode })).status).toBe(400);
    expect((await report({ readerCode: 'R01', tagCode: g.tagCode, spaceCode: 'F301' })).status).toBe(400);
  });

  it('拒绝：手牌没有在店客人、刷卡点没登记或停用、装的地方停用、技师不存在；店员不能上报，客户经理看不到位置', async () => {
    const g = await enter();
    await pay(g.visitId);
    expect((await report({ readerCode: 'R01', tagCode: g.tagCode })).body.error.code).toBe('TAG_NOT_IN_STORE');
    const h = await enter();
    expect((await report({ readerCode: 'R99', tagCode: h.tagCode })).status).toBe(404);
    expect((await report({ source: 'position', spaceCode: 'Z999', tagCode: h.tagCode })).status).toBe(404);
    expect((await report({ readerCode: 'R01', technicianNo: '99' })).status).toBe(404);
    const r03 = (await admin()).readers.find((r) => r.code === 'R03')!;
    const off = { code: 'R03', name: r03.name, zoneId: r03.zoneId, spaceId: null, note: '', active: false, expectedVersion: r03.version };
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/locations/readers/${r03.id}`, off)).status).toBe(200);
    expect((await report({ readerCode: 'R03', tagCode: h.tagCode })).body.error.code).toBe('READER_INACTIVE');
    // 装的区域停用了：这个刷卡点刷卡拒绝，后台标出来
    const r01 = (await admin()).readers.find((r) => r.code === 'R01')!;
    await ctx.sql`UPDATE zones SET active = false WHERE id = ${Z('合成接待区')}`;
    expect((await report({ readerCode: 'R01', tagCode: h.tagCode })).body.error.code).toBe('PLACE_INACTIVE');
    expect((await admin()).readers.find((r) => r.id === r01.id)!.placeInactive).toBe(true);
    await ctx.sql`UPDATE zones SET active = true WHERE id = ${Z('合成接待区')}`;
    expect((await report({ readerCode: 'R01', tagCode: h.tagCode }, ctx.clerk)).status).toBe(403);
    expect((await report({ readerCode: 'R01', tagCode: h.tagCode }, boss)).status).toBe(200);
    expect((await api(ctx.app, manager, 'GET', '/api/locations/current')).status).toBe(403);
    expect((await api(ctx.app, manager, 'GET', `/api/locations/tracks?visitId=${h.visitId}`)).status).toBe(403);
    // 只带手牌号与技师，不带会员姓名、手机号
    const p = (await current()).people.find((x) => x.kind === 'guest')!;
    expect(Object.keys(p).sort()).toEqual(
      ['floorCode', 'floorId', 'floorName', 'id', 'kind', 'lastAt', 'lastSource', 'since', 'spaceCode', 'spaceId', 'spaceName', 'tagCode', 'techName', 'techNo', 'zoneId', 'zoneName'].sort(),
    );
  });

  it('同一个人第一次记位置时同时来两条：当前位置行只建一次，两条都记上、轨迹一致', async () => {
    await rules({ checkinZoneId: null });
    const g = await enter();
    expect(await guestAt(g.visitId)).toBeUndefined();
    const at = new Date().toISOString();
    const [a, b] = await Promise.all([report({ readerCode: 'R01', tagCode: g.tagCode, at }), report({ readerCode: 'R02', tagCode: g.tagCode, at })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await track(`visitId=${g.visitId}`)).events).toHaveLength(2);
    await allChecksOk();
    await rules({ checkinZoneId: Z('合成接待区') });
  });
});

describe('开关关着、写不进去、自检', () => {
  it('开关关着：不推导、刷卡拒绝；已有位置的客人结账照样清掉', async () => {
    const g = await enter();
    expect((await guestAt(g.visitId))!.zoneName).toBe('合成接待区');
    await rules({ enabled: false });
    const before = await eventCount();
    expect((await post(g.visitId, [{ itemId: itemId('果汁'), quantity: 1 }], 2800)).status).toBe(200);
    expect(await eventCount()).toBe(before);
    expect((await report({ readerCode: 'R02', tagCode: g.tagCode })).body.error.code).toBe('LOCATION_OFF');
    await pay(g.visitId);
    expect(await eventCount()).toBe(before + 1);
    expect((await track(`visitId=${g.visitId}`)).events.at(-1)).toMatchObject({ kind: 'gone', source: 'checkout' });
    await rules({ enabled: true });
    await allChecksOk();
  });

  it('位置写不进去（模拟）：业务照常生效，只是这一次不推导', async () => {
    const g = await enter();
    await ctx.sql.unsafe(`
      CREATE FUNCTION test_location_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '模拟位置写入失败'; END $$;
      CREATE TRIGGER test_location_fail BEFORE INSERT ON location_events FOR EACH ROW EXECUTE FUNCTION test_location_fail();`);
    try {
      const r = await post(g.visitId, [{ itemId: itemId('果汁'), quantity: 1 }], 2800);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.lines.some((l: { name: string }) => l.name === '果汁')).toBe(true);
    } finally {
      await ctx.sql.unsafe('DROP TRIGGER test_location_fail ON location_events; DROP FUNCTION test_location_fail();');
    }
    expect((await guestAt(g.visitId))!.zoneName).toBe('合成接待区');
    await allChecksOk();
  });

  it('自检能查出当前位置与事件不符、离店的客人还有位置', async () => {
    const g = await enter();
    const [row] = await ctx.sql<{ id: number; zoneId: number }[]>`SELECT id, zone_id FROM current_locations WHERE visit_id = ${g.visitId}`;
    await ctx.sql`UPDATE current_locations SET zone_id = ${Z('合成餐厅区')}, floor_id = (SELECT floor_id FROM zones WHERE id = ${Z('合成餐厅区')}) WHERE id = ${row!.id}`;
    const bad = await locationChecks(ctx.sql);
    expect(bad[0]!.ok).toBe(false);
    expect(bad[1]!.ok).toBe(false);
    await ctx.sql`UPDATE current_locations SET zone_id = ${row!.zoneId}, floor_id = (SELECT floor_id FROM zones WHERE id = ${row!.zoneId}) WHERE id = ${row!.id}`;
    await allChecksOk();
    // 技师下牌了、位置却没清掉（模拟下牌时位置没记上）：第三项查得出
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech['02']}/state`, { action: 'sign_out' })).status).toBe(200);
    const [t2] = await ctx.sql<{ id: number }[]>`SELECT id FROM current_locations WHERE technician_id = ${tech['02']!}`;
    const [track] = await ctx.sql<{ id: number }[]>`SELECT id FROM location_tracks WHERE technician_id = ${tech['02']!} ORDER BY id DESC LIMIT 1`;
    await ctx.sql`UPDATE current_locations SET state = 'at', floor_id = (SELECT floor_id FROM zones WHERE id = ${Z('合成技师休息区')}), zone_id = ${Z('合成技师休息区')},
             since = now() - interval '1 hour', track_id = ${track!.id}, last_at = now() - interval '1 hour' WHERE id = ${t2!.id}`;
    const stale = await locationChecks(ctx.sql);
    expect(stale[2]).toMatchObject({ ok: false });
    expect(stale[2]!.detail).toContain('技师 02');
  });
});
