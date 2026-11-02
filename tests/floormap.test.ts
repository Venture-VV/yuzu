// v0.7.16 · 飞书需求 RQ-004 第三段（docs/ROOMMAP.md）：房态图——状态口径（共用的纯函数）、钟单记服务的房间
// （派钟选房间、换房间、清掉房间；只能选在用、可售的技师服务类空间；页面看到的房间对不上拒绝）、空间台账停用与改业态的拦截、
// 平面图接口（空间、记了房间的钟单、在用底图批次、权限）、房态看板带空间编号、自检。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FLOOR_MAP_LEGEND, FLOOR_MAP_STATES, spaceMatches, spaceStatus, type FloorMapData, type FloorMapSession, type FloorMapSpace } from '../src/shared/floormap';
import type { RoomBoardRoom } from '../src/shared/rooms';
import type { SpaceLedger } from '../src/shared/spaces';
import { spaceChecks } from '../src/server/modules/spaces';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let manager: string; // 客户经理：没有客房、钟房权限
let foot = 0;
const tech: Record<string, number> = {};
let tagNo = 0;

const ZONES_CSV = ['楼层,区域名(中文),区域名(英文),备注', 'L3,合成SPA区,Sample SPA,合成样例'].join('\r\n');
const SPACES_CSV = [
  '楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注',
  'L3,S,S301,SPA,1,合成SPA 1人间,,合成 SPA S301,',
  'L3,S,S302,SPA,2,合成SPA 2人间,,合成 SPA S302,',
  'L3,F,F312,足浴,4,合成足浴 4人间,,合成 F312,',
  'L3,S,S303,SPA,1,合成SPA 停售,,合成 SPA S303,',
  'L3,G,G301,客房,2,合成客房,,合成客房 G301,',
  'L3,G,G302,客房,2,合成客房,,合成客房 G302,',
  'L2,P,P201,派对房,,合成派对房,,合成派对房 P201,',
].join('\r\n');

const ledger = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/spaces')).body as SpaceLedger;
const space = async (code: string) => (await ledger()).spaces.find((s) => s.code === code)!;
const fieldsOf = (s: SpaceLedger['spaces'][number], patch: Record<string, unknown> = {}) => ({
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
const editSpace = async (code: string, patch: Record<string, unknown>) => {
  const s = await space(code);
  return api(ctx.app, ctx.owner, 'PUT', `/api/admin/spaces/${s.id}`, fieldsOf(s, patch));
};
const enter = async () => {
  tagNo += 1;
  const code = `F${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'female' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { visitId: r.body.visits[0].id as number, tagCode: code };
};
const dispatch = (body: Record<string, unknown>, clientKey = randomUUID()) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', { clientKey, quantity: 1, startNow: true, itemId: foot, tier: 'standard', expectedTotal: 19800, callType: 'designated', ...body });
type Session = { id: number; visitId: number; status: string; techNo: string; space: { id: number; code: string; displayName: string } | null; spaceVersion: number };
const sessions = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom')).body.sessions as Session[];
const sessionOf = async (visitId: number) => (await sessions()).find((s) => s.visitId === visitId)!;
const map = async (cookie = ctx.clerk) => (await api(ctx.app, cookie, 'GET', '/api/floormap')).body as FloorMapData;
const setRoom = (id: number, spaceId: number | null, expectedVersion: number) =>
  api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${id}/space`, { spaceId, expectedVersion });
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
const allChecksOk = async () => {
  for (const c of await spaceChecks(ctx.sql)) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
};

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'am', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  manager = await login(ctx.app, 'am');
  for (const [kind, csv] of [
    ['zones', ZONES_CSV],
    ['spaces', SPACES_CSV],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', { kind, fileName: `${kind}.csv`, csv, encoding: 'UTF-8', clientKey: randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  expect((await editSpace('S303', { sellable: false })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'F', from: 1, to: 30, width: 3, zone: 'female' })).status).toBe(200);
  const item = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '足疗', category: '足疗', durationMinutes: 90, technicianRequired: true, price: 19800 });
  expect(item.status, JSON.stringify(item.body)).toBe(200);
  foot = item.body.items.find((i: { name: string }) => i.name === '足疗').id;
  for (const no of ['01', '02', '03']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name: `技师${no}`, gender: 'female', grade: 'standard' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true })).status).toBe(200);
  for (const no of ['01', '02', '03']) expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech[no]}/state`, { action: 'sign_in' })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('状态口径（共用的纯函数）', () => {
  const sp = (patch: Partial<FloorMapSpace> = {}): FloorMapSpace => ({
    id: 1,
    code: 'S301',
    floorCode: 'L3',
    floorName: '三层',
    zoneName: null,
    businessType: 'SPA',
    capacity: 2,
    areaCentiM2: null,
    displayName: '合成SPA',
    sellable: true,
    active: true,
    aliases: ['合成品牌名'],
    roomId: null,
    ...patch,
  });
  const room = (status: RoomBoardRoom['status']): RoomBoardRoom => ({
    id: 9,
    roomNo: 'G301',
    spaceName: '合成客房',
    spaceId: 1,
    floor: '3',
    typeName: '大床房',
    kind: 'daily',
    price: 30000,
    blockMinutes: null,
    status,
    maintenanceNote: null,
    stay: null,
  });
  const session = (status: 'waiting' | 'serving', spaceId = 1): FloorMapSession => ({
    id: Math.random(),
    sessionNo: 'ZD1',
    spaceId,
    techNo: '01',
    techName: '技师01',
    tagCode: 'F001',
    itemName: '足疗',
    clocks: 1,
    minutes: 90,
    status,
    createdAt: new Date().toISOString(),
    startedAt: status === 'serving' ? new Date().toISOString() : null,
    plannedEnd: null,
  });

  it('客房照房态看板（停用、不可售也照看板）；没挂房间为未挂接；挂的房间停用、看板上没有为灰色', () => {
    const g = sp({ businessType: '客房', roomId: 9 });
    for (const s of ['vacant', 'occupied', 'dirty', 'maintenance'] as const) expect(spaceStatus(g, room(s), []).state).toBe(s);
    expect(spaceStatus({ ...g, sellable: false }, room('occupied'), []).state).toBe('occupied');
    expect(spaceStatus({ ...g, roomId: null }, undefined, []).state).toBe('unlinked');
    expect(spaceStatus(g, undefined, []).state).toBe('off');
    expect(spaceStatus({ ...g, roomId: null, active: false }, undefined, []).state).toBe('off');
  });

  it('技师房：服务中优先、其次待上钟、没有钟单为空闲；占用写「钟单数/容量」；停用、不可售没人用为灰色，有钟单照样显示', () => {
    expect(spaceStatus(sp(), undefined, []).state).toBe('vacant');
    expect(spaceStatus(sp(), undefined, []).occupancy).toBeNull();
    const w = spaceStatus(sp(), undefined, [session('waiting'), session('waiting', 2)]);
    expect([w.state, w.occupancy, w.sessions.length]).toEqual(['waiting', '1/2', 1]);
    const s = spaceStatus(sp(), undefined, [session('waiting'), session('serving')]);
    expect([s.state, s.occupancy]).toEqual(['serving', '2/2']);
    expect(spaceStatus(sp({ capacity: null }), undefined, [session('serving')]).occupancy).toBe('1');
    expect(spaceStatus(sp({ sellable: false }), undefined, []).state).toBe('off');
    expect(spaceStatus(sp({ active: false }), undefined, [session('serving')]).state).toBe('serving');
  });

  it('其他业态只显示业态；颜色表每个状态都有、互不相同；搜索编码、显示名、别名不分大小写', () => {
    expect(spaceStatus(sp({ businessType: '派对房' }), undefined, []).state).toBe('other');
    expect(spaceStatus(sp({ businessType: '自定业态' }), undefined, []).kind).toBe('other');
    expect(Object.keys(FLOOR_MAP_LEGEND).sort()).toEqual([...FLOOR_MAP_STATES].sort());
    expect(new Set(FLOOR_MAP_STATES.map((k) => FLOOR_MAP_LEGEND[k].fill)).size).toBe(FLOOR_MAP_STATES.length);
    expect(new Set(FLOOR_MAP_STATES.map((k) => FLOOR_MAP_LEGEND[k].label)).size).toBe(FLOOR_MAP_STATES.length);
    expect(spaceMatches(sp(), 's30')).toBe(true);
    expect(spaceMatches(sp(), '合成spa')).toBe(true);
    expect(spaceMatches(sp(), '品牌')).toBe(true);
    expect(spaceMatches(sp(), 'G3')).toBe(false);
    expect(spaceMatches(sp(), '  ')).toBe(true);
  });
});

describe('派钟选房间', () => {
  it('可选的房间：在用、可售的技师服务类空间，带占用；没有钟房权限的看不了', async () => {
    const r = await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom/spaces');
    expect(r.status).toBe(200);
    expect((r.body as { code: string; serving: number; waiting: number }[]).map((s) => [s.code, s.serving, s.waiting])).toEqual([
      ['F312', 0, 0],
      ['S301', 0, 0],
      ['S302', 0, 0],
    ]);
    expect((await api(ctx.app, manager, 'GET', '/api/clockroom/spaces')).status).toBe(403);
  });

  it('派钟带房间：钟单记下房间，钟房看板、平面图、钟房日志都看得到；不是技师房、停用、不可售、不存在的拒绝', async () => {
    const a = await enter();
    const s301 = await space('S301');
    const r = await dispatch({ visitId: a.visitId, technicianId: tech['01'], spaceId: s301.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = await sessionOf(a.visitId);
    expect([s.status, s.space]).toEqual(['serving', { id: s301.id, code: 'S301', displayName: '合成SPA 1人间' }]);
    const m = await map();
    expect(m.sessions.map((x) => [x.spaceId, x.techNo, x.tagCode, x.status])).toEqual([[s301.id, '01', a.tagCode, 'serving']]);
    expect(m.sessions[0]!.plannedEnd).not.toBeNull();
    const spaces = (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom/spaces')).body as { code: string; serving: number }[];
    expect(spaces.find((x) => x.code === 'S301')!.serving).toBe(1);
    const events = (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom/events')).body as { kind: string; text: string }[];
    expect(events.find((e) => e.kind === 'dispatch')!.text).toContain('房间 S301 · 合成SPA 1人间');

    const b = await enter();
    const bad = async (code: string) => (await dispatch({ visitId: b.visitId, technicianId: tech['02'], spaceId: (await space(code)).id })).body.error?.code;
    expect(await bad('G301')).toBe('SPACE_NOT_SERVICE');
    expect(await bad('P201')).toBe('SPACE_NOT_SERVICE');
    expect(await bad('S303')).toBe('SPACE_NOT_SELLABLE');
    expect((await dispatch({ visitId: b.visitId, technicianId: tech['02'], spaceId: 999_999 })).status).toBe(404);
    // 被拒绝的派钟没有挂账、没有钟单
    expect((await sessions()).filter((x) => x.visitId === b.visitId)).toEqual([]);
  });

  it('同一个操作编号原样重发照常返回、不重复派；换了房间重发拒绝；不带房间与升级前一样', async () => {
    const c = await enter();
    const key = randomUUID();
    const s302 = await space('S302');
    const body = { visitId: c.visitId, technicianId: tech['02'], spaceId: s302.id };
    expect((await dispatch(body, key)).status).toBe(200);
    expect((await dispatch(body, key)).status).toBe(200);
    expect((await sessions()).filter((x) => x.visitId === c.visitId)).toHaveLength(1);
    const other = await dispatch({ ...body, spaceId: (await space('F312')).id }, key);
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const d = await enter();
    expect((await dispatch({ visitId: d.visitId, technicianId: tech['03'], spaceId: null })).status).toBe(200);
    expect((await sessionOf(d.visitId)).space).toBeNull();
  });
});

describe('换房间', () => {
  it('补选、换、清掉房间都记钟房日志、版本号加 1；版本号对不上拒绝；已经是这间照常返回；只能换到技师房', async () => {
    const d = (await sessions()).find((x) => x.techNo === '03')!;
    expect([d.space, d.spaceVersion]).toEqual([null, 0]);
    const s302 = await space('S302');
    const f312 = await space('F312');
    expect((await setRoom(d.id, f312.id, 1)).body.error.code).toBe('SESSION_SPACE_STALE');
    expect((await setRoom(d.id, (await space('G302')).id, 0)).body.error.code).toBe('SPACE_NOT_SERVICE');
    expect((await setRoom(d.id, f312.id, 0)).status).toBe(200);
    expect(await sessionOf(d.visitId)).toMatchObject({ space: { code: 'F312' }, spaceVersion: 1 });
    // 重发、两个人同时选了同一间：照常返回，不改版本号、不另记日志
    expect((await setRoom(d.id, f312.id, 0)).status).toBe(200);
    expect((await sessionOf(d.visitId)).spaceVersion).toBe(1);
    expect((await setRoom(d.id, s302.id, 1)).status).toBe(200);
    expect((await setRoom(d.id, null, 2)).status).toBe(200);
    expect(await sessionOf(d.visitId)).toMatchObject({ space: null, spaceVersion: 3 });
    const events = (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom/events')).body as { kind: string; text: string; sessionNo: string }[];
    expect(events.filter((e) => e.kind === 'room').map((e) => e.text)).toEqual(['清掉房间 S302 · 合成SPA 2人间', '房间 F312 · 合成足浴 4人间 → S302 · 合成SPA 2人间', '选房间 F312 · 合成足浴 4人间']);
    expect((await api(ctx.app, manager, 'POST', `/api/clockroom/sessions/${d.id}/space`, { spaceId: f312.id, expectedVersion: 3 })).status).toBe(403);
  });

  it('超时后迟到的旧请求：中间换过又换回原来的房间（A → C → A），旧请求照样被拒绝，不盖掉后来的修改', async () => {
    const d = (await sessions()).find((x) => x.techNo === '03')!;
    const s302 = await space('S302');
    const f312 = await space('F312');
    // 页面看到「没有房间、版本 3」时发出「换到 S302」，请求在路上耽搁了
    const seen = d.spaceVersion;
    expect([d.space, seen]).toEqual([null, 3]);
    // 这期间另一台终端换到 F312、又清掉（回到没有房间）
    expect((await setRoom(d.id, f312.id, seen)).status).toBe(200);
    expect((await setRoom(d.id, null, seen + 1)).status).toBe(200);
    // 迟到的那次到了：房间与看到时一样，但版本号对不上，拒绝
    expect((await setRoom(d.id, s302.id, seen)).body.error.code).toBe('SESSION_SPACE_STALE');
    expect(await sessionOf(d.visitId)).toMatchObject({ space: null, spaceVersion: seen + 2 });
    // 按看板上现在的版本号再选
    expect((await setRoom(d.id, f312.id, seen + 2)).status).toBe(200);
    expect(await sessionOf(d.visitId)).toMatchObject({ space: { code: 'F312' }, spaceVersion: seen + 3 });
  });
});

describe('空间台账与钟单', () => {
  it('房间里还有没结束的钟单：不能停用、不能改成非技师服务的业态；改成别的技师服务业态可以；客人结账离店后可以停用', async () => {
    expect((await editSpace('S301', { active: false })).body.error.code).toBe('SPACE_HAS_SESSIONS');
    expect((await editSpace('S301', { businessType: '娱乐室' })).body.error.code).toBe('SPACE_HAS_SESSIONS');
    expect((await editSpace('S301', { businessType: '按摩' })).status).toBe(200);
    expect((await editSpace('S301', { businessType: 'SPA' })).status).toBe(200);
    // 改显示名、容量照常
    expect((await editSpace('S301', { displayName: '合成SPA 单人间' })).status).toBe(200);
    await allChecksOk();
    const a = (await sessions()).find((x) => x.space?.code === 'S301')!;
    await pay(a.visitId);
    expect((await map()).sessions.some((x) => x.spaceId === a.space!.id)).toBe(false);
    expect((await editSpace('S301', { active: false })).status).toBe(200);
    expect((await editSpace('S301', { active: true })).status).toBe(200);
    await allChecksOk();
  });

  it('自检：没结束的钟单记的房间停用了（绕过接口改库）会报出来', async () => {
    const f312 = await space('F312');
    await ctx.sql`UPDATE spaces SET active = false WHERE id = ${f312.id}`;
    const bad = (await spaceChecks(ctx.sql)).find((c) => c.label === '钟单记的房间是在用的技师服务类空间')!;
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('F312');
    await ctx.sql`UPDATE spaces SET active = true WHERE id = ${f312.id}`;
    await allChecksOk();
  });
});

describe('平面图接口', () => {
  it('空间（含楼层、区域、别名、挂接的房间）、在用底图批次；看得到客房的岗位能看，别的不行；房态看板带空间编号', async () => {
    const g301 = await space('G301');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/spaces/${g301.id}/aliases`, { alias: '合成品牌名 C5', kind: 'brand' })).status).toBe(200);
    const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '大床房', kind: 'daily', price: 30000 });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo: '', floor: '3', roomTypeId: t.body.types[0].id, spaceId: g301.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const roomId = r.body.rooms[0].id as number;

    const zone = (await ledger()).zones.find((z) => z.name === '合成SPA区')!;
    expect((await editSpace('S301', { zoneId: zone.id })).status).toBe(200);
    const m = await map();
    expect(m.floorplanBatchId).toBeNull();
    expect(m.spaces.map((s) => s.code)).toEqual(['P201', 'F312', 'G301', 'G302', 'S301', 'S302', 'S303']);
    expect(m.spaces.find((s) => s.code === 'G301')).toMatchObject({ floorCode: 'L3', businessType: '客房', roomId, aliases: ['合成客房 G301', '合成品牌名 C5'] });
    expect(m.spaces.find((s) => s.code === 'S303')).toMatchObject({ sellable: false, active: true, roomId: null });
    expect(m.spaces.find((s) => s.code === 'S301')!.zoneName).toBe('合成SPA区');

    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/rooms')).body as { rooms: RoomBoardRoom[] };
    expect(board.rooms.find((x) => x.id === roomId)!.spaceId).toBe(g301.id);

    const status = (code: string) => {
      const s = m.spaces.find((x) => x.code === code)!;
      return spaceStatus(s, board.rooms.find((x) => x.spaceId === s.id), m.sessions).state;
    };
    expect([status('G301'), status('G302'), status('F312'), status('S302'), status('S303'), status('P201')]).toEqual(['vacant', 'unlinked', 'serving', 'serving', 'off', 'other']);

    await createStaff(ctx.sql, { username: 'bo', displayName: '后勤', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
    const bo = await login(ctx.app, 'bo');
    expect((await api(ctx.app, bo, 'GET', '/api/floormap')).status).toBe(200);
    expect((await api(ctx.app, manager, 'GET', '/api/floormap')).status).toBe(403);
    // 只带手牌号与技师，不带会员姓名、手机号
    expect(Object.keys(m.sessions[0]!).sort()).toEqual(['clocks', 'createdAt', 'id', 'itemName', 'minutes', 'plannedEnd', 'sessionNo', 'spaceId', 'startedAt', 'status', 'tagCode', 'techName', 'techNo']);
  });
});
