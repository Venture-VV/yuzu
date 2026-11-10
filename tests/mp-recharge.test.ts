// 小程序第二期 2a：线上充值（小程序线，docs/MP_RECHARGE.md）。用模拟的微信支付（本机生成的密钥，照真的签名、加密）走：
//   · 设置（店主、店总；版本号；不超过前台单笔上限；只能勾启用的套餐）；可充的项与预估、首充最低挡住的写原因；
//   · 建单 → 付款 → 到账通知 → 钱包入账（渠道小程序、不记班次）；同一个编号重提返回同一张单；一人只有一张待支付的；每天的笔数；
//   · 建单「结果待确认」：确认作废之后晚到的原请求不建单；
//   · 到账通知：验签失败、改过的不认也不记库；重复、并发的只入账一次；通知没到时查单补记；找不到单子的记下来给店主看；
//   · 关单：取消、过期补查时请微信关单；关单之后才付的照样入账、标出来；微信那边没有这一单的过期后关；
//   · 到账时规则变了（套餐停用）：记「已付款待处理」，店主重新入账、按金额入账、已另行处理；对不上的只能记已另行处理；
//   · 冻结的会员不能下单，下单之后冻结的照样入账、标出来；模拟支付只在 development、test；微信支付的配置读法。

import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MembershipRules } from '../src/shared/membership';
import { MP_GATEWAY_HEADER, MP_OPENID_HEADER, type MpRechargeAdminData, type MpRechargeOptions, type MpRechargeOrder } from '../src/shared/mp';
import type { Deps } from '../src/server/lib/context';
import { buildMpApp } from '../src/server/modules/mp/app';
import { loadPayRuntime, type PayRuntime } from '../src/server/modules/mp/pay';
import { payRechargeOrder, sweepRechargeOrders } from '../src/server/modules/mp/recharge';
import { createMockWxPay, type MockWxPay } from '../src/server/modules/mp/wxpay-mock';
import { consistencyChecks } from '../src/server/ops/consistency';
import { api, balanceOf, createMember, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
const yuan = (n: number) => n * 100;
/** 北京时间 m 分钟前（RFC 3339，带 +08:00）：合成到账通知的付款时间；超过 5 分钟的算晚到（门店先去微信查单） */
const beijingIso = (m: number) => `${new Date(Date.now() - m * 60_000 + 8 * 3_600_000).toISOString().slice(0, 19)}+08:00`;
let ctx: TestContext;
let deps: Deps;
let mp: FastifyInstance;
let wx: MockWxPay;
let pay: PayRuntime;
const plan: Record<string, number> = {};

/**
 * 有几个请求在排 holderPid 这条连接拿着的那把咨询锁：同一个数据库、同一个锁号、还没拿到的。
 * 只数这一把——按文件并行的别的测试库（<库名>_w1…）、同一个库里别的咨询锁在排的都不算。
 * 原来数整台数据库服务器上所有没拿到的咨询锁：并行全量时偶尔数到别的库，解绑还没排上就当排上了
 * （主线在 #84 的报告；小程序线测试 bf79dcc 的复核）。holderPid 这条连接只拿这一把咨询锁。
 */
async function advisoryWaitersOn(holderPid: number): Promise<number> {
  const [w] = await ctx.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks w
    JOIN pg_locks h ON h.pid = ${holderPid} AND h.locktype = 'advisory' AND h.granted
      AND w.database = h.database AND w.classid = h.classid AND w.objid = h.objid AND w.objsubid = h.objsubid
    WHERE w.locktype = 'advisory' AND NOT w.granted`;
  return w!.n;
}

/** 等到有 count 个请求在排 holderPid 拿着的那把咨询锁 */
async function waitForAdvisoryWaiters(holderPid: number, count: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await advisoryWaitersOn(holderPid)) >= count) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('没有排上队');
}

/** 在一条连接上拿住一把咨询锁（排他）：返回这条连接的 pid，release 放开并等事务结束 */
async function holdAdvisory(key: string): Promise<{ pid: number; release: () => Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let held!: (pid: number) => void;
  const holding = new Promise<number>((r) => (held = r));
  const done = ctx.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const [p] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    held(p!.pid);
    await released;
  });
  const pid = await Promise.race([holding, done.then(() => Promise.reject(new Error('没拿住锁')))]);
  return {
    pid,
    release: async () => {
      release();
      await done;
    },
  };
}

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  wx = createMockWxPay();
  pay = { mode: 'mock', config: wx.config, client: wx.client, mock: wx };
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } }, { pay, sweepMs: 0 });
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })})`;
  await ctx.sql`UPDATE mp_stores SET phone = '0755-12345678' WHERE is_home`;
  // 首充 500 元起、续充 100 元起；L1 ¥1,000 赠 3%、L2 ¥3,000 赠 5%（好算）
  const r = (await api(ctx.app, ctx.owner, 'GET', '/api/membership/rules')).body as MembershipRules;
  const thresholds = [0, yuan(1000), yuan(3000), yuan(10000), yuan(20000), yuan(50000), yuan(100000)];
  const bonus = [0, 300, 500, 800, 1000, 1200, 1500];
  const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', {
    ...r,
    firstRechargeMinCents: yuan(500),
    topUpMinCents: yuan(100),
    grades: r.grades.map((g, i) => ({ ...g, thresholdCents: thresholds[i], bonusBp: bonus[i] })),
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  for (const [name, payAmount] of [
    ['线上一千', yuan(1000)],
    ['线上三千', yuan(3000)],
    ['线上三百', yuan(300)],
    ['停用的套餐', yuan(2000)],
  ] as const) {
    const p = await api(ctx.app, ctx.owner, 'POST', '/api/plans', { name, payAmount, bonusAmount: 0 });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    plan[name] = (await ctx.sql<{ id: number }[]>`SELECT id FROM recharge_plans WHERE name = ${name}`)[0]!.id;
  }
  await ctx.sql`UPDATE recharge_plans SET active = false WHERE id = ${plan['停用的套餐']!}`;
  // 「线上三千」挂两张券
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '线上搓澡券', kind: 'cash', faceValue: 3000, validity: 'days', validDays: 30 });
  expect(t.status, JSON.stringify(t.body)).toBe(200);
  const rule = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/rules', { clientKey: randomUUID(), kind: 'recharge', planId: plan['线上三千'], templateId: t.body.id, quantity: 2 });
  expect(rule.status, JSON.stringify(rule.body)).toBe(200);
});
afterAll(async () => {
  await mp.close();
  await ctx.close();
});

const call = (method: 'GET' | 'POST', url: string, openid: string | null, payload?: unknown) =>
  Promise.resolve(
    mp.inject({
      method,
      url,
      headers: { [MP_GATEWAY_HEADER]: KEY, ...(openid ? { [MP_OPENID_HEADER]: openid } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    }),
  );
let n = 0;
/** 建一位会员并用模拟微信绑定，返回会员编号与这个微信 */
async function bound(name: string): Promise<{ memberId: number; openid: string; phone: string }> {
  n += 1;
  const phone = `1366600${String(1000 + n)}`;
  const m = await createMember(ctx, name, phone);
  const openid = `openid-recharge-${n}-${randomUUID().slice(0, 8)}`;
  await bindPhone(openid, phone);
  return { memberId: m.id, openid, phone };
}
/** 这个微信（用模拟的验证）绑定手机号是 phone 的会员 */
async function bindPhone(openid: string, phone: string): Promise<void> {
  const version = (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
  const b = await call('POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, bindVersion: version, mock: true });
  expect(b.statusCode, b.body).toBe(200);
}
const rules = (patch: Record<string, unknown> = {}) =>
  api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/recharge/rules', {
    enabled: true,
    planIds: [plan['线上一千'], plan['线上三千'], plan['线上三百']],
    customEnabled: true,
    maxCents: yuan(10000),
    dailyLimit: 3,
    ...patch,
  });
const options = async (openid: string) => {
  const r = await call('GET', '/api/mp/recharge', openid);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as MpRechargeOptions;
};
/** 这个微信现在的绑定状态版本号（充值页上带回来的那个数） */
const versionOf = async (openid: string) => (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
/** 建单：默认带这个微信现在的绑定版本号（body 里给了 bindVersion 的用给的） */
const createOrder = async (openid: string, body: Record<string, unknown>, clientKey = randomUUID()) =>
  call('POST', '/api/mp/recharge/orders', openid, { clientKey, bindVersion: await versionOf(openid), ...body });
const orderOf = async (openid: string, no: string) => (await call('GET', `/api/mp/recharge/orders/${no}`, openid)).json() as MpRechargeOrder;
const notify = (msg: { headers: unknown; body: string }) =>
  call('POST', '/api/mp/pay/notify', null, { headers: msg.headers, body: Buffer.from(msg.body, 'utf8').toString('base64') });
const row = async (no: string) =>
  (await ctx.sql<{ id: number; status: string; flags: string[]; rechargeId: number | null; transactionId: string | null; holdCode: string | null; closeReason: string | null }[]>`
    SELECT id, status, flags, recharge_id, transaction_id, hold_code, close_reason FROM mp_recharge_orders WHERE order_no = ${no}`)[0]!;
const rechargesOf = async (memberId: number) =>
  ctx.sql<{ id: number; paidAmount: number; bonusAmount: number; channel: string; shiftId: number | null; paymentRef: string; planId: number | null }[]>`
    SELECT id, paid_amount, bonus_amount, channel, shift_id, payment_ref, plan_id FROM recharges WHERE member_id = ${memberId} ORDER BY id`;
const adminData = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/mp/recharge')).body as MpRechargeAdminData;
/** 付一张单：小程序点「模拟支付」 */
const mockPay = (openid: string, no: string) => call('POST', `/api/mp/recharge/orders/${no}/mock-pay`, openid, {});

describe('线上充值的设置', () => {
  it('默认关着：可充的项写原因，建单拒绝；没有权限的岗位看不了、改不了', async () => {
    const { openid } = await bound('演示·线上关着');
    const o = await options(openid);
    expect(o).toMatchObject({ open: false, notice: '线上充值还没开通，请到前台充值', mock: true });
    const r = await createOrder(openid, { planId: plan['线上一千'] });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('MP_RECHARGE_DISABLED');
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/mp/recharge')).status).toBe(403);
    expect((await rules().then(() => api(ctx.app, ctx.clerk, 'PUT', '/api/admin/mp/recharge/rules', { enabled: false, customEnabled: true, maxCents: 100, dailyLimit: 1 }))).status).toBe(403);
  });

  it('店主保存：带版本号；线上单笔上限不超过前台的；只能勾启用的套餐', async () => {
    const before = (await adminData()).rules;
    expect((await rules({ version: before.version + 5 })).body.error.code).toBe('VERSION_CONFLICT');
    expect((await rules({ maxCents: yuan(600000) })).body.error.code).toBe('OVER_COUNTER_LIMIT');
    expect((await rules({ planIds: [plan['停用的套餐']] })).body.error.code).toBe('PLAN_UNAVAILABLE');
    expect((await rules({ maxCents: 12345 })).status).toBe(400);
    const ok = await rules({ version: before.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ enabled: true, customEnabled: true, maxCents: yuan(10000), dailyLimit: 3, version: before.version + 1 });
    const data = await adminData();
    expect(data).toMatchObject({ payMode: 'mock', payProblem: null });
    expect(data.plans.map((p) => p.name)).not.toContain('停用的套餐');
  });
});

describe('可充的项与建单', () => {
  it('勾选的套餐按这位会员预估赠金与档阶，首充最低挡住的写原因；挂的券写出来；自定义金额的范围', async () => {
    const { openid } = await bound('演示·看看能充什么');
    const o = await options(openid);
    expect(o).toMatchObject({ open: true, notice: null, first: true, minimum: yuan(500), dailyLimit: 3, usedToday: 0, pending: null });
    expect(o.custom).toEqual({ minCents: yuan(500), maxCents: yuan(10000) });
    const byName = Object.fromEntries(o.plans.map((p) => [p.name, p]));
    expect(byName['线上三百']).toMatchObject({ amount: yuan(300), blocked: '首充单笔最低 ¥500.00' });
    expect(byName['线上一千']).toMatchObject({ amount: yuan(1000), bonus: yuan(30), blocked: null, upgraded: true });
    expect(byName['线上一千']!.label).toContain('L1');
    expect(byName['线上三千']).toMatchObject({ bonus: yuan(150), coupons: ['线上搓澡券 × 2'] });
    const est = await call('GET', `/api/mp/recharge/preview?amount=${yuan(3000)}`, openid);
    expect(est.json()).toMatchObject({ amount: yuan(3000), bonus: yuan(150), upgraded: true });
    expect((await call('GET', '/api/mp/recharge/preview?amount=12345', openid)).statusCode).toBe(400);
  });

  it('建单 → 付款 → 到账通知 → 钱包入账：渠道小程序、不记班次、赠金照档算、套餐券照发；结果页写本金与赠金', async () => {
    const { memberId, openid } = await bound('演示·线上充三千');
    const created = await createOrder(openid, { planId: plan['线上三千'] });
    expect(created.statusCode, created.body).toBe(201);
    const c = created.json();
    expect(c).toMatchObject({ mock: true, replayed: false, order: { status: 'pending', amount: yuan(3000), planName: '线上三千', estBonus: yuan(150) } });
    expect(c.order.orderNo).toMatch(/^MPR\d{8}[0-9A-Z]{10}$/);
    expect(c.payment).toMatchObject({ signType: 'RSA', package: expect.stringMatching(/^prepay_id=wx/) });
    expect(wx.state(c.order.orderNo)).toBe('NOTPAY');
    const paid = await mockPay(openid, c.order.orderNo);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ status: 'paid', result: { principal: yuan(3000), bonus: yuan(150) } });
    expect(paid.json().result.label).toContain('L2');
    const [r] = await rechargesOf(memberId);
    expect(r).toMatchObject({ paidAmount: yuan(3000), bonusAmount: yuan(150), channel: 'mp', shiftId: null, planId: plan['线上三千'] });
    expect(await balanceOf(ctx, memberId)).toEqual({ principal: yuan(3000), bonus: yuan(150) });
    const o = await row(c.order.orderNo);
    expect(o).toMatchObject({ status: 'paid', rechargeId: r!.id, transactionId: r!.paymentRef, flags: [] });
    const coupons = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM coupons WHERE member_id = ${memberId}`;
    expect(coupons[0]!.n).toBeGreaterThanOrEqual(2);
    const events = await ctx.sql<{ kind: string }[]>`SELECT kind FROM mp_recharge_events WHERE order_id = ${o.id} ORDER BY id`;
    expect(events.map((e) => e.kind)).toEqual(['created', 'wx_order', 'notify', 'booked']);
    expect((await consistencyChecks(ctx.sql, ctx.config.timezone)).filter((c) => !c.ok)).toEqual([]);
  });

  it('同一个编号重提返回同一张单、不重复下单；换了内容拒绝；一人只有一张待支付的，取消后能再下', async () => {
    const { openid } = await bound('演示·重提与取消');
    const key = randomUUID();
    const first = (await createOrder(openid, { amount: yuan(800) }, key)).json();
    const again = await createOrder(openid, { amount: yuan(800) }, key);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, order: { orderNo: first.order.orderNo } });
    expect((await createOrder(openid, { amount: yuan(900) }, key)).json().error.code).toBe('CLIENT_KEY_REUSED');
    const second = await createOrder(openid, { amount: yuan(900) });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ORDER_PENDING');
    expect((await options(openid)).pending).toMatchObject({ orderNo: first.order.orderNo, status: 'pending' });
    const cancelled = await call('POST', `/api/mp/recharge/orders/${first.order.orderNo}/cancel`, openid, {});
    expect(cancelled.json()).toMatchObject({ status: 'closed', notice: '这张单已取消' });
    expect(wx.state(first.order.orderNo)).toBe('CLOSED');
    expect((await createOrder(openid, { amount: yuan(900) })).statusCode).toBe(201);
    // 别人的单看不到
    const other = await bound('演示·别人');
    expect((await call('GET', `/api/mp/recharge/orders/${first.order.orderNo}`, other.openid)).statusCode).toBe(404);
  });

  it('金额：整元、不低于首充最低、不超过线上单笔上限；自定义金额关掉后只能选套餐；停用、没勾的套餐不能下', async () => {
    const { openid } = await bound('演示·金额校验');
    expect((await createOrder(openid, { amount: yuan(800) + 50 })).statusCode).toBe(400);
    expect((await createOrder(openid, { amount: yuan(300) })).json().error.code).toBe('RECHARGE_BELOW_MIN');
    expect((await createOrder(openid, { amount: yuan(10001) })).json().error.code).toBe('RECHARGE_OVER_LIMIT');
    expect((await createOrder(openid, { planId: plan['停用的套餐'] })).json().error.code).toBe('PLAN_NOT_ONLINE');
    expect((await createOrder(openid, {})).statusCode).toBe(400);
    await rules({ customEnabled: false });
    expect((await createOrder(openid, { amount: yuan(800) })).json().error.code).toBe('CUSTOM_DISABLED');
    expect((await options(openid)).custom).toBeNull();
    await rules();
  });

  it('每人每天的笔数：已付的、待支付的都算，取消的不算', async () => {
    const { openid } = await bound('演示·每天三笔');
    await rules({ dailyLimit: 2 });
    for (const amount of [yuan(600), yuan(100)]) {
      const c = (await createOrder(openid, { amount })).json();
      expect((await mockPay(openid, c.order.orderNo)).json().status).toBe('paid');
    }
    const third = await createOrder(openid, { amount: yuan(100) });
    expect(third.json().error.code).toBe('DAILY_LIMIT');
    expect(await options(openid)).toMatchObject({ open: false, usedToday: 2 });
    await rules();
  });

  it('冻结的会员不能下单；下单之后冻结的照样入账、标出来给店主看', async () => {
    const a = await bound('演示·已冻结');
    await ctx.sql`UPDATE members SET status = 'frozen' WHERE id = ${a.memberId}`;
    expect((await options(a.openid)).notice).toBe('会员已冻结，请到前台咨询');
    expect((await createOrder(a.openid, { amount: yuan(600) })).json().error.code).toBe('MEMBER_FROZEN');
    const b = await bound('演示·付款前冻结');
    const c = (await createOrder(b.openid, { amount: yuan(600) })).json();
    await ctx.sql`UPDATE members SET status = 'frozen' WHERE id = ${b.memberId}`;
    expect((await mockPay(b.openid, c.order.orderNo)).json().status).toBe('paid');
    expect((await row(c.order.orderNo)).flags).toEqual(['frozen']);
    expect(await balanceOf(ctx, b.memberId)).toEqual({ principal: yuan(600), bonus: 0 });
  });
});

describe('合并掉的会员卡（主线 v0.7.26，MP25）', () => {
  it('「我的」写已合并、不给充值；线上充值不能下单', async () => {
    const target = await createMember(ctx, '演示·合并目标', '13666009991');
    const { memberId, openid } = await bound('演示·合并来源');
    await ctx.sql`UPDATE members SET status = 'frozen', merged_into_id = ${target.id} WHERE id = ${memberId}`;
    const me = (await call('GET', '/api/mp/me', openid)).json();
    expect(me.member).toMatchObject({ merged: true, frozen: true });
    expect((await options(openid)).open).toBe(false);
    expect((await createOrder(openid, { amount: yuan(600) })).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('建单结果待确认', () => {
  it('确认作废：已经建了就返回那张单；还没有就作废，之后原请求不建单；别的微信用同一个编号不认', async () => {
    const { openid } = await bound('演示·作废');
    const made = randomUUID();
    const c = (await createOrder(openid, { amount: yuan(600) }, made)).json();
    const r1 = await call('POST', '/api/mp/recharge/abandon', openid, { clientKey: made });
    expect(r1.json()).toMatchObject({ status: 'created', order: { orderNo: c.order.orderNo } });
    await call('POST', `/api/mp/recharge/orders/${c.order.orderNo}/cancel`, openid, {});
    const lost = randomUUID();
    expect((await call('POST', '/api/mp/recharge/abandon', openid, { clientKey: lost })).json()).toEqual({ status: 'abandoned' });
    const late = await createOrder(openid, { amount: yuan(600) }, lost);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('OP_ABANDONED');
    const other = await bound('演示·作废别人');
    expect((await call('POST', '/api/mp/recharge/abandon', other.openid, { clientKey: lost })).json().error.code).toBe('CLIENT_KEY_REUSED');
  });
});

describe('解绑、换绑之后的旧充值单（小程序线测试 866ccfa 的 P1）', () => {
  const bindingOf = async (openid: string) =>
    (await ctx.sql<{ id: number }[]>`SELECT id FROM mp_bindings WHERE openid = ${openid} AND unbound_at IS NULL`)[0]!.id;
  const unbind = async (openid: string) => {
    const r = await api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/bindings/${await bindingOf(openid)}/unbind`, { clientKey: randomUUID(), reason: '换手机号' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  /** 顾客对这张单能做的四件事：查单、继续支付、取消、模拟支付 */
  const touches = (openid: string, no: string) =>
    Promise.all([
      call('GET', `/api/mp/recharge/orders/${no}`, openid),
      call('POST', `/api/mp/recharge/orders/${no}/pay`, openid, {}),
      call('POST', `/api/mp/recharge/orders/${no}/cancel`, openid, {}),
      call('POST', `/api/mp/recharge/orders/${no}/mock-pay`, openid, {}),
    ]);
  const expectAll = async (openid: string, no: string, status: number, code: string) => {
    for (const r of await touches(openid, no)) {
      expect(r.statusCode, r.body).toBe(status);
      expect(r.json().error.code).toBe(code);
    }
  };
  const closeEvents = async (no: string) =>
    ctx.sql<{ detail: Record<string, unknown> }[]>`
      SELECT e.detail FROM mp_recharge_events e JOIN mp_recharge_orders o ON o.id = e.order_id WHERE o.order_no = ${no} AND e.kind = 'close' AND e.ok`;

  it('解绑当场请微信关掉还没付的单；旧微信查单、继续支付、取消、模拟支付都不认；换绑到别的会员后也一样，谁的余额都不变', async () => {
    await rules();
    const a = await bound('演示·解绑前下单');
    const c = (await createOrder(a.openid, { amount: yuan(600) })).json();
    expect(wx.state(c.order.orderNo)).toBe('NOTPAY');
    await unbind(a.openid);
    expect(wx.state(c.order.orderNo)).toBe('CLOSED');
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'closed', closeReason: 'cancelled' });
    expect((await closeEvents(c.order.orderNo))[0]!.detail).toMatchObject({ reason: 'cancelled', unbound: true });
    await expectAll(a.openid, c.order.orderNo, 403, 'MP_NOT_BOUND');
    // 同一个微信换绑到会员 B（B 原来绑的微信先解绑）
    const b = await bound('演示·换绑到的会员');
    await unbind(b.openid);
    await bindPhone(a.openid, b.phone);
    await expectAll(a.openid, c.order.orderNo, 404, 'NOT_FOUND');
    expect((await options(a.openid)).pending).toBeNull();
    expect(await rechargesOf(a.memberId)).toHaveLength(0);
    expect(await rechargesOf(b.memberId)).toHaveLength(0);
  });

  it('解绑时微信支付连不上：解绑照样成功；换绑后旧单不能再看、再付（测试报告的复现）；每分钟的补查接着关掉', async () => {
    const a = await bound('演示·解绑时连不上');
    const c = (await createOrder(a.openid, { amount: yuan(600) })).json();
    wx.setDown(true);
    await unbind(a.openid);
    wx.setDown(false);
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'pending' });
    expect(wx.state(c.order.orderNo)).toBe('NOTPAY');
    await expectAll(a.openid, c.order.orderNo, 403, 'MP_NOT_BOUND');
    // 同一个微信换绑到会员 B：旧单是 A 的、付款人是这个微信，照样不认；B 的可充项里也没有
    n += 1;
    const phoneB = `1366600${String(1000 + n)}`;
    const memberB = await createMember(ctx, '演示·换绑到 B', phoneB);
    await bindPhone(a.openid, phoneB);
    await expectAll(a.openid, c.order.orderNo, 404, 'NOT_FOUND');
    expect((await options(a.openid)).pending).toBeNull();
    expect(wx.state(c.order.orderNo)).toBe('NOTPAY');
    // 补查：已解绑的待支付单请微信关掉
    expect(await sweepRechargeOrders(deps, pay)).toMatchObject({ errors: 0 });
    expect(wx.state(c.order.orderNo)).toBe('CLOSED');
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'closed', closeReason: 'cancelled' });
    expect(await rechargesOf(a.memberId)).toHaveLength(0);
    expect(await rechargesOf(memberB.id)).toHaveLength(0);
  });

  it('换绑回同一位会员：之前那条绑定下的单也不认；那张单还没关上时下新单提示稍后再试，关上后照常下单', async () => {
    const a = await bound('演示·换绑回自己');
    const c = (await createOrder(a.openid, { amount: yuan(600) })).json();
    wx.setDown(true);
    await unbind(a.openid);
    wx.setDown(false);
    await bindPhone(a.openid, a.phone);
    await expectAll(a.openid, c.order.orderNo, 404, 'NOT_FOUND');
    expect((await options(a.openid)).pending).toBeNull();
    const blocked = await createOrder(a.openid, { amount: yuan(600) });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatchObject({ code: 'ORDER_PENDING', message: '换绑之前下的那张充值单还在关闭，请过一分钟再试' });
    await sweepRechargeOrders(deps, pay);
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'closed' });
    const again = await createOrder(a.openid, { amount: yuan(600) });
    expect(again.statusCode, again.body).toBe(201);
    expect((await options(a.openid)).pending?.orderNo).toBe(again.json().order.orderNo);
    await call('POST', `/api/mp/recharge/orders/${again.json().order.orderNo}/cancel`, a.openid, {});
  });

  it('换绑完成以后才到的建单请求（确认时还绑着 A）：门店系统拒绝、不建单，钱不会记到 B 身上；按 B 的版本号重新确认才建单（小程序线测试 #52 的 P1）', async () => {
    const a = await bound('演示·确认时是 A');
    // 充值页打开时：这个微信绑着 A，页面拿到的版本号
    const seen = (await options(a.openid)).bindVersion;
    expect(seen).toBe(await versionOf(a.openid));
    // 请求在路上：员工解绑 A，这个微信换绑会员 B
    await unbind(a.openid);
    n += 1;
    const phoneB = `1366600${String(1000 + n)}`;
    const memberB = await createMember(ctx, '演示·后来换绑的 B', phoneB);
    await bindPhone(a.openid, phoneB);
    // 旧请求这时才到：带的是确认时的版本号
    const key = randomUUID();
    const late = await createOrder(a.openid, { amount: yuan(600), bindVersion: seen }, key);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('BIND_STALE');
    const [count] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mp_recharge_orders WHERE client_key = ${key}`;
    expect(count!.n).toBe(0);
    expect((await options(a.openid)).pending).toBeNull();
    // 同一个编号再提一次（原样重提）也一样拒绝
    expect((await createOrder(a.openid, { amount: yuan(600), bindVersion: seen }, key)).json().error.code).toBe('BIND_STALE');
    expect(await rechargesOf(a.memberId)).toHaveLength(0);
    expect(await rechargesOf(memberB.id)).toHaveLength(0);
    // 顾客回到充值页（看到的是 B）重新确认：按 B 的版本号建单
    const fresh = await options(a.openid);
    expect(fresh.bindVersion).toBeGreaterThan(seen);
    const ok = await createOrder(a.openid, { amount: yuan(600), bindVersion: fresh.bindVersion });
    expect(ok.statusCode, ok.body).toBe(201);
    const [o] = await ctx.sql<{ memberId: number }[]>`SELECT member_id FROM mp_recharge_orders WHERE order_no = ${ok.json().order.orderNo}`;
    expect(o!.memberId).toBe(memberB.id);
    await call('POST', `/api/mp/recharge/orders/${ok.json().order.orderNo}/cancel`, a.openid, {});
  });

  it('解绑以后、换绑以前到的旧请求：没绑定，不建单；版本号不对的请求（例如页面没刷新）也不建单', async () => {
    const a = await bound('演示·解绑后才到');
    const seen = await versionOf(a.openid);
    await unbind(a.openid);
    const r = await createOrder(a.openid, { amount: yuan(600), bindVersion: seen });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('MP_NOT_BOUND');
    const b = await bound('演示·版本号不对');
    const wrong = await createOrder(b.openid, { amount: yuan(600), bindVersion: (await versionOf(b.openid)) + 1 });
    expect(wrong.json().error.code).toBe('BIND_STALE');
    const missing = await call('POST', '/api/mp/recharge/orders', b.openid, { clientKey: randomUUID(), amount: yuan(600) });
    expect(missing.statusCode).toBe(400);
    expect(await rechargesOf(a.memberId)).toHaveLength(0);
  });

  it('建单的编号在解绑、换绑之后重提或确认作废：不给旧单、不另建单，提示重新选择', async () => {
    const a = await bound('演示·换绑后重提');
    const key = randomUUID();
    const v0 = await versionOf(a.openid);
    const c = (await createOrder(a.openid, { amount: yuan(600) }, key)).json();
    await unbind(a.openid);
    const unboundReplay = await createOrder(a.openid, { amount: yuan(600) }, key);
    expect(unboundReplay.statusCode).toBe(403);
    expect(unboundReplay.json().error.code).toBe('MP_NOT_BOUND');
    expect((await call('POST', '/api/mp/recharge/abandon', a.openid, { clientKey: key })).json()).toEqual({ status: 'abandoned' });
    n += 1;
    const phoneB = `1366600${String(1000 + n)}`;
    await createMember(ctx, '演示·重提时的 B', phoneB);
    await bindPhone(a.openid, phoneB);
    // 原样重提（带当初的版本号）：绑定变过，拒绝；带现在的版本号：编号是之前那条绑定用过的，也拒绝
    expect((await createOrder(a.openid, { amount: yuan(600), bindVersion: v0 }, key)).json().error.code).toBe('BIND_STALE');
    const reboundReplay = await createOrder(a.openid, { amount: yuan(600) }, key);
    expect(reboundReplay.statusCode).toBe(409);
    expect(reboundReplay.json().error.code).toBe('CLIENT_KEY_REUSED');
    expect((await call('POST', '/api/mp/recharge/abandon', a.openid, { clientKey: key })).json()).toEqual({ status: 'abandoned' });
    const [count] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mp_recharge_orders WHERE client_key = ${key}`;
    expect(count!.n).toBe(1);
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'closed' });
  });

  it('解绑前已经付了：解绑时请微信关单得知已付，当场按原单入账到原来的会员；之后到账通知再到不重复入账', async () => {
    const a = await bound('演示·解绑前付了');
    const c = (await createOrder(a.openid, { amount: yuan(600) })).json();
    const msg = wx.pay(c.order.orderNo);
    await unbind(a.openid);
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'paid' });
    expect((await notify(msg)).statusCode).toBe(204);
    const rs = await rechargesOf(a.memberId);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ paidAmount: yuan(600), channel: 'mp' });
  });

  it('解绑前已经付了、解绑时微信连不上、换绑之后到账通知才到：照样按原单入账到原来的会员，只入账一次；新绑的会员不变', async () => {
    const a = await bound('演示·通知晚到');
    const c = (await createOrder(a.openid, { amount: yuan(600) })).json();
    const msg = wx.pay(c.order.orderNo);
    wx.setDown(true);
    await unbind(a.openid);
    wx.setDown(false);
    n += 1;
    const phoneB = `1366600${String(1000 + n)}`;
    const memberB = await createMember(ctx, '演示·通知晚到时的 B', phoneB);
    await bindPhone(a.openid, phoneB);
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'pending' });
    const [r1, r2] = await Promise.all([notify(msg), notify(msg)]);
    expect([r1.statusCode, r2.statusCode]).toEqual([204, 204]);
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'paid' });
    expect(await rechargesOf(a.memberId)).toHaveLength(1);
    expect(await rechargesOf(memberB.id)).toHaveLength(0);
    // 补查不再动它
    await sweepRechargeOrders(deps, pay);
    expect(await rechargesOf(a.memberId)).toHaveLength(1);
  });

  it('继续支付与解绑交错（这张单已经有 prepay_id、解绑时微信关单失败）：解绑先提交的，继续支付不再签出支付参数；之前拿到参数付了的照样按原单入账（测试会话 #52 的补充）', async () => {
    const a = await bound('演示·继续支付与解绑');
    const c = (await createOrder(a.openid, { amount: yuan(600) })).json();
    expect(c.payment).not.toBeNull();
    const id = await bindingOf(a.openid);
    // 先拿住这个微信绑定锁的排他模式，让解绑、继续支付按先后排队：解绑在前（只数排这一把的，见 advisoryWaitersOn）
    const holder = await holdAdvisory(`mp_bind:${a.openid}`);
    wx.setDown(true);
    let unbinding: ReturnType<typeof api> | undefined;
    let paying: ReturnType<typeof call> | undefined;
    try {
      unbinding = api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/bindings/${id}/unbind`, { clientKey: randomUUID(), reason: '换手机号' });
      await waitForAdvisoryWaiters(holder.pid, 1);
      paying = call('POST', `/api/mp/recharge/orders/${c.order.orderNo}/pay`, a.openid, {});
      await waitForAdvisoryWaiters(holder.pid, 2);
    } finally {
      // 中途出错也放开，不让排着的请求一直等、连累后面的用例
      await holder.release();
    }
    const [u, p] = await Promise.all([unbinding!, paying!]);
    wx.setDown(false);
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(p.statusCode, p.body).toBe(403);
    expect(p.json().error.code).toBe('MP_NOT_BOUND');
    expect(p.json().payment).toBeUndefined();
    // 关单没成功，建单时拿到的参数还能付：付了照样按原单入账到原来的会员，只入一次；之后补查不再动它
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'pending' });
    const msg = wx.pay(c.order.orderNo);
    expect((await notify(msg)).statusCode).toBe(204);
    expect((await notify(msg)).statusCode).toBe(204);
    await sweepRechargeOrders(deps, pay);
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'paid' });
    expect(await rechargesOf(a.memberId)).toHaveLength(1);
  });

  it('建单与解绑同时：要么没建成（已解绑），要么建好的单在解绑后马上关掉；不会留下解绑之后还能付的单', async () => {
    await rules();
    for (let i = 0; i < 6; i++) {
      const a = await bound(`演示·同时解绑${i}`);
      const id = await bindingOf(a.openid);
      const [c, u] = await Promise.all([
        createOrder(a.openid, { amount: yuan(600) }),
        api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/bindings/${id}/unbind`, { clientKey: randomUUID(), reason: '同时解绑' }),
      ]);
      expect(u.status, JSON.stringify(u.body)).toBe(200);
      if (c.statusCode !== 201) expect(['MP_NOT_BOUND', 'ORDER_NOT_PENDING'], c.body).toContain(c.json().error.code);
      const left = await ctx.sql<{ orderNo: string; status: string }[]>`SELECT order_no, status FROM mp_recharge_orders WHERE binding_id = ${id}`;
      for (const o of left) {
        expect(o.status).toBe('closed');
        expect(wx.state(o.orderNo)).not.toBe('NOTPAY');
      }
      expect(await rechargesOf(a.memberId)).toHaveLength(0);
    }
    const [open] = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM mp_recharge_orders o JOIN mp_bindings b ON b.id = o.binding_id WHERE o.status = 'pending' AND b.unbound_at IS NOT NULL`;
    expect(open!.n).toBe(0);
  });
});

describe('到账通知', () => {
  it('验签失败、改过的、没带网关密钥的都不认、不入账、不记库', async () => {
    const { memberId, openid } = await bound('演示·冒充的通知');
    const c = (await createOrder(openid, { amount: yuan(600) })).json();
    const real = wx.pay(c.order.orderNo);
    const before = Number((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mp_recharge_events`)[0]!.n);
    const tampered = await notify({ headers: real.headers, body: real.body.replace('"TRANSACTION.SUCCESS"', '"TRANSACTION.SUCCESs"') });
    expect(tampered.statusCode).toBe(401);
    const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = { ...real, headers: { ...real.headers, signature: (await import('node:crypto')).createSign('RSA-SHA256').update(`${real.headers.timestamp}\n${real.headers.nonce}\n${real.body}\n`).sign(stranger.privateKey, 'base64') } };
    expect((await notify(forged)).statusCode).toBe(401);
    expect((await notify({ headers: { ...real.headers, signature: 'WECHATPAY/SIGNTEST/abc' }, body: real.body })).statusCode).toBe(401);
    const noKey = await mp.inject({ method: 'POST', url: '/api/mp/pay/notify', payload: { headers: real.headers, body: Buffer.from(real.body).toString('base64') } });
    expect(noKey.statusCode).toBe(401);
    expect(Number((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mp_recharge_events`)[0]!.n)).toBe(before);
    expect(await rechargesOf(memberId)).toEqual([]);
    // 真的那条到了照常入账
    expect((await notify(real)).statusCode).toBe(204);
    expect((await row(c.order.orderNo)).status).toBe('paid');
  });

  it('退款等别的事件的通知：验过签就回收到、不动单子（免得微信一直重发）；改过的照样不认', async () => {
    const { memberId, openid } = await bound('演示·退款通知');
    const c = (await createOrder(openid, { amount: yuan(600) })).json();
    expect((await notify(wx.pay(c.order.orderNo))).statusCode).toBe(204);
    // 例如店里在商户平台把这笔退了、商户平台的退款通知也配到了这个地址（这里用模拟的退款接口造一条退款通知）
    await wx.client.refund({ outTradeNo: c.order.orderNo, outRefundNo: `RF${c.order.orderNo}`, reason: '', refundCents: yuan(600), totalCents: yuan(600) });
    const n = wx.settleRefund(`RF${c.order.orderNo}`, 'SUCCESS');
    expect((await notify(n)).statusCode).toBe(204);
    expect((await notify({ headers: n.headers, body: n.body.replace('"REFUND.SUCCESS"', '"REFUND.SUCCESs"') })).statusCode).toBe(401);
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'paid' });
    expect(await rechargesOf(memberId)).toHaveLength(1);
  });

  it('同一笔的通知重复到、同时到：只入账一次', async () => {
    const { memberId, openid } = await bound('演示·重复通知');
    const c = (await createOrder(openid, { amount: yuan(1000) })).json();
    const msg = wx.pay(c.order.orderNo);
    const results = await Promise.all([notify(msg), notify(msg), notify(msg)]);
    expect(results.map((r) => r.statusCode)).toEqual([204, 204, 204]);
    expect((await notify(msg)).statusCode).toBe(204);
    expect(await rechargesOf(memberId)).toHaveLength(1);
    expect(await balanceOf(ctx, memberId)).toEqual({ principal: yuan(1000), bonus: yuan(30) });
  });

  it('通知没到：顾客查单时门店系统去微信查、当场入账；之后通知再到不重复入账', async () => {
    const { memberId, openid } = await bound('演示·查单补记');
    const c = (await createOrder(openid, { amount: yuan(700) })).json();
    expect((await orderOf(openid, c.order.orderNo)).status).toBe('pending');
    const msg = wx.pay(c.order.orderNo);
    // 同一张单 3 秒查一次：刚查过的这次不再去微信
    await ctx.sql`UPDATE mp_recharge_orders SET queried_at = NULL WHERE order_no = ${c.order.orderNo}`;
    expect((await orderOf(openid, c.order.orderNo)).status).toBe('paid');
    expect((await notify(msg)).statusCode).toBe(204);
    expect(await rechargesOf(memberId)).toHaveLength(1);
  });

  it('找不到单子的真付款（例如从备份恢复过）：记下来给店主看，同一笔只记一次，回收到', async () => {
    const t = { appid: wx.config.appId, mchid: wx.config.mchId, out_trade_no: 'MPR20260101AAAAAAAAAA', transaction_id: '4200000000000000000000000001', trade_state: 'SUCCESS', success_time: beijingIso(1), payer: { openid: 'openid-gone-000001' }, amount: { total: 50000 } };
    expect((await notify(wx.notification(t))).statusCode).toBe(204);
    expect((await notify(wx.notification(t))).statusCode).toBe(204);
    const orphans = (await adminData()).orphans.filter((o) => o.outTradeNo === 'MPR20260101AAAAAAAAAA');
    expect(orphans).toEqual([expect.objectContaining({ transactionId: '4200000000000000000000000001', amount: 50000 })]);
  });
});

describe('关单与补查', () => {
  it('过期没付的：补查时请微信关单、记已关闭；付了没通知的补记入账；微信那边没有这一单的过期后关', async () => {
    const a = await bound('演示·过期没付');
    const ca = (await createOrder(a.openid, { amount: yuan(600) })).json();
    const b = await bound('演示·付了没通知');
    const cb = (await createOrder(b.openid, { amount: yuan(600) })).json();
    wx.pay(cb.order.orderNo);
    const c = await bound('演示·微信下单没成功');
    wx.setDown(true);
    const cc = await createOrder(c.openid, { amount: yuan(600) });
    wx.setDown(false);
    expect(cc.statusCode).toBe(201);
    expect(cc.json().payment).toBeNull();
    const later = new Date(Date.now() + 20 * 60_000);
    const swept = await sweepRechargeOrders(deps, pay, later);
    expect(swept.errors).toBe(0);
    expect(await row(ca.order.orderNo)).toMatchObject({ status: 'closed', closeReason: 'expired' });
    expect(wx.state(ca.order.orderNo)).toBe('CLOSED');
    expect((await row(cb.order.orderNo)).status).toBe('paid');
    expect(await balanceOf(ctx, b.memberId)).toEqual({ principal: yuan(600), bonus: 0 });
    expect(await row(cc.json().order.orderNo)).toMatchObject({ status: 'closed', closeReason: 'expired' });
    expect((await orderOf(a.openid, ca.order.orderNo)).notice).toBe('这张单过了 15 分钟没有付，已关闭');
  });

  it('微信连不上时建的单：支付参数为空，继续支付时再向微信下单', async () => {
    const { openid } = await bound('演示·继续支付');
    wx.setDown(true);
    const c = (await createOrder(openid, { amount: yuan(600) })).json();
    wx.setDown(false);
    expect(c.payment).toBeNull();
    const again = await call('POST', `/api/mp/recharge/orders/${c.order.orderNo}/pay`, openid, {});
    expect(again.json().payment).toMatchObject({ signType: 'RSA' });
    expect(wx.state(c.order.orderNo)).toBe('NOTPAY');
  });

  it('关单之后才到的付款：照样入账、标出来', async () => {
    const { memberId, openid } = await bound('演示·关单后付款');
    const c = (await createOrder(openid, { amount: yuan(600) })).json();
    const msg = wx.pay(c.order.orderNo);
    // 门店这边先记了关单（例如顾客点取消时微信那边还没回已付），付款的通知后到
    await ctx.sql`UPDATE mp_recharge_orders SET status = 'closed', closed_at = now(), close_reason = 'cancelled' WHERE order_no = ${c.order.orderNo}`;
    expect((await notify(msg)).statusCode).toBe(204);
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'paid', flags: ['after_close'] });
    expect(await balanceOf(ctx, memberId)).toEqual({ principal: yuan(600), bonus: 0 });
  });
});

describe('已付款待处理', () => {
  it('到账时套餐停用了：不入账、记已付款待处理；店主重新入账仍被拒，按金额入账（不发套餐券）', async () => {
    const { memberId, openid } = await bound('演示·套餐停用');
    const c = (await createOrder(openid, { planId: plan['线上一千'] })).json();
    await ctx.sql`UPDATE recharge_plans SET active = false WHERE id = ${plan['线上一千']!}`;
    const after = (await mockPay(openid, c.order.orderNo)).json();
    expect(after).toMatchObject({ status: 'held', notice: expect.stringContaining('0755-12345678') });
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'held', holdCode: 'PLAN_UNAVAILABLE' });
    expect(await rechargesOf(memberId)).toEqual([]);
    const held = (await adminData()).held.find((h) => h.orderNo === c.order.orderNo)!;
    expect(held).toMatchObject({ status: 'held', holdCode: 'PLAN_UNAVAILABLE', memberId });
    const resolve = (action: string, clientKey = randomUUID(), cookie = ctx.owner) =>
      api(ctx.app, cookie, 'POST', `/api/admin/mp/recharge/orders/${held.id}/resolve`, { clientKey, action, note: '套餐停用了，按金额入账' });
    expect((await resolve('rebook_amount', randomUUID(), ctx.clerk)).status).toBe(403);
    expect((await resolve('rebook')).body.error.code).toBe('PLAN_UNAVAILABLE');
    const key = randomUUID();
    const done = await resolve('rebook_amount', key);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'paid', resolution: 'rebook_amount', resolvedByName: expect.any(String) });
    expect((await resolve('rebook_amount', key)).body).toMatchObject({ status: 'paid' });
    const rs = await rechargesOf(memberId);
    expect(rs).toEqual([expect.objectContaining({ paidAmount: yuan(1000), bonusAmount: yuan(30), channel: 'mp', planId: null })]);
    expect((await resolve('handled')).body.error.code).toBe('NOT_HELD');
    await ctx.sql`UPDATE recharge_plans SET active = true WHERE id = ${plan['线上一千']!}`;
    expect((await consistencyChecks(ctx.sql, ctx.config.timezone)).filter((c) => !c.ok)).toEqual([]);
  });

  it('通知与单子对不上（金额）：记已付款待处理，不能直接入账，只能记已另行处理', async () => {
    const { memberId, openid } = await bound('演示·对不上');
    const c = (await createOrder(openid, { amount: yuan(600) })).json();
    const t = { appid: wx.config.appId, mchid: wx.config.mchId, out_trade_no: c.order.orderNo, transaction_id: '4200000000000000000000000099', trade_state: 'SUCCESS', success_time: beijingIso(1), payer: { openid }, amount: { total: yuan(6) } };
    expect((await notify(wx.notification(t))).statusCode).toBe(204);
    expect(await row(c.order.orderNo)).toMatchObject({ status: 'held', holdCode: 'MISMATCH' });
    const id = (await row(c.order.orderNo)).id;
    // 两种入账都拒（MP24 第二类：只能记已另行处理）
    for (const action of ['rebook', 'rebook_amount']) {
      const r = await api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/recharge/orders/${id}/resolve`, { clientKey: randomUUID(), action, note: '试试' });
      expect(r.body.error.code, action).toBe('REBOOK_REFUSED');
    }
    const h = await api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/recharge/orders/${id}/resolve`, { clientKey: randomUUID(), action: 'handled', note: '商户平台已原路退回' });
    expect(h.body).toMatchObject({ status: 'handled', resolution: 'handled', resolutionNote: '商户平台已原路退回' });
    expect(await rechargesOf(memberId)).toEqual([]);
    expect((await orderOf(openid, c.order.orderNo)).status).toBe('handled');
  });

  it('付款的微信不是下单的微信：同样记已付款待处理（对不上），两种入账都拒，只能记已另行处理', async () => {
    const { memberId, openid } = await bound('演示·付款人对不上');
    const c = (await createOrder(openid, { amount: yuan(600) })).json();
    const t = { appid: wx.config.appId, mchid: wx.config.mchId, out_trade_no: c.order.orderNo, transaction_id: '4200000000000000000000000098', trade_state: 'SUCCESS', success_time: beijingIso(1), payer: { openid: 'openid-someone-else-01' }, amount: { total: yuan(600) } };
    expect((await notify(wx.notification(t))).statusCode).toBe(204);
    const held = await row(c.order.orderNo);
    expect(held).toMatchObject({ status: 'held', holdCode: 'MISMATCH' });
    for (const action of ['rebook', 'rebook_amount']) {
      const r = await api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/recharge/orders/${held.id}/resolve`, { clientKey: randomUUID(), action, note: '试试' });
      expect(r.body.error.code, action).toBe('REBOOK_REFUSED');
    }
    expect(await rechargesOf(memberId)).toEqual([]);
  });
});

describe('审查 2a 的修正', () => {
  const minutesAgo = beijingIso;
  /** 微信那边这一单现在的样子，拼成一条付款时间是 m 分钟前的到账通知（微信在重发） */
  const lateNotice = async (no: string, m: number) => {
    const t = (await wx.client.queryOrder(no))!;
    return wx.notification({
      appid: t.appId,
      mchid: t.mchId,
      out_trade_no: no,
      transaction_id: t.transactionId,
      trade_state: 'SUCCESS',
      success_time: minutesAgo(m),
      payer: { openid: t.payerOpenid },
      amount: { total: t.amountTotal },
    });
  };

  it('晚到的通知（微信在重发）：先查单——已在商户平台退了的不入账、记已付款待处理；查得到已付的照常入账；查不了回失败等重发', async () => {
    const a = await bound('演示·晚到已退款');
    const ca = (await createOrder(a.openid, { amount: yuan(600) })).json();
    wx.pay(ca.order.orderNo);
    wx.refund(ca.order.orderNo);
    expect((await notify(await lateNotice(ca.order.orderNo, 30))).statusCode).toBe(204);
    expect(await row(ca.order.orderNo)).toMatchObject({ status: 'held', holdCode: 'WX_REFUND' });
    expect(await rechargesOf(a.memberId)).toEqual([]);

    const b = await bound('演示·晚到照常');
    const cb = (await createOrder(b.openid, { amount: yuan(600) })).json();
    wx.pay(cb.order.orderNo);
    const late = await lateNotice(cb.order.orderNo, 30);
    wx.setDown(true);
    expect((await notify(late)).statusCode).toBe(503);
    expect((await row(cb.order.orderNo)).status).toBe('pending');
    wx.setDown(false);
    expect((await notify(late)).statusCode).toBe(204);
    expect((await row(cb.order.orderNo)).status).toBe('paid');
    expect(await rechargesOf(b.memberId)).toHaveLength(1);
  });

  it('这一次付款失败（PAYERROR）不是最终结果：单子不关，之后付了照常入账', async () => {
    const { memberId, openid } = await bound('演示·付款失败再付');
    const c = (await createOrder(openid, { amount: yuan(600) })).json();
    wx.payError(c.order.orderNo);
    await sweepRechargeOrders(deps, pay, new Date(Date.now() + 3 * 60_000));
    expect((await row(c.order.orderNo)).status).toBe('pending');
    wx.pay(c.order.orderNo);
    await sweepRechargeOrders(deps, pay, new Date(Date.now() + 5 * 60_000));
    expect((await row(c.order.orderNo)).status).toBe('paid');
    expect(await rechargesOf(memberId)).toHaveLength(1);
  });

  it('「继续支付」向微信下单期间这张单被取消了：不给支付参数，刚下的微信单也关掉', async () => {
    const { openid } = await bound('演示·继续支付与取消');
    wx.setDown(true);
    const c = (await createOrder(openid, { amount: yuan(600) })).json();
    wx.setDown(false);
    const racing: PayRuntime = {
      ...pay,
      client: {
        ...pay.client,
        async jsapiOrder(o) {
          const r = await pay.client.jsapiOrder(o);
          // 下单的应答回来之前，顾客在另一处把这张单取消了（微信那边当时还没有这一单，只在本地关）
          await ctx.sql`UPDATE mp_recharge_orders SET status = 'closed', closed_at = now(), close_reason = 'cancelled' WHERE order_no = ${o.outTradeNo}`;
          return r;
        },
      },
    };
    await expect(payRechargeOrder(deps, racing, openid, c.order.orderNo)).rejects.toMatchObject({ code: 'ORDER_NOT_PENDING' });
    expect(wx.state(c.order.orderNo)).toBe('CLOSED');
    const [o] = await ctx.sql<{ prepayId: string | null }[]>`SELECT prepay_id FROM mp_recharge_orders WHERE order_no = ${c.order.orderNo}`;
    expect(o!.prepayId).toBeNull();
  });

  it('店主处理在锁住的单子上再核对：等锁期间变成「对不上」的，入账照样拒', async () => {
    const { memberId, openid } = await bound('演示·处理时变了');
    const c = (await createOrder(openid, { amount: yuan(600) })).json();
    const id = (await row(c.order.orderNo)).id;
    // 先让这张单成为已付款待处理（套餐、规则都没问题，这里直接造一条第一类的待处理记录不现实，改用：先占住会员一行）
    let release!: () => void;
    const holding = ctx.sql.begin(async (tx) => {
      await tx`SELECT id FROM members WHERE id = ${memberId} FOR UPDATE`;
      await new Promise<void>((r) => (release = r));
    });
    await new Promise((r) => setTimeout(r, 100));
    // 这时店主发「重新入账」（单子还在待支付；手工拼的请求），在会员一行上等着
    const resolving = api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/recharge/orders/${id}/resolve`, { clientKey: randomUUID(), action: 'rebook', note: '试试' });
    await new Promise((r) => setTimeout(r, 300));
    // 等的这段时间到了一条金额对不上的通知：只锁单子一行，记成已付款待处理（对不上）
    const t = { appid: wx.config.appId, mchid: wx.config.mchId, out_trade_no: c.order.orderNo, transaction_id: '4200000000000000000000000097', trade_state: 'SUCCESS', success_time: minutesAgo(1), payer: { openid }, amount: { total: yuan(6) } };
    expect((await notify(wx.notification(t))).statusCode).toBe(204);
    release();
    await holding;
    const r = await resolving;
    expect(r.body.error.code).toBe('REBOOK_REFUSED');
    expect(await rechargesOf(memberId)).toEqual([]);
  });

  it('门店这边入账一直出错：出错 3 次以上、头一次过了 10 分钟，记已付款待处理（BOOK_FAILED）给店主；修好后重新入账只入一次', async () => {
    const a = await bound('演示·一直出错');
    const ca = (await createOrder(a.openid, { amount: yuan(600) })).json();
    const ida = (await row(ca.order.orderNo)).id;
    await ctx.sql`
      CREATE FUNCTION test_fail_recharge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION '模拟门店系统出错'; END $$`;
    await ctx.sql.unsafe(`CREATE TRIGGER test_fail_recharge BEFORE INSERT ON recharges FOR EACH ROW WHEN (NEW.member_id = ${a.memberId}) EXECUTE FUNCTION test_fail_recharge()`);
    try {
      // 刚出错：回失败（微信会重发），单子还是待支付
      const msg = wx.pay(ca.order.orderNo);
      expect((await notify(msg)).statusCode).toBe(500);
      expect((await row(ca.order.orderNo)).status).toBe('pending');
      // 之前已经出错过两次、头一次在 15 分钟前
      await ctx.sql`INSERT INTO mp_recharge_events (order_id, kind, ok, code, created_at) VALUES (${ida}, 'booked', false, 'ERROR', now() - interval '15 minutes')`;
      expect((await notify(msg)).statusCode).toBe(204);
      expect(await row(ca.order.orderNo)).toMatchObject({ status: 'held', holdCode: 'BOOK_FAILED' });
    } finally {
      await ctx.sql`DROP TRIGGER test_fail_recharge ON recharges`;
      await ctx.sql`DROP FUNCTION test_fail_recharge()`;
    }
    const done = await api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/recharge/orders/${ida}/resolve`, { clientKey: randomUUID(), action: 'rebook', note: '系统修好了' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await rechargesOf(a.memberId)).toHaveLength(1);
  });
});

describe('模拟支付与微信支付的配置', () => {
  it('模拟支付只在 development、test：演练、正式的实例拒绝', async () => {
    const prodMp = await buildMpApp(ctx.sql, { ...ctx.config, env: 'production', mp: { ...ctx.config.mp, gatewayKey: KEY } }, { pay, sweepMs: 0 });
    try {
      const { openid } = await bound('演示·正式环境模拟');
      const c = (await createOrder(openid, { amount: yuan(600) })).json();
      const r = await prodMp.inject({ method: 'POST', url: `/api/mp/recharge/orders/${c.order.orderNo}/mock-pay`, headers: { [MP_GATEWAY_HEADER]: KEY, [MP_OPENID_HEADER]: openid }, payload: {} });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('MP_MOCK_REFUSED');
    } finally {
      await prodMp.close();
      // 换回测试用的（buildMpApp 会设这个进程的微信支付）
      await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } }, { pay, sweepMs: 0 }).then((a) => a.close());
    }
  });

  it('读配置：一样没配不开；配了一部分、模拟开在正式环境都报错；配齐了用真的', () => {
    expect(loadPayRuntime({}, 'production')).toBeNull();
    expect(() => loadPayRuntime({ MP_PAY_MOCK: 'true' }, 'production')).toThrow('只能在 development、test');
    expect(loadPayRuntime({ MP_PAY_MOCK: 'true' }, 'development')?.mode).toBe('mock');
    expect(() => loadPayRuntime({ WXPAY_MCHID: '1900000109' }, 'production')).toThrow('还缺');
    const dir = mkdtempSync(join(tmpdir(), 'wxpay-'));
    const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wechat = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(join(dir, 'key.pem'), merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(join(dir, 'pub.pem'), wechat.publicKey.export({ type: 'spki', format: 'pem' }));
    const env = {
      WXPAY_APPID: 'wx0123456789abcdef',
      WXPAY_MCHID: '1900000109',
      WXPAY_SERIAL_NO: '5157F09EFDC096DE15EBE81A47057A7232F1B8E1',
      WXPAY_PRIVATE_KEY_FILE: join(dir, 'key.pem'),
      WXPAY_APIV3_KEY: 'a'.repeat(32),
      WXPAY_PUBLIC_KEY_ID: 'PUB_KEY_ID_0114232134912410000000000000',
      WXPAY_PUBLIC_KEY_FILE: join(dir, 'pub.pem'),
      WXPAY_NOTIFY_URL: 'https://mp.example.com/v1/pay/notify',
    };
    expect(loadPayRuntime(env, 'production')).toMatchObject({ mode: 'real', mock: null, config: { mchId: '1900000109', appId: 'wx0123456789abcdef' } });
    expect(() => loadPayRuntime({ ...env, WXPAY_APIV3_KEY: 'short' }, 'production')).toThrow('32 个字符');
    expect(() => loadPayRuntime({ ...env, WXPAY_PRIVATE_KEY_FILE: join(dir, 'nothing.pem') }, 'production')).toThrow('读不了');
    // 证书也可以给文件内容的 Base64（一行，放进 .env）
    const b64 = { ...env, WXPAY_PRIVATE_KEY_FILE: '', WXPAY_PRIVATE_KEY_BASE64: Buffer.from(merchant.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') };
    expect(loadPayRuntime(b64, 'production')?.mode).toBe('real');
    expect(() => loadPayRuntime({ ...b64, WXPAY_PRIVATE_KEY_BASE64: 'bm90IGEga2V5' }, 'production')).toThrow('WXPAY_PRIVATE_KEY_BASE64 不是商户 API 证书的私钥');
    expect(() => loadPayRuntime({ ...env, WXPAY_PUBLIC_KEY_FILE: '' }, 'production')).toThrow('WXPAY_PUBLIC_KEY_FILE（或 WXPAY_PUBLIC_KEY_BASE64）');
    expect(() => loadPayRuntime({ ...env, WXPAY_NOTIFY_URL: 'http://mp.example.com/v1/pay/notify' }, 'production')).toThrow('https');
    expect(() => loadPayRuntime({ ...env, MP_PAY_MOCK: 'true' }, 'development')).toThrow('不要再配');
    // 实例标识是正式服、影子运行、测试服的也不开模拟
    expect(() => loadPayRuntime({ MP_PAY_MOCK: 'true' }, 'development', 'test')).toThrow('不能开在 test 实例上');
    expect(loadPayRuntime({ MP_PAY_MOCK: 'true' }, 'development', 'demo')?.mode).toBe('mock');
  });
});

describe('测试自己的同步：等锁的计数', () => {
  it('只数持锁那条连接拿着的那一把：同一个库里别的咨询锁在排的不算；目标锁上 0、1、2 个（主线在 #84 的报告、小程序线测试 bf79dcc 的复核）', async () => {
    const target = await holdAdvisory('test:lockwait:target');
    const other = await holdAdvisory('test:lockwait:other');
    const wait = (key: string) => ctx.sql.begin((tx) => tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    // 同一个库里别的咨询锁上有人在排：不算
    const o = wait('test:lockwait:other');
    await waitForAdvisoryWaiters(other.pid, 1);
    expect(await advisoryWaitersOn(target.pid)).toBe(0);
    // 目标锁上排一个、两个
    const t1 = wait('test:lockwait:target');
    await waitForAdvisoryWaiters(target.pid, 1);
    expect(await advisoryWaitersOn(target.pid)).toBe(1);
    const t2 = wait('test:lockwait:target');
    await waitForAdvisoryWaiters(target.pid, 2);
    expect(await advisoryWaitersOn(target.pid)).toBe(2);
    // 别的那把放开、排的拿到了：目标锁照旧 2 个
    await other.release();
    await o;
    expect(await advisoryWaitersOn(target.pid)).toBe(2);
    // 放开以后排着的两个都拿到、做完
    await target.release();
    await Promise.all([t1, t2]);
  });
});
