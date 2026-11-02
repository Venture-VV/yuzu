// 退款单（v0.7.20，飞书 RQ-006；docs/CASHIER.md 第 3 节）：结账后按项部分退款。
//   · 按结账单的项目（部门快照的一项）退：份数、金额都不超过剩下的；金额默认是实收（应收 − 分摊的优惠）；
//   · 按原收款方式退：只退现金类，每种不超过原单这种方式收的钱；储值等不能部分退；扫码要登记退款单号；
//   · 现金从选定的钱箱退，扣减那个班次的应有现金；其余记到经办人自己的班次（只列提醒）；
//   · 有生效的退款单的结账单不能反结账；当天、班次没交班时可以作废退款单，作废后都不算；
//   · 值班经理及以上，超过撤销时限只有店主；同一操作编号只退一次；
//   · 日结、部门、看板、对账包、自检都按退款单冲减。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RefundDetail, RefundOptions } from '../src/shared/checkout';
import { createRefund } from '../src/server/modules/frontdesk/refunds';
import { buildDailyRecon } from '../src/server/ops/recon';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let duty2: string;
let today: string;
let tagNo = 0;
const item: Record<string, number> = {};

const checks = async () => {
  for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
  const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
  for (const c of st.checks as { ok: boolean; label: string; detail: string }[]) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
};
const openShift = async (cookie: string, openingCash = 0) => {
  const r = await api(ctx.app, cookie, 'POST', '/api/shifts', { openingCash });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { id: number; shiftNo: string };
};
const current = async (cookie: string) =>
  (await api(ctx.app, cookie, 'GET', '/api/shifts/current')).body.shift as {
    id: number;
    summary: { cash: { expected: number; refundSlip?: number }; refundSlips?: { count: number; total: number; list: { refundNo: string; cash: number; operatorName?: string; refs: { ref: string }[] }[] } };
  };
/** 接待一位客人、挂项目、结账，返回结账单 */
const sale = async (payments: (total: number) => Record<string, unknown>[], lines: { itemId: number; quantity: number }[] = [], memberId?: number, cookie = ctx.clerk) => {
  tagNo += 1;
  const code = `R${String(tagNo).padStart(3, '0')}`;
  const v = await api(ctx.app, cookie, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male', ...(memberId ? { memberId } : {}) }] });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.visits[0].id as number;
  if (lines.length) {
    const amount = lines.reduce((s, l) => s + l.quantity * (prices[l.itemId] ?? 0), 0);
    const p = await api(ctx.app, cookie, 'POST', `/api/frontdesk/visits/${id}/charges`, { clientKey: randomUUID(), lines, expectedTotal: amount });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  }
  const pre = (await api(ctx.app, cookie, 'GET', `/api/frontdesk/checkout-preview?ids=${id}`)).body;
  const c = await api(ctx.app, cookie, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [id], expectedTotal: pre.totalAmount, payments: payments(pre.totalAmount) });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return c.body as { id: number; checkoutNo: string; totalAmount: number };
};
const prices: Record<number, number> = {};
const options = async (checkoutId: number, cookie = duty) => {
  const r = await api(ctx.app, cookie, 'GET', `/api/frontdesk/checkouts/${checkoutId}/refund-options`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as RefundOptions;
};
const refund = (checkoutId: number, body: Record<string, unknown>, cookie = duty, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', `/api/frontdesk/checkouts/${checkoutId}/refunds`, { clientKey, reason: '客人投诉服务', ...body });
const voidRefund = (id: number, cookie = duty, reason = '登记错了') => api(ctx.app, cookie, 'POST', `/api/frontdesk/refunds/${id}/void`, { reason });

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { requireOpenShift: true })).status).toBe(200);
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'duty2', displayName: '值班经理二', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  duty2 = await login(ctx.app, 'duty2');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'R', from: 1, to: 60, width: 3, zone: 'male' })).status).toBe(200);
  for (const [name, category, price] of [
    ['退款搓澡', '退款洗浴', 6800],
    ['退款按摩', '退款按摩', 19800],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
    prices[item[name]!] = price;
  }
  await openShift(ctx.clerk, 100000);
  await openShift(duty, 0);
});
afterAll(async () => ctx.close());

describe('开退款单', () => {
  let checkoutId: number;
  let first: RefundDetail;

  it('核对：每项的实收、每种方式还能退多少；店员没有开退款单的权限', async () => {
    const c = await sale((t) => [{ method: 'wechat', amount: 30000 }, { method: 'cash', amount: t - 30000 }], [
      { itemId: item['退款搓澡']!, quantity: 2 },
      { itemId: item['退款按摩']!, quantity: 1 },
    ]);
    checkoutId = c.id;
    expect(c.totalAmount).toBe(49900 + 13600 + 19800);
    const o = await options(c.id);
    expect(o.blocked).toBeNull();
    expect(o.items.map((i) => [i.category, i.quantity, i.amount, i.discount, i.remainingQuantity, i.remainingAmount])).toEqual([
      ['门票', 1, 49900, 0, 1, 49900],
      ['退款按摩', 1, 19800, 0, 1, 19800],
      ['退款洗浴', 2, 13600, 0, 2, 13600],
    ]);
    expect(o.methods).toEqual([
      { method: 'cash', paid: c.totalAmount - 30000, refunded: 0, remaining: c.totalAmount - 30000 },
      { method: 'wechat', paid: 30000, refunded: 0, remaining: 30000 },
    ]);
    expect(o.drawers?.suggested).toBeTypeOf('number');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts/${c.id}/refund-options`)).status).toBe(403);
    expect((await refund(c.id, {}, ctx.clerk)).status).toBe(403);
  });

  it('按项退一份搓澡（现金）：退款单、交班扣现金、日结与部门冲减、自检一致', async () => {
    const before = (await current(ctx.clerk)).summary.cash.expected;
    const dutyBefore = (await current(duty)).summary.cash.expected;
    const r = await refund(checkoutId, { items: [{ category: '退款洗浴', name: '退款搓澡', quantity: 1, amount: 6800 }], payments: [{ method: 'cash', amount: 6800 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    first = r.body;
    expect(first.refundNo).toMatch(/^TK\d{8}-\d{4}$/);
    expect(first.status).toBe('completed');
    expect(first.amount).toBe(6800);
    expect(first.items).toEqual([{ category: '退款洗浴', name: '退款搓澡', quantity: 1, amount: 6800 }]);
    // 不选钱箱：记到经办人（值班经理）自己的班次，扣减它的应有现金
    expect(first.shift?.staffName).toBe('值班经理');
    expect((await current(duty)).summary.cash.expected).toBe(dutyBefore - 6800);
    expect((await current(ctx.clerk)).summary.cash.expected).toBe(before);
    const slips = (await current(duty)).summary.refundSlips!;
    expect(slips.count).toBe(1);
    expect(slips.list[0]!.cash).toBe(6800);

    const o = await options(checkoutId);
    const wash = o.items.find((i) => i.name === '退款搓澡')!;
    expect([wash.refundedQuantity, wash.refundedAmount, wash.remainingQuantity, wash.remainingAmount]).toEqual([1, 6800, 1, 6800]);
    expect(o.methods.find((m) => m.method === 'cash')!.refunded).toBe(6800);
    expect(o.refunds.map((x) => x.refundNo)).toEqual([first.refundNo]);

    const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
    expect(st.business.refunds).toEqual({ count: 1, total: 6800, byMethod: [{ method: 'cash', count: 1, amount: 6800 }] });
    expect(st.anomalies.some((a: { kind: string; docNo: string }) => a.kind === 'refund' && a.docNo === first.refundNo)).toBe(true);
    const exec = (await api(ctx.app, ctx.owner, 'GET', `/api/reports/executive?from=${today}&to=${today}`)).body;
    expect(exec.kpis.refund).toBe(6800);
    expect(exec.kpis.net).toBe(exec.kpis.receivable - exec.kpis.discount - exec.kpis.coupon - 6800);
    expect(exec.departments.find((d: { category: string }) => d.category === '退款洗浴')).toEqual({ category: '退款洗浴', quantity: 1, amount: 13600, discount: 0, refund: 6800 });
    const dash = (await api(ctx.app, ctx.owner, 'GET', '/api/dashboard')).body;
    expect(dash.todayStats.refund).toBe(6800);
    const detail = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts/${checkoutId}`)).body;
    expect(detail.refunds.map((x: { refundNo: string }) => x.refundNo)).toEqual([first.refundNo]);
    const list = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts?date=${today}`)).body as { id: number; refundedAmount: number }[];
    expect(list.find((x) => x.id === checkoutId)!.refundedAmount).toBe(6800);
    await checks();
  });

  it('超过剩下的份数或金额、没收过的方式、超过原单收的、两边对不上、扫码没登记退款单号：整笔拒绝', async () => {
    const wash = { category: '退款洗浴', name: '退款搓澡' };
    const code = async (body: Record<string, unknown>) => (await refund(checkoutId, body)).body.error?.code ?? 'OK';
    expect(await code({ items: [{ ...wash, quantity: 2, amount: 6800 }], payments: [{ method: 'cash', amount: 6800 }] })).toBe('REFUND_EXCEEDS');
    expect(await code({ items: [{ ...wash, quantity: 1, amount: 6801 }], payments: [{ method: 'cash', amount: 6801 }] })).toBe('REFUND_EXCEEDS');
    expect(await code({ items: [{ ...wash, quantity: 1, amount: 6800 }], payments: [{ method: 'alipay', amount: 6800, ref: 'AL-9' }] })).toBe('REFUND_METHOD_NOT_PAID');
    expect(
      await code({ items: [{ category: '门票', name: '门票 · 标准票（12 小时档）', quantity: 1, amount: 40000 }], payments: [{ method: 'wechat', amount: 40000, ref: 'WX-1' }] }),
    ).toMatch(/REFUND_METHOD_EXCEEDS|REFUND_ITEM_NOT_FOUND/);
    expect(await code({ items: [{ ...wash, quantity: 1, amount: 6800 }], payments: [{ method: 'cash', amount: 6000 }] })).toBe('REFUND_NOT_BALANCED');
    expect((await refund(checkoutId, { items: [{ ...wash, quantity: 1, amount: 6800 }], payments: [{ method: 'wechat', amount: 6800 }] })).status).toBe(400);
    expect(await code({ items: [{ category: '退款洗浴', name: '不存在的项目', quantity: 1, amount: 100 }], payments: [{ method: 'cash', amount: 100 }] })).toBe(
      'REFUND_ITEM_NOT_FOUND',
    );
    // 没退过、没改过
    expect((await options(checkoutId)).refunds).toHaveLength(1);
  });

  it('数量 0（只退钱）、扫码退款登记退款单号；同一操作编号重提返回原退款单，不重复退', async () => {
    const key = randomUUID();
    const body = {
      items: [{ category: '退款按摩', name: '退款按摩', quantity: 0, amount: 5000 }],
      payments: [{ method: 'wechat', amount: 5000, ref: 'WX20261102001' }],
      reason: '按摩力度不满意，退一部分',
    };
    const a = await refund(checkoutId, body, duty, key);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await refund(checkoutId, body, duty, key);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect((await refund(checkoutId, { ...body, reason: '另一笔' }, duty, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const o = await options(checkoutId);
    const massage = o.items.find((i) => i.name === '退款按摩')!;
    expect([massage.refundedQuantity, massage.remainingQuantity, massage.remainingAmount]).toEqual([0, 1, 14800]);
    // 查回：按编号找到这张退款单
    const look = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}?type=checkout_refund`)).body;
    expect(look).toMatchObject({ found: true, type: 'checkout_refund', refund: { id: a.body.id } });
    // 扫码退款只作提醒：值班经理的现金不变
    const slips = (await current(duty)).summary.refundSlips!;
    expect(slips.count).toBe(2);
    expect(slips.list.find((x) => x.refundNo === a.body.refundNo)).toMatchObject({ cash: 0, refs: [{ ref: 'WX20261102001' }] });
    await checks();
  });

  it('有生效的退款单就不能反结账；作废退款单后可以；作废只能一次', async () => {
    const r = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${checkoutId}/void`, { reason: '想整单撤销' });
    expect(r.body.error.code).toBe('REFUND_EXISTS');
    const all = (await options(checkoutId)).refunds;
    for (const x of all) {
      const v = await voidRefund(x.id);
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect(v.body.status).toBe('voided');
    }
    expect((await voidRefund(first.id)).body.error.code).toBe('ALREADY_VOIDED');
    // 作废后：班次、日结、部门都不算
    expect((await current(duty)).summary.refundSlips).toBeUndefined();
    const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
    expect(st.business.refunds.total).toBe(0);
    expect(st.anomalies.filter((a: { kind: string }) => a.kind === 'refund_void')).toHaveLength(2);
    await checks();
    const back = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${checkoutId}/void`, { reason: '整单撤销' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    // 反结账之后不能再开退款单
    expect((await options(checkoutId)).blocked?.code).toBe('CHECKOUT_VOIDED');
    expect((await refund(checkoutId, { items: [{ category: '退款洗浴', name: '退款搓澡', quantity: 1, amount: 100 }], payments: [{ method: 'cash', amount: 100 }] })).body.error.code).toBe(
      'CHECKOUT_VOIDED',
    );
  });
});

describe('钱箱、班次与作废', () => {
  it('退现金选别人的钱箱：记到那个班次、扣它的应有现金；不退现金时不能选钱箱', async () => {
    const shifts = (await api(ctx.app, ctx.owner, 'GET', `/api/shifts?date=${today}`)).body as { id: number; staffName: string; status: string }[];
    const clerkShift = shifts.find((s) => s.staffName === '测试店员' && s.status === 'open')!;
    const c = await sale((t) => [{ method: 'cash', amount: t }], [{ itemId: item['退款搓澡']!, quantity: 1 }]);
    const before = (await current(ctx.clerk)).summary.cash.expected;
    const r = await refund(c.id, { items: [{ category: '退款洗浴', name: '退款搓澡', quantity: 1, amount: 6800 }], payments: [{ method: 'cash', amount: 6800 }], refundShiftId: clerkShift.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.shift.staffName).toBe('测试店员');
    const after = await current(ctx.clerk);
    expect(after.summary.cash.expected).toBe(before - 6800);
    expect(after.summary.cash.refundSlip).toBe(6800);
    expect(after.summary.refundSlips!.list.find((x) => x.refundNo === r.body.refundNo)!.operatorName).toBe('值班经理');

    const c2 = await sale((t) => [{ method: 'wechat', amount: t }]);
    const bad = await refund(c2.id, {
      items: [{ category: '门票', name: (await options(c2.id)).items[0]!.name, quantity: 0, amount: 1000 }],
      payments: [{ method: 'wechat', amount: 1000, ref: 'WX-2' }],
      refundShiftId: clerkShift.id,
    });
    expect(bad.body.error.code).toBe('REFUND_SHIFT_NOT_CASH');
  });

  it('记退款的班次交班以后不能作废；过了撤销时限只有店主能开', async () => {
    const mine = await openShift(duty2, 0);
    const c = await sale((t) => [{ method: 'cash', amount: t }], [{ itemId: item['退款搓澡']!, quantity: 1 }]);
    const r = await refund(c.id, { items: [{ category: '退款洗浴', name: '退款搓澡', quantity: 1, amount: 3000 }], payments: [{ method: 'cash', amount: 3000 }] }, duty2);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const expected = (await api(ctx.app, duty2, 'GET', '/api/shifts/current')).body.shift.summary.cash.expected;
    expect(expected).toBe(-3000);
    const closed = await api(ctx.app, duty2, 'POST', `/api/shifts/${mine.id}/close`, { countedCash: 0, expectedCash: expected, note: '' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.summary.refundSlips.count).toBe(1);
    expect((await voidRefund(r.body.id)).body.error.code).toBe('REFUND_SHIFT_CLOSED');

    // 撤销时限（默认 48 小时）：值班经理过了时限不能开，店主可以
    const late = new Date(Date.now() + 49 * 3_600_000);
    const dutyActor = { id: (await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'duty'`)[0]!.id, role: 'duty_manager' as const, username: 'duty', displayName: '值班经理' };
    const input = { clientKey: randomUUID(), items: [{ category: '退款洗浴', name: '退款搓澡', quantity: 0, amount: 100 }], payments: [{ method: 'cash' as const, amount: 100 }], reason: '超时退款' };
    await expect(
      createRefund({ sql: ctx.sql, config: ctx.config } as never, c.id, input, { actor: dutyActor as never, ip: '127.0.0.1', at: late }),
    ).rejects.toMatchObject({ code: 'REFUND_WINDOW' });
  });

  it('只用会员储值付的结账单不能部分退款：提示用反结账', async () => {
    const m = await createMember(ctx, '退款储值', '19900007001');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 100000, 0))).status).toBe(200);
    const c = await sale((t) => [{ method: 'wallet', memberId: m.id, amount: t, expectedSplit: { principal: t, bonus: 0 } }], [], m.id);
    const o = await options(c.id);
    expect(o.blocked?.code).toBe('REFUND_NO_METHOD');
    expect(o.nonRefundable).toEqual([{ method: 'wallet', amount: c.totalAmount }]);
    expect((await refund(c.id, { items: [{ category: '门票', name: o.items[0]!.name, quantity: 1, amount: 1000 }], payments: [{ method: 'cash', amount: 1000 }] })).body.error.code).toBe(
      'REFUND_METHOD_NOT_PAID',
    );
    await checks();
  });

  it('对账包：09-退款单逐项列出（含作废），部门参考表的退款一列与日结一致', async () => {
    const pack = await buildDailyRecon(ctx.sql, ctx.config, today);
    const file = (name: string) => pack.files.find((f) => f.name === name)!.content;
    const refundsCsv = file('09-退款单.csv');
    expect(refundsCsv).toContain('退款单号');
    expect(refundsCsv).toContain('已作废');
    expect(refundsCsv).toContain('WX20261102001');
    expect(file('03-部门参考表.csv')).toContain('退款（元）');
    expect(file('03-部门参考表.csv')).toMatch(/核对,一致/);
    expect(pack.ok).toBe(true);
  });
});
