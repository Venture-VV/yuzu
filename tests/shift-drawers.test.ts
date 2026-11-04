// v0.7.28 ⑨（docs/SCHEDULE_FINISH.md 第 10 节，N11）：按钱箱交班。全部是合成数据。
//   · 默认按人交班（照旧）；后台切到按钱箱交班：开班选钱箱，同一个钱箱的人加入同一个班次，收款记到经办人此刻所在的班次；
//   · 中途离开钱箱：班次照常开着，之后本人的收款不再记进来（收款前要先开班时整笔拒绝）；离开后可以去开另一个钱箱；
//   · 交班：在这个钱箱上的人（或值班经理及以上）点钱交班，在上面的人一起离开；交班表另列各人经办的结账与充值；
//   · 切换交班方式不用等大家交班：开着的班照旧到交班为止，新开的按新做法；按人交班的班次不能加入、不能离开。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrawerBoard, ShiftRecord } from '../src/shared/checkout';
import { createStaff } from '../src/server/modules/staff';
import { lockPaymentShift } from '../src/server/modules/shifts';
import { frontdeskChecks } from '../src/server/modules/frontdesk/checks';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let amy: { id: number; cookie: string };
let ben: { id: number; cookie: string };
let duty: { id: number; cookie: string };
let memberId: number;

const staff = async (username: string, displayName: string, role: 'clerk' | 'duty_manager') => {
  const id = await createStaff(ctx.sql, { username, displayName, role, password: PASSWORD, mustChangePassword: false });
  return { id, cookie: await login(ctx.app, username) };
};
const board = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/shifts/drawers')).body as DrawerBoard;
const current = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/shifts/current')).body.shift as ShiftRecord | null;
const cash = (cookie: string, amount: number) =>
  api(ctx.app, cookie, 'POST', '/api/recharges', { ...rechargeBody(memberId, amount, 0, { paymentMethod: 'cash' }), idempotencyKey: randomUUID() });
const shiftOfRecharge = async (id: number) => (await ctx.sql<{ shiftId: number | null }[]>`SELECT shift_id FROM recharges WHERE id = ${id}`)[0]!.shiftId;
const settings = (body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', '/api/settings', body);

beforeAll(async () => {
  ctx = await setup();
  amy = await staff('amy', '前台小艾', 'clerk');
  ben = await staff('ben', '前台小本', 'clerk');
  duty = await staff('duty', '值班经理', 'duty_manager');
  memberId = (await createMember(ctx, '钱箱会员', '19922220001')).id;
  // 收款前必须先开班（测试库默认关着）
  expect((await settings({ requireOpenShift: true })).status).toBe(200);
});
afterAll(async () => ctx?.close());

describe('按钱箱交班', () => {
  it('默认按人交班：开班只填备用金，不能加入、不能离开', async () => {
    expect(await board(amy.cookie)).toMatchObject({ mode: 'person', mine: null });
    const s = await api(ctx.app, amy.cookie, 'POST', '/api/shifts', { openingCash: 0 });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ drawerName: null, members: [{ staffId: amy.id, leftAt: null }] });
    expect((await api(ctx.app, ben.cookie, 'POST', `/api/shifts/${s.body.id}/join`, {})).body.error.code).toBe('NOT_DRAWER_SHIFT');
    expect((await api(ctx.app, amy.cookie, 'POST', `/api/shifts/${s.body.id}/leave`, {})).body.error.code).toBe('NOT_DRAWER_SHIFT');
    // 开班时选了钱箱：现在是按人交班，拒绝
    expect((await api(ctx.app, ben.cookie, 'POST', '/api/shifts', { openingCash: 0, drawer: 'k1' })).body.error.code).toBe('SHIFT_MODE_CHANGED');
    expect((await api(ctx.app, amy.cookie, 'POST', `/api/shifts/${s.body.id}/close`, { countedCash: 0, expectedCash: 0 })).status).toBe(200);
  });

  it('后台切到按钱箱交班：钱箱不能删、名字不重复、至少一个启用的；新钱箱按顺序编号', async () => {
    expect((await settings({ cashDrawers: [] })).status).toBe(400);
    expect((await settings({ cashDrawers: [{ key: 'k1', label: '1 号钱箱' }, { label: '1 号钱箱' }] })).status).toBe(400);
    expect((await settings({ shiftMode: 'drawer', cashDrawers: [{ key: 'k1', label: '1 号钱箱', active: false }] })).status).toBe(400);
    const saved = await settings({ shiftMode: 'drawer', cashDrawers: [{ key: 'k1', label: '1 号钱箱', active: true }, { label: '2 号钱箱', active: true }] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ shiftMode: 'drawer', cashDrawers: [{ key: 'k1' }, { key: 'k2', label: '2 号钱箱' }] });
    expect((await board(amy.cookie)).drawers.map((d) => [d.key, d.shift])).toEqual([
      ['k1', null],
      ['k2', null],
    ]);
  });

  it('开班选钱箱；同一个钱箱再开要「加入」；已经在一个班次上的不能再开、再加入', async () => {
    expect((await api(ctx.app, amy.cookie, 'POST', '/api/shifts', { openingCash: 20000 })).status).toBe(400);
    expect((await api(ctx.app, amy.cookie, 'POST', '/api/shifts', { openingCash: 20000, drawer: 'k9' })).status).toBe(400);
    const s = await api(ctx.app, amy.cookie, 'POST', '/api/shifts', { openingCash: 20000, drawer: 'k1' });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toMatchObject({ drawerName: '1 号钱箱', staffId: amy.id, members: [{ staffId: amy.id, leftAt: null }] });
    const taken = await api(ctx.app, ben.cookie, 'POST', '/api/shifts', { openingCash: 0, drawer: 'k1' });
    expect(taken.body.error.code).toBe('DRAWER_OPEN');
    expect(taken.body.error.message).toContain('加入');
    const joined = await api(ctx.app, ben.cookie, 'POST', `/api/shifts/${s.body.id}/join`, {});
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect((joined.body as ShiftRecord).members.map((m) => [m.staffName, m.leftAt])).toEqual([
      ['前台小艾', null],
      ['前台小本', null],
    ]);
    expect((await api(ctx.app, ben.cookie, 'POST', `/api/shifts/${s.body.id}/join`, {})).body.error.code).toBe('SHIFT_OPEN');
    expect((await api(ctx.app, ben.cookie, 'POST', '/api/shifts', { openingCash: 0, drawer: 'k2' })).body.error.code).toBe('SHIFT_OPEN');
    const b = await board(duty.cookie);
    expect(b.drawers.find((d) => d.key === 'k1')!.shift!.members.map((m) => m.staffName)).toEqual(['前台小艾', '前台小本']);
    expect(b.mine).toBeNull();
    expect((await board(ben.cookie)).mine).toBe(s.body.id);
  });

  it('两个人的收款都记到这个钱箱的班次；离开之后本人收款要先开班，这个钱箱照常开着', async () => {
    const shift = (await current(amy.cookie))!;
    expect((await current(ben.cookie))!.id).toBe(shift.id);
    const a = await cash(amy.cookie, 10000);
    const b = await cash(ben.cookie, 20000);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await shiftOfRecharge(a.body.recharge.id)).toBe(shift.id);
    expect(await shiftOfRecharge(b.body.recharge.id)).toBe(shift.id);
    const now = (await current(amy.cookie))!;
    expect(now.summary.cash.expected).toBe(20000 + 30000);
    expect(now.summary.byOperator?.map((o) => [o.staffName, o.recharges.count, o.recharges.paid])).toEqual([
      ['前台小本', 1, 20000],
      ['前台小艾', 1, 10000],
    ]);

    // 小本离开钱箱
    const left = await api(ctx.app, ben.cookie, 'POST', `/api/shifts/${shift.id}/leave`, {});
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect((left.body as ShiftRecord).members.find((m) => m.staffId === ben.id)!.leftAt).not.toBeNull();
    expect(await current(ben.cookie)).toBeNull();
    expect((await cash(ben.cookie, 5000)).body.error.code).toBe('SHIFT_REQUIRED');
    // 离开之前开始的收款（已经记下了这个班次）在离开之后才入账：整笔拒绝，提示离开了钱箱
    await expect(ctx.sql.begin((tx) => lockPaymentShift(tx, ben.id, shift.id))).rejects.toMatchObject({ code: 'SHIFT_CLOSED', message: expect.stringContaining('离开') });
    expect((await api(ctx.app, ben.cookie, 'POST', `/api/shifts/${shift.id}/leave`, {})).body.error.code).toBe('NOT_ON_SHIFT');
    // 离开后可以去开另一个钱箱
    const k2 = await api(ctx.app, ben.cookie, 'POST', '/api/shifts', { openingCash: 5000, drawer: 'k2' });
    expect(k2.status, JSON.stringify(k2.body)).toBe(200);
    const c = await cash(ben.cookie, 3000);
    expect(await shiftOfRecharge(c.body.recharge.id)).toBe(k2.body.id);
    expect((await current(amy.cookie))!.summary.recharges.paid).toBe(30000);
    // 退现金选钱箱：显示钱箱名，在上面的人标「我的」
    const drawers = (await api(ctx.app, ben.cookie, 'GET', `/api/members/${memberId}/refund-drawers`)).body;
    expect(drawers.shifts.map((x: { drawerName: string; mine: boolean }) => [x.drawerName, x.mine])).toEqual([
      ['1 号钱箱', false],
      ['2 号钱箱', true],
    ]);
    // 看板的当班中：钱箱名（此刻在上面的人）
    const dash = (await api(ctx.app, ctx.owner, 'GET', '/api/dashboard')).body;
    expect(dash.openShifts.map((s: { staffName: string }) => s.staffName)).toEqual(['1 号钱箱（前台小艾）', '2 号钱箱（前台小本）']);
  });

  it('交班：不在这个钱箱上的店员不能交，在上面的人可以；交班后所有人离开，交班表记各人经办', async () => {
    const shift = (await current(amy.cookie))!;
    // 小本离开过 1 号钱箱：还能看这个班次，但不能交
    expect((await api(ctx.app, ben.cookie, 'GET', `/api/shifts/${shift.id}`)).status).toBe(200);
    const notOn = await api(ctx.app, ben.cookie, 'POST', `/api/shifts/${shift.id}/close`, { countedCash: 50000, expectedCash: 50000 });
    expect(notOn.status).toBe(403);
    expect(notOn.body.error.message).toContain('1 号钱箱');
    const closed = await api(ctx.app, amy.cookie, 'POST', `/api/shifts/${shift.id}/close`, { countedCash: 50000, expectedCash: 50000, note: '1 号钱箱交班' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const rec = closed.body as ShiftRecord;
    expect(rec).toMatchObject({ status: 'closed', drawerName: '1 号钱箱', countedCash: 50000, expectedCash: 50000 });
    expect(rec.members.every((m) => m.leftAt !== null)).toBe(true);
    expect(rec.summary.byOperator?.map((o) => o.staffName)).toEqual(['前台小本', '前台小艾']);
    expect(await current(amy.cookie)).toBeNull();
    // 交班之后不能再加入
    expect((await api(ctx.app, duty.cookie, 'POST', `/api/shifts/${shift.id}/join`, {})).body.error.code).toBe('SHIFT_CLOSED');
    // 值班经理可以替别人交班（2 号钱箱上只有小本）
    const k2 = (await current(ben.cookie))!;
    const byDuty = await api(ctx.app, duty.cookie, 'POST', `/api/shifts/${k2.id}/close`, { countedCash: 8000, expectedCash: 8000 });
    expect(byDuty.status, JSON.stringify(byDuty.body)).toBe(200);
    expect(byDuty.body.closedByName).toBe('值班经理');
    // 成员记录只追加
    await expect(ctx.sql`DELETE FROM shift_members WHERE shift_id = ${shift.id}`).rejects.toThrow(/禁止删除/);
    await expect(ctx.sql`UPDATE shift_members SET left_at = now() WHERE shift_id = ${shift.id}`).rejects.toThrow(/只能离开一次/);
  });

  it('切换交班方式不用等大家交班：开着的钱箱班次照旧，新开的按人交班；自检通过', async () => {
    const k1 = await api(ctx.app, amy.cookie, 'POST', '/api/shifts', { openingCash: 0, drawer: 'k1' });
    expect(k1.status).toBe(200);
    expect((await settings({ shiftMode: 'person' })).status).toBe(200);
    // 开着的钱箱班次照旧：小艾的收款仍记进去，小本还能加入、离开
    const a = await cash(amy.cookie, 1000);
    expect(await shiftOfRecharge(a.body.recharge.id)).toBe(k1.body.id);
    expect((await api(ctx.app, ben.cookie, 'POST', `/api/shifts/${k1.body.id}/join`, {})).status).toBe(200);
    expect((await api(ctx.app, ben.cookie, 'POST', `/api/shifts/${k1.body.id}/leave`, {})).status).toBe(200);
    // 新开的按人交班
    const mine = await api(ctx.app, ben.cookie, 'POST', '/api/shifts', { openingCash: 0 });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.drawerName).toBeNull();
    // 还开着班的 1 号钱箱也能停用（开着的班照旧到交班为止）；看板只列启用的与还开着班的钱箱
    expect((await settings({ shiftMode: 'drawer', cashDrawers: [{ key: 'k1', label: '1 号钱箱', active: false }, { key: 'k2', label: '2 号钱箱', active: true }] })).status).toBe(200);
    expect((await board(duty.cookie)).drawers.map((d) => [d.key, d.active, d.shift?.id ?? null])).toEqual([
      ['k1', false, k1.body.id],
      ['k2', true, null],
    ]);
    // 停用的钱箱不能新开
    expect((await api(ctx.app, amy.cookie, 'POST', `/api/shifts/${k1.body.id}/close`, { countedCash: 1000, expectedCash: 1000 })).status).toBe(200);
    expect((await api(ctx.app, amy.cookie, 'POST', '/api/shifts', { openingCash: 0, drawer: 'k1' })).status).toBe(400);
    const checks = await frontdeskChecks(ctx.sql);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.find((c) => c.key === 'shift_members')!.detail).toContain('未交班的班次 1 个');
  });
});
