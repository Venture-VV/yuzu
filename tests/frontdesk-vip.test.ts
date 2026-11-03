// Batch 2.2：真实柜池的 VIP 柜等级校验、当场授权、丢牌赔偿、按清单导入与前台规则。
//   · 会员能用的柜子等级不低于柜子等级才能使用该 VIP 柜（店主 #26）；会员体系 v2（v0.7.23）起按档级对应（会员规则里的「VIP 柜」）；
//   · 当场授权默认关闭；开启后由值班经理 / 店总 / 店主输入账号密码签发一次性授权（❓2）：
//     绑定申请人、柜与客人，5 分钟有效，只能用一次，业务回滚时核销一起回滚；密码错误与登录共用限流；
//   · 丢牌赔偿 200 元作为挂账明细，和换牌同一事务、同一操作编号（#30）；
//   · 按清单导入：预览不写入、已有牌号以清单为准、在店手牌不改。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseHandTagCsv } from '../src/shared/hand-tag-import';
import { createStaff } from '../src/server/modules/staff';
import { api, consumeBody, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let dutyId: number;
let clerk2: string;
let item: number;

const tagsCsv = `code,gender,kind,area,vip_level
A8060,male,normal,A,
A8061,male,normal,A,
A8062,male,normal,A,
A8065,male,normal,A,
A8066,male,normal,A,
A8067,male,normal,A,
A8068,male,normal,A,
A8069,male,normal,A,
A6001,female,normal,A,
A6002,female,normal,A,
8001,male,vip,,1
8002,male,vip,,1
8003,male,vip,,1
9033,male,vip,,2
9035,male,vip,,2
9058,male,vip,,3
9059,male,vip,,3
9060,male,vip,,3
9061,male,vip,,3
9062,male,vip,,3
9111,male,vip,,5
9001,female,vip,,2
9002,female,vip,,2
`;

beforeAll(async () => {
  ctx = await setup();
  const parsed = parseHandTagCsv(tagsCsv);
  expect(parsed.errors).toEqual([]);
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/import', { rows: parsed.rows, dryRun: false });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  dutyId = await createStaff(ctx.sql, { username: 'duty', displayName: '王经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'clerk2', displayName: '第二店员', role: 'clerk', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'locked_mgr', displayName: '被锁经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  clerk2 = await login(ctx.app, 'clerk2');
  const it = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '浴资', category: '洗浴', price: 9800 });
  item = it.body.items.find((i: { name: string }) => i.name === '浴资').id;
});
afterAll(async () => ctx.close());

const checkin = (cookie: string, guests: unknown[], extra: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests, ...extra });
const authorize = (cookie: string, tags: { code: string; memberId: number | null }[], who = 'duty', password = PASSWORD) =>
  api(ctx.app, cookie, 'POST', '/api/auth/authorize', { username: who, password, purpose: 'vip_tag', scope: { tags } });
const setRules = async (patch: Record<string, unknown>) => {
  const r = await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', patch);
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body;
};
const openOn = async (code: string) =>
  (await ctx.sql<{ id: number; vipOverrideBy: number | null }[]>`
    SELECT v.id, v.vip_override_by FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = ${code} AND v.status = 'open'`)[0] ?? null;
const cancel = (cookie: string, visitId: number) => api(ctx.app, cookie, 'POST', `/api/frontdesk/visits/${visitId}/cancel`, { reason: '开错手牌' });
const gradeOf = async (memberId: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/members/${memberId}/grade`)).body;
const memberWith = async (name: string, phone: string, recharges: number[]) => {
  const m = await createMember(ctx, name, phone);
  for (const paid of recharges) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, paid));
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
  return m.id;
};

describe('会员档级与 VIP 柜（会员体系 v2，v0.7.23）', () => {
  it('档级按滚动累计充值升；VIP 柜按档级对应：L0–L3 能用 1 级柜、L4 2 级、L5 4 级、L6 5 级', async () => {
    const fresh = await memberWith('新会员', '19900007001', []);
    expect(await gradeOf(fresh)).toMatchObject({ grade: 0, tier: null, label: 'L0 青溪', lockerLevel: 1 });
    const almost = await memberWith('差一分', '19900007002', [4_999_999]);
    expect(await gradeOf(almost)).toMatchObject({ grade: 3, lockerLevel: 1 });
    const exact = await memberWith('正好五万', '19900007003', [5_000_000]);
    expect(await gradeOf(exact)).toMatchObject({ grade: 4, tier: 0, label: 'L4 望岳 · 初', lockerLevel: 2 });
    const big = await memberWith('十二万', '19900007004', [5_000_000, 5_000_000, 2_000_000]);
    expect(await gradeOf(big)).toMatchObject({ grade: 5, lockerLevel: 4 });
  });

  it('消费不降档（同一周期只升不降）', async () => {
    const m = await memberWith('消费会员', '19900007005', [5_000_000]);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m, 1_000_000))).status).toBe(200);
    expect(await gradeOf(m)).toMatchObject({ grade: 4, lockerLevel: 2 });
  });

  it('前台规则只剩手牌与授权的几项：旧页面带来的等级门槛不再保存；只改提交的字段；店员不能改规则', async () => {
    const before = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/rules')).body;
    expect(before).toEqual({ selfVoidMinutes: 15, lostTagFeeCents: 20000, vipOverrideEnabled: false, overtimeGraceMinutes: 15 });
    expect(await setRules({ vipLevelThresholds: [0, 5_000_000, 5_000_000] })).toEqual(before);
    expect(await setRules({ selfVoidMinutes: 20 })).toEqual({ ...before, selfVoidMinutes: 20 });
    await setRules({ selfVoidMinutes: 15 });
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/frontdesk/rules', { selfVoidMinutes: 30 })).status).toBe(403);
    expect((await api(ctx.app, duty, 'PUT', '/api/frontdesk/rules', { selfVoidMinutes: 30 })).status).toBe(403);
  });
});

describe('VIP 柜等级校验（当场授权关闭，默认）', () => {
  it('散客不能用 VIP 柜；第 1 级会员可用第 1 级柜、不能用第 2 级柜', async () => {
    const walkin = await checkin(ctx.clerk, [{ tagCode: '8001', zone: 'male' }]);
    expect(walkin.status).toBe(422);
    expect(walkin.body.error.code).toBe('VIP_LEVEL_TOO_LOW');
    expect(walkin.body.error.message).toContain('散客不能使用');
    expect(await openOn('8001')).toBeNull();

    const m = await memberWith('一级会员', '19900007101', [100_000]);
    const high = await checkin(ctx.clerk, [{ tagCode: '9033', zone: 'male', memberId: m }]);
    expect(high.body.error).toMatchObject({ code: 'VIP_LEVEL_TOO_LOW', details: { shortfalls: [{ code: '9033', memberId: m, tagLevel: 2, memberLevel: 1 }] } });
    expect(high.body.error.message).toContain('现在是「L0 青溪」，只能用第 1 级及以下的 VIP 柜');
    const ok = await checkin(ctx.clerk, [{ tagCode: '8001', zone: 'male', memberId: m }]);
    expect(ok.status).toBe(201);
    expect((await openOn('8001'))!.vipOverrideBy).toBeNull();
  });

  it('等级更高的会员可以用等级更低的柜；同行的散客不能沾会员的等级', async () => {
    const m = await memberWith('三级会员', '19900007102', [5_000_000, 5_000_000]);
    const r = await checkin(ctx.clerk, [
      { tagCode: '9058', zone: 'male', memberId: m },
      { tagCode: '8002', zone: 'male', guestLabel: '朋友' },
    ]);
    expect(r.body.error.code).toBe('VIP_LEVEL_TOO_LOW');
    expect(r.body.error.details.shortfalls).toEqual([{ code: '8002', memberId: null, tagLevel: 1, memberLevel: 0 }]);
    expect(await openOn('9058')).toBeNull();
    const ok = await checkin(ctx.clerk, [
      { tagCode: '9033', zone: 'male', memberId: m },
      { tagCode: 'A8060', zone: 'male', guestLabel: '朋友' },
    ]);
    expect(ok.status).toBe(201);
  });

  it('开关关闭时不签发授权', async () => {
    const r = await authorize(ctx.clerk, [{ code: '9111', memberId: null }]);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('VIP_OVERRIDE_DISABLED');
    expect((await ctx.sql`SELECT 1 FROM auth_grants`).length).toBe(0);
  });

  it('换牌到 VIP 柜同样核对等级', async () => {
    const v = (await checkin(ctx.clerk, [{ tagCode: 'A8061', zone: 'male' }])).body.visits[0].id;
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/swap`, { clientKey: randomUUID(), toTagCode: '8003', reason: '顾客要求换柜' });
    expect(r.body.error.code).toBe('VIP_LEVEL_TOO_LOW');
    expect(await openOn('A8061')).not.toBeNull();
    expect((await cancel(ctx.clerk, v)).status).toBe(200);
  });
});

describe('当场授权（开关开启）', () => {
  let walkinGrant: string;
  beforeAll(async () => {
    await setRules({ vipOverrideEnabled: true });
  });

  it('没有授权时提示需要当场授权', async () => {
    const r = await checkin(ctx.clerk, [{ tagCode: '9111', zone: 'male' }]);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('VIP_AUTH_REQUIRED');
    expect(r.body.error.message).toContain('当场授权');
  });

  it('授权人密码错误返回 403（不会把前台登出）；店员没有授权权限；授权人停用不能授权', async () => {
    const wrong = await authorize(ctx.clerk, [{ code: '9111', memberId: null }], 'duty', 'wrong-password');
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('AUTH_FAILED');
    const unknown = await authorize(ctx.clerk, [{ code: '9111', memberId: null }], 'nobody', 'x');
    expect(unknown.body.error.code).toBe('AUTH_FAILED');
    const notAllowed = await authorize(ctx.clerk, [{ code: '9111', memberId: null }], 'clerk2');
    expect(notAllowed.status).toBe(403);
    expect(notAllowed.body.error.code).toBe('AUTH_NOT_ALLOWED');
    // 前台员工的会话仍然有效
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).status).toBe(200);
    const [failed] = await ctx.sql<{ n: number }[]>`SELECT count(*) AS n FROM audit_logs WHERE action = 'auth_failed'`;
    expect(failed!.n).toBe(2);
  });

  it('授权人密码错误与登录共用限流：连续 5 次后授权与登录都被锁定', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await authorize(ctx.clerk, [{ code: '9111', memberId: null }], 'locked_mgr', 'bad')).status).toBe(403);
    }
    const locked = await authorize(ctx.clerk, [{ code: '9111', memberId: null }], 'locked_mgr');
    expect(locked.status).toBe(429);
    const loginTry = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'locked_mgr', password: PASSWORD } });
    expect(loginTry.statusCode).toBe(429);
  });

  it('值班经理授权散客用 VIP 柜：开牌成功并记下授权人；授权只能用一次', async () => {
    const g = await authorize(ctx.clerk, [{ code: '9111', memberId: null }]);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ purpose: 'vip_tag', approverName: '王经理', scope: { tags: [{ code: '9111', memberId: null }] } });
    walkinGrant = g.body.grantId;
    const key = randomUUID();
    const body = { clientKey: key, guests: [{ tagCode: '9111', zone: 'male', guestLabel: '贵宾' }], vipGrantId: walkinGrant };
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', body);
    expect(r.status).toBe(201);
    const v = await openOn('9111');
    expect(v!.vipOverrideBy).toBe(dutyId);
    const detail = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v!.id}`)).body;
    expect(detail.vipOverrideByName).toBe('王经理');
    expect(detail.history[0].text).toContain('王经理当场授权');
    const [grant] = await ctx.sql<{ usedRef: string; usedAt: string | null }[]>`SELECT used_ref, used_at FROM auth_grants WHERE id = ${walkinGrant}`;
    expect(grant).toMatchObject({ usedRef: `checkin:${key}` });
    const [audit] = await ctx.sql<{ detail: { vipOverride: { approverId: number } } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'frontdesk_checkin' AND target_id = ${String(v!.id)}`;
    expect(audit!.detail.vipOverride.approverId).toBe(dutyId);

    // 同一编号原样重提：返回第一次的结果，不再核销
    const replay = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', body);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    // 同一授权换个编号再用：拒绝
    expect((await cancel(ctx.clerk, v!.id)).status).toBe(200);
    const again = await checkin(ctx.clerk, [{ tagCode: '9111', zone: 'male' }], { vipGrantId: walkinGrant });
    expect(again.body.error.code).toBe('GRANT_USED');
  });

  it('授权绑定申请人、柜与客人', async () => {
    const m = await memberWith('一级换柜', '19900007201', [100_000]);
    const g = (await authorize(ctx.clerk, [{ code: '9060', memberId: m }])).body.grantId;
    // 其他店员拿去用
    expect((await checkin(clerk2, [{ tagCode: '9060', zone: 'male', memberId: m }], { vipGrantId: g })).body.error.code).toBe('GRANT_INVALID');
    // 换了一张柜
    expect((await checkin(ctx.clerk, [{ tagCode: '9061', zone: 'male', memberId: m }], { vipGrantId: g })).body.error.code).toBe('GRANT_SCOPE');
    // 换了一位客人（散客）
    expect((await checkin(ctx.clerk, [{ tagCode: '9060', zone: 'male' }], { vipGrantId: g })).body.error.code).toBe('GRANT_SCOPE');
    // 原样使用：成功
    expect((await checkin(ctx.clerk, [{ tagCode: '9060', zone: 'male', memberId: m }], { vipGrantId: g })).status).toBe(201);
  });

  it('业务没成功时核销一起回滚，授权仍可在有效期内使用；不需要授权时不核销', async () => {
    const g = (await authorize(ctx.clerk, [{ code: '9062', memberId: null }])).body.grantId;
    // 第二位客人的牌已在店 → 整笔失败
    const fail = await checkin(ctx.clerk, [{ tagCode: '9062', zone: 'male' }, { tagCode: '9060', zone: 'male' }], { vipGrantId: g });
    expect(fail.body.error.code).toBe('TAG_OCCUPIED');
    const [unused] = await ctx.sql<{ usedAt: string | null }[]>`SELECT used_at FROM auth_grants WHERE id = ${g}`;
    expect(unused!.usedAt).toBeNull();
    // 带着授权开普通柜：不需要授权，不核销
    expect((await checkin(ctx.clerk, [{ tagCode: 'A8062', zone: 'male' }], { vipGrantId: g })).status).toBe(201);
    expect((await ctx.sql<{ usedAt: string | null }[]>`SELECT used_at FROM auth_grants WHERE id = ${g}`)[0]!.usedAt).toBeNull();
    expect((await checkin(ctx.clerk, [{ tagCode: '9062', zone: 'male' }], { vipGrantId: g })).status).toBe(201);
  });

  it('同一授权并发用于两笔：只有一笔成功', async () => {
    const g = (await authorize(ctx.clerk, [{ code: '9035', memberId: null }, { code: '9059', memberId: null }])).body.grantId;
    const results = await Promise.all([
      checkin(ctx.clerk, [{ tagCode: '9035', zone: 'male' }], { vipGrantId: g }),
      checkin(ctx.clerk, [{ tagCode: '9059', zone: 'male' }], { vipGrantId: g }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(results.find((r) => r.status === 422)!.body.error.code).toBe('GRANT_USED');
  });

  it('过期的授权、授权人已停用的授权都不能用', async () => {
    const [expired] = await ctx.sql<{ id: string }[]>`
      INSERT INTO auth_grants (purpose, requested_by, approved_by, scope, created_at, expires_at)
      VALUES ('vip_tag', ${ctx.clerkId}, ${dutyId}, ${ctx.sql.json({ tags: [{ code: '9002', memberId: null }] })}, now() - interval '10 minutes', now() - interval '5 minutes')
      RETURNING id`;
    const r = await checkin(ctx.clerk, [{ tagCode: '9002', zone: 'female' }], { vipGrantId: expired!.id });
    expect(r.body.error.code).toBe('GRANT_EXPIRED');

    const g = (await authorize(ctx.clerk, [{ code: '9002', memberId: null }])).body.grantId;
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${dutyId}`;
    const r2 = await checkin(ctx.clerk, [{ tagCode: '9002', zone: 'female' }], { vipGrantId: g });
    expect(r2.body.error.code).toBe('GRANT_INVALID');
    await ctx.sql`UPDATE staff SET active = true WHERE id = ${dutyId}`;
    expect((await checkin(ctx.clerk, [{ tagCode: '9002', zone: 'female' }], { vipGrantId: g })).status).toBe(201);
  });

  it('换牌到等级不够的 VIP 柜：经授权后换牌成功，换牌记录记下授权人', async () => {
    const m = await memberWith('二级换柜', '19900007202', [5_000_000]);
    const v = (await checkin(ctx.clerk, [{ tagCode: 'A8065', zone: 'male', memberId: m }])).body.visits[0].id;
    const swap = (extra: Record<string, unknown>) =>
      api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/swap`, { clientKey: randomUUID(), toTagCode: '9058', reason: '顾客要求换柜', ...extra });
    expect((await swap({})).body.error.code).toBe('VIP_AUTH_REQUIRED');
    const g = (await authorize(ctx.clerk, [{ code: '9058', memberId: m }])).body.grantId;
    const ok = await swap({ vipGrantId: g });
    expect(ok.status).toBe(200);
    expect(ok.body.tag).toMatchObject({ code: '9058', kind: 'vip', vipLevel: 3 });
    expect(ok.body.memberGrade).toMatchObject({ grade: 4, lockerLevel: 2 });
    expect(ok.body.history.find((h: { kind: string }) => h.kind === 'swap').text).toContain('王经理当场授权');
    const [change] = await ctx.sql<{ vipOverrideBy: number }[]>`SELECT vip_override_by FROM visit_tag_changes WHERE visit_id = ${v}`;
    expect(change!.vipOverrideBy).toBe(dutyId);
  });

  it('数据库层：授权记录不能删除、用过的不能再改', async () => {
    const [g] = await ctx.sql<{ id: string }[]>`SELECT id FROM auth_grants WHERE used_at IS NOT NULL LIMIT 1`;
    await expect(ctx.sql`DELETE FROM auth_grants WHERE id = ${g!.id}`).rejects.toThrow(/禁止删除/);
    await expect(ctx.sql`UPDATE auth_grants SET used_at = NULL, used_ref = NULL WHERE id = ${g!.id}`).rejects.toThrow(/只能登记一次使用/);
  });

  afterAll(async () => {
    await setRules({ vipOverrideEnabled: false });
  });
});

describe('丢牌赔偿', () => {
  let v: number;
  beforeAll(async () => {
    v = (await checkin(ctx.clerk, [{ tagCode: 'A8066', zone: 'male', guestLabel: '丢牌客' }])).body.visits[0].id;
    await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/charges`, { clientKey: randomUUID(), lines: [{ itemId: item, quantity: 1 }], expectedTotal: 9800 });
  });
  const swap = (body: Record<string, unknown>) => api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/swap`, { clientKey: randomUUID(), reason: '手牌丢失', ...body });

  it('收赔偿必须同时锁定原手牌；金额与当前规则不一致时拒绝', async () => {
    const noLock = await swap({ toTagCode: 'A8067', lostFee: 20000, lockOld: false });
    expect(noLock.status).toBe(400);
    expect(noLock.body.error.message).toContain('锁定');
    const stale = await swap({ toTagCode: 'A8067', lostFee: 10000, lockOld: true });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PRICE_CHANGED');
    expect(stale.body.error.message).toContain('¥200.00');
    const vis = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body;
    expect(vis.tag.code).toBe('A8066');
    expect(vis.bill.amountCents).toBe(9800);
  });

  it('换牌、锁定原牌、挂赔偿同一事务；原样重提不重复收；自检通过', async () => {
    const key = randomUUID();
    const body = { clientKey: key, toTagCode: 'A8067', reason: '手牌丢失', lockOld: true, lostFee: 20000 };
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/swap`, body);
    expect(r.status).toBe(200);
    expect(r.body.tag.code).toBe('A8067');
    expect(r.body.bill).toMatchObject({ amountCents: 29800, lineCount: 2 });
    const fee = r.body.lines.find((l: { source: string }) => l.source === 'other');
    expect(fee).toMatchObject({ name: '手牌丢失赔偿（A8066）', unitPrice: 20000, quantity: 1, amount: 20000, status: 'active', postKey: key, postedByName: '测试店员' });
    const again = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/swap`, body);
    expect(again.status).toBe(200);
    expect(again.body.bill.amountCents).toBe(29800);
    const [old] = await ctx.sql<{ locked: boolean; lockReason: string }[]>`SELECT locked, lock_reason FROM hand_tags WHERE code = 'A8066'`;
    expect(old).toMatchObject({ locked: true, lockReason: '手牌丢失' });
    for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body) expect(c, c.label).toMatchObject({ ok: true });
    // 店员可在时限内作废自己挂的赔偿（例如找回了手牌）
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${fee.id}/void`, { reason: '顾客取消' })).status).toBe(200);
  });

  it('规则改为不收时拒绝带赔偿的换牌', async () => {
    await setRules({ lostTagFeeCents: 0 });
    const r = await swap({ toTagCode: 'A8068', lostFee: 20000, lockOld: true });
    expect(r.body.error.code).toBe('LOST_FEE_DISABLED');
    await setRules({ lostTagFeeCents: 20000 });
  });
});

describe('按清单导入', () => {
  it('预览不写入；正式导入后再导一次全部未变', async () => {
    const rows = [
      { code: 'B8186', zone: 'male', kind: 'normal', vipLevel: null },
      { code: '9070', zone: 'male', kind: 'vip', vipLevel: 4 },
    ];
    const preview = (await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/import', { rows })).body;
    expect(preview).toMatchObject({ dryRun: true, total: 2, created: 2 });
    expect((await ctx.sql`SELECT 1 FROM hand_tags WHERE code IN ('B8186', '9070')`).length).toBe(0);
    const applied = (await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/import', { rows, dryRun: false })).body;
    expect(applied).toMatchObject({ dryRun: false, created: 2, updated: 0, unchanged: 0 });
    expect(applied.groups).toEqual(expect.arrayContaining([{ zone: 'male', kind: 'vip', vipLevel: 4, area: '', count: 1 }]));
    const again = (await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/import', { rows, dryRun: false })).body;
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*) AS n FROM audit_logs WHERE action = 'hand_tags_imported'`;
    expect(audit!.n).toBe(3); // beforeAll 一次 + 这里两次（预览不记）
  });

  it('已有牌号以清单为准更新柜型与等级，停用的恢复启用；在店手牌不改', async () => {
    const tags = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/tags')).body as { id: number; code: string }[];
    const b = tags.find((t) => t.code === 'B8186')!;
    await api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/tags/${b.id}`, { zone: 'male', active: false });
    const inStore = 'A8069';
    expect((await checkin(ctx.clerk, [{ tagCode: inStore, zone: 'male' }])).status).toBe(201);
    const r = (await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/import', {
      rows: [
        { code: 'B8186', zone: 'male', kind: 'normal', vipLevel: null },
        { code: inStore, zone: 'male', kind: 'vip', vipLevel: 2 },
        { code: '9070', zone: 'male', kind: 'vip', vipLevel: 5 },
      ],
      dryRun: false,
    })).body;
    expect(r).toMatchObject({ updated: 2, unchanged: 0, blocked: [{ code: inStore }] });
    const rows = await ctx.sql<{ code: string; kind: string; vipLevel: number | null; active: boolean }[]>`
      SELECT code, kind, vip_level, active FROM hand_tags WHERE code IN ('B8186', '9070', ${inStore}) ORDER BY code`;
    expect(rows).toEqual([
      { code: '9070', kind: 'vip', vipLevel: 5, active: true },
      { code: inStore, kind: 'normal', vipLevel: null, active: true },
      { code: 'B8186', kind: 'normal', vipLevel: null, active: true },
    ]);
  });

  it('清单校验与权限：重复牌号、VIP 柜缺等级、儿童分区都拒绝；店员与值班经理以外不能导入', async () => {
    const dup = await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/import', {
      rows: [
        { code: 'C8510', zone: 'male', kind: 'normal', vipLevel: null },
        { code: 'c8510', zone: 'male', kind: 'normal', vipLevel: null },
      ],
    });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('C8510');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/import', { rows: [{ code: '9999', zone: 'male', kind: 'vip', vipLevel: null }] })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/import', { rows: [{ code: 'C001', zone: 'child', kind: 'normal', vipLevel: null }] })).status).toBe(400);
    const rows = [{ code: 'C8511', zone: 'male', kind: 'normal', vipLevel: null }];
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/tags/import', { rows })).status).toBe(403);
    expect((await api(ctx.app, duty, 'POST', '/api/frontdesk/tags/import', { rows })).status).toBe(200);
  });

  it('CSV 解析：中文表头与取值、区号与牌号不一致、重复与缺等级逐行报出', () => {
    const ok = parseHandTagCsv('﻿柜号,性别,柜型,区,等级\r\nA8060,男宾,普通柜,A,\r\n9058,男,VIP 柜,,3\r\n');
    expect(ok.errors).toEqual([]);
    expect(ok.rows).toEqual([
      { code: 'A8060', zone: 'male', kind: 'normal', vipLevel: null },
      { code: '9058', zone: 'male', kind: 'vip', vipLevel: 3 },
    ]);
    const bad = parseHandTagCsv('code,gender,kind,area,vip_level\nA8060,male,normal,B,\n9058,female,vip,,\nA8060,male,normal,A,\nX-1,child,normal,,\n');
    expect(bad.errors.map((e) => e.line)).toEqual([2, 3, 5]);
    expect(bad.errors[0]!.message).toContain('区号');
    expect(bad.errors[1]!.message).toContain('等级');
    expect(bad.errors[2]!.message).toMatch(/格式不正确.*male \/ female/);
    expect(parseHandTagCsv('a,b\n1,2').errors[0]!.message).toContain('表头缺少');
  });
});
