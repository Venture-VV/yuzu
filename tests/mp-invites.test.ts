// 小程序第三期 3b：邀请好友（小程序线，docs/MP_PHASE3.md 第 2 节；MP30、MP31；接主线 v0.7.28 的 createTrialInviteFromMp）：
//   · 设置：默认关着；店主、店总能开；
//   · 邀请人：能不能邀请照主线的规则（L0 不能邀请）；发一个邀请码（同一个编号重提返回同一个）；发出去没人领的占着本月的次数，
//     收回的退回；绑定刚变过的拒绝；
//   · 好友：已有会员、这个微信绑着的：用这位会员的手机号领；还不是会员的：要姓名，当场建档、顺带绑上这个微信；
//     领了以后邀请人看得到；同一个编号重提返回第一次；被领走的、收回的、过期的、自己发的、手机号对不上的、档级不够低的都拒绝；
//   · 确认作废以后晚到的原请求不生效；两个好友同时领只有一个领到；邀请码只能这样变；后台看得到；自检照常全过。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rechargeOutcome, type MemberGradeInfo, type MembershipRules } from '../src/shared/membership';
import { MP_GATEWAY_HEADER, MP_OPENID_HEADER, type MpInviteAdminData, type MpInviteHome, type MpInviteView } from '../src/shared/mp';
import { buildMpApp } from '../src/server/modules/mp/app';
import { consistencyChecks } from '../src/server/ops/consistency';
import { api, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
let ctx: TestContext;
let mp: FastifyInstance;

beforeAll(async () => {
  ctx = await setup();
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } }, { pay: null, sweepMs: 0 });
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })})`;
});
afterAll(async () => {
  await mp.close();
  await ctx.close();
});

const call = (method: 'GET' | 'POST', url: string, openid: string, payload?: unknown) =>
  Promise.resolve(mp.inject({ method, url, headers: { [MP_GATEWAY_HEADER]: KEY, [MP_OPENID_HEADER]: openid }, ...(payload === undefined ? {} : { payload: payload as object }) }));
const versionOf = async (openid: string) => (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
const rules = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/membership/rules')).body as MembershipRules;
const gradeOf = async (memberId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/grade`)).body as MemberGradeInfo;
let n = 0;
/** 一位会员（充了 paidYuan 元，按会员体系升到对应的档级），可以把一个微信绑上 */
async function member(name: string, paidYuan: number, bind = true): Promise<{ id: number; phone: string; openid: string }> {
  n += 1;
  const phone = `1344400${String(1000 + n)}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name, phone });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.id as number;
  if (paidYuan > 0) {
    const info = await gradeOf(id);
    const paid = paidYuan * 100;
    const bonus = rechargeOutcome(await rules(), info.state.grade, info.rollingRechargeCents, paid).bonusCents;
    const rc = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', {
      idempotencyKey: randomUUID(),
      memberId: id,
      planId: null,
      paidAmount: paid,
      bonusAmount: bonus,
      paymentMethod: 'wechat',
      paymentConfirmed: true,
      bonusMode: 'auto',
    });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
  }
  const openid = `openid-invite-${n}-${randomUUID().slice(0, 8)}`;
  if (bind) {
    const b = await call('POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, bindVersion: await versionOf(openid), mock: true });
    expect(b.statusCode, b.body).toBe(200);
  }
  return { id, phone, openid };
}
const home = async (openid: string) => {
  const r = await call('GET', '/api/mp/invites', openid);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as MpInviteHome;
};
const create = async (openid: string, clientKey = randomUUID(), bindVersion?: number) =>
  call('POST', '/api/mp/invites', openid, { clientKey, bindVersion: bindVersion ?? (await versionOf(openid)) });
const view = async (openid: string, code: string) => {
  const r = await call('GET', `/api/mp/invites/${code}`, openid);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as MpInviteView;
};
const claim = async (openid: string, code: string, body: { phone: string; name?: string; clientKey?: string }) =>
  call('POST', `/api/mp/invites/${code}/claim`, openid, { clientKey: body.clientKey ?? randomUUID(), phone: body.phone, ...(body.name ? { name: body.name } : {}), bindVersion: await versionOf(openid) });
const enable = async (enabled = true) => {
  const { rules: r } = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/mp/invites')).body as MpInviteAdminData;
  const s = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/invites/rules', { enabled, version: r.version });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
};

describe('邀请好友', () => {
  it('默认关着：邀请页写没开放、发不了；没有权限的岗位看不了、改不了；「我的」没有入口', async () => {
    const a = await member('演示·邀请关着', 10000);
    expect(await home(a.openid)).toMatchObject({ open: false, notice: '邀请好友还没开放', option: null });
    const r = await create(a.openid);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('MP_INVITE_DISABLED');
    expect((await call('GET', '/api/mp/me', a.openid)).json().member.inviteOpen).toBe(false);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/mp/invites')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/mp/invites/rules', { enabled: true })).status).toBe(403);
    await enable();
    expect((await call('GET', '/api/mp/me', a.openid)).json().member.inviteOpen).toBe(true);
  });

  it('邀请人：L0 不能邀请；够格的发一个码（同一个编号重提返回同一个），没人领的占着本月的次数，收回的退回；绑定刚变过的拒绝', async () => {
    const low = await member('演示·L0 邀请人', 0);
    const lh = await home(low.openid);
    expect(lh.option).toMatchObject({ allowed: false });
    expect(lh.option!.reason).toBeTruthy();
    expect((await create(low.openid)).statusCode).toBe(422);
    const a = await member('演示·邀请人', 10000);
    const h = await home(a.openid);
    expect(h).toMatchObject({ open: true, option: { allowed: true, used: 0, limit: 1, pending: 0 } });
    expect(h.option!.label).toMatch(/^L1 /);
    const key = randomUUID();
    const first = await create(a.openid, key);
    expect(first.statusCode, first.body).toBe(201);
    const code = first.json().code as string;
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{10}$/);
    const again = await create(a.openid, key);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ code, replayed: true });
    // 发出去还没人领：占着本月的次数
    const second = await create(a.openid);
    expect(second.statusCode).toBe(422);
    expect(second.json().error).toMatchObject({ code: 'INVITE_NOT_ALLOWED', message: '这个月的邀请已经发出去了：好友还没领，可以收回再发' });
    expect((await home(a.openid)).option).toMatchObject({ allowed: false, pending: 1 });
    expect((await home(a.openid)).invites).toMatchObject([{ code, state: 'open', friend: null }]);
    // 收回：退回次数，可以再发；收回过的再收回照样回已收回
    const rv = await call('POST', `/api/mp/invites/${code}/revoke`, a.openid, {});
    expect(rv.statusCode, rv.body).toBe(200);
    expect(rv.json()).toMatchObject({ code, state: 'revoked' });
    expect((await call('POST', `/api/mp/invites/${code}/revoke`, a.openid, {})).json()).toMatchObject({ state: 'revoked' });
    expect((await home(a.openid)).option).toMatchObject({ allowed: true, pending: 0 });
    // 别人收不了
    const other = await member('演示·别人收不了', 0);
    expect((await call('POST', `/api/mp/invites/${code}/revoke`, other.openid, {})).statusCode).toBe(404);
    // 绑定刚变过：带的版本号不对
    const stale = await create(a.openid, randomUUID(), (await versionOf(a.openid)) - 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('BIND_STALE');
    expect((await create(a.openid)).statusCode).toBe(201);
  });

  it('好友已经是会员、这个微信绑着：用这位会员的手机号领；邀请人看得到；同一个编号重提返回第一次；再领的拒绝', async () => {
    const a = await member('演示·邀请老会员', 10000);
    const f = await member('演示·老会员好友', 0);
    const code = (await create(a.openid)).json().code as string;
    const v = await view(f.openid, code);
    expect(v).toMatchObject({ code, state: 'open', inviterName: '演*', mine: false, bound: true });
    expect((await view(a.openid, code)).mine).toBe(true);
    // 手机号对不上这个微信绑定的会员
    const wrong = await claim(f.openid, code, { phone: '13999990000' });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe('OPENID_BOUND');
    const key = randomUUID();
    const r = await claim(f.openid, code, { phone: f.phone, clientKey: key });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ code, bound: true, replayed: false, trial: { status: 'active' } });
    expect(r.json().trial.label).toMatch(/^L1 /);
    const again = await claim(f.openid, code, { phone: f.phone, clientKey: key });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, trial: r.json().trial });
    const other = await member('演示·晚了一步', 0);
    const late = await claim(other.openid, code, { phone: other.phone });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toMatchObject({ code: 'INVITE_USED', message: '这份邀请已经被领走了' });
    const h = await home(a.openid);
    expect(h.invites[0]).toMatchObject({ code, state: 'used', friend: { name: '演*', trial: { status: 'active' } } });
    // 本月用掉了：不能再发
    expect(h.option).toMatchObject({ allowed: false, used: 1 });
    expect((await call('GET', '/api/mp/me', f.openid)).json().member.grade.label).toBeTruthy();
    // 领了的收不回来
    expect((await call('POST', `/api/mp/invites/${code}/revoke`, a.openid, {})).statusCode).toBe(409);
  });

  it('好友还不是会员：先要姓名；填了当场建档、顺带绑上这个微信', async () => {
    const a = await member('演示·邀请新朋友', 10000);
    const code = (await create(a.openid)).json().code as string;
    const openid = `openid-invite-new-${randomUUID().slice(0, 8)}`;
    const phone = '13444499001';
    expect((await view(openid, code)).bound).toBe(false);
    const noName = await claim(openid, code, { phone });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error).toMatchObject({ code: 'NAME_REQUIRED', message: '你还不是会员：填一下姓名，就能开卡体验' });
    const r = await claim(openid, code, { phone, name: '新朋友' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ bound: true, notice: null, trial: { status: 'active' } });
    const me = (await call('GET', '/api/mp/me', openid)).json();
    expect(me).toMatchObject({ bound: true, member: { name: '新朋友' } });
    const [m] = await ctx.sql<{ phone: string }[]>`SELECT phone FROM members WHERE name = '新朋友'`;
    expect(m!.phone).toBe(phone);
  });

  it('拒绝：自己发的、收回的、过期的、档级不够低的；会员已经绑了别的微信的领到了但不绑这个微信', async () => {
    const a = await member('演示·拒绝的邀请人', 10000);
    const c1 = (await create(a.openid)).json().code as string;
    const self = await claim(a.openid, c1, { phone: a.phone });
    expect(self.statusCode).toBe(422);
    expect(self.json().error).toMatchObject({ code: 'TRIAL_SELF', message: '不能领自己发出的邀请' });
    expect((await call('POST', `/api/mp/invites/${c1}/revoke`, a.openid, {})).statusCode).toBe(200);
    const f = await member('演示·拒绝的好友', 0);
    const revoked = await claim(f.openid, c1, { phone: f.phone });
    expect(revoked.statusCode).toBe(422);
    expect(revoked.json().error.code).toBe('INVITE_REVOKED');
    // 过期的：7 天没人领
    const [exp] = await ctx.sql<{ code: string }[]>`
      INSERT INTO mp_invites (code, client_key, inviter_member_id, inviter_binding_id, label, created_at, expires_at)
      SELECT 'XPRD234567', ${randomUUID()}, ${a.id}, b.id, 'L1 云涧 · 初', now() - interval '8 days', now() - interval '1 day'
      FROM mp_bindings b WHERE b.member_id = ${a.id} AND b.unbound_at IS NULL RETURNING code`;
    expect((await view(f.openid, exp!.code)).state).toBe('expired');
    const expired = await claim(f.openid, exp!.code, { phone: f.phone });
    expect(expired.statusCode).toBe(422);
    expect(expired.json().error.code).toBe('INVITE_EXPIRED');
    // 好友的档级不低于体验的档级
    const rich = await member('演示·档级高的好友', 30000);
    const c2 = (await create(a.openid)).json().code as string;
    const high = await claim(rich.openid, c2, { phone: rich.phone });
    expect(high.statusCode).toBe(422);
    expect(high.json().error.code).toBe('TRIAL_INVITEE');
    expect(high.json().error.message).toMatch(/^你/);
    // 会员已经绑了别的微信：领到了，这个微信不绑
    const g = await member('演示·绑了别的微信', 0);
    const otherWx = `openid-invite-otherwx-${randomUUID().slice(0, 8)}`;
    const r = await claim(otherWx, c2, { phone: g.phone });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ bound: false, notice: '会员卡已经绑了别的微信，这个微信没有绑上；要换绑请到前台办理' });
    expect((await call('GET', '/api/mp/me', otherWx)).json().bound).toBe(false);
  });

  it('确认作废以后晚到的原请求不生效；领到了的作废回那一次；两个好友同时领只有一个领到', async () => {
    const a = await member('演示·作废的邀请人', 10000);
    const code = (await create(a.openid)).json().code as string;
    const f = await member('演示·作废的好友', 0);
    const key = randomUUID();
    const ab = await call('POST', '/api/mp/invites/claim/abandon', f.openid, { clientKey: key });
    expect(ab.json()).toEqual({ status: 'abandoned' });
    const late = await claim(f.openid, code, { phone: f.phone, clientKey: key });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('OP_ABANDONED');
    // 两个好友同时领
    const g = await member('演示·同时领一', 0);
    const h = await member('演示·同时领二', 0);
    const [r1, r2] = await Promise.all([claim(g.openid, code, { phone: g.phone }), claim(h.openid, code, { phone: h.phone })]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
    const winner = r1.statusCode === 201 ? g : h;
    const winnerKey = randomUUID();
    // 领到了以后作废：回领到的那一次（用领取的编号）
    const [row] = await ctx.sql<{ claimClientKey: string }[]>`SELECT claim_client_key FROM mp_invites WHERE code = ${code}`;
    const done = await call('POST', '/api/mp/invites/claim/abandon', winner.openid, { clientKey: row!.claimClientKey });
    expect(done.json()).toMatchObject({ status: 'claimed', claimed: { code, replayed: true } });
    void winnerKey;
  });

  it('发出去了、回答路上丢了，之后又换过绑定：原样重提照样回那个码（码占着本月的次数，不能说成没发出）；别的微信用不了这个编号', async () => {
    const a = await member('演示·邀请重提', 10000);
    const key = randomUUID();
    const v0 = await versionOf(a.openid);
    const first = await create(a.openid, key, v0);
    expect(first.statusCode, first.body).toBe(201);
    const code = first.json().code as string;
    // 解绑、再绑同一位会员（绑定状态版本号变了两次）
    const bindings = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/mp/members/${a.id}/bindings`)).body as { id: number }[];
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/bindings/${bindings[0]!.id}/unbind`, { clientKey: randomUUID(), reason: '测试换绑' })).status).toBe(200);
    expect((await call('POST', '/api/mp/bind', a.openid, { clientKey: randomUUID(), phone: a.phone, bindVersion: await versionOf(a.openid), mock: true })).statusCode).toBe(200);
    const again = await create(a.openid, key, v0);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ code, replayed: true });
    const other = await member('演示·别的微信邀请', 10000);
    const stolen = await create(other.openid, key);
    expect([stolen.statusCode, stolen.json().error.code]).toEqual([409, 'CLIENT_KEY_REUSED']);
  });

  it('邀请码只能这样变；后台看得到最近的邀请与各状态的数；自检照常全过', async () => {
    const [any] = await ctx.sql<{ id: number }[]>`SELECT id FROM mp_invites WHERE status = 'used' LIMIT 1`;
    await expect(ctx.sql`UPDATE mp_invites SET code = 'ABCDEFGHJK' WHERE id = ${any!.id}`).rejects.toThrow(/不能改/);
    await expect(ctx.sql`UPDATE mp_invites SET status = 'revoked', revoked_at = now() WHERE id = ${any!.id}`).rejects.toThrow(/不能再改/);
    await expect(ctx.sql`DELETE FROM mp_invites WHERE id = ${any!.id}`).rejects.toThrow(/不能删除/);
    const d = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/mp/invites')).body as MpInviteAdminData;
    expect(d.rules.enabled).toBe(true);
    expect(d.stats.used).toBeGreaterThanOrEqual(3);
    expect(d.stats.revoked).toBeGreaterThanOrEqual(2);
    expect(d.stats.open).toBeGreaterThanOrEqual(1);
    expect(d.recent.length).toBeGreaterThan(5);
    expect(d.recent.find((r) => r.state === 'used')).toMatchObject({ inviteeName: expect.any(String), trial: { status: 'active' } });
    expect((await consistencyChecks(ctx.sql, ctx.config.timezone)).filter((c) => !c.ok)).toEqual([]);
  });
});
