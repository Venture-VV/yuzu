// 小程序领取的发券入口（v0.7.27，docs/MP_COUPONS.md 第 3 节，MP22；docs/MEMBERSHIP_FINISH.md 第 6 节）：
//   · 小程序线在自己的事务里调用 issueMpClaimCoupon：发券记录种类「小程序领取」、经办人系统账号「小程序」、一次 1 张、有效期照模板；
//   · 同一个领取记录只发一次：再调用返回第一次那张（replayed）；同一个领取记录发给别的模板或会员拒绝；两个事务同时发也只出一张；
//   · 会员停用、已合并，模板停用、固定有效期已过，档级不在模板限定里，都拒绝，调用方的事务跟着回滚、什么都不留；
//   · 会员的券里照常显示、标「小程序领取」；自检照常全过。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CouponTemplate, MemberCoupons } from '../src/shared/coupons';
import type { Deps } from '../src/server/lib/context';
import { issueMpClaimCoupon, type MpClaimInput } from '../src/server/modules/coupons';
import { consistencyChecks } from '../src/server/ops/consistency';
import { api, createMember, setup, type TestContext } from './helpers';

let ctx: TestContext;
let deps: Deps;

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
});
afterAll(async () => ctx?.close());

const template = async (body: Record<string, unknown>) => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), validity: 'days', validDays: 30, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as CouponTemplate;
};
const claim = (input: MpClaimInput) => ctx.sql.begin((tx) => issueMpClaimCoupon(tx, deps, input));
const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string };
  }
  throw new Error('应该拒绝');
};
const couponsOf = async (memberId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/coupons`)).body as MemberCoupons;
const issuesOf = (memberId: number) =>
  ctx.sql<{ kind: string; quantity: number; dedupeKey: string; issuedBy: string; reason: string }[]>`
    SELECT i.kind, i.quantity, i.dedupe_key, s.username AS issued_by, i.reason
    FROM coupon_issues i JOIN staff s ON s.id = i.issued_by WHERE i.member_id = ${memberId} ORDER BY i.id`;

describe('小程序领取', () => {
  let memberId: number;
  let cash: CouponTemplate;

  it('发 1 张：种类「小程序领取」、经办人系统账号「小程序」、有效期照模板；会员的券里能看到', async () => {
    memberId = (await createMember(ctx, '领券会员', '19977770001')).id;
    cash = await template({ name: '线上领三十', kind: 'cash', faceValue: 3000, threshold: 5000, validDays: 15 });
    const r = await claim({ templateId: cash.id, memberId, claimId: 101 });
    expect(r).toMatchObject({ replayed: false, coupon: { templateId: cash.id, memberId, issueKind: 'mp_claim', state: 'available' } });
    expect(r.issueNo).toMatch(/^FQ/);
    const days = (Date.parse(`${r.coupon.validTo}T00:00:00Z`) - Date.parse(`${r.coupon.validFrom}T00:00:00Z`)) / 86_400_000;
    expect(days).toBe(14);
    expect(await issuesOf(memberId)).toEqual([{ kind: 'mp_claim', quantity: 1, dedupeKey: 'mp_claim:101', issuedBy: 'system.mp', reason: '小程序领取' }]);
    const mine = await couponsOf(memberId);
    expect(mine.coupons.map((c) => [c.templateName, c.issueKind])).toEqual([['线上领三十', 'mp_claim']]);
  });

  it('同一个领取记录再调用返回第一次那张，不多发；发给别的模板或会员拒绝；字符串编号也行', async () => {
    const again = await claim({ templateId: cash.id, memberId, claimId: 101 });
    expect(again.replayed).toBe(true);
    expect((await couponsOf(memberId)).coupons).toHaveLength(1);
    const other = await template({ name: '线上领十元', kind: 'cash', faceValue: 1000 });
    const e = await errorOf(claim({ templateId: other.id, memberId, claimId: 101 }));
    expect(e.code).toBe('MP_CLAIM_CONFLICT');
    const someone = (await createMember(ctx, '另一位', '19977770002')).id;
    expect((await errorOf(claim({ templateId: cash.id, memberId: someone, claimId: 101 }))).code).toBe('MP_CLAIM_CONFLICT');
    const s = await claim({ templateId: other.id, memberId, claimId: 'mpc_2026-11-04_0001' });
    expect(s.replayed).toBe(false);
    expect((await issuesOf(memberId)).map((i) => i.dedupeKey)).toEqual(['mp_claim:101', 'mp_claim:mpc_2026-11-04_0001']);
    // 编号格式不对的拒绝（不进去重键）
    expect((await errorOf(claim({ templateId: other.id, memberId, claimId: 'a b' }))).status).toBe(400);
  });

  it('两个事务同时发同一个领取记录：只出一张，后到的返回第一次那张', async () => {
    const t = await template({ name: '并发领券', kind: 'cash', faceValue: 500 });
    const [a, b] = await Promise.all([claim({ templateId: t.id, memberId, claimId: 'race-1' }), claim({ templateId: t.id, memberId, claimId: 'race-1' })]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.issueId).toBe(b.issueId);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM coupons WHERE template_id = ${t.id}`;
    expect(n!.n).toBe(1);
  });

  it('拒绝：模板停用、固定有效期已过、档级不够、会员停用或已合并；调用方的事务回滚，什么都不留', async () => {
    const before = (await couponsOf(memberId)).coupons.length;
    const off = await template({ name: '停用的券', kind: 'cash', faceValue: 500, active: false });
    expect((await errorOf(claim({ templateId: off.id, memberId, claimId: 201 }))).code).toBe('TEMPLATE_INACTIVE');
    const expired = await template({ name: '过期的券', kind: 'cash', faceValue: 500, validity: 'fixed', validFrom: '2026-01-01', validTo: '2026-01-31' });
    expect((await errorOf(claim({ templateId: expired.id, memberId, claimId: 202 }))).code).toBe('TEMPLATE_EXPIRED');
    const vip = await template({ name: '只给 L3 起', kind: 'cash', faceValue: 500, levels: [3, 4, 5, 6] });
    const level = await errorOf(claim({ templateId: vip.id, memberId, claimId: 203 }));
    expect(level.code).toBe('COUPON_LEVEL');
    expect(level.message).toContain('L0');
    expect((await errorOf(claim({ templateId: 999_999, memberId, claimId: 204 }))).code).toBe('NOT_FOUND');
    expect((await errorOf(claim({ templateId: cash.id, memberId: 999_999, claimId: 205 }))).code).toBe('NOT_FOUND');

    // 调用方在同一个事务里先写了自己的记录，入口拒绝时一起回滚
    await ctx.sql`CREATE TABLE IF NOT EXISTS t_mp_claims (id int PRIMARY KEY)`;
    await errorOf(
      ctx.sql.begin(async (tx) => {
        await tx`INSERT INTO t_mp_claims (id) VALUES (206)`;
        return issueMpClaimCoupon(tx, deps, { templateId: vip.id, memberId, claimId: 206 });
      }),
    );
    expect(await ctx.sql`SELECT 1 FROM t_mp_claims WHERE id = 206`).toHaveLength(0);
    expect(await ctx.sql`SELECT 1 FROM coupon_issues WHERE dedupe_key LIKE 'mp_claim:20%'`).toHaveLength(0);

    const frozen = (await createMember(ctx, '停用的会员', '19977770003')).id;
    await ctx.sql`UPDATE members SET status = 'frozen' WHERE id = ${frozen}`;
    expect((await errorOf(claim({ templateId: cash.id, memberId: frozen, claimId: 207 }))).code).toBe('MEMBER_FROZEN');
    const merged = (await createMember(ctx, '并走的会员', '19977770004')).id;
    await ctx.sql`UPDATE members SET status = 'frozen', merged_into_id = ${memberId} WHERE id = ${merged}`;
    expect((await errorOf(claim({ templateId: cash.id, memberId: merged, claimId: 208 }))).code).toBe('MEMBER_MERGED');
    expect((await couponsOf(memberId)).coupons).toHaveLength(before);
  });

  it('自检照常全过；发券记录的约束：小程序领取只能 1 张、要有会员和去重键', async () => {
    const checks = await consistencyChecks(ctx.sql, ctx.config.timezone);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    const [t] = await ctx.sql<{ id: number }[]>`SELECT id FROM coupon_templates WHERE name = '线上领三十'`;
    const [staff] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'system.mp'`;
    await expect(
      ctx.sql`INSERT INTO coupon_issues (issue_no, kind, template_id, member_id, quantity, dedupe_key, issued_by, issued_at, business_date)
              VALUES ('FQ-BAD-1', 'mp_claim', ${t!.id}, ${memberId}, 2, 'mp_claim:bad', ${staff!.id}, now(), current_date)`,
    ).rejects.toThrow(/coupon_issues_mp_claim_check/);
    await expect(
      ctx.sql`INSERT INTO coupon_issues (issue_no, kind, template_id, member_id, quantity, dedupe_key, issued_by, issued_at, business_date)
              VALUES ('FQ-BAD-2', 'mp_claim', ${t!.id}, ${memberId}, 1, 'other:bad', ${staff!.id}, now(), current_date)`,
    ).rejects.toThrow(/coupon_issues_mp_claim_check/);
  });
});
