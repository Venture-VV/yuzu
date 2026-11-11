// 8.0.8 前台整改 · 客房（docs/FRONTDESK_V808.md 第 6 节）：
//   · B04 改房态：带上看到的房态，刚被别人改过拒绝（HOUSEKEEPING_CHANGED）；每次改动记房态记录（谁、从哪到哪、备注）；
//     最近一次手动修改、之后没再变过的能撤回一次（撤回成维修时恢复原来的原因；有人住着不能撤回成维修）；
//     退房、换房、撤销入住自动改成待打扫也记一条（自动）；房态没变的什么都不记。
//   · B07 房间详情：按时间倒序列出入住、换进换出、退房，房费、押金，住客住在这间期间的服务（技师、钟单）、餐饮、其他，房态记录；
//     换房前后的消费分别记在两间房上；金额与账单一致；超过 92 天拒绝。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoomBoard, RoomBoardRoom, RoomTimeline } from '../src/shared/rooms';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
const room: Record<string, number> = {};
const item: Record<string, number> = {};
let techId = 0;
let tagNo = 0;

const tile = async (roomNo: string) => ((await api(ctx.app, ctx.clerk, 'GET', '/api/rooms')).body as RoomBoard).rooms.find((r) => r.roomNo === roomNo) as RoomBoardRoom;
const housekeep = (roomNo: string, body: Record<string, unknown>) => api(ctx.app, ctx.clerk, 'PUT', `/api/rooms/${room[roomNo]}/housekeeping`, body);
const revert = (roomNo: string, eventId: number) => api(ctx.app, ctx.clerk, 'POST', `/api/rooms/${room[roomNo]}/housekeeping/revert`, { eventId });
const events = async (roomNo: string) =>
  ctx.sql<{ fromState: string; toState: string; source: string; note: string; ref: string; revertsId: number | null }[]>`
    SELECT from_state, to_state, source, note, ref, reverts_id FROM room_housekeeping_events WHERE room_id = ${room[roomNo]!} ORDER BY id`;
const enter = async () => {
  tagNo += 1;
  const code = `K${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { visitId: r.body.visits[0].id as number, code };
};
const checkin = async (roomNo: string, tagCode: string, extra: Record<string, unknown> = {}) => {
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkin', { clientKey: randomUUID(), roomId: room[roomNo], tagCode, guests: 1, expectedRate: 38800, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { id: number; stayNo: string; visitId: number };
};
const timeline = async (roomNo: string, query = '') => {
  const r = await api(ctx.app, ctx.clerk, 'GET', `/api/rooms/${room[roomNo]}/timeline${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as RoomTimeline;
};

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'K', from: 1, to: 30, width: 3, zone: 'male' })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(200);
  const rt = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '大床房', kind: 'daily', price: 38800 });
  expect(rt.status, JSON.stringify(rt.body)).toBe(200);
  const typeId = rt.body.types.find((t: { name: string }) => t.name === '大床房').id as number;
  for (const roomNo of ['W301', 'W302', 'W303', 'W304']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo, floor: '3', roomTypeId: typeId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    room[roomNo] = r.body.rooms.find((x: { roomNo: string }) => x.roomNo === roomNo).id;
  }
  // 技师：足疗（需要技师）；餐饮：简餐进厨房；搓背是普通项目
  for (const [name, category, price, extra] of [
    ['足疗', '足疗', 16800, { durationMinutes: 60, technicianRequired: true }],
    ['简餐', '主食', 3800, {}],
    ['搓背', '洗浴', 5000, {}],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: '41', name: '小林', gender: 'female', grade: 'standard' });
  techId = t.body.technicians.find((x: { techNo: string }) => x.techNo === '41').id;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${techId}/state`, { action: 'sign_in' })).status).toBe(200);
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '厨房' });
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '厨房').id as number;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: item['简餐'], stationId }] })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
});
afterAll(async () => ctx?.close());

describe('改房态要确认、可备注、能撤回（B04）', () => {
  it('带上看到的房态：刚被别人改过拒绝；记下谁改的、从哪到哪、备注；撤回一次回到改之前，不能再撤', async () => {
    expect(await tile('W302')).toMatchObject({ status: 'vacant', housekeeping: 'clean', lastChange: null });
    expect((await housekeep('W302', { status: 'dirty', expectedFrom: 'clean' })).status).toBe(200);
    // 另一个窗口还以为是「已打扫」
    const stale = await housekeep('W302', { status: 'maintenance', note: '漏水', expectedFrom: 'clean' });
    expect([stale.status, stale.body.error.code]).toEqual([409, 'HOUSEKEEPING_CHANGED']);
    const r = await housekeep('W302', { status: 'clean', note: '已检查', expectedFrom: 'dirty' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = (r.body as RoomBoard).rooms.find((x) => x.roomNo === 'W302')!;
    expect(after).toMatchObject({ status: 'vacant', housekeeping: 'clean', lastChange: { from: 'dirty', to: 'clean', note: '已检查', source: 'manual', staffName: '测试店员', canRevert: true } });
    // 撤回：回到待打扫，记一条「撤回」；同一条不能再撤
    const back = await revert('W302', after.lastChange!.id);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await tile('W302')).toMatchObject({ status: 'dirty', housekeeping: 'dirty', lastChange: { from: 'clean', to: 'dirty', source: 'revert', canRevert: false } });
    expect((await revert('W302', after.lastChange!.id)).body.error.code).toBe('HOUSEKEEPING_CHANGED');
    // 房态没变：什么都不记
    expect((await housekeep('W302', { status: 'dirty' })).status).toBe(200);
    expect((await events('W302')).map((e) => [e.fromState, e.toState, e.source, e.note])).toEqual([
      ['clean', 'dirty', 'manual', ''],
      ['dirty', 'clean', 'manual', '已检查'],
      ['clean', 'dirty', 'revert', '撤回上一次修改'],
    ]);
  });

  it('改维修必须写原因；撤回成维修时恢复原来的原因；有人住着不能撤回成维修', async () => {
    expect((await housekeep('W303', { status: 'maintenance' })).status).toBe(400);
    expect((await housekeep('W303', { status: 'maintenance', note: '空调不制冷', expectedFrom: 'clean' })).status).toBe(200);
    expect((await housekeep('W303', { status: 'clean', note: '修好了', expectedFrom: 'maintenance' })).status).toBe(200);
    const fixed = await tile('W303');
    expect(fixed.lastChange).toMatchObject({ from: 'maintenance', to: 'clean', canRevert: true });
    expect((await revert('W303', fixed.lastChange!.id)).status).toBe(200);
    expect(await tile('W303')).toMatchObject({ status: 'maintenance', maintenanceNote: '空调不制冷' });
    // 再修好、住进客人以后：不能撤回成维修
    expect((await housekeep('W303', { status: 'clean', expectedFrom: 'maintenance' })).status).toBe(200);
    const g = await enter();
    await checkin('W303', g.code);
    const busy = await tile('W303');
    expect(busy).toMatchObject({ status: 'occupied', housekeeping: 'clean', lastChange: { canRevert: true } });
    expect((await revert('W303', busy.lastChange!.id)).body.error.code).toBe('ROOM_IN_USE');
  });
});

describe('房间详情汇总（B07）', () => {
  it('入住、房费、押金、足疗（技师、钟单号）、简餐、换房、退房、自动改待打扫，按时间倒序；换房前后的消费各记在各自的房间上', async () => {
    const g = await enter();
    const s = await checkin('W301', g.code, { deposit: { method: 'cash', amount: 20000 } });
    // 在 W301 时点了一钟足疗、一份简餐
    const d = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', {
      clientKey: randomUUID(),
      visitId: g.visitId,
      itemId: item['足疗'],
      quantity: 1,
      technicianId: techId,
      callType: 'designated',
      startNow: true,
      expectedTotal: 16800,
    });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const food = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId: g.visitId, lines: [{ itemId: item['简餐'], quantity: 1 }], expectedTotal: 3800 });
    expect(food.status, JSON.stringify(food.body)).toBe(200);
    // 换到 W304，再搓个背
    const moved = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/move`, { toRoomId: room['W304'], reason: '客人嫌吵' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${g.visitId}/charges`, { clientKey: randomUUID(), lines: [{ itemId: item['搓背'], quantity: 1 }], expectedTotal: 5000 })).status).toBe(200);
    // 退房
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/rooms/stays/${s.id}/checkout-preview`)).body;
    const close = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/close`, { clientKey: randomUUID(), expectedDue: preview.dueAmount, expectedDeposits: preview.depositByMethod });
    expect(close.status, JSON.stringify(close.body)).toBe(200);

    const w301 = await timeline('W301');
    const sessionNo = (await ctx.sql<{ sessionNo: string }[]>`SELECT session_no FROM technician_sessions WHERE visit_id = ${g.visitId}`)[0]!.sessionNo;
    // 时间倒序：最新的在前
    expect([...w301.entries].map((e) => e.at)).toEqual([...w301.entries].map((e) => e.at).sort().reverse());
    const pick = (t: RoomTimeline) => t.entries.map((e) => [e.kind, e.title, e.amount, e.ref]).reverse();
    expect(pick(w301)).toEqual([
      ['stay', '入住', null, s.stayNo],
      ['charge', expect.stringContaining('房费'), 38800, s.stayNo],
      ['deposit', '收押金（现金）', 20000, s.stayNo],
      ['service', '足疗', 16800, sessionNo],
      ['dining', '简餐', 3800, expect.stringMatching(/^CD/)],
      ['stay', '换出（到 W304）', null, s.stayNo],
      ['housekeeping', '已打扫 → 待打扫', null, s.stayNo],
    ]);
    expect(w301.entries.find((e) => e.kind === 'service')!.detail).toContain('技师 41 小林');
    // W304：换进、搓背、退房（押金原路退回）、自动改待打扫
    const w304 = await timeline('W304');
    expect(pick(w304)).toEqual([
      ['stay', '换进（从 W301）', null, s.stayNo],
      ['other', '搓背', 5000, ''],
      ['deposit', '退押金（现金）', -20000, s.stayNo],
      ['stay', '退房', null, s.stayNo],
      ['housekeeping', '已打扫 → 待打扫', null, s.stayNo],
    ]);
    // 金额与账单一致：两间房记的消费加起来等于这位客人账单的有效金额
    const bill = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${g.visitId}`)).body as { lines: { amount: number; status: string }[] };
    const sum = (t: RoomTimeline) => t.entries.filter((e) => e.amount !== null && e.kind !== 'deposit' && e.status === null).reduce((n, e) => n + e.amount!, 0);
    expect(sum(w301) + sum(w304)).toBe(bill.lines.filter((l) => l.status === 'active').reduce((n, l) => n + l.amount, 0));
    // 日期范围：默认近 7 天；超过 92 天拒绝；后勤也能看
    expect(w301.to).toBe((await api(ctx.app, ctx.clerk, 'GET', '/api/business-day')).body.today);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/rooms/${room['W301']}/timeline?from=2026-01-01&to=2026-06-30`)).status).toBe(400);
    expect((await events('W301')).map((e) => [e.source, e.note])).toEqual([['auto', '换房到 W304']]);
    expect((await events('W304')).map((e) => [e.source, e.note])).toEqual([['auto', '退房']]);
  });
});
