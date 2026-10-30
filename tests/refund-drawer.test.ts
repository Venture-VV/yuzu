// 跨钱箱退款（店主 2026-10-30 定，方案 A；PENDING_DECISIONS V71-c）：反结账退现金时选从哪个钱箱退，
// 退款记到那个钱箱当班的班次，扣减它的应有现金；建议的默认是原单收款的班次（仍在班上时），否则是自己的班次。
//   · 所选班次已交班、是升级前开的：整笔拒绝，什么都不改；
//   · 选了钱箱就不要求反结账人自己开班；不选时与原来一样记到反结账人自己的班次；
//   · 反结账之后交班：员工看到的应有现金过期时 SHIFT_CHANGED，快照里写明是谁做的反结账；
//   · 只有能反结账的岗位能看可选的钱箱。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let duty2: string;
let clerk2: string;
let tagNo = 0;

type Summary = { cash: { expected: number; refund?: number }; voids: { checkoutNo: string; cashRefund?: number; voidedByName?: string }[] };
type Options = { shifts: { id: number; shiftNo: string; staffName: string; mine: boolean; original: boolean }[]; suggested: number | null };

const openShift = async (cookie: string, openingCash = 0) => {
  const r = await api(ctx.app, cookie, 'POST', '/api/shifts', { openingCash });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { id: number; shiftNo: string };
};
const current = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/shifts/current')).body.shift as { id: number; summary: Summary } | null;
const closeShift = (cookie: string, id: number, expectedCash: number) =>
  api(ctx.app, cookie, 'POST', `/api/shifts/${id}/close`, { countedCash: Math.max(0, expectedCash), expectedCash, note: '测试交班' });
/** 店员接待一位客人并结账（默认现金），返回结账单 */
const cashCheckout = async (cookie: string, method: 'cash' | 'wechat' = 'cash') => {
  tagNo += 1;
  const code = `D${String(tagNo).padStart(3, '0')}`;
  const v = await api(ctx.app, cookie, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.visits[0].id as number;
  const pre = (await api(ctx.app, cookie, 'GET', `/api/frontdesk/checkout-preview?ids=${id}`)).body;
  const c = await api(ctx.app, cookie, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [id],
    expectedTotal: pre.totalAmount,
    payments: [{ method, amount: pre.totalAmount }],
  });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return c.body as { id: number; checkoutNo: string; totalAmount: number };
};
const options = async (cookie: string, checkoutId: number) => (await api(ctx.app, cookie, 'GET', `/api/frontdesk/checkouts/${checkoutId}/refund-shifts`)).body as Options;
const voidTo = (cookie: string, checkoutId: number, refundShiftId?: number) =>
  api(ctx.app, cookie, 'POST', `/api/frontdesk/checkouts/${checkoutId}/void`, { reason: '收款方式记错', ...(refundShiftId ? { refundShiftId } : {}) });

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { requireOpenShift: true })).status).toBe(200);
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'duty2', displayName: '没开班的经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'clerk2', displayName: '晚班店员', role: 'clerk', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  duty2 = await login(ctx.app, 'duty2');
  clerk2 = await login(ctx.app, 'clerk2');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'D', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('跨钱箱退款', () => {
  it('从原收款人的钱箱退：退款记到收银员的班次，与原单相抵；值班经理的班次不变；交班表写明是谁反结账的', async () => {
    const mine = await openShift(ctx.clerk, 50000);
    const dutyShift = await openShift(duty, 0);
    const c = await cashCheckout(ctx.clerk);
    const opts = await options(duty, c.id);
    expect(opts.shifts.map((s) => [s.staffName, s.original, s.mine])).toEqual([
      ['测试店员', true, false],
      ['值班经理', false, true],
    ]);
    expect(opts.suggested).toBe(mine.id);
    const before = (await current(ctx.clerk))!.summary.cash.expected;
    expect(before).toBe(50000 + c.totalAmount);

    expect((await voidTo(duty, c.id, mine.id)).status).toBe(200);
    // 收银员反结账之前看到的应有现金过期了：交班被拒（反结账先拿到班次的共享锁，交班要按新的应有现金核对）
    expect((await closeShift(ctx.clerk, mine.id, before)).body.error.code).toBe('SHIFT_CHANGED');
    const clerkNow = (await current(ctx.clerk))!.summary;
    expect(clerkNow.cash.expected).toBe(50000);
    expect(clerkNow.cash.refund).toBe(c.totalAmount);
    expect(clerkNow.voids.find((v) => v.checkoutNo === c.checkoutNo)).toMatchObject({ cashRefund: c.totalAmount, voidedByName: '值班经理' });
    const dutyNow = (await current(duty))!.summary;
    expect(dutyNow.cash.expected).toBe(0);
    expect(dutyNow.voids).toEqual([]);
    const [row] = await ctx.sql<{ voidShiftId: number }[]>`SELECT void_shift_id FROM checkouts WHERE id = ${c.id}`;
    expect(row!.voidShiftId).toBe(mine.id);
    const [audit] = await ctx.sql<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM audit_logs WHERE action = 'frontdesk_checkout_void' AND target_id = ${String(c.id)} ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail).toMatchObject({ refundDrawer: '测试店员' });
    // 本人做的反结账不写「谁做的」
    const c2 = await cashCheckout(ctx.clerk);
    expect((await voidTo(duty, c2.id, dutyShift.id)).status).toBe(200);
    expect((await current(duty))!.summary.voids.find((v) => v.checkoutNo === c2.checkoutNo)).not.toHaveProperty('voidedByName');
    // 按新的应有现金交班，快照里写明是谁做的反结账
    const closed = await closeShift(ctx.clerk, mine.id, (await current(ctx.clerk))!.summary.cash.expected);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((closed.body.summary as Summary).voids.find((v) => v.checkoutNo === c.checkoutNo)?.voidedByName).toBe('值班经理');
    expect((await closeShift(duty, dutyShift.id, (await current(duty))!.summary.cash.expected)).status).toBe(200);
  });

  it('原单的班次已交班：默认自己的班次；自己没开班、只有一位当班时默认那一位；都没有时不预选', async () => {
    const day = await openShift(ctx.clerk, 0);
    const c = await cashCheckout(ctx.clerk);
    expect((await closeShift(ctx.clerk, day.id, (await current(ctx.clerk))!.summary.cash.expected)).status).toBe(200);
    expect(await options(duty, c.id)).toEqual({ shifts: [], suggested: null });
    const night = await openShift(clerk2, 20000);
    let opts = await options(duty, c.id);
    expect(opts.shifts.map((s) => s.staffName)).toEqual(['晚班店员']);
    expect(opts.suggested).toBe(night.id);
    const dutyShift = await openShift(duty, 0);
    opts = await options(duty, c.id);
    expect(opts.suggested).toBe(dutyShift.id);
    // 自己没开班也能从晚班的钱箱退（规则「收款前必须先开班」开着）
    expect(await current(duty2)).toBeNull();
    expect((await voidTo(duty2, c.id, night.id)).status).toBe(200);
    expect((await current(clerk2))!.summary.cash.expected).toBe(20000 - c.totalAmount);
    expect((await current(duty))!.summary.cash.expected).toBe(0);
    // 不选钱箱：与原来一样要反结账人自己开班
    const c2 = await cashCheckout(clerk2);
    expect((await voidTo(duty2, c2.id)).body.error.code).toBe('SHIFT_REQUIRED');
    for (const [cookie, id] of [
      [clerk2, night.id],
      [duty, dutyShift.id],
    ] as const) {
      expect((await closeShift(cookie, id, (await current(cookie))!.summary.cash.expected)).status).toBe(200);
    }
  });

  it('所选钱箱的班次已交班或是升级前开的：整笔拒绝，结账单、来访、班次都不变', async () => {
    const s = await openShift(ctx.clerk, 0);
    const c = await cashCheckout(ctx.clerk);
    const other = await openShift(clerk2, 0);
    expect((await closeShift(clerk2, other.id, 0)).status).toBe(200);
    const closed = await voidTo(duty, c.id, other.id);
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('REFUND_SHIFT_CLOSED');
    expect(closed.body.error.message).toContain('晚班店员');
    // 升级前开的班次（迁移 017 之前）：退款不按钱箱记，不能选，也不在可选列表里
    const legacyStaff = await createStaff(ctx.sql, { username: 'old', displayName: '老班次', role: 'clerk', password: PASSWORD, mustChangePassword: false });
    const [legacy] = await ctx.sql<{ id: number }[]>`
      INSERT INTO shifts (shift_no, staff_id, business_date, started_at, opening_cash, legacy_refund)
      VALUES ('BC-LEGACY', ${legacyStaff}, current_date, now(), 0, true) RETURNING id`;
    expect((await options(duty, c.id)).shifts.map((x) => x.shiftNo)).not.toContain('BC-LEGACY');
    expect((await voidTo(duty, c.id, legacy!.id)).body.error.code).toBe('REFUND_SHIFT_LEGACY');
    expect((await voidTo(duty, c.id, 999_999)).status).toBe(404);
    const [row] = await ctx.sql<{ status: string; voidShiftId: number | null }[]>`SELECT status, void_shift_id FROM checkouts WHERE id = ${c.id}`;
    expect(row).toEqual({ status: 'completed', voidShiftId: null });
    expect((await current(ctx.clerk))!.summary.cash.expected).toBe(c.totalAmount);
    expect((await voidTo(duty, c.id, s.id)).status).toBe(200);
    expect((await current(ctx.clerk))!.summary.cash.expected).toBe(0);
    expect((await closeShift(ctx.clerk, s.id, 0)).status).toBe(200);
  });

  it('原单没收现金（只收了扫码）：不能选钱箱，整笔拒绝；反结账人要先开班，原路退回的提醒记到自己的班次（PR #17 复测 P2）', async () => {
    const night = await openShift(clerk2, 0);
    const c = await cashCheckout(clerk2, 'wechat');
    expect(await current(duty2)).toBeNull();
    const r = await voidTo(duty2, c.id, night.id);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('REFUND_SHIFT_NOT_CASH');
    const [row] = await ctx.sql<{ status: string; voidShiftId: number | null }[]>`SELECT status, void_shift_id FROM checkouts WHERE id = ${c.id}`;
    expect(row).toEqual({ status: 'completed', voidShiftId: null });
    expect((await current(clerk2))!.summary.voids).toEqual([]);
    // 不选钱箱：与页面一致要先开班；开班后记到反结账人自己的班次
    expect((await voidTo(duty2, c.id)).body.error.code).toBe('SHIFT_REQUIRED');
    const own = await openShift(duty2, 0);
    expect((await voidTo(duty2, c.id)).status).toBe(200);
    const [after] = await ctx.sql<{ voidShiftId: number | null }[]>`SELECT void_shift_id FROM checkouts WHERE id = ${c.id}`;
    expect(after!.voidShiftId).toBe(own.id);
    expect((await current(duty2))!.summary.voids.map((v) => v.checkoutNo)).toEqual([c.checkoutNo]);
    expect((await current(clerk2))!.summary.voids).toEqual([]);
    for (const [cookie, id] of [
      [clerk2, night.id],
      [duty2, own.id],
    ] as const) {
      expect((await closeShift(cookie, id, (await current(cookie))!.summary.cash.expected)).status).toBe(200);
    }
  });

  it('只有能反结账的岗位能看可选的钱箱；前台自检与日结核对照常通过', async () => {
    const s = await openShift(ctx.clerk, 0);
    const c = await cashCheckout(ctx.clerk);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts/${c.id}/refund-shifts`)).status).toBe(403);
    expect((await api(ctx.app, duty, 'GET', '/api/frontdesk/checkouts/999999/refund-shifts')).status).toBe(404);
    expect((await voidTo(ctx.clerk, c.id, s.id)).status).toBe(403);
    const checks = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean; detail: string }[];
    expect(checks.filter((x) => !x.ok)).toEqual([]);
  });
});
