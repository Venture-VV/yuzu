// Synthetic fixtures only, in this run's isolated test database.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readSnapshot } from "../src/server/db";
import type { Actor } from "../src/server/lib/context";
import { loadInsightMembersByIds } from "../src/server/modules/concierge/insights";
import { createMemberRefund, memberRefundPlan } from "../src/server/modules/member-refunds";
import { loadMembershipRules, projectedGrade } from "../src/server/modules/membership";
import { createStaff } from "../src/server/modules/staff";
import { recharge } from "../src/server/modules/wallet";
import { customerLowBalances, customerMembers } from "../src/server/modules/customer/reads";
import { tierTargets } from "../src/shared/membership";
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from "./helpers";

let ctx: TestContext, seller: number, otherSeller: number, sellerCookie: string;
let charge: number, chargeDoc: string, batchIds: number[], mergedSource: number;
let visitSequence = 0;
let arrivalIds: { crossDay: number; earlierOpen: number; earlierClosed: number; todayOpen: number; otherHour: number; cancelled: number; overnight: number; laterOpen: number; bulk: number[] };
const tz = "Asia/Shanghai", day = "2026-11-10", refundDay = "2026-11-12";
const arrivalDay = "2026-09-20", earlierDay = "2026-09-19", laterDay = "2026-09-21";
const at = new Date("2026-11-14T12:00:00+08:00");
const actor = (): Actor => ({ id: ctx.ownerId, username: "owner", displayName: "测试店主", role: "owner", duties: [], mustChangePassword: false });
const get = (query: string, cookie = ctx.owner) => api(ctx.app, cookie, "GET", "/api/customer/" + query);

async function topup(memberId: number, amount: number, sellerId: number, hour = 10, verified = true) {
  const out = await recharge({ sql: ctx.sql, config: ctx.config }, { ...rechargeBody(memberId, amount), paymentMethod: "wechat", paymentConfirmed: true },
    { actor: actor(), at: new Date(`${day}T${String(hour).padStart(2, "0")}:00:00+08:00`) });
  if (out.type !== "recharge") throw new Error("unexpected operation");
  await ctx.sql`INSERT INTO customer_recharge_credits(recharge_id,member_id,canonical_member_id,occurred_at,seller_staff_id,
    first_kind,owner_department,status,reason,claimed_by,reviewed_by,reviewed_at,review_reason)
    VALUES(${out.recharge.id},${memberId},${memberId},${out.recharge.createdAt},${sellerId},'renewal','customer',
      ${verified ? "verified" : "pending"},'合成复审归属',${sellerId},${verified ? ctx.ownerId : null},${verified ? at.toISOString() : null},${verified ? "合成核定" : ""})`;
  return out.recharge;
}
async function refund(memberId: number, amount: number) {
  const deps = { sql: ctx.sql, config: ctx.config }, when = new Date(refundDay + "T12:00:00+08:00");
  const plan = await memberRefundPlan(deps, memberId, amount, when);
  const authorization = await api(ctx.app, ctx.owner, "POST", "/api/auth/authorize", {
    username: "owner", password: PASSWORD, purpose: "member_refund", scope: { memberId, amount },
  });
  expect(authorization.status, JSON.stringify(authorization.body)).toBe(200);
  await createMemberRefund(deps, memberId, {
    clientKey: randomUUID(), amount: plan.amount, expectedBonus: plan.bonus,
    lines: plan.lines.map((l) => ({ source: l.source, id: l.id, method: l.method ?? "cash", amount: l.amount, ref: "SYNTHETIC-REVIEW" })),
    reason: "合成跨日退款", grantId: authorization.body.grantId,
  }, { actor: actor(), at: when });
}
async function consumption(memberId: number, date: string, amount: number, status = "completed") {
  await ctx.sql`INSERT INTO consumptions(doc_no,member_id,total_amount,principal_amount,bonus_amount,deduction_rule,status,business_date,operator_id)
    VALUES(${"REVIEW-" + randomUUID()},${memberId},${amount},${amount},0,'principal_first',${status},${date},${ctx.ownerId})`;
}
async function visit(memberId: number, date: string, status = "settled") {
  const unique = randomUUID(), when = date + "T10:00:00+08:00";
  const [bill] = await ctx.sql`INSERT INTO bills(bill_no,kind,status,business_date,opened_at,closed_at)
    VALUES(${"RB-" + unique},'visit',${status},${date},${when},${when}) RETURNING id`;
  const [tag] = await ctx.sql`INSERT INTO hand_tags(code,zone) VALUES(${"RV" + String(++visitSequence).padStart(3, "0")},'male') RETURNING id`;
  await ctx.sql`INSERT INTO visits(visit_no,bill_id,tag_id,zone,member_id,status,business_date,checked_in_at,checked_in_by,checkin_key,closed_at)
    VALUES(${"RV-" + unique},${bill!.id},${tag!.id},'male',${memberId},${status},${date},${when},${ctx.ownerId},${randomUUID()},${when})`;
}
async function arrivalVisit(options: {
  businessDate: string; checkedAt: string; status: "open" | "settled" | "cancelled";
  closedAt?: string; checkoutDay?: string; memberId?: number; label: string; amount?: number;
}) {
  const unique = randomUUID(), closedAt = options.closedAt ?? null;
  const [bill] = await ctx.sql`INSERT INTO bills(bill_no,kind,status,business_date,opened_at,closed_at,amount_cents)
    VALUES(${"AB-" + unique},'visit',${options.status},${options.businessDate},${options.checkedAt},${closedAt},${options.amount ?? 0}) RETURNING id`;
  const [tag] = await ctx.sql`INSERT INTO hand_tags(code,zone) VALUES(${"RV" + String(++visitSequence).padStart(3, "0")},'male') RETURNING id`;
  const [row] = await ctx.sql`INSERT INTO visits(visit_no,bill_id,tag_id,zone,member_id,guest_label,status,business_date,checked_in_at,checked_in_by,checkin_key,closed_at)
    VALUES(${"AV-" + unique},${bill!.id},${tag!.id},'male',${options.memberId ?? null},${options.label},${options.status},${options.businessDate},
      ${options.checkedAt},${ctx.ownerId},${randomUUID()},${closedAt}) RETURNING id`;
  if (options.checkoutDay) {
    const [checkout] = await ctx.sql`INSERT INTO checkouts(checkout_no,client_key,total_amount,paid_amount,business_date,operator_id,created_at)
      VALUES(${"AC-" + unique},${randomUUID()},0,0,${options.checkoutDay},${ctx.ownerId},${closedAt}) RETURNING id`;
    const [ticket] = await ctx.sql`SELECT id,name FROM ticket_types WHERE is_default LIMIT 1`;
    await ctx.sql`INSERT INTO checkout_bills(checkout_id,bill_id,visit_id,amount,stay_minutes,ticket_type_id,ticket_name,ticket_segments,ticket_amount)
      VALUES(${checkout!.id},${bill!.id},${row!.id},0,60,${ticket!.id},${ticket!.name},1,0)`;
  }
  return Number(row!.id);
}
async function measured<T>(run: () => Promise<T>) {
  const statements: string[] = [], previous = ctx.sql.options.debug;
  ctx.sql.options.debug = (_id, query) => { if (/^\s*(SELECT|WITH)\b/i.test(query)) statements.push(query); };
  try { return { value: await run(), statements }; }
  finally { ctx.sql.options.debug = previous; }
}
const snapshot = async () => JSON.stringify({
  members: await ctx.sql`SELECT * FROM members ORDER BY id`,
  lots: await ctx.sql`SELECT * FROM bonus_lots ORDER BY id`,
  ledger: await ctx.sql`SELECT * FROM ledger_entries ORDER BY id`,
  grades: await ctx.sql`SELECT * FROM member_grade_events ORDER BY id`,
});

beforeAll(async () => {
  ctx = await setup();
  seller = await createStaff(ctx.sql, { username: "review_seller", displayName: "复审经理甲", role: "account_manager", password: PASSWORD, mustChangePassword: false });
  otherSeller = await createStaff(ctx.sql, { username: "review_other", displayName: "复审经理乙", role: "account_manager", password: PASSWORD, mustChangePassword: false });
  sellerCookie = await login(ctx.app, "review_seller");
  const a = (await createMember(ctx, "复审跨日甲", "19900008701")).id,
    b = (await createMember(ctx, "复审跨日乙", "19900008702")).id;
  const original = await topup(a, 20000, seller);
  charge = original.id; chargeDoc = original.docNo;
  await refund(a, 5000);
  await topup(b, 10000, otherSeller);
  await refund(b, 1000);
  await topup(a, 7000, seller, 10, false);
  for (let i = 0; i < 51; i++) await topup(a, 100, seller, 9);

  const rows = await ctx.sql`INSERT INTO members(member_no,name,phone,created_by,grade,tier,cycle_start,cycle_end,principal_balance,bonus_balance)
    SELECT 'REVIEW-'||lpad(i::text,3,'0'),'复审批量'||lpad(i::text,3,'0'),'19900088'||lpad(i::text,3,'0'),${ctx.ownerId},
      1,0,'2020-01-01'::date,'2020-01-30'::date,1000,200
    FROM generate_series(1,52) i RETURNING id`;
  batchIds = rows.map((r) => Number(r.id));
  await ctx.sql`INSERT INTO bonus_lots(member_id,source,amount,remaining,expires_at)
    SELECT id,'legacy',200,200,'2020-01-01'::timestamptz FROM members WHERE id=ANY(${batchIds}::bigint[])`;
  await ctx.sql`UPDATE members SET grade=2,cycle_start='2026-10-01',cycle_end='2026-10-30',grace_until='2026-11-09' WHERE id=${batchIds[0]!}`;
  await ctx.sql`UPDATE members SET grade=2,cycle_start='2026-10-01',cycle_end='2026-10-30' WHERE id=${batchIds[1]!}`;
  await ctx.sql`UPDATE members SET grade=3,cycle_start='2026-08-01',cycle_end='2026-08-30' WHERE id=${batchIds[2]!}`;
  await ctx.sql`UPDATE members SET cycle_start='2026-10-01',cycle_end='2026-10-30' WHERE id=${batchIds[3]!}`;
  await ctx.sql`UPDATE members SET grade=2,cycle_start='2026-10-01',cycle_end='2026-10-30' WHERE id=${batchIds[4]!}`;
  const [source] = await ctx.sql`INSERT INTO members(member_no,name,phone,status,merged_into_id,created_by)
    VALUES('REVIEW-OLD','复审合并旧账号','19900087999','frozen',${batchIds[0]!},${ctx.ownerId}) RETURNING id`;
  mergedSource = Number(source!.id);
  const rules = await loadMembershipRules(ctx.sql);
  await ctx.sql`UPDATE settings SET value=value||${ctx.sql.json({ cycleDays: 30, graceDays: 10 })} WHERE key='membership_rules'`;
  await consumption(mergedSource, "2026-11-05", tierTargets(rules, 2).honor);
  await consumption(batchIds[1]!, "2026-10-10", tierTargets(rules, 2).enjoy);
  await consumption(batchIds[2]!, "2026-08-30", tierTargets(rules, 3).honor);
  await consumption(batchIds[2]!, "2026-09-29", tierTargets(rules, 3).honor);
  await consumption(batchIds[3]!, "2026-10-15", tierTargets(rules, 1).honor, "reversed");
  await consumption(batchIds[4]!, "2026-10-30", tierTargets(rules, 2).honor);
  await consumption(batchIds[4]!, "2026-09-30", tierTargets(rules, 2).honor);
  await consumption(batchIds[4]!, "2099-01-01", tierTargets(rules, 2).honor);
  await visit(batchIds[0]!, "2026-10-25");
  await visit(mergedSource, "2026-11-01");
  await visit(mergedSource, "2026-11-12", "cancelled");
  await visit(mergedSource, "2099-01-01");
  await ctx.sql`INSERT INTO customer_bindings(member_id,maintainer_staff_id,version) VALUES(${batchIds[0]!},${otherSeller},3)`;
  await ctx.sql`UPDATE staff SET active=false WHERE id=${otherSeller}`;
  const arrivalMemberA = (await createMember(ctx, "入场回归会员甲", "19900008711")).id,
    arrivalMemberB = (await createMember(ctx, "入场回归会员乙", "19900008712")).id;
  arrivalIds = {
    crossDay: await arrivalVisit({ businessDate: arrivalDay, checkedAt: arrivalDay + "T14:00:00+08:00", status: "settled", closedAt: laterDay + "T10:00:00+08:00", checkoutDay: laterDay, memberId: arrivalMemberA, label: "入场跨日离店" }),
    earlierOpen: await arrivalVisit({ businessDate: earlierDay, checkedAt: earlierDay + "T14:00:00+08:00", status: "open", label: "入场前日仍在店" }),
    earlierClosed: await arrivalVisit({ businessDate: earlierDay, checkedAt: earlierDay + "T14:00:00+08:00", status: "settled", closedAt: arrivalDay + "T10:00:00+08:00", checkoutDay: arrivalDay, label: "入场前日今日离店" }),
    todayOpen: await arrivalVisit({ businessDate: arrivalDay, checkedAt: arrivalDay + "T14:00:00+08:00", status: "open", memberId: arrivalMemberB, label: "入场今日仍在店", amount: 100000 }),
    otherHour: await arrivalVisit({ businessDate: arrivalDay, checkedAt: arrivalDay + "T15:00:00+08:00", status: "settled", closedAt: arrivalDay + "T18:00:00+08:00", label: "入场另一个小时" }),
    cancelled: await arrivalVisit({ businessDate: arrivalDay, checkedAt: arrivalDay + "T14:00:00+08:00", status: "cancelled", closedAt: arrivalDay + "T16:00:00+08:00", label: "入场撤销误开" }),
    overnight: await arrivalVisit({ businessDate: arrivalDay, checkedAt: laterDay + "T02:00:00+08:00", status: "settled", closedAt: laterDay + "T10:00:00+08:00", label: "入场凌晨营业日" }),
    laterOpen: await arrivalVisit({ businessDate: laterDay, checkedAt: laterDay + "T14:00:00+08:00", status: "open", label: "入场次日仍在店" }),
    bulk: [],
  };
  for (let i = 0; i < 51; i++) arrivalIds.bulk.push(await arrivalVisit({ businessDate: arrivalDay, checkedAt: arrivalDay + "T14:00:00+08:00", status: "settled", closedAt: laterDay + "T10:00:00+08:00", label: "入场回归分页" }));
  await ctx.sql`INSERT INTO customer_bindings(member_id,maintainer_staff_id,version) VALUES(${arrivalMemberA},${seller},1),(${arrivalMemberB},${otherSeller},1)`;
}, 60000);
afterAll(async () => ctx?.close());

it("keeps lifetime row net while dating verified recharge and refund performance to their own business days", async () => {
  const original = await get(`recharges?day=${day}&q=${chargeDoc}`),
    refunded = await get(`recharges?day=${refundDay}&q=${chargeDoc}`),
    range = await get(`recharges?from=${day}&to=${refundDay}&q=${chargeDoc}`);
  expect(original.status, JSON.stringify(original.body)).toBe(200);
  expect(original.body.rows[0]).toMatchObject({ id: charge, paidCents: 20000, refundedCents: 5000, netPaidCents: 15000 });
  expect(original.body.totals.verifiedCreditCents).toBe(20000);
  expect(refunded.body.rows).toEqual([]);
  expect(refunded.body.totals.verifiedCreditCents).toBe(-5000);
  expect(range.body.totals.verifiedCreditCents).toBe(15000);
  for (const selected of [day, refundDay]) {
    const recharges = await get(`recharges?day=${selected}`), overview = await get(`overview?day=${selected}`),
      performance = await get(`performance?day=${selected}&period=today&scope=department`);
    expect(recharges.body.totals.verifiedCreditCents).toBe(overview.body.metrics.verifiedCreditCents);
    expect(recharges.body.totals.verifiedCreditCents).toBe(performance.body.totals.netCents);
  }
});

it("retains signed totals across pagination, manager/personal scope, status, search and event-hour filters", async () => {
  const first = await get(`recharges?day=${day}`), last = await get(`recharges?day=${day}&offset=50`);
  expect(first.body.rows).toHaveLength(50);
  expect(last.body.rows).toHaveLength(4);
  expect(first.body.totals.verifiedCreditCents).toBe(35100);
  expect(last.body.totals).toEqual(first.body.totals);
  expect((await get(`recharges?day=${refundDay}&offset=50`)).body.totals.verifiedCreditCents).toBe(-6000);
  expect((await get(`recharges?from=${day}&to=${refundDay}&managerId=${seller}`)).body.totals.verifiedCreditCents).toBe(20100);
  expect((await get(`recharges?from=${day}&to=${refundDay}`, sellerCookie)).body.totals.verifiedCreditCents).toBe(20100);
  expect((await get(`recharges?day=${refundDay}`, sellerCookie)).body.totals.verifiedCreditCents).toBe(-5000);
  expect((await get(`recharges?day=${refundDay}&managerId=${otherSeller}`, sellerCookie)).status).toBe(403);
  for (const status of ["unclaimed", "pending", "rejected", "voided"])
    expect((await get(`recharges?from=${day}&to=${refundDay}&status=${status}`)).body.totals.verifiedCreditCents).toBe(0);
  expect((await get(`recharges?day=${refundDay}&status=verified`)).body.totals.verifiedCreditCents).toBe(-6000);
  expect((await get(`recharges?day=${refundDay}&q=NO-MATCH`)).body.totals.verifiedCreditCents).toBe(0);
  expect((await get(`recharges?day=${day}&hour=9`)).body.totals.verifiedCreditCents).toBe(5100);
  expect((await get(`recharges?day=${refundDay}&hour=12`)).body.totals.verifiedCreditCents).toBe(-6000);
  expect((await get(`recharges?day=${refundDay}&hour=10`)).body.totals.verifiedCreditCents).toBe(0);
});

it("matches native overdue projection for grace, retention, multiple cycles, reversed consumption and merged family spend without writes", async () => {
  const before = await snapshot();
  await readSnapshot(ctx.sql, async (db) => {
    const projected = await loadInsightMembersByIds(db, tz, [...batchIds, mergedSource], at);
    for (const id of batchIds) {
      const native = await projectedGrade(db, id, "2026-11-14");
      expect(projected.get(id)).toMatchObject({ grade: native!.grade, tier: native!.tier, cycleEnd: native!.cycleEnd, graceUntil: native!.graceUntil });
    }
    expect(batchIds.slice(0, 5).map((id) => projected.get(id)!.grade)).toEqual([2, 1, 2, 0, 2]);
    expect(projected.get(mergedSource)).toEqual(projected.get(batchIds[0]!));
  });
  expect(await snapshot()).toBe(before);
});

it("loads fifty-row member and low-balance pages with constant native/rules/settings queries and preserves projection contents", async () => {
  const before = await snapshot();
  for (const read of [customerMembers, customerLowBalances]) {
    const single = await measured(() => readSnapshot(ctx.sql, (db) => read(db, actor(), tz, { q: "复审批量001" }, at))),
      full = await measured(() => readSnapshot(ctx.sql, (db) => read(db, actor(), tz, { q: "复审批量" }, at))),
      next = await readSnapshot(ctx.sql, (db) => read(db, actor(), tz, { q: "复审批量", offset: 50 }, at));
    expect(single.value.rows).toHaveLength(1);
    expect(full.value.rows).toHaveLength(50);
    expect(next.rows).toHaveLength(2);
    expect(full.value.filteredTotal).toBe(52);
    expect(full.statements).toHaveLength(single.statements.length);
    expect(full.statements.length).toBeLessThanOrEqual(9);
    expect(full.statements.filter((q) => /SELECT value FROM settings WHERE key\s*=/i.test(q))).toHaveLength(1);
    expect(full.statements.filter((q) => /SELECT key, value FROM settings/i.test(q))).toHaveLength(2);
    const all = [...full.value.rows, ...next.rows], first = all.find((r) => r.id === batchIds[0])!;
    expect(first).toMatchObject({ lastVisitAt: "2026-11-01T02:00:00.000Z", principalCents: 1000, bonusCents: 0, totalCents: 1000,
      binding: { memberId: batchIds[0], version: 3, maintainer: { id: otherSeller, active: false } } });
    expect(all.find((r) => r.id === batchIds[1])!.binding).toEqual({ memberId: batchIds[1], maintainer: null, version: 0, updatedAt: null });
    expect(new Set(all.map((r) => r.id)).size).toBe(52);
    const filtered = await readSnapshot(ctx.sql, (db) => read(db, actor(), tz, { q: "复审批量", managerId: otherSeller }, at));
    expect(filtered.rows.map((r) => r.id)).toEqual([batchIds[0]]);
  }
  const empty = await measured(() => readSnapshot(ctx.sql, (db) => customerMembers(db, actor(), tz, { q: "复审批量", offset: 100 }, at)));
  expect(empty.value.rows).toEqual([]);
  expect(empty.statements).toHaveLength(2);
  expect(await snapshot()).toBe(before);
});

it("drills into the overview's original arrival business day while preserving the default current/departing workbench", async () => {
  const overview = await get(`overview?day=${arrivalDay}`),
    arrivals = await get(`visits?day=${arrivalDay}&visitScope=arrivals`),
    firstHour = await get(`visits?day=${arrivalDay}&visitScope=arrivals&hour=14`),
    lastHour = await get(`visits?day=${arrivalDay}&visitScope=arrivals&hour=14&offset=50`);
  expect(arrivals.status, JSON.stringify(arrivals.body)).toBe(200);
  expect(arrivals.body.filteredTotal).toBe(55);
  expect(arrivals.body.filteredTotal).toBe(overview.body.metrics.visitCount);
  expect(firstHour.body.filteredTotal).toBe(53);
  expect(firstHour.body.filteredTotal).toBe(overview.body.hourly.find((r: any) => r.hour === 14).visitCount);
  expect(firstHour.body.rows).toHaveLength(50);
  expect(firstHour.body.hasMore).toBe(true);
  expect(lastHour.body.rows).toHaveLength(3);
  expect(lastHour.body.hasMore).toBe(false);
  const hourlyIds = [...firstHour.body.rows, ...lastHour.body.rows].map((r: any) => r.id);
  expect(new Set(hourlyIds)).toEqual(new Set([arrivalIds.crossDay, arrivalIds.todayOpen, ...arrivalIds.bulk]));
  const overnight = await get(`visits?day=${arrivalDay}&visitScope=arrivals&hour=2`);
  expect(overnight.body.rows.map((r: any) => r.id)).toEqual([arrivalIds.overnight]);
  expect(overnight.body.filteredTotal).toBe(overview.body.hourly.find((r: any) => r.hour === 2).visitCount);

  const workbench = await get(`visits?day=${arrivalDay}&hour=14&q=${encodeURIComponent("入场")}`),
    explicit = await get(`visits?day=${arrivalDay}&hour=14&q=${encodeURIComponent("入场")}&visitScope=workbench`);
  const expected = new Set([arrivalIds.earlierOpen, arrivalIds.earlierClosed, arrivalIds.todayOpen, arrivalIds.cancelled, arrivalIds.laterOpen]);
  expect(new Set(workbench.body.rows.map((r: any) => r.id))).toEqual(expected);
  expect(explicit.body.rows).toEqual(workbench.body.rows);
  expect(workbench.body.totals.inStoreCount).toBe(arrivals.body.totals.inStoreCount);
  expect(workbench.body.totals.amountCents).toBe(arrivals.body.totals.amountCents);
  expect(arrivals.body.totals.filteredInStoreCount).toBe(1);
  expect(firstHour.body.totals).toEqual(lastHour.body.totals);
  const detail = await get(`visits/${arrivalIds.crossDay}`);
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  expect(detail.body.visit.id).toBe(arrivalIds.crossDay);
});

it("keeps arrival scope bounded by dates, filters and existing customer permissions", async () => {
  const prefix = `visits?day=${arrivalDay}&visitScope=arrivals`;
  expect((await get(prefix + `&managerId=${seller}`)).body.rows.map((r: any) => r.id)).toEqual([arrivalIds.crossDay]);
  expect((await get(prefix + `&managerId=${otherSeller}&status=open`)).body.rows.map((r: any) => r.id)).toEqual([arrivalIds.todayOpen]);
  expect((await get(prefix + `&q=${encodeURIComponent("跨日离店")}`)).body.rows.map((r: any) => r.id)).toEqual([arrivalIds.crossDay]);
  expect((await get(prefix + "&q=NO-MATCH")).body.filteredTotal).toBe(0);
  expect((await get(prefix + "&status=cancelled")).body.filteredTotal).toBe(0);
  expect((await get(prefix + "&status=left")).body.filteredTotal).toBe(54);
  expect((await get(prefix + "&amountBand=1k-3k")).body.rows.map((r: any) => r.id)).toEqual([arrivalIds.todayOpen]);
  expect((await get(prefix + "&offset=100")).body).toMatchObject({ rows: [], filteredTotal: 55, hasMore: false });
  const range = await get(`visits?from=${arrivalDay}&to=${laterDay}&visitScope=arrivals`);
  expect(range.body.filteredTotal).toBe(56);
  expect((await get(prefix, sellerCookie)).body.filteredTotal).toBe(55);
  expect((await get(prefix, ctx.clerk)).status).toBe(403);
  expect((await api(ctx.app, null, "GET", "/api/customer/" + prefix)).status).toBe(401);
  for (const query of ["visitScope=bogus", "visitScope=arrivals&day=2026-09-31", "visitScope=arrivals&from=2026-09-21&to=2026-09-20", "visitScope=arrivals&day=2026-09-20&from=2026-09-19", "visitScope=arrivals&hour=24"])
    expect((await get("visits?" + query)).status).toBe(400);
});
