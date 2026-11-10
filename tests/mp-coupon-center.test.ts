// 小程序第二期 2c：线上领券（小程序线，docs/MP_COUPONS.md；MP22、MP27）：
//   · 设置（店主、店总；版本号；新放进来的券模板要启用的；同一张只能放一次；之前放进来后来停用的原样保存不拦）；
//   · 领券中心的列表：关着不列；停领的、停用或过期的券模板不列；档级不够、领满了写原因；「我的」有入口；
//   · 领取：主线发券入口发 1 张（种类小程序领取）、领取记录只追加；每人限领 N 张（同时点两次也只出一张）、不限领；
//     同一个编号重提返回同一张；确认作废之后晚到的原请求不发券；
//   · 限领按会员：换绑一个微信也不能多领，合并进来的会员卡领过的也算；换绑到别的会员后旧编号不认；
//   · 停领、领券中心关掉、券模板停用、会员停用或已合并都领不了，写给顾客看的原因；自检照常全过。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CouponTemplate, MemberCoupons } from '../src/shared/coupons';
import { MP_GATEWAY_HEADER, MP_OPENID_HEADER, type MpCoupon, type MpCouponAdminData, type MpCouponCenter, type MpCouponOffer } from '../src/shared/mp';
import { buildMpApp } from '../src/server/modules/mp/app';
import { createStaff } from '../src/server/modules/staff';
import { consistencyChecks } from '../src/server/ops/consistency';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
let ctx: TestContext;
let mp: FastifyInstance;
let boss: string;
let duty: string;
const t: Record<string, CouponTemplate> = {};

const template = async (body: Record<string, unknown>) => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), validity: 'days', validDays: 30, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as CouponTemplate;
};

beforeAll(async () => {
  ctx = await setup();
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } }, { pay: null, sweepMs: 0 });
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })})`;
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  boss = await login(ctx.app, 'boss');
  duty = await login(ctx.app, 'duty');
  t.once = await template({ name: '新客领三十', kind: 'cash', faceValue: 3000, threshold: 5000, validDays: 15 });
  t.twice = await template({ name: '搓澡券', kind: 'cash', faceValue: 2000 });
  t.free = await template({ name: '饮品九折', kind: 'discount', ratePercent: 90 });
  t.vip = await template({ name: '尊享代金券', kind: 'cash', faceValue: 5000, levels: [3, 4, 5, 6] });
  t.later = await template({ name: '要停用的券', kind: 'cash', faceValue: 1000 });
  t.expired = await template({ name: '过期的券', kind: 'cash', faceValue: 500, validity: 'fixed', validFrom: '2026-01-01', validTo: '2026-01-31' });
  t.off = await template({ name: '一直停用的券', kind: 'cash', faceValue: 500, active: false });
});
afterAll(async () => {
  await mp.close();
  await ctx.close();
});

const call = (method: 'GET' | 'POST', url: string, openid: string, payload?: unknown) =>
  Promise.resolve(
    mp.inject({ method, url, headers: { [MP_GATEWAY_HEADER]: KEY, [MP_OPENID_HEADER]: openid }, ...(payload === undefined ? {} : { payload: payload as object }) }),
  );
let n = 0;
async function bindPhone(openid: string, phone: string) {
  const version = (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
  const b = await call('POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, bindVersion: version, mock: true });
  expect(b.statusCode, b.body).toBe(200);
}
async function bound(name: string): Promise<{ memberId: number; openid: string; phone: string }> {
  n += 1;
  const phone = `1377700${String(1000 + n)}`;
  const m = await createMember(ctx, name, phone);
  const openid = `openid-coupon-${n}-${randomUUID().slice(0, 8)}`;
  await bindPhone(openid, phone);
  return { memberId: m.id, openid, phone };
}
const unbind = async (openid: string) => {
  const [b] = await ctx.sql<{ id: number }[]>`SELECT id FROM mp_bindings WHERE openid = ${openid} AND unbound_at IS NULL`;
  const r = await api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/bindings/${b!.id}/unbind`, { clientKey: randomUUID(), reason: '换微信' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const adminData = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/mp/coupons')).body as MpCouponAdminData;
const offer = (templateId: number, patch: Partial<MpCouponOffer> = {}): MpCouponOffer => ({ templateId, limit: 'per_member', perMember: 1, active: true, ...patch });
async function saveRules(offers: MpCouponOffer[], enabled = true) {
  const { version } = (await adminData()).rules;
  const r = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/coupons/rules', { enabled, offers, version });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
const center = async (openid: string) => {
  const r = await call('GET', '/api/mp/coupon-center', openid);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as MpCouponCenter;
};
/** 这个微信现在的绑定状态版本号（领券中心列表里带回来的那个数） */
const versionOf = async (openid: string) => (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
/** 领一张：默认带这个微信现在的绑定版本号 */
const claim = async (openid: string, templateId: number, clientKey = randomUUID(), bindVersion?: number) =>
  call('POST', '/api/mp/coupon-claims', openid, { clientKey, templateId, bindVersion: bindVersion ?? (await versionOf(openid)) });
const couponsOf = async (memberId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/coupons`)).body as MemberCoupons;
const claimsOf = (memberId: number) =>
  ctx.sql<{ templateId: number; seq: number; issueKind: string }[]>`
    SELECT c.template_id, c.seq, i.kind AS issue_kind FROM mp_coupon_claims c JOIN coupon_issues i ON i.id = c.issue_id WHERE c.member_id = ${memberId} ORDER BY c.id`;
const STANDARD = () => [offer(t.once!.id), offer(t.twice!.id, { perMember: 2 }), offer(t.free!.id, { limit: 'unlimited' }), offer(t.vip!.id), offer(t.later!.id)];

describe('领券中心的设置', () => {
  it('默认关着：列表写没开放、领取拒绝、「我的」没有入口；没有权限的岗位看不了、改不了', async () => {
    const a = await bound('演示·领券关着');
    expect(await center(a.openid)).toEqual({ open: false, notice: '领券中心还没开放', items: [], bindVersion: await versionOf(a.openid) });
    const r = await claim(a.openid, t.once!.id);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('MP_COUPON_DISABLED');
    expect((await call('GET', '/api/mp/me', a.openid)).json().member.couponCenterOpen).toBe(false);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/mp/coupons')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/mp/coupons/rules', { enabled: true, offers: [] })).status).toBe(403);
  });

  it('店主保存：带版本号；新放进来的券模板要启用的；同一张只能放一次；之前放进来、后来停用的原样保存不拦', async () => {
    const before = (await adminData()).rules;
    expect(before).toMatchObject({ enabled: false, offers: [], version: 0 });
    const stale = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/coupons/rules', { enabled: true, offers: [], version: before.version + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const off = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/coupons/rules', { enabled: true, offers: [offer(t.off!.id)], version: before.version });
    expect(off.status).toBe(422);
    expect(off.body.error.code).toBe('TEMPLATE_UNAVAILABLE');
    const twice = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/coupons/rules', { enabled: true, offers: [offer(t.once!.id), offer(t.once!.id)], version: before.version });
    expect(twice.status).toBe(400);
    const tooMany = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/coupons/rules', { enabled: true, offers: [offer(t.once!.id, { perMember: 100 })], version: before.version });
    expect(tooMany.status).toBe(400);
    const saved = await saveRules(STANDARD());
    expect(saved).toMatchObject({ enabled: true, version: before.version + 1 });
    // 放进来之后停用了：原样再保存一次不拦（列表里不显示、领不了）
    await ctx.sql`UPDATE coupon_templates SET active = false WHERE id = ${t.later!.id}`;
    expect((await saveRules(STANDARD())).version).toBe(before.version + 2);
    const data = await adminData();
    expect(data.templates.find((x) => x.id === t.later!.id)?.name).toBe('要停用的券（已停用）');
    expect(data.templates.some((x) => x.id === t.off!.id)).toBe(false);
    // 店总能看能改、值班经理不能（MP27）
    expect((await api(ctx.app, boss, 'GET', '/api/admin/mp/coupons')).status).toBe(200);
    expect((await api(ctx.app, duty, 'GET', '/api/admin/mp/coupons')).status).toBe(403);
  });
});

describe('领券中心的列表与领取', () => {
  it('列表：停领、停用、过期的不列；档级不够写原因；限领与不限领写明；「我的」有入口', async () => {
    const a = await bound('演示·看领券中心');
    const c = await center(a.openid);
    expect(c.open).toBe(true);
    expect(c.notice).toBeNull();
    expect(c.items.map((i) => [i.name, i.limitText, i.canClaim, i.reason])).toEqual([
      ['新客领三十', '每人限领 1 张', true, null],
      ['搓澡券', '每人限领 2 张', true, null],
      ['饮品九折', '不限领', true, null],
      ['尊享代金券', '每人限领 1 张', false, '只给 L3–L6 的会员领'],
    ]);
    expect(c.items[0]).toMatchObject({ validity: '领取后 15 天内有效', claimed: 0 });
    expect(c.items[0]!.summary).toContain('30');
    expect((await call('GET', '/api/mp/me', a.openid)).json().member.couponCenterOpen).toBe(true);
  });

  it('领取：发 1 张到会员名下（种类小程序领取）；每人限领 1 张的第二次拒绝；限领 2 张的第三次拒绝；不限领的一直能领', async () => {
    const a = await bound('演示·领券');
    const r = await claim(a.openid, t.once!.id);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ templateId: t.once!.id, replayed: false, coupon: { name: '新客领三十' } });
    const mine = await couponsOf(a.memberId);
    expect(mine.coupons.map((x) => [x.templateName, x.issueKind, x.code])).toEqual([['新客领三十', 'mp_claim', r.json().coupon.code]]);
    const again = await claim(a.openid, t.once!.id);
    expect(again.statusCode).toBe(422);
    expect(again.json().error).toMatchObject({ code: 'CLAIM_LIMIT', message: '每人限领 1 张，已经领满了' });
    expect((await claim(a.openid, t.twice!.id)).statusCode).toBe(201);
    expect((await claim(a.openid, t.twice!.id)).statusCode).toBe(201);
    expect((await claim(a.openid, t.twice!.id)).json().error.code).toBe('CLAIM_LIMIT');
    for (let i = 0; i < 3; i++) expect((await claim(a.openid, t.free!.id)).statusCode).toBe(201);
    expect((await claimsOf(a.memberId)).map((c) => [c.templateId, c.seq, c.issueKind])).toEqual([
      [t.once!.id, 1, 'mp_claim'],
      [t.twice!.id, 1, 'mp_claim'],
      [t.twice!.id, 2, 'mp_claim'],
      [t.free!.id, 1, 'mp_claim'],
      [t.free!.id, 2, 'mp_claim'],
      [t.free!.id, 3, 'mp_claim'],
    ]);
    const c = await center(a.openid);
    expect(c.items.find((i) => i.templateId === t.once!.id)).toMatchObject({ claimed: 1, canClaim: false, reason: '每人限领 1 张，已经领满了' });
    expect(c.items.find((i) => i.templateId === t.free!.id)).toMatchObject({ claimed: 3, canClaim: true });
    // 后台：每张一共领了多少、最近的领取记录
    const data = await adminData();
    expect(data.stats.find((s) => s.templateId === t.free!.id)).toMatchObject({ total: 3, last7Days: 3 });
    expect(data.recent[0]).toMatchObject({ memberId: a.memberId, templateName: '饮品九折', seq: 3 });
  });

  it('同一位会员同时点两次（不同编号）：限领 1 张只出一张', async () => {
    const a = await bound('演示·同时点两次');
    const rs = await Promise.all([claim(a.openid, t.once!.id), claim(a.openid, t.once!.id), claim(a.openid, t.once!.id)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 422, 422]);
    expect(await claimsOf(a.memberId)).toHaveLength(1);
    expect((await couponsOf(a.memberId)).coupons).toHaveLength(1);
  });

  it('同一个编号重提：返回第一次领到的那张、不另发；同时重提也只发一张；换了券的同一个编号不认', async () => {
    const a = await bound('演示·重提');
    const key = randomUUID();
    const [r1, r2] = await Promise.all([claim(a.openid, t.free!.id, key), claim(a.openid, t.free!.id, key)]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 201]);
    expect(r1.json().coupon.code).toBe(r2.json().coupon.code);
    const r3 = await claim(a.openid, t.free!.id, key);
    expect(r3.statusCode).toBe(200);
    expect(r3.json()).toMatchObject({ replayed: true, coupon: { code: r1.json().coupon.code } });
    expect((await claim(a.openid, t.twice!.id, key)).json().error.code).toBe('CLIENT_KEY_REUSED');
    expect(await claimsOf(a.memberId)).toHaveLength(1);
  });
});

describe('领取结果待确认', () => {
  it('确认作废：已经领到了返回那张；还没有就作废，之后原请求不发券；别的微信用同一个编号不认', async () => {
    const a = await bound('演示·领券作废');
    const done = randomUUID();
    const r = (await claim(a.openid, t.free!.id, done)).json();
    expect((await call('POST', '/api/mp/coupon-claims/abandon', a.openid, { clientKey: done })).json()).toMatchObject({
      status: 'claimed',
      claimed: { replayed: true, coupon: { code: r.coupon.code } },
    });
    const lost = randomUUID();
    expect((await call('POST', '/api/mp/coupon-claims/abandon', a.openid, { clientKey: lost })).json()).toEqual({ status: 'abandoned' });
    const late = await claim(a.openid, t.free!.id, lost);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('OP_ABANDONED');
    const other = await bound('演示·领券作废别人');
    expect((await call('POST', '/api/mp/coupon-claims/abandon', other.openid, { clientKey: lost })).json().error.code).toBe('CLIENT_KEY_REUSED');
    expect((await call('POST', '/api/mp/coupon-claims/abandon', other.openid, { clientKey: done })).json().error.code).toBe('CLIENT_KEY_REUSED');
    expect(await claimsOf(a.memberId)).toHaveLength(1);
  });
});

describe('限领按会员', () => {
  it('换绑一个新微信也不能多领；换绑到别的会员后，旧编号重提不认、确认作废回已作废', async () => {
    const a = await bound('演示·换微信');
    const key = randomUUID();
    expect((await claim(a.openid, t.once!.id, key)).statusCode).toBe(201);
    await unbind(a.openid);
    const second = `openid-coupon-new-${randomUUID().slice(0, 8)}`;
    await bindPhone(second, a.phone);
    const again = await claim(second, t.once!.id);
    expect(again.json().error.code).toBe('CLAIM_LIMIT');
    expect((await center(second)).items.find((i) => i.templateId === t.once!.id)).toMatchObject({ claimed: 1, canClaim: false });
    // 同一位会员换了微信：旧编号在新微信上不认（编号只认原来那个微信）
    expect((await claim(second, t.once!.id, key)).json().error.code).toBe('CLIENT_KEY_REUSED');
    // 原来那个微信换绑到别的会员：旧编号重提不认（带当初的版本号：绑定变过；带现在的：编号是之前那位会员用过的），
    // 确认作废回已作废（券在原来那位会员名下）
    const v0 = await versionOf(a.openid);
    n += 1;
    const phoneB = `1377700${String(1000 + n)}`;
    await createMember(ctx, '演示·换绑到的会员', phoneB);
    await bindPhone(a.openid, phoneB);
    expect((await claim(a.openid, t.once!.id, key, v0)).json().error.code).toBe('BIND_STALE');
    expect((await claim(a.openid, t.once!.id, key)).json().error.code).toBe('CLIENT_KEY_REUSED');
    expect((await call('POST', '/api/mp/coupon-claims/abandon', a.openid, { clientKey: key })).json()).toEqual({ status: 'abandoned' });
    expect(await claimsOf(a.memberId)).toHaveLength(1);
  });

  it('合并进来的会员卡领过的也算；合并掉的会员卡领不了；停用的会员领不了', async () => {
    const source = await bound('演示·合并来源卡');
    expect((await claim(source.openid, t.once!.id)).statusCode).toBe(201);
    const target = await bound('演示·合并目标卡');
    await ctx.sql`UPDATE members SET status = 'frozen', merged_into_id = ${target.memberId} WHERE id = ${source.memberId}`;
    expect((await center(target.openid)).items.find((i) => i.templateId === t.once!.id)).toMatchObject({ claimed: 1, canClaim: false });
    expect((await claim(target.openid, t.once!.id)).json().error.code).toBe('CLAIM_LIMIT');
    const merged = await claim(source.openid, t.free!.id);
    expect(merged.statusCode).toBe(422);
    expect(merged.json().error).toMatchObject({ code: 'MEMBER_MERGED', message: '会员卡已合并到另一张，请到前台换绑后再领' });
    expect((await center(source.openid)).notice).toBe('会员卡已合并到另一张，请到前台换绑后再领');
    const frozen = await bound('演示·停用的会员');
    await ctx.sql`UPDATE members SET status = 'frozen' WHERE id = ${frozen.memberId}`;
    const r = await claim(frozen.openid, t.free!.id);
    expect(r.json().error).toMatchObject({ code: 'MEMBER_FROZEN', message: '会员已停用，请到前台咨询' });
    expect(await claimsOf(frozen.memberId)).toHaveLength(0);
  });
});

describe('点了领取之后才换绑（小程序线测试 #52 的 P1，与充值建单同一个做法）', () => {
  it('请求在换绑到 B 之后才到：带的是点领取时的版本号，不发券、B 名下没有这张；回到领券中心按 B 重新领才发', async () => {
    const a = await bound('演示·点领取时是 A');
    const seen = (await center(a.openid)).bindVersion;
    await unbind(a.openid);
    n += 1;
    const phoneB = `1377700${String(1000 + n)}`;
    const memberB = await createMember(ctx, '演示·后来换绑的 B', phoneB);
    await bindPhone(a.openid, phoneB);
    const key = randomUUID();
    const late = await claim(a.openid, t.free!.id, key, seen);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('BIND_STALE');
    expect(await claimsOf(a.memberId)).toHaveLength(0);
    expect(await claimsOf(memberB.id)).toHaveLength(0);
    expect((await couponsOf(memberB.id)).coupons).toHaveLength(0);
    const fresh = (await center(a.openid)).bindVersion;
    expect(fresh).toBeGreaterThan(seen);
    expect((await claim(a.openid, t.free!.id, randomUUID(), fresh)).statusCode).toBe(201);
    expect(await claimsOf(memberB.id)).toHaveLength(1);
    // 解绑以后、换绑以前到的：没绑定；没带版本号的：格式不对
    const c = await bound('演示·解绑后才到的领取');
    const v = await versionOf(c.openid);
    await unbind(c.openid);
    expect((await claim(c.openid, t.free!.id, randomUUID(), v)).json().error.code).toBe('MP_NOT_BOUND');
    expect((await call('POST', '/api/mp/coupon-claims', a.openid, { clientKey: randomUUID(), templateId: t.free!.id })).statusCode).toBe(400);
  });
});

describe('买一赠一券（8.0.4 的新种类，RQ-014）', () => {
  it('领券中心与「我的券」都给出种类 bogo 与门店系统的一句话说明：买的、送的项目与「最多抵」', async () => {
    const items: Record<string, number> = {};
    for (const [name, price] of [
      ['领券拿铁', 3200],
      ['领券修脚', 6800],
    ] as const) {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category: '领券测试', price });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      items[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
    }
    const same = await template({ name: '拿铁买一赠一', kind: 'bogo', buyItemId: items['领券拿铁'] });
    const other = await template({ name: '拿铁送修脚', kind: 'bogo', buyItemId: items['领券拿铁'], exchangeItemId: items['领券修脚'], maxOff: 5000 });
    expect(same.summary).toBe('买一赠一 · 买 领券拿铁 送 领券拿铁 1 份');
    expect(other.summary).toBe('买一赠一 · 买 领券拿铁 送 领券修脚 1 份 · 最多抵 ¥50.00');
    await saveRules([...STANDARD(), offer(same.id), offer(other.id)]);
    const a = await bound('演示·买一赠一');
    const list = (await center(a.openid)).items.filter((i) => i.templateId === same.id || i.templateId === other.id);
    expect(list.map((i) => [i.name, i.kind, i.summary, i.canClaim])).toEqual([
      ['拿铁买一赠一', 'bogo', same.summary, true],
      ['拿铁送修脚', 'bogo', other.summary, true],
    ]);
    // 后台勾选用的券模板列表也是同一句
    expect((await adminData()).templates.find((x) => x.id === other.id)?.summary).toBe(other.summary);
    for (const [id, summary] of [
      [same.id, same.summary],
      [other.id, other.summary],
    ] as const) {
      const r = await claim(a.openid, id);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().coupon.summary).toBe(summary);
    }
    const mine = (await call('GET', '/api/mp/coupons', a.openid)).json() as MpCoupon[];
    const byName = Object.fromEntries(mine.map((c) => [c.name, c]));
    expect(byName['拿铁买一赠一']).toMatchObject({ kind: 'bogo', state: 'available' });
    expect(byName['拿铁送修脚']).toMatchObject({ kind: 'bogo', state: 'available' });
    // 买的、送的项目与「最多抵」都照写，与模板那一句一样（已发券的查询带上买的项目：主线 #80，8.0.5）
    expect(byName['拿铁买一赠一']!.summary).toBe(same.summary);
    expect(byName['拿铁送修脚']!.summary).toBe(other.summary);
    await saveRules(STANDARD());
  });
});

describe('领不了的', () => {
  it('档级不够、券模板停用：写给顾客看的原因，什么都不留；停领的、领券中心关掉的不能领', async () => {
    const a = await bound('演示·领不了');
    const vip = await claim(a.openid, t.vip!.id);
    expect(vip.statusCode).toBe(422);
    expect(vip.json().error).toMatchObject({ code: 'COUPON_LEVEL', message: '你现在的会员等级领不了这张券' });
    const later = await claim(a.openid, t.later!.id);
    expect(later.json().error).toMatchObject({ code: 'TEMPLATE_INACTIVE', message: '这张券已经停领了' });
    expect((await center(a.openid)).items.some((i) => i.templateId === t.later!.id)).toBe(false);
    expect(await claimsOf(a.memberId)).toHaveLength(0);
    expect((await couponsOf(a.memberId)).coupons).toHaveLength(0);
    // 停领：列表里没有、领取拒绝
    await saveRules(STANDARD().map((o) => (o.templateId === t.free!.id ? { ...o, active: false } : o)));
    expect((await center(a.openid)).items.some((i) => i.templateId === t.free!.id)).toBe(false);
    expect((await claim(a.openid, t.free!.id)).json().error.code).toBe('OFFER_UNAVAILABLE');
    expect((await claim(a.openid, t.expired!.id)).json().error.code).toBe('OFFER_UNAVAILABLE');
    // 领券中心关掉
    await saveRules(STANDARD(), false);
    expect((await claim(a.openid, t.once!.id)).json().error.code).toBe('MP_COUPON_DISABLED');
    expect((await call('GET', '/api/mp/me', a.openid)).json().member.couponCenterOpen).toBe(false);
    await saveRules(STANDARD());
  });

  it('领取记录只追加；自检照常全过', async () => {
    await expect(ctx.sql`UPDATE mp_coupon_claims SET seq = seq + 10`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM mp_coupon_claims`).rejects.toThrow();
    const checks = await consistencyChecks(ctx.sql, ctx.config.timezone);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });
});
