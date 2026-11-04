// 解绑满 3 年清除（小程序线，MP16，docs/MP_PRIVACY.md：绑定期间保存，解绑后再保存 3 年，期满删除）：
//   · 解绑满 3 年的绑定记录：手机号、微信标识清空，解绑原因换成固定的一句，记下清除时间；没满 3 年的、还绑着的不动；
//   · 同一条绑定下的线上充值单、领券记录、到期提醒的同意：去掉微信标识，单子与记录照留；作废登记满 3 年的删掉；
//   · 只放开这几种改法：清除过的不能再改，没满 3 年的、还绑着的、别的字段、没清除的绑定下的记录都改不了；
//   · 清除以后：小程序看不到之前的单子，同一个微信可以重新绑定；后台写「已清除」；自检照常全过。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MP_GATEWAY_HEADER, MP_OPENID_HEADER, type MpBindingRow } from '../src/shared/mp';
import { buildMpApp } from '../src/server/modules/mp/app';
import type { PayRuntime } from '../src/server/modules/mp/pay';
import { PURGED_REASON, purgeOldBindings } from '../src/server/modules/mp/retention';
import { createMockWxPay } from '../src/server/modules/mp/wxpay-mock';
import { consistencyChecks } from '../src/server/ops/consistency';
import { api, createMember, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
const TPL = 'tplRetain-0123456789abcdefABCDEF';
let ctx: TestContext;
let mp: FastifyInstance;
let templateId: number;
const deps = () => ({ sql: ctx.sql, config: ctx.config });

beforeAll(async () => {
  ctx = await setup();
  const wx = createMockWxPay();
  const pay: PayRuntime = { mode: 'mock', config: wx.config, client: wx.client, mock: wx };
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } }, { pay, sweepMs: 0 });
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })})`;
  const rr = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/recharge/rules', { enabled: true, planIds: [], customEnabled: true, maxCents: 1_000_000, dailyLimit: 5 });
  expect(rr.status, JSON.stringify(rr.body)).toBe(200);
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '清除用的券', kind: 'cash', faceValue: 1000, validity: 'days', validDays: 30 });
  expect(t.status, JSON.stringify(t.body)).toBe(200);
  templateId = t.body.id;
  const cr = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/coupons/rules', { enabled: true, offers: [{ templateId, limit: 'unlimited', perMember: 1, active: true }] });
  expect(cr.status, JSON.stringify(cr.body)).toBe(200);
  const rm = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/reminders/rules', {
    enabled: true,
    coupon: { templateId: TPL, fields: [{ key: 'thing1', source: 'name' }] },
    membership: null,
    bonus: null,
  });
  expect(rm.status, JSON.stringify(rm.body)).toBe(200);
});
afterAll(async () => {
  await mp.close();
  await ctx.close();
});

const call = (method: 'GET' | 'POST', url: string, openid: string, payload?: unknown) =>
  Promise.resolve(mp.inject({ method, url, headers: { [MP_GATEWAY_HEADER]: KEY, [MP_OPENID_HEADER]: openid }, ...(payload === undefined ? {} : { payload: payload as object }) }));
const versionOf = async (openid: string) => (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
let n = 0;
async function bind(openid: string, phone: string) {
  const b = await call('POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, bindVersion: await versionOf(openid), mock: true });
  expect(b.statusCode, b.body).toBe(200);
  const [row] = await ctx.sql<{ id: number }[]>`SELECT id FROM mp_bindings WHERE openid = ${openid} AND unbound_at IS NULL`;
  return Number(row!.id);
}
/** 一位会员绑上微信，留下一张线上充值单、一条领券记录、一条到期提醒的同意 */
async function boundWithRecords(name: string) {
  n += 1;
  const phone = `1355500${String(1000 + n)}`;
  const m = await createMember(ctx, name, phone);
  const openid = `openid-retain-${n}-${randomUUID().slice(0, 8)}`;
  const bindingId = await bind(openid, phone);
  const order = await call('POST', '/api/mp/recharge/orders', openid, { clientKey: randomUUID(), amount: 100000, bindVersion: await versionOf(openid) });
  expect(order.statusCode, order.body).toBe(201);
  const claim = await call('POST', '/api/mp/coupon-claims', openid, { clientKey: randomUUID(), templateId, bindVersion: await versionOf(openid) });
  expect(claim.statusCode, claim.body).toBe(201);
  const consent = await call('POST', '/api/mp/reminders', openid, {
    clientKey: randomUUID(),
    kind: 'coupon',
    couponCode: claim.json().coupon.code,
    templateId: TPL,
    bindVersion: await versionOf(openid),
  });
  expect(consent.statusCode, consent.body).toBe(201);
  return { memberId: m.id, openid, phone, bindingId, orderNo: order.json().order.orderNo as string };
}
/** 解绑，解绑时间往前放（解绑的四个字段只能从空填上一次，填的时候可以是任何时间） */
const unbindAgo = (bindingId: number, interval: string, reason = '换手机号 13800001111') =>
  ctx.sql`
    UPDATE mp_bindings SET unbound_at = now() - ${interval}::interval, unbound_by = ${ctx.ownerId}, unbind_reason = ${reason}, unbind_client_key = ${randomUUID()}
    WHERE id = ${bindingId}`;
const openidsOf = async (bindingId: number) => {
  const [o] = await ctx.sql<{ orders: (string | null)[]; claims: (string | null)[]; consents: (string | null)[] }[]>`
    SELECT (SELECT coalesce(json_agg(openid), '[]') FROM mp_recharge_orders WHERE binding_id = ${bindingId}) AS orders,
           (SELECT coalesce(json_agg(openid), '[]') FROM mp_coupon_claims WHERE binding_id = ${bindingId}) AS claims,
           (SELECT coalesce(json_agg(openid), '[]') FROM mp_reminder_consents WHERE binding_id = ${bindingId}) AS consents`;
  return o!;
};

describe('解绑满 3 年清除', () => {
  it('满 3 年的：手机号、微信标识清空，解绑原因换掉，单子与记录照留、去掉微信标识；没满 3 年的、还绑着的不动；作废登记满 3 年的删掉', async () => {
    const old = await boundWithRecords('演示·解绑满三年');
    const recent = await boundWithRecords('演示·解绑两年多');
    const active = await boundWithRecords('演示·还绑着');
    await unbindAgo(old.bindingId, '3 years 1 day');
    await unbindAgo(recent.bindingId, '2 years 364 days');
    const oldFence = randomUUID();
    const newFence = randomUUID();
    await ctx.sql`INSERT INTO mp_op_fences (key, op_type, openid, created_at) VALUES (${oldFence}, 'mp_coupon', ${old.openid}, now() - interval '3 years 1 day')`;
    await ctx.sql`INSERT INTO mp_op_fences (key, op_type, openid) VALUES (${newFence}, 'mp_coupon', ${active.openid})`;
    expect(await purgeOldBindings(deps())).toEqual({ bindings: 1, fences: 1 });
    const [b] = await ctx.sql<{ openid: string | null; phone: string | null; unbindReason: string; purgedAt: string | null; memberId: number }[]>`
      SELECT openid, phone, unbind_reason, purged_at, member_id FROM mp_bindings WHERE id = ${old.bindingId}`;
    expect(b).toMatchObject({ openid: null, phone: null, unbindReason: PURGED_REASON, memberId: old.memberId });
    expect(b!.purgedAt).not.toBeNull();
    expect(await openidsOf(old.bindingId)).toEqual({ orders: [null], claims: [null], consents: [null] });
    expect(await openidsOf(recent.bindingId)).toEqual({ orders: [recent.openid], claims: [recent.openid], consents: [recent.openid] });
    expect(await openidsOf(active.bindingId)).toEqual({ orders: [active.openid], claims: [active.openid], consents: [active.openid] });
    const [r] = await ctx.sql<{ openid: string; phone: string; purgedAt: string | null }[]>`SELECT openid, phone, purged_at FROM mp_bindings WHERE id = ${recent.bindingId}`;
    expect(r).toEqual({ openid: recent.openid, phone: recent.phone, purgedAt: null });
    const fences = await ctx.sql<{ key: string }[]>`SELECT key FROM mp_op_fences WHERE key IN (${oldFence}, ${newFence})`;
    expect(fences.map((f) => f.key)).toEqual([newFence]);
    // 再跑一次：没有要清的
    expect(await purgeOldBindings(deps())).toEqual({ bindings: 0, fences: 0 });
    // 后台：写「已清除」，不再有手机号与微信标识
    const rows = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/mp/members/${old.memberId}/bindings`)).body as MpBindingRow[];
    expect(rows).toMatchObject([{ id: old.bindingId, openidTail: null, phone: null, unbindReason: PURGED_REASON }]);
    expect(rows[0]!.purgedAt).not.toBeNull();
    // 小程序：同一个微信看不到之前的单子；可以重新绑定（版本号从清除以后剩下的算）
    expect((await call('GET', `/api/mp/recharge/orders/${old.orderNo}`, old.openid)).statusCode).toBe(403);
    expect(await versionOf(old.openid)).toBe(0);
    await bind(old.openid, old.phone);
    expect((await call('GET', `/api/mp/recharge/orders/${old.orderNo}`, old.openid)).statusCode).toBe(404);
    expect((await consistencyChecks(ctx.sql, ctx.config.timezone)).filter((c) => !c.ok)).toEqual([]);
  });

  it('只放开这几种改法：清除过的不能再改；没满 3 年的、还绑着的清不了；别的字段改不了；没清除的绑定下的记录去不掉微信标识；新的作废登记删不了', async () => {
    const a = await boundWithRecords('演示·清除的规矩');
    const b = await boundWithRecords('演示·没满三年');
    await unbindAgo(a.bindingId, '3 years 2 days');
    await unbindAgo(b.bindingId, '1 year');
    expect((await purgeOldBindings(deps())).bindings).toBe(1);
    await expect(ctx.sql`UPDATE mp_bindings SET unbind_reason = '改一下' WHERE id = ${a.bindingId}`).rejects.toThrow(/已经清除的绑定记录不能再改/);
    await expect(ctx.sql`DELETE FROM mp_bindings WHERE id = ${a.bindingId}`).rejects.toThrow(/禁止删除/);
    // 没满 3 年的：约束拦住
    await expect(
      ctx.sql`UPDATE mp_bindings SET openid = NULL, phone = NULL, unbind_reason = ${PURGED_REASON}, purged_at = now() WHERE id = ${b.bindingId}`,
    ).rejects.toThrow();
    // 还绑着的
    const c = await boundWithRecords('演示·绑着清不了');
    await expect(ctx.sql`UPDATE mp_bindings SET openid = NULL, phone = NULL, unbind_reason = ${PURGED_REASON}, purged_at = now() WHERE id = ${c.bindingId}`).rejects.toThrow();
    // 清除时改了别的字段
    const d = await boundWithRecords('演示·清除时改别的');
    await unbindAgo(d.bindingId, '4 years');
    await expect(
      ctx.sql`UPDATE mp_bindings SET openid = NULL, phone = NULL, unbind_reason = ${PURGED_REASON}, purged_at = now(), mock = NOT mock WHERE id = ${d.bindingId}`,
    ).rejects.toThrow(/只能在解绑满 3 年以后清除/);
    // 没清除的绑定下的记录去不掉微信标识；清除过的绑定下的记录也只能去掉微信标识
    for (const table of ['mp_coupon_claims', 'mp_reminder_consents'] as const) {
      await expect(ctx.sql`UPDATE ${ctx.sql(table)} SET openid = NULL WHERE binding_id = ${b.bindingId}`).rejects.toThrow(/只能在绑定记录清除时去掉微信标识/);
      await expect(ctx.sql`DELETE FROM ${ctx.sql(table)} WHERE binding_id = ${a.bindingId}`).rejects.toThrow(/不能删除/);
    }
    await expect(ctx.sql`UPDATE mp_coupon_claims SET seq = seq + 10 WHERE binding_id = ${a.bindingId}`).rejects.toThrow();
    await expect(ctx.sql`UPDATE mp_recharge_orders SET openid = NULL WHERE binding_id = ${b.bindingId}`).rejects.toThrow(/不能改/);
    await expect(ctx.sql`UPDATE mp_recharge_orders SET amount = amount + 1 WHERE binding_id = ${a.bindingId}`).rejects.toThrow(/不能改/);
    // 充值单原来的规则照旧：状态只能照原来的变
    await expect(ctx.sql`UPDATE mp_recharge_orders SET status = 'handled' WHERE binding_id = ${b.bindingId}`).rejects.toThrow(/不能从/);
    const fence = randomUUID();
    await ctx.sql`INSERT INTO mp_op_fences (key, op_type, openid) VALUES (${fence}, 'mp_coupon', ${c.openid})`;
    await expect(ctx.sql`DELETE FROM mp_op_fences WHERE key = ${fence}`).rejects.toThrow(/满 3 年的才能删除/);
    await expect(ctx.sql`UPDATE mp_op_fences SET openid = NULL WHERE key = ${fence}`).rejects.toThrow(/只追加/);
    expect((await purgeOldBindings(deps())).bindings).toBe(1);
    expect((await consistencyChecks(ctx.sql, ctx.config.timezone)).filter((x) => !x.ok)).toEqual([]);
  });
});
