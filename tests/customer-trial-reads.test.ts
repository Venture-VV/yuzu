// Synthetic fixtures in a dedicated test database; never run against local trial/demo data.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from "./helpers";
import { createStaff } from "../src/server/modules/staff";
import { recharge } from "../src/server/modules/wallet";
import { createMemberRefund, memberRefundPlan } from "../src/server/modules/member-refunds";
import { nativeMemberSummary } from "../src/server/modules/concierge/native-links";
import type { Actor } from "../src/server/lib/context";
let ctx: TestContext, sellerId: number, sellerCookie: string, visitMemberId: number, openVisitId: number;
const selected = "2026-11-12", month = "2026-11", tz = "Asia/Shanghai";
const get = (url: string, cookie?: string) => api(ctx.app, cookie ?? ctx.owner, "GET", "/api/customer/" + url);
const actor = (): Actor => ({ id: ctx.ownerId, username: "owner", displayName: "测试店主", role: "owner", duties: [], mustChangePassword: false });
const post = async (url: string, body: Record<string, unknown>) => {
  const r = await api(ctx.app, ctx.owner, "POST", "/api/customer/" + url, { requestKey: randomUUID(), ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
beforeAll(async () => {
  ctx = await setup();
  sellerId = await createStaff(ctx.sql, { username: "read_trial_seller", displayName: "合成试跑经理", role: "account_manager", password: PASSWORD, mustChangePassword: false });
  sellerCookie = await login(ctx.app, "read_trial_seller");
  visitMemberId = (await createMember(ctx, "合成手牌会员", "19900008901")).id;
  const values = [99999, 100000, 299999, 300000, 499999, 500000, 1000000];
  for (let i = 0; i < values.length + 2; i++) {
    const status = i < values.length ? "open" : i === values.length ? "settled" : "cancelled";
    const amount = values[i] ?? 0, suffix = String(i + 1).padStart(3, "0"), closed = status === "open" ? null : `${selected}T10:00:00+08:00`;
    const [tag] = await ctx.sql`INSERT INTO hand_tags(code,zone,is_synthetic) VALUES(${"CT" + suffix},'male',true) RETURNING id`;
    const [bill] = await ctx.sql`INSERT INTO bills(bill_no,kind,status,amount_cents,line_count,business_date,closed_at)
      VALUES(${"CB" + suffix},'visit',${status},${amount},${amount ? 1 : 0},'2026-11-10',${closed}) RETURNING id`;
    const [visit] = await ctx.sql`INSERT INTO visits(visit_no,bill_id,tag_id,zone,member_id,status,business_date,checked_in_at,checked_in_by,checkin_key,closed_at)
      VALUES(${"CV" + suffix},${bill!.id},${tag!.id},'male',${i === 0 ? visitMemberId : null},${status},'2026-11-10','2026-11-10T10:00:00+08:00',${ctx.ownerId},${randomUUID()}::uuid,${closed}) RETURNING id`;
    if (i === 0) openVisitId = Number(visit!.id);
    if (amount) await ctx.sql`INSERT INTO bill_lines(bill_id,source,name,unit_price,quantity,amount,post_key,business_date,posted_by)
      VALUES(${bill!.id},'other','合成有效明细',${amount},1,${amount},${randomUUID()}::uuid,'2026-11-10',${ctx.ownerId})`;
    if (i === 0) {
      const [returned] = await ctx.sql`INSERT INTO bill_lines(bill_id,source,name,unit_price,quantity,amount,post_key,business_date,posted_by)
        VALUES(${bill!.id},'dining','合成已退菜',9000000,1,9000000,${randomUUID()}::uuid,'2026-11-10',${ctx.ownerId}) RETURNING id`;
      await ctx.sql`UPDATE bill_lines SET status='voided',void_reason='合成退菜',voided_by=${ctx.ownerId},voided_at=now() WHERE id=${returned!.id}`;
    }
  }
}, 60000);
afterAll(async () => ctx?.close());

it("includes cross-day current guests and selected-day departures, with native counts unaffected by filters or pagination", async () => {
  const board = await api(ctx.app, ctx.owner, "GET", "/api/frontdesk/board"), all = await get(`visits?day=${selected}`);
  expect(all.status, JSON.stringify(all.body)).toBe(200);
  expect(all.body.filteredTotal).toBe(9);
  expect(all.body.totals.inStoreCount).toBe(board.body.stats.inStore);
  expect(all.body.totals.amountCents).toBe(board.body.stats.unsettledCents);
  expect(all.body.totals.filteredInStoreCount).toBe(7);
  expect((await get(`visits?day=${selected}&status=left`)).body.filteredTotal).toBe(2);
  expect((await get("visits?day=1900-01-01&status=open")).body.filteredTotal).toBe(7);
  for (const query of ["q=NO-MATCH", "offset=50", "status=left"]) {
    const r = await get(`visits?day=${selected}&${query}`);
    expect(r.body.totals.inStoreCount).toBe(7);
    expect(r.body.totals.amountCents).toBe(all.body.totals.amountCents);
  }
  const expected: Record<string, number[]> = { lt1k: [99999], "1k-3k": [100000, 299999], "3k-5k": [300000, 499999], "5k-10k": [500000], gte10k: [1000000] };
  for (const [amountBand, amounts] of Object.entries(expected)) {
    const r = await get(`visits?day=${selected}&status=open&amountBand=${amountBand}`);
    expect(r.body.rows.map((x: any) => x.amountCents).sort((a: number, b: number) => a - b)).toEqual(amounts);
  }
  expect((await get("visits?amountBand=bogus")).status).toBe(400);
  const detail = await get(`visits/${openVisitId}`), native = await nativeMemberSummary(ctx.sql, visitMemberId, tz);
  expect(detail.body.visit.amountCents).toBe(99999); // not the sum including the returned dish
  expect(detail.body.visit.member).toMatchObject({ memberNo: native!.memberNo, gradeLabel: native!.gradeLabel, grade: native!.grade, tier: native!.tier });
});

it("uses all native members and the concierge available-bonus basis with a strict 30000-yuan boundary, without read-time writes", async () => {
  const low = (await createMember(ctx, "低余额合成过期赠金", "19900008911")).id,
    equal = (await createMember(ctx, "低余额合成等于门槛", "19900008912")).id,
    available = (await createMember(ctx, "低余额合成可用赠金", "19900008913")).id;
  for (const [id, principal, bonus, expires] of [[low, 2900000, 200000, "2020-01-01T00:00:00Z"], [equal, 3000000, 0, null], [available, 2900000, 100000, null]] as const) {
    await ctx.sql`UPDATE members SET principal_balance=${principal},bonus_balance=${bonus} WHERE id=${id}`;
    if (bonus) await ctx.sql`INSERT INTO bonus_lots(member_id,source,amount,remaining,expires_at) VALUES(${id},'legacy',${bonus},${bonus},${expires})`;
  }
  const snapshot = async () => JSON.stringify({ members: await ctx.sql`SELECT * FROM members ORDER BY id`, lots: await ctx.sql`SELECT * FROM bonus_lots ORDER BY id`, ledger: await ctx.sql`SELECT * FROM ledger_entries ORDER BY id` });
  const before = await snapshot(), r = await get("low-balances?q=低余额合成", sellerCookie), summary = await nativeMemberSummary(ctx.sql, low, tz);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.rows.map((m: any) => m.id)).toEqual([low]);
  expect(r.body.rows[0]).toMatchObject({ memberNo: summary!.memberNo, gradeLabel: summary!.gradeLabel, principalCents: 2900000, bonusCents: 0, totalCents: 2900000 });
  expect(r.body.totals).toEqual({ memberCount: 1, principalCents: 2900000, bonusCents: 0, totalCents: 2900000 });
  expect(r.body.thresholdCents).toBe(3000000);
  const offPage = await get("low-balances?q=低余额合成&offset=50", sellerCookie);
  expect(offPage.body.rows).toEqual([]);
  expect(offPage.body.totals).toEqual(r.body.totals);
  expect((await ctx.sql`SELECT count(*)::int AS count FROM concierge_members WHERE native_member_id=${low}`)[0]!.count).toBe(0);
  expect(await snapshot()).toBe(before);
});

it("cuts MTD and previous-month comparison at the selected business day, preserves signed native refunds, monthly groups, ranking and personal scope", async () => {
  const memberId = (await createMember(ctx, "合成业绩会员", "19900008921")).id;
  const deps = { sql: ctx.sql, config: ctx.config };
  const topup = async (date: string, amount: number) => {
    const out = await recharge(deps, { ...rechargeBody(memberId, amount), paymentMethod: "wechat", paymentConfirmed: true }, { actor: actor(), at: new Date(date + "T10:00:00+08:00") });
    if (out.type !== "recharge") throw Error("unexpected operation");
    const claimed = await post("credits/claim", { rechargeId: out.recharge.id, sellerId, firstKind: "renewal", ownerDepartment: "customer", expectedVersion: 0, reason: "合成原单核定" });
    await post(`credits/${claimed.id}/review`, { expectedVersion: 1, decision: "verify", reason: "合成核定通过" });
    return out.recharge.id;
  };
  await topup("2026-10-10", 10000);
  await topup("2026-10-14", 5000);
  const sourceId = await topup("2026-11-10", 20000);
  const at = new Date(selected + "T10:00:00+08:00"), plan = await memberRefundPlan(deps, memberId, 5000, at);
  const authorization = await api(ctx.app, ctx.owner, "POST", "/api/auth/authorize", { username: "owner", password: PASSWORD, purpose: "member_refund", scope: { memberId, amount: 5000 } });
  expect(authorization.status, JSON.stringify(authorization.body)).toBe(200);
  const refund = await createMemberRefund(deps, memberId, { clientKey: randomUUID(), amount: plan.amount, expectedBonus: plan.bonus,
    lines: plan.lines.map((l) => ({ source: l.source, id: l.id, method: l.method ?? "cash", amount: l.amount, ref: "SYNTHETIC-REFUND" })),
    reason: "合成跨日退储值", grantId: authorization.body.grantId }, { actor: actor(), at });
  await topup("2026-11-14", 30000);
  await post("targets", { month: "2026-10", staffId: sellerId, amountCents: 100000, groupName: "B组", expectedVersion: 0, reason: "合成上月分组" });
  await post("targets", { month, staffId: sellerId, amountCents: 200000, groupName: "A组", expectedVersion: 0, reason: "合成本月分组" });
  const r = await get(`targets?month=${month}&day=${selected}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body).toMatchObject({ asOfDay: selected, departmentVerifiedCreditCents: 15000, departmentTodayCreditCents: -5000, departmentLastMonthSameDayCents: 10000 });
  expect(r.body.rows.find((m: any) => m.manager.id === sellerId)).toMatchObject({ groupName: "A组", rank: 1, verifiedCreditCents: 15000, todayCreditCents: -5000, lastMonthSameDayCents: 10000 });
  expect(r.body.groups).toEqual([{ groupName: "A组", verifiedCreditCents: 15000, todayCreditCents: -5000, lastMonthSameDayCents: 0, targetCents: 200000 }, { groupName: "B组", verifiedCreditCents: 0, todayCreditCents: 0, lastMonthSameDayCents: 10000, targetCents: null }]);
  expect(r.body.ratings.individual.S).toBe(50000000);
  expect(r.body.daily.at(-1).day).toBe(selected);
  expect((await get(`targets?month=2026-10&day=${selected}`)).status).toBe(400);
  const events = await get(`performance?day=${selected}&period=month&scope=group&groupName=${encodeURIComponent("A组")}`);
  expect(events.status, JSON.stringify(events.body)).toBe(200);
  expect(events.body.totals).toEqual({ rechargeCents: 20000, refundCents: 5000, netCents: 15000 });
  expect(events.body.rows.find((e: any) => e.eventType === "refund")).toMatchObject({ amountCents: -5000, rechargeId: sourceId, refundId: refund.refund.id });
  const offPage = await get(`performance?day=${selected}&period=month&scope=group&groupName=${encodeURIComponent("A组")}&offset=50`);
  expect(offPage.body.rows).toEqual([]);
  expect(offPage.body.totals).toEqual(events.body.totals);
  expect((await get(`performance?day=${selected}&scope=department`, sellerCookie)).status).toBe(403);
  expect((await get(`performance?day=${selected}&scope=group&groupName=${encodeURIComponent("A组")}`, sellerCookie)).status).toBe(403);
  const own = await get(`performance?day=${selected}&scope=staff`, sellerCookie);
  expect(own.body.totals.netCents).toBe(15000);
  expect(own.body.rows.every((e: any) => e.manager.id === sellerId)).toBe(true);
  const previous = await get(`performance?day=${selected}&period=lastMonthSame&scope=group&groupName=${encodeURIComponent("B组")}`);
  expect(previous.body.totals.netCents).toBe(10000);
  const overview = await get(`overview?day=${selected}`);
  expect(overview.body.metrics.monthVerifiedCreditCents).toBe(15000);
  const clamp = await get("performance?day=2024-03-31&period=lastMonthSame");
  expect(clamp.body).toMatchObject({ from: "2024-02-01", to: "2024-02-29" });
}, 60000);
