// 微信小程序第一期 ②（小程序线，docs/MINIPROGRAM.md 第 4、12 节）：绑定会员（手机号对上才绑、不建会员；
// 同一个微信、同一位会员各只有一条有效绑定；操作编号重提返回原结果；模拟微信只在 development / test）；
// 会员卡、余额、流水、券（只读，只给顾客该看的字段）；会员码（yuzu 签发、前台本机校验、过期与篡改拒绝）；解绑（权限、原因、重提）。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import { buildMpApp } from '../src/server/modules/mp/app';
import { makeMemberCode } from '../src/server/modules/mp/member';
import { createStaff } from '../src/server/modules/staff';
import { MP_CODE, MP_GATEWAY_HEADER, MP_OPENID_HEADER } from '../src/shared/mp';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
const SECRET = 'test-code-secret-0123456789abcdef-0123456';
let ctx: TestContext;
let mp: FastifyInstance;
let staffApp: FastifyInstance;
let duty: string;

beforeAll(async () => {
  ctx = await setup();
  const mpConfig = { ...ctx.config.mp, gatewayKey: KEY, codeSecret: SECRET };
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: mpConfig });
  // 员工端口：前台用会员码查会员要用同一个会员码密钥（会话存在库里，ctx 的登录照样能用）
  staffApp = await buildApp(ctx.sql, { ...ctx.config, mp: mpConfig });
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })})`;
});
afterAll(async () => {
  await mp.close();
  await staffApp.close();
  await ctx.close();
});

let n = 0;
const newOpenid = () => `openid-member-${++n}-${randomUUID().slice(0, 8)}`;
const call = (app: FastifyInstance, method: 'GET' | 'POST', url: string, openid: string | null, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { [MP_GATEWAY_HEADER]: KEY, ...(openid ? { [MP_OPENID_HEADER]: openid } : {}) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
const bind = (openid: string, phone: string, extra: Record<string, unknown> = {}) =>
  call(mp, 'POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, ...extra });
const phoneOf = (i: number) => `1370000${String(1000 + i)}`;
const activeBindings = async (memberId: number) =>
  Number((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mp_bindings WHERE member_id = ${memberId} AND unbound_at IS NULL`)[0]!.n);

describe('绑定会员', () => {
  it('手机号不是会员：不绑、不建会员', async () => {
    const before = Number((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM members`)[0]!.n);
    const res = await bind(newOpenid(), '13900009999');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_MEMBER');
    expect(Number((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM members`)[0]!.n)).toBe(before);
    expect(Number((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mp_bindings`)[0]!.n)).toBe(0);
  });

  it('手机号对上就绑定；同一个编号重提返回原结果；编号换内容拒绝', async () => {
    const m = await createMember(ctx, '演示·绑定甲', phoneOf(1));
    const openid = newOpenid();
    const clientKey = randomUUID();
    const first = await call(mp, 'POST', '/api/mp/bind', openid, { clientKey, phone: phoneOf(1) });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'bound', replayed: false, member: { name: '演示·绑定甲', frozen: false } });
    const again = await call(mp, 'POST', '/api/mp/bind', openid, { clientKey, phone: phoneOf(1) });
    expect(again.json()).toMatchObject({ status: 'bound', replayed: true });
    const reused = await call(mp, 'POST', '/api/mp/bind', openid, { clientKey, phone: phoneOf(2) });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('CLIENT_KEY_REUSED');
    // 新编号、同一个微信、同一位会员：照旧返回已绑定，不多一条
    expect((await bind(openid, phoneOf(1))).json()).toMatchObject({ replayed: true });
    expect(await activeBindings(m.id)).toBe(1);
  });

  it('一个微信只绑一位会员、一位会员只绑一个微信', async () => {
    const a = await createMember(ctx, '演示·绑定乙', phoneOf(3));
    await createMember(ctx, '演示·绑定丙', phoneOf(4));
    const openid = newOpenid();
    expect((await bind(openid, phoneOf(3))).statusCode).toBe(200);
    const other = await bind(openid, phoneOf(4));
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('OPENID_BOUND');
    const second = await bind(newOpenid(), phoneOf(3));
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('MEMBER_BOUND');
    expect(await activeBindings(a.id)).toBe(1);
  });

  it('两个微信同时绑同一位会员：只成一个', async () => {
    const m = await createMember(ctx, '演示·并发', phoneOf(5));
    const results = await Promise.all([bind(newOpenid(), phoneOf(5)), bind(newOpenid(), phoneOf(5)), bind(newOpenid(), phoneOf(5))]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    for (const r of results.filter((r) => r.statusCode !== 200)) expect(r.json().error.code).toBe('MEMBER_BOUND');
    expect(await activeBindings(m.id)).toBe(1);
  });

  it('没带 openid 拒绝；小程序没开时拒绝', async () => {
    const res = await call(mp, 'POST', '/api/mp/bind', null, { clientKey: randomUUID(), phone: phoneOf(1) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MP_OPENID_REQUIRED');
    const bad = await call(mp, 'POST', '/api/mp/bind', 'bad openid!', { clientKey: randomUUID(), phone: phoneOf(1) });
    expect(bad.json().error.code).toBe('MP_OPENID_REQUIRED');
    await ctx.sql`UPDATE settings SET value = ${ctx.sql.json({ enabled: false })} WHERE key = 'mp_rules'`;
    expect((await bind(newOpenid(), phoneOf(1))).json().error.code).toBe('MP_DISABLED');
    await ctx.sql`UPDATE settings SET value = ${ctx.sql.json({ enabled: true })} WHERE key = 'mp_rules'`;
  });

  it('模拟微信只在 development / test 实例可用', async () => {
    const m = await createMember(ctx, '演示·模拟', phoneOf(6));
    const ok = await bind(newOpenid(), phoneOf(6), { mock: true });
    expect(ok.statusCode).toBe(200);
    expect((await ctx.sql<{ mock: boolean }[]>`SELECT mock FROM mp_bindings WHERE member_id = ${m.id}`)[0]!.mock).toBe(true);
    for (const env of ['production', 'trial'] as const) {
      const prod = await buildMpApp(ctx.sql, { ...ctx.config, env, mp: { ...ctx.config.mp, gatewayKey: KEY, codeSecret: SECRET } });
      const res = await call(prod, 'POST', '/api/mp/bind', newOpenid(), { clientKey: randomUUID(), phone: phoneOf(1), mock: true });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('MP_MOCK_REFUSED');
      await prod.close();
    }
  });
});

describe('会员卡、余额、流水、券（只读）', () => {
  let memberId: number;
  let openid: string;
  beforeAll(async () => {
    const m = await createMember(ctx, '演示·沈先生', phoneOf(10));
    memberId = m.id;
    openid = newOpenid();
    expect((await bind(openid, phoneOf(10))).statusCode).toBe(200);
    const recharge = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 500000));
    expect(recharge.status, JSON.stringify(recharge.body)).toBe(200);
    const t = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '演示·满200减30', kind: 'cash', faceValue: 3000, minSpend: 20000, validity: 'days', validDays: 30 });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const issued = await api(ctx.app, ctx.owner, 'POST', `/api/members/${m.id}/coupons`, { clientKey: randomUUID(), templateId: t.body.id, quantity: 1, reason: '老客人回馈' });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  });

  it('没绑定：bound 为 false', async () => {
    expect((await call(mp, 'GET', '/api/mp/me', newOpenid())).json()).toEqual({ bound: false, member: null });
  });

  it('会员卡：余额、档阶（会员体系 v2）、可用券数', async () => {
    const me = (await call(mp, 'GET', '/api/mp/me', openid)).json();
    expect(me.bound).toBe(true);
    expect(me.member).toMatchObject({ name: '演示·沈先生', frozen: false, principalBalance: 500000, bonusBalance: 0, availableCoupons: 1 });
    expect(me.member.grade).toMatchObject({ grade: 1, gradeName: '云涧', tier: 0, tierName: '初', label: 'L1 云涧 · 初' });
    expect(me.member.grade.next).toMatchObject({ grade: 2, name: '潭影' });
    expect(me.member.grade.ladder).toEqual(['青溪', '云涧', '潭影', '观澜', '望岳', '山海', '归墟']);
    expect(me.member.deductionRule).toBe('先本金，后赠金');
    // 不给员工用的字段
    expect(me.member).not.toHaveProperty('phone');
    expect(me.member.grade).not.toHaveProperty('events');
  });

  it('流水：只给顾客该看的字段', async () => {
    const rows = (await call(mp, 'GET', '/api/mp/ledger', openid)).json();
    expect(rows[0]).toMatchObject({ kind: 'recharge', kindLabel: '充值', principalDelta: 500000, principalAfter: 500000 });
    expect(rows[0]).not.toHaveProperty('operatorName');
    expect(rows[0]).not.toHaveProperty('memberPhone');
    expect(rows[0]).not.toHaveProperty('docNo');
  });

  it('券：可用的在前', async () => {
    const coupons = (await call(mp, 'GET', '/api/mp/coupons', openid)).json();
    expect(coupons).toHaveLength(1);
    expect(coupons[0]).toMatchObject({ name: '演示·满200减30', kind: 'cash', state: 'available' });
    expect(coupons[0].code).toMatch(/^[A-Z0-9-]+$/);
  });

  it('没绑定的看流水、券、会员码都拒绝', async () => {
    for (const [method, url] of [['GET', '/api/mp/ledger'], ['GET', '/api/mp/coupons'], ['POST', '/api/mp/code']] as const) {
      const res = await call(mp, method, url, newOpenid());
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('MP_NOT_BOUND');
    }
  });
});

describe('会员码', () => {
  let memberId: number;
  let openid: string;
  beforeAll(async () => {
    const m = await createMember(ctx, '演示·会员码', phoneOf(20));
    memberId = m.id;
    openid = newOpenid();
    expect((await bind(openid, phoneOf(20))).statusCode).toBe(200);
  });
  const resolve = (code: string, cookie: string | null = ctx.clerk) =>
    staffApp.inject({ method: 'GET', url: `/api/mp-codes/${code}`, headers: cookie ? { cookie } : {} });

  it('签发：16 位数字、不会与手机号混淆，一分钟后过期', async () => {
    const res = await call(mp, 'POST', '/api/mp/code', openid);
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.code).toMatch(MP_CODE);
    expect(c.code).toHaveLength(16);
    expect(c.code[0]).toBe('8');
    expect(Date.parse(c.expiresAt)).toBeGreaterThan(Date.now());
    expect(c.refreshSeconds).toBe(60);
  });

  it('前台扫码认出会员；上一分钟的码也认；更早的、改过的不认', async () => {
    const { code } = (await call(mp, 'POST', '/api/mp/code', openid)).json();
    const ok = await resolve(code);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ memberId, name: '演示·会员码' });
    expect((await resolve(makeMemberCode(SECRET, memberId, Date.now() - 60_000))).statusCode).toBe(200);
    expect((await resolve(makeMemberCode(SECRET, memberId, Date.now() - 3 * 60_000))).json().error.code).toBe('CODE_EXPIRED');
    const tampered = `${code.slice(0, -1)}${code.endsWith('0') ? '1' : '0'}`;
    expect((await resolve(tampered)).json().error.code).toBe('CODE_EXPIRED');
    expect((await resolve(makeMemberCode('another-secret-0123456789abcdef-0123', memberId))).json().error.code).toBe('CODE_EXPIRED');
    expect((await resolve('13700001020')).statusCode).toBe(400);
    expect((await resolve(code, null)).statusCode).toBe(401);
  });

  it('冻结的会员不出码、扫了也不认', async () => {
    const m = await createMember(ctx, '演示·冻结', phoneOf(21));
    const o = newOpenid();
    expect((await bind(o, phoneOf(21))).statusCode).toBe(200);
    const code = makeMemberCode(SECRET, m.id);
    await ctx.sql`UPDATE members SET status = 'frozen' WHERE id = ${m.id}`;
    expect((await call(mp, 'POST', '/api/mp/code', o)).json().error.code).toBe('MEMBER_FROZEN');
    expect((await resolve(code)).json().error.code).toBe('MEMBER_FROZEN');
    expect((await call(mp, 'GET', '/api/mp/me', o)).json().member.frozen).toBe(true);
  });

  it('没配会员码密钥：不出码', async () => {
    const noSecret = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY, codeSecret: null } });
    expect((await call(noSecret, 'POST', '/api/mp/code', openid)).json().error.code).toBe('MP_CODE_UNAVAILABLE');
    await noSecret.close();
  });
});

describe('解绑', () => {
  it('值班经理及以上能解绑：写原因、记经办人；同一个编号重提返回原结果；解绑后会员码失效、可以重新绑定', async () => {
    const m = await createMember(ctx, '演示·换绑', phoneOf(30));
    const openid = newOpenid();
    expect((await bind(openid, phoneOf(30))).statusCode).toBe(200);
    const code = makeMemberCode(SECRET, m.id);
    const list = await api(ctx.app, ctx.clerk, 'GET', `/api/admin/mp/members/${m.id}/bindings`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ openidTail: openid.slice(-6), phone: phoneOf(30), unboundAt: null });
    const id = list.body[0].id as number;

    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/admin/mp/bindings/${id}/unbind`, { clientKey: randomUUID(), reason: '换手机号' })).status).toBe(403);
    expect((await api(ctx.app, duty, 'POST', `/api/admin/mp/bindings/${id}/unbind`, { clientKey: randomUUID(), reason: '' })).status).toBe(400);
    const clientKey = randomUUID();
    const res = await api(ctx.app, duty, 'POST', `/api/admin/mp/bindings/${id}/unbind`, { clientKey, reason: '换手机号' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unboundByName: '值班经理', unbindReason: '换手机号' });
    expect(res.body.unboundAt).not.toBeNull();
    expect((await api(ctx.app, duty, 'POST', `/api/admin/mp/bindings/${id}/unbind`, { clientKey, reason: '换手机号' })).status).toBe(200);
    const twice = await api(ctx.app, duty, 'POST', `/api/admin/mp/bindings/${id}/unbind`, { clientKey: randomUUID(), reason: '再解一次' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ALREADY_UNBOUND');
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'mp_unbind' AND target_id = ${String(m.id)}`;
    expect(audit!.n).toBe(1);

    expect((await call(mp, 'GET', '/api/mp/me', openid)).json().bound).toBe(false);
    expect((await staffApp.inject({ method: 'GET', url: `/api/mp-codes/${code}`, headers: { cookie: ctx.clerk } })).json().error.code).toBe('CODE_EXPIRED');
    expect((await bind(newOpenid(), phoneOf(30))).statusCode).toBe(200);
  });
});
