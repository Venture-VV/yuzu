// 微信小程序第一期 ②（小程序线，docs/MINIPROGRAM.md 第 4、12 节）：绑定会员（手机号对上才绑、不建会员；
// 同一个微信、同一位会员各只有一条有效绑定；操作编号重提返回原结果；模拟微信只在 development / test）；
// 绑定状态版本号（解绑之后晚到的旧请求不生效）；会员卡、余额、流水、券（只读，只给顾客该看的字段）；会员码（yuzu 签发、前台本机校验、过期与篡改拒绝）；解绑（权限、原因、重提）。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app';
import { buildMpApp } from '../src/server/modules/mp/app';
import { getMe, makeMemberCode } from '../src/server/modules/mp/member';
import { createStaff } from '../src/server/modules/staff';
import type { Benefit, BenefitCatalog } from '../src/shared/benefits';
import { rechargeOutcome, type MemberGradeInfo, type MembershipRules } from '../src/shared/membership';
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
/** 这个微信现在的绑定状态版本号（小程序点绑定时带的就是 /v1/me 给的这个） */
const versionOf = async (openid: string) => (await call(mp, 'GET', '/api/mp/me', openid)).json().bindVersion as number;
const bind = async (openid: string, phone: string, extra: Record<string, unknown> = {}) =>
  call(mp, 'POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, bindVersion: await versionOf(openid), ...extra });
const phoneOf = (i: number) => `1370000${String(1000 + i)}`;
const activeBindings = async (memberId: number) =>
  Number((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mp_bindings WHERE member_id = ${memberId} AND unbound_at IS NULL`)[0]!.n);
/** 这位会员当前有效的绑定记录编号（会员码的签名里有它） */
const bindingOf = async (memberId: number) =>
  Number((await ctx.sql<{ id: number }[]>`SELECT id FROM mp_bindings WHERE member_id = ${memberId} AND unbound_at IS NULL`)[0]!.id);

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
    const first = await call(mp, 'POST', '/api/mp/bind', openid, { clientKey, phone: phoneOf(1), bindVersion: 0 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'bound', replayed: false, member: { name: '演示·绑定甲', frozen: false } });
    const again = await call(mp, 'POST', '/api/mp/bind', openid, { clientKey, phone: phoneOf(1), bindVersion: 0 });
    expect(again.json()).toMatchObject({ status: 'bound', replayed: true });
    const reused = await call(mp, 'POST', '/api/mp/bind', openid, { clientKey, phone: phoneOf(2), bindVersion: 0 });
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

  it('合并掉的会员卡：用它的手机号绑定拒绝（MP25），用合并到的那张卡的手机号照常绑；之前已经绑着的照旧认', async () => {
    const source = await createMember(ctx, '演示·合并来源', phoneOf(60));
    const target = await createMember(ctx, '演示·合并目标', phoneOf(61));
    const kept = await createMember(ctx, '演示·合并前已绑', phoneOf(62));
    const keptOpenid = newOpenid();
    expect((await bind(keptOpenid, phoneOf(62))).statusCode).toBe(200);
    // 主线的合并：来源会员停用、记合并到谁，手机号还留在来源会员上
    await ctx.sql`UPDATE members SET status = 'frozen', merged_into_id = ${target.id} WHERE id IN ${ctx.sql([source.id, kept.id])}`;
    const openid = newOpenid();
    const refused = await bind(openid, phoneOf(60));
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({
      code: 'MEMBER_MERGED',
      message: '这个手机号的会员卡已经合并到另一张会员卡：请用那张卡登记的手机号绑定，不清楚的请问前台',
    });
    expect(refused.body).not.toContain('演示·合并目标');
    expect(await activeBindings(source.id)).toBe(0);
    // 同一个微信改用目标会员的手机号：照常绑上
    const ok = await bind(openid, phoneOf(61));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'bound', member: { name: '演示·合并目标' } });
    // 合并之前就绑着来源会员的微信：照旧认（「我的」写已合并、请到前台换绑），不会被这条拦掉
    expect((await bind(keptOpenid, phoneOf(62))).json()).toMatchObject({ status: 'bound', replayed: true });
    expect((await call(mp, 'GET', '/api/mp/me', keptOpenid)).json()).toMatchObject({ bound: true, member: { merged: true } });
  });

  it('两个微信同时绑同一位会员：只成一个', async () => {
    const m = await createMember(ctx, '演示·并发', phoneOf(5));
    const results = await Promise.all([bind(newOpenid(), phoneOf(5)), bind(newOpenid(), phoneOf(5)), bind(newOpenid(), phoneOf(5))]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    for (const r of results.filter((r) => r.statusCode !== 200)) expect(r.json().error.code).toBe('MEMBER_BOUND');
    expect(await activeBindings(m.id)).toBe(1);
  });

  it('没带 openid 拒绝；小程序没开时拒绝', async () => {
    const res = await call(mp, 'POST', '/api/mp/bind', null, { clientKey: randomUUID(), phone: phoneOf(1), bindVersion: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MP_OPENID_REQUIRED');
    const bad = await call(mp, 'POST', '/api/mp/bind', 'bad openid!', { clientKey: randomUUID(), phone: phoneOf(1), bindVersion: 0 });
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
      const res = await call(prod, 'POST', '/api/mp/bind', newOpenid(), { clientKey: randomUUID(), phone: phoneOf(1), mock: true, bindVersion: 0 });
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
    expect((await call(mp, 'GET', '/api/mp/me', newOpenid())).json()).toEqual({ bound: false, bindVersion: 0, member: null });
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

describe('流水先作废到期的赠金（Codex 审查 PR #42）', () => {
  // 赠金有效 1 天：应用的时钟拨到 3 天后，批次就到期了；后台的全店扫描还没跑，要靠打开时作废
  let planId: number;
  beforeAll(async () => {
    const created = await api(ctx.app, ctx.owner, 'POST', '/api/plans', { name: '演示·一天赠金', payAmount: 50000, bonusAmount: 5000, bonusValidDays: 1 });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    planId = created.body.plans.find((p: { name: string }) => p.name === '演示·一天赠金').id;
  });
  const memberWithBonus = async (i: number) => {
    const m = await createMember(ctx, `演示·赠金${i}`, phoneOf(i));
    const openid = newOpenid();
    expect((await bind(openid, phoneOf(i))).statusCode).toBe(200);
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, 50000, 5000, { planId, bonusMode: 'custom', bonusValidDays: 1, paymentMethod: 'cash' }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { memberId: m.id, openid };
  };
  const later = async <T>(fn: () => Promise<T>) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3 * 86_400_000);
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  };

  it('只看流水（没先打开会员卡）：流水里就有这笔过期，结尾的余额是作废之后的', async () => {
    const { memberId, openid } = await memberWithBonus(70);
    const rows = await later(async () => (await call(mp, 'GET', '/api/mp/ledger', openid)).json());
    expect(rows[0]).toMatchObject({ kind: 'expire', principalDelta: 0, bonusDelta: -5000, principalAfter: 50000, bonusAfter: 0 });
    expect(rows[1]).toMatchObject({ kind: 'recharge', principalAfter: 50000, bonusAfter: 5000 });
    const [m] = await ctx.sql<{ bonusBalance: number }[]>`SELECT bonus_balance FROM members WHERE id = ${memberId}`;
    expect(m!.bonusBalance).toBe(0);
  });

  it('会员卡与流水同时取：两边都作废也只过期一次，流水结尾的余额与会员卡一致', async () => {
    const { memberId, openid } = await memberWithBonus(71);
    const [me, rows] = await later(async () => {
      const [a, b] = await Promise.all([call(mp, 'GET', '/api/mp/me', openid), call(mp, 'GET', '/api/mp/ledger', openid)]);
      return [a.json(), b.json()];
    });
    expect(me.member).toMatchObject({ principalBalance: 50000, bonusBalance: 0 });
    expect(rows[0]).toMatchObject({ kind: 'expire', bonusDelta: -5000, principalAfter: me.member.principalBalance, bonusAfter: me.member.bonusBalance });
    expect(rows.filter((r: { kind: string }) => r.kind === 'expire')).toHaveLength(1);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bonus_expiries WHERE member_id = ${memberId}`;
    expect(n!.n).toBe(1);
  });
});

describe('本月可享（第一期 ⑥，接主线 v0.7.24 的会员权益）', () => {
  // 会员专属通道（QY-001）：L2·初 起每月 2 次；一次性浴衣拖鞋（QY-010）改成 L4·初 起，这位 L2 会员看到的是「升档以后」
  let openid: string;
  let memberId: number;
  const benefit = async (code: string) => ((await api(ctx.app, ctx.owner, 'GET', '/api/benefits')).body as BenefitCatalog).items.find((b) => b.code === code)!;
  const publish = async (code: string, patch: Partial<Benefit>) => {
    const b = await benefit(code);
    const { id, version, name, category, startGrade, startTier, period, quantity, tierQuantities, templateId, events, festivalDates, content, conditions } = b;
    const e = await api(ctx.app, ctx.owner, 'PUT', `/api/benefits/${id}`, {
      expectedVersion: version,
      ...{ name, category, startGrade, startTier, period, quantity, tierQuantities, templateId, events, festivalDates, content, conditions },
      ...patch,
    });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    const fresh = await benefit(code);
    const p = await api(ctx.app, ctx.owner, 'POST', `/api/benefits/${fresh.id}/status`, { expectedVersion: fresh.version, status: 'published' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    return fresh;
  };
  beforeAll(async () => {
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/benefits/import')).status).toBe(200);
    const m = await createMember(ctx, '演示·本月可享', phoneOf(80));
    memberId = m.id;
    openid = newOpenid();
    expect((await bind(openid, phoneOf(80))).statusCode).toBe(200);
    // 充 1 万升到 L2（赠金按规则算）
    const rules = (await api(ctx.app, ctx.clerk, 'GET', '/api/membership/rules')).body as MembershipRules;
    const info = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${m.id}/grade`)).body as MemberGradeInfo;
    const paid = 1_000_000;
    const bonus = rechargeOutcome(rules, info.state.grade, info.rollingRechargeCents, paid).bonusCents;
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, paid, bonus, { bonusMode: 'auto' }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('列出够格的服务与次数，升档以后能享的只给名字与起点；不带经办人、单号、备注', async () => {
    const channel = await publish('QY-001', { period: 'month', quantity: 2 });
    await publish('QY-010', { startGrade: 4, startTier: 0 });
    const used = await api(ctx.app, ctx.clerk, 'POST', `/api/members/${memberId}/benefit-uses`, { clientKey: randomUUID(), benefitId: channel.id, quantity: 1, note: '前台的备注' });
    expect(used.status, JSON.stringify(used.body)).toBe(201);

    const res = await call(mp, 'GET', '/api/mp/benefits', openid);
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.month).toMatch(/^\d{4}-\d{2}$/);
    expect(b.label).toMatch(/^L2 /);
    const item = b.items.find((i: { code: string }) => i.code === 'QY-001');
    expect(item).toEqual({
      code: 'QY-001',
      name: '会员专属通道',
      category: 'service',
      period: 'month',
      allowance: '每月 2 次',
      content: channel.content,
      conditions: channel.conditions,
      used: 1,
      limit: 2,
      available: 0,
    });
    expect(b.items.some((i: { code: string }) => i.code === 'QY-010')).toBe(false);
    expect(b.upcoming).toContainEqual({ name: '一次性浴衣拖鞋', startLabel: expect.stringMatching(/^L4/) });
    // 员工看的「本月可享」里有登记记录（经办人、备注），小程序里没有
    expect(JSON.stringify(b)).not.toContain('前台的备注');
    expect(b).not.toHaveProperty('uses');
    expect(b).not.toHaveProperty('grants');
    expect(b).not.toHaveProperty('memberId');
  });

  it('没绑定的拒绝', async () => {
    const res = await call(mp, 'GET', '/api/mp/benefits', newOpenid());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MP_NOT_BOUND');
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
    const bindingId = await bindingOf(memberId);
    expect((await resolve(makeMemberCode(SECRET, memberId, bindingId, Date.now() - 60_000))).statusCode).toBe(200);
    expect((await resolve(makeMemberCode(SECRET, memberId, bindingId, Date.now() - 3 * 60_000))).json().error.code).toBe('CODE_EXPIRED');
    const tampered = `${code.slice(0, -1)}${code.endsWith('0') ? '1' : '0'}`;
    expect((await resolve(tampered)).json().error.code).toBe('CODE_EXPIRED');
    expect((await resolve(makeMemberCode('another-secret-0123456789abcdef-0123', memberId, bindingId))).json().error.code).toBe('CODE_EXPIRED');
    // 签名里有绑定记录的编号：别的绑定编号算出来的码不认
    expect((await resolve(makeMemberCode(SECRET, memberId, bindingId + 1000))).json().error.code).toBe('CODE_EXPIRED');
    expect((await resolve('13700001020')).statusCode).toBe(400);
    expect((await resolve(code, null)).statusCode).toBe(401);
  });

  it('冻结的会员不出码、扫了也不认', async () => {
    const m = await createMember(ctx, '演示·冻结', phoneOf(21));
    const o = newOpenid();
    expect((await bind(o, phoneOf(21))).statusCode).toBe(200);
    const code = makeMemberCode(SECRET, m.id, await bindingOf(m.id));
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
    const code = makeMemberCode(SECRET, m.id, await bindingOf(m.id));
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
    // 换绑到别的微信后，旧微信在这一分钟里拿到的码照样认不出（Codex 审查 PR #42）
    expect((await staffApp.inject({ method: 'GET', url: `/api/mp-codes/${code}`, headers: { cookie: ctx.clerk } })).json().error.code).toBe('CODE_EXPIRED');
    const fresh = makeMemberCode(SECRET, m.id, await bindingOf(m.id));
    expect((await staffApp.inject({ method: 'GET', url: `/api/mp-codes/${fresh}`, headers: { cookie: ctx.clerk } })).statusCode).toBe(200);
  });
});

describe('绑定状态版本号：解绑之后，晚到的旧请求不再绑上（小程序线测试预检 #44 的 P1）', () => {
  it('另一边先绑定、员工解绑之后，之前没确认的请求晚到被拒（BIND_STALE），不出现新的绑定', async () => {
    const a = await createMember(ctx, '演示·晚到甲', phoneOf(90));
    const b = await createMember(ctx, '演示·晚到乙', phoneOf(91));
    const openid = newOpenid();
    // ① 这个微信点绑定（会员甲）时看到的版本号是 0；这次请求在路上耽搁了，手机上的记录后来也读不出来、被删了
    const v0 = await versionOf(openid);
    expect(v0).toBe(0);
    const late = { clientKey: randomUUID(), phone: phoneOf(90), bindVersion: v0 };
    // ② 同一个微信在另一处先绑上了会员乙
    expect((await bind(openid, phoneOf(91))).statusCode).toBe(200);
    expect(await versionOf(openid)).toBe(1);
    // 还绑着乙的时候晚到：照旧被拒
    expect((await call(mp, 'POST', '/api/mp/bind', openid, late)).json().error.code).toBe('BIND_STALE');
    // ③ 员工在后台解绑乙
    const id = await bindingOf(b.id);
    expect((await api(ctx.app, duty, 'POST', `/api/admin/mp/bindings/${id}/unbind`, { clientKey: randomUUID(), reason: '顾客要求解绑' })).status).toBe(200);
    expect(await versionOf(openid)).toBe(2);
    // ④ 第一步那次请求这时才到：版本号对不上，不绑定
    const res = await call(mp, 'POST', '/api/mp/bind', openid, late);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BIND_STALE');
    expect(await activeBindings(a.id)).toBe(0);
    expect((await call(mp, 'GET', '/api/mp/me', openid)).json()).toEqual({ bound: false, bindVersion: 2, member: null });
    // 顾客按现在的样子重新点绑定（新的编号、现在的版本号）：照常绑上
    expect((await bind(openid, phoneOf(90))).statusCode).toBe(200);
    expect(await activeBindings(a.id)).toBe(1);
    expect(await versionOf(openid)).toBe(3);
  });

  it('同一个编号重提照旧返回原来那次（先认编号，再比版本号）；不带版本号拒绝', async () => {
    await createMember(ctx, '演示·版本号', phoneOf(92));
    const openid = newOpenid();
    const body = { clientKey: randomUUID(), phone: phoneOf(92), bindVersion: 0 };
    expect((await call(mp, 'POST', '/api/mp/bind', openid, body)).json()).toMatchObject({ status: 'bound', replayed: false });
    // 绑上之后版本号是 1，原样重提（带的还是 0）返回原来那次的结果
    expect((await call(mp, 'POST', '/api/mp/bind', openid, body)).json()).toMatchObject({ status: 'bound', replayed: true });
    const missing = await call(mp, 'POST', '/api/mp/bind', newOpenid(), { clientKey: randomUUID(), phone: phoneOf(92) });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toBe('请刷新小程序后再绑定');
  });
});

describe('绑定与解绑交错（小程序线测试预检 3ab3ab5 的 P1）', () => {
  const waitFor = async (check: () => Promise<boolean>, what: string) => {
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`等不到：${what}`);
  };
  /** 这个测试库里正在等锁的语句：等会员行（绑定停在锁会员一行）、等咨询锁（解绑排在绑定后面） */
  const lockWaits = async (on: 'member' | 'advisory') =>
    Number(
      (
        await ctx.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND ${on === 'advisory' ? ctx.sql`wait_event = 'advisory'` : ctx.sql`query LIKE '%FROM members WHERE phone%FOR SHARE%'`}`
      )[0]!.n,
    );

  it('绑定比完版本号、还没写入时员工解绑：解绑排在绑定后面，绑定按「还绑着」被拒，不出现新的绑定', async () => {
    const a = await createMember(ctx, '演示·交错甲', phoneOf(93));
    const b = await createMember(ctx, '演示·交错乙', phoneOf(94));
    const openid = newOpenid();
    expect((await bind(openid, phoneOf(94))).statusCode).toBe(200);
    const v1 = await versionOf(openid);
    // 另一个事务锁住甲的会员行：绑定甲会停在「锁会员一行（共享锁）」，这时它已经比完了版本号（版本号对得上）
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedNow = new Promise<void>((r) => (locked = r));
    const holder = ctx.sql.begin(async (tx) => {
      await tx`SELECT id FROM members WHERE id = ${a.id} FOR UPDATE`;
      locked();
      await held;
    });
    await lockedNow;
    let bindA: Promise<Awaited<ReturnType<typeof call>>>;
    let unbindB: ReturnType<typeof api>;
    try {
      bindA = Promise.resolve(call(mp, 'POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone: phoneOf(93), bindVersion: v1 }));
      await waitFor(async () => (await lockWaits('member')) > 0, '绑定停在会员行上');
      // 员工这时解绑乙：要等同一把咨询锁（原来不取这把锁，会先提交，绑定接着写入就绑上了甲）
      unbindB = api(ctx.app, duty, 'POST', `/api/admin/mp/bindings/${await bindingOf(b.id)}/unbind`, { clientKey: randomUUID(), reason: '顾客要求解绑' });
      await waitFor(async () => (await lockWaits('advisory')) > 0, '解绑排在绑定后面');
    } finally {
      // 不论成败都放开甲的会员行，不让测试库留着锁
      release();
      await holder;
    }
    const [rb, ru] = await Promise.all([bindA, unbindB]);
    expect(rb.statusCode).toBe(409);
    expect(rb.json().error.code).toBe('OPENID_BOUND');
    expect(ru.status).toBe(200);
    expect(await activeBindings(a.id)).toBe(0);
    expect((await call(mp, 'GET', '/api/mp/me', openid)).json()).toEqual({ bound: false, bindVersion: 2, member: null });
  });

  it('/me 的绑定状态与版本号来自同一个快照：读的中途别处绑上，也不会拼成「没绑定、版本号 1」', async () => {
    await createMember(ctx, '演示·快照', phoneOf(95));
    const openid = newOpenid();
    let fired = false;
    // 包一层 sql：读这个微信绑定记录的第一条语句一返回，就在别处绑上（已提交）；之后再有语句读绑定记录就会读到新的状态
    const sql = new Proxy(ctx.sql, {
      apply(target, self, args: unknown[]) {
        const q = Reflect.apply(target as unknown as (...a: unknown[]) => unknown, self, args);
        const text = Array.isArray(args[0]) && 'raw' in (args[0] as object) ? (args[0] as string[]).join('?') : '';
        if (!fired && text.includes('mp_bindings')) {
          fired = true;
          return Promise.resolve(q).then(async (rows) => {
            expect((await bind(openid, phoneOf(95))).statusCode).toBe(200);
            return rows;
          });
        }
        return q;
      },
    });
    const me = await getMe({ sql, config: ctx.config }, openid);
    expect(fired).toBe(true);
    // 读的时候还没绑定：版本号也是绑定之前的 0（原来分两条读，拿到的是「没绑定、版本号 1」，按 1 去绑就能绕过版本号）
    expect(me).toEqual({ bound: false, bindVersion: 0, member: null });
    expect((await call(mp, 'GET', '/api/mp/me', openid)).json()).toMatchObject({ bound: true, bindVersion: 1 });
  });
});

describe('绑定结果不确定：确认作废（迁移 044）', () => {
  const abandon = (openid: string, clientKey: string) => call(mp, 'POST', '/api/mp/bind/abandon', openid, { clientKey });

  it('还没绑上就登记作废：原请求晚到也不绑定；同一个编号再作废照样是作废', async () => {
    const m = await createMember(ctx, '演示·作废绑定', phoneOf(40));
    const openid = newOpenid();
    const clientKey = randomUUID();
    const a = await abandon(openid, clientKey);
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json()).toEqual({ status: 'abandoned' });
    const late = await call(mp, 'POST', '/api/mp/bind', openid, { clientKey, phone: phoneOf(40), bindVersion: 0 });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('OP_ABANDONED');
    expect(await activeBindings(m.id)).toBe(0);
    expect((await call(mp, 'GET', '/api/mp/me', openid)).json().bound).toBe(false);
    expect((await abandon(openid, clientKey)).json()).toEqual({ status: 'abandoned' });
    // 换一个新的编号照常能绑
    expect((await bind(openid, phoneOf(40))).statusCode).toBe(200);
  });

  it('已经绑上了：作废只返回绑定的结果，不作废；别的微信不能作废这个编号', async () => {
    await createMember(ctx, '演示·已绑上', phoneOf(41));
    const openid = newOpenid();
    const clientKey = randomUUID();
    expect((await call(mp, 'POST', '/api/mp/bind', openid, { clientKey, phone: phoneOf(41), bindVersion: 0 })).statusCode).toBe(200);
    const a = await abandon(openid, clientKey);
    expect(a.json()).toMatchObject({ status: 'bound', member: { name: '演示·已绑上' }, replayed: true });
    const [fence] = await ctx.sql`SELECT 1 FROM mp_op_fences WHERE key = ${clientKey}`;
    expect(fence).toBeUndefined();
    expect((await abandon(newOpenid(), clientKey)).json().error.code).toBe('CLIENT_KEY_REUSED');
  });

  it('绑定与作废同时到：只有一个结果（绑上了作废就返回绑上；作废了绑定就被拒）', async () => {
    for (let i = 0; i < 6; i++) {
      const m = await createMember(ctx, `演示·同时${i}`, phoneOf(50 + i));
      const openid = newOpenid();
      const clientKey = randomUUID();
      const [b, a] = await Promise.all([call(mp, 'POST', '/api/mp/bind', openid, { clientKey, phone: phoneOf(50 + i), bindVersion: 0 }), abandon(openid, clientKey)]);
      if (b.statusCode === 200) expect(a.json().status).toBe('bound');
      else {
        expect(b.json().error.code).toBe('OP_ABANDONED');
        expect(a.json().status).toBe('abandoned');
      }
      expect(await activeBindings(m.id)).toBe(b.statusCode === 200 ? 1 : 0);
    }
  });

  it('作废登记只追加：不能改、不能删', async () => {
    const openid = newOpenid();
    const clientKey = randomUUID();
    await abandon(openid, clientKey);
    await expect(ctx.sql`DELETE FROM mp_op_fences WHERE key = ${clientKey}`).rejects.toThrow();
    await expect(ctx.sql`UPDATE mp_op_fences SET openid = 'someone-else' WHERE key = ${clientKey}`).rejects.toThrow();
  });
});
