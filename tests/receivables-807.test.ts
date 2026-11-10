// 8.0.7 ERP P2 3.1 应收与挂账（docs/ERP_V807.md）：
//   · 协议单位（额度空 = 不限）；结账「挂账」要岗位权限「挂账」（V12），超额度拒绝（AR_LIMIT），停用的不能挂；
//   · 挂账算营业额（应收、净营业额）不算实收；桌台、手牌结账都能挂；
//   · 回款：从最早的挂账开始核销，不能超过没结清的；同一编号重复提交只记一次；当月冲销；
//   · 反结账：挂账作废；已经回款核销过的不能反结账（AR_COLLECTED），冲销回款以后可以；
//   · 账龄与平台回款、待办；自检一致。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/server/lib/context';
import { isCashLike } from '../src/shared/checkout';
import { checkout, voidCheckout, type CheckoutInputData } from '../src/server/modules/frontdesk/checkout';
import { checkin } from '../src/server/modules/frontdesk/visits';
import { receivableChecks } from '../src/server/modules/receivables';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let manager: Actor; // 值班经理（有「挂账」）
let clerk: Actor; // 店员（没有「挂账」）
let deps: { sql: TestContext['sql']; config: TestContext['config'] };
let accountId: number;
let today: string;
let tagNo = 1;

const enter = async () => {
  const code = `R${String(tagNo++).padStart(3, '0')}`;
  const r = await checkin(deps, { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] }, { actor: manager, at: new Date() });
  return r.visits[0]!.id;
};
const totalOf = async (visitId: number) => {
  const r = await api(ctx.app, ctx.owner, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.totalAmount as number;
};
const pay = (actor: Actor, visitIds: number[], expectedTotal: number, payments: CheckoutInputData['payments']) =>
  checkout(deps, { clientKey: randomUUID(), visitIds, expectedTotal, payments }, { actor, at: new Date() });
const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string; status: number };
  }
  throw new Error('应该被拒绝');
};
const detail = async () => (await api(ctx.app, ctx.owner, 'GET', `/api/erp/receivables/accounts/${accountId}`)).body;
const collect = (body: Record<string, unknown>, cookie = ctx.owner) =>
  api(ctx.app, cookie, 'POST', '/api/erp/receivables/collections', { clientKey: randomUUID(), accountId, collectedOn: today, method: 'bank_transfer', ...body });

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  clerk = { id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk', duties: [], mustChangePassword: false };
  // 同一个账号当值班经理用（班次与经办人按编号找，权限按岗位）
  manager = { ...clerk, displayName: '值班经理', role: 'duty_manager' };
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'R', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  const list = (await api(ctx.app, ctx.owner, 'POST', '/api/erp/receivables/accounts', { code: 'XY01', name: '协议单位甲', contact: '张会计', phone: '13800000000', creditLimitCents: 100_000 })).body;
  accountId = list.find((a: { code: string }) => a.code === 'XY01').id;
}, 60_000);
afterAll(async () => ctx.close());

describe('协议单位与结账挂账', () => {
  it('名称、编码不重复；修改带版本号；前台只看到在用的单位', async () => {
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/erp/receivables/accounts', { code: 'XY01', name: '别的' })).body.error.code).toBe('CODE_EXISTS');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/erp/receivables/accounts', { code: 'XY09', name: '协议单位甲' })).body.error.code).toBe('NAME_EXISTS');
    const list = (await api(ctx.app, ctx.owner, 'POST', '/api/erp/receivables/accounts', { code: 'XY02', name: '已停用的单位', active: false })).body;
    const off = list.find((a: { code: string }) => a.code === 'XY02');
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/erp/receivables/accounts/${off.id}`, { code: 'XY02', name: '已停用的单位', active: false, expectedVersion: 9 })).body.error.code).toBe('VERSION_CONFLICT');
    const opts = (await api(ctx.app, ctx.owner, 'GET', '/api/ar-accounts/options')).body as { code: string }[];
    expect(opts.map((o) => o.code)).toEqual(['XY01']);
    // 店员没有「挂账」：看不到协议单位
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/ar-accounts/options')).status).toBe(403);
  });

  it('值班经理能挂账：算营业额不算实收；店员不能挂；超额度、停用的拒绝', async () => {
    const v1 = await enter();
    const total = await totalOf(v1);
    const denied = await errorOf(pay(clerk, [v1], total, [{ method: 'on_account', accountId, signer: '张会计', amount: total }]));
    expect(denied.code, denied.message).toBe('FORBIDDEN');
    const done = await pay(manager, [v1], total, [{ method: 'on_account', accountId, signer: '张会计', amount: total }]);
    expect(done.payments).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'on_account', amount: total })]));
    const d = await detail();
    expect(d.account.outstandingCents).toBe(total);
    expect(d.charges[0]).toMatchObject({ checkoutNo: done.checkoutNo, signer: '张会计', amountCents: total, collectedCents: 0, status: 'open' });
    // 日结：按方式分列里有挂账，实收不含
    const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
    const m = st.business.byMethod.find((x: { method: string }) => x.method === 'on_account');
    expect(Number(m.amount)).toBe(total);
    expect(isCashLike('on_account')).toBe(false);
    // 额度只剩 ¥0.01：再挂就超了
    const v2 = await enter();
    const t2 = await totalOf(v2);
    const limit = await errorOf(
      (async () => {
        await ctx.sql`UPDATE ar_accounts SET credit_limit_cents = ${total + 1} WHERE id = ${accountId}`;
        return pay(manager, [v2], t2, [{ method: 'on_account', accountId, signer: '张会计', amount: t2 }]);
      })(),
    );
    expect(limit.code).toBe('AR_LIMIT');
    await ctx.sql`UPDATE ar_accounts SET credit_limit_cents = NULL WHERE id = ${accountId}`;
    // 一张结账单只能挂一笔
    expect((await errorOf(pay(manager, [v2], t2, [{ method: 'on_account', accountId, signer: 'a', amount: 1 }, { method: 'on_account', accountId, signer: 'a', amount: t2 - 1 }]))).status).toBe(400);
    // 停用的单位
    const [off] = await ctx.sql<{ id: number }[]>`SELECT id FROM ar_accounts WHERE code = 'XY02'`;
    expect((await errorOf(pay(manager, [v2], t2, [{ method: 'on_account', accountId: Number(off!.id), signer: 'a', amount: t2 }]))).code).toBe('AR_ACCOUNT_INVALID');
    // 不限额以后能挂：挂一部分、其余现金
    await pay(manager, [v2], t2, [
      { method: 'on_account', accountId, signer: '李主任', amount: t2 - 1000 },
      { method: 'cash', amount: 1000, ref: '' },
    ]);
    expect((await detail()).account.outstandingCents).toBe(total + t2 - 1000);
    for (const c of await receivableChecks(ctx.sql)) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  });
});

describe('回款与核销、反结账', () => {
  it('回款从最早的挂账核销；不能超过没结清的；同一编号只记一次；核销过的不能反结账，冲销回款以后可以', async () => {
    const before = await detail();
    const open = before.account.outstandingCents as number;
    expect((await collect({ amountCents: open + 1 })).body.error.code).toBe('OVER_OUTSTANDING');
    const key = randomUUID();
    const first = await api(ctx.app, ctx.owner, 'POST', '/api/erp/receivables/collections', { clientKey: key, accountId, collectedOn: today, method: 'bank_transfer', amountCents: 10_000, evidence: '流水 8899' });
    expect(first.status).toBe(201);
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/erp/receivables/collections', { clientKey: key, accountId, collectedOn: today, method: 'bank_transfer', amountCents: 10_000, evidence: '流水 8899' });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    // 编号相同、内容不同：拒绝
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/erp/receivables/collections', { clientKey: key, accountId, collectedOn: today, method: 'bank_transfer', amountCents: 9_000 })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const collection = first.body.collection;
    // 最早的那笔挂账先核销
    const oldest = [...before.charges].filter((c: { status: string }) => c.status === 'open').sort((a: { id: number }, b: { id: number }) => a.id - b.id)[0];
    expect(collection.allocations).toEqual([expect.objectContaining({ chargeId: oldest.id, amountCents: 10_000 })]);
    expect((await detail()).account.outstandingCents).toBe(open - 10_000);
    // 店员、仓库没有维护权限
    expect((await collect({ amountCents: 100 }, ctx.clerk)).status).toBe(403);

    // 核销过的挂账：不能反结账
    const blocked = await errorOf(voidCheckout(deps, oldest.checkoutId, { reason: '登错了' }, { actor: { ...manager, role: 'owner' } }));
    expect(blocked.code).toBe('AR_COLLECTED');
    // 冲销回款（当月）以后可以反结账，挂账作废
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/erp/receivables/collections/${collection.id}/void`, { reason: '金额登错' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.collection.voided.reason).toBe('金额登错');
    await voidCheckout(deps, oldest.checkoutId, { reason: '登错了' }, { actor: { ...manager, role: 'owner' } });
    const after = await detail();
    expect(after.charges.find((c: { id: number }) => c.id === oldest.id).status).toBe('voided');
    expect(after.account.outstandingCents).toBe(open - oldest.amountCents);
    // 回款、核销与挂账都不能改、不能删
    await expect(ctx.sql`UPDATE ar_charges SET amount_cents = 1 WHERE id = ${oldest.id}`).rejects.toThrow(/只能作废一次/);
    await expect(ctx.sql`DELETE FROM ar_allocations`).rejects.toThrow();
    for (const c of await receivableChecks(ctx.sql)) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    const fd = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[];
    for (const c of fd) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  });

  it('账龄、平台回款与待办', async () => {
    // 把还没结清的那笔挂账挪到 70 天前（模拟旧账）
    await ctx.sql`ALTER TABLE ar_charges DISABLE TRIGGER ar_charges_guard`;
    await ctx.sql`UPDATE ar_charges SET business_date = ${today}::date - 70 WHERE account_id = ${accountId} AND status = 'open'`;
    await ctx.sql`ALTER TABLE ar_charges ENABLE TRIGGER ar_charges_guard`;
    const aging = (await api(ctx.app, ctx.owner, 'GET', '/api/erp/receivables/aging')).body;
    expect(aging.overdueDays).toBe(60);
    const row = aging.rows.find((r: { name: string }) => r.name === '协议单位甲');
    expect(row.buckets.d90).toBeGreaterThan(0);
    expect(row.overdueCents).toBe(row.totalCents);
    const todo = (await api(ctx.app, ctx.owner, 'GET', '/api/erp/receivables/todo')).body;
    expect(todo.overdueCharges).toBeGreaterThan(0);
    expect(todo.overdueCents).toBe(row.totalCents);
    // 平台：结账登记一张团购券，平台打款一部分
    const v = await enter();
    const t = await totalOf(v);
    await pay(manager, [v], t, [{ method: 'coupon', platform: 'meituan', code: 'MT20261110001', dealName: '', amount: t }]);
    const settle = await api(ctx.app, ctx.owner, 'POST', '/api/platform/settlements', { clientKey: randomUUID(), platform: 'meituan', periodFrom: today, periodTo: today, amount: 10_000, receivedOn: today });
    expect(settle.status, JSON.stringify(settle.body)).toBeLessThan(300);
    const platforms = (await api(ctx.app, ctx.owner, 'GET', '/api/erp/receivables/platforms')).body as { platform: string; redeemedCents: number; settledCents: number; outstandingCents: number }[];
    expect(platforms.find((p) => p.platform === 'meituan')).toMatchObject({ redeemedCents: t, settledCents: 10_000, outstandingCents: t - 10_000 });
    const csv = await ctx.app.inject({ method: 'GET', url: '/api/erp/receivables/aging/export', headers: { cookie: ctx.owner } });
    expect(csv.body).toContain('协议单位甲');
    expect(csv.body).toContain('团购 · 美团');
  });
});
