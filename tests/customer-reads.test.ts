// Synthetic fixtures only, in this test run's isolated database/template workers.
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import {
  api,
  createMember,
  setup,
  login,
  PASSWORD,
  rechargeBody,
  consumeBody,
  type TestContext,
} from "./helpers";
import { createStaff } from "../src/server/modules/staff";
import { readSnapshot } from "../src/server/db";
import type { Actor } from "../src/server/lib/context";
import { reverse } from "../src/server/modules/wallet";
import {
  customerOverview,
  customerRecharges,
  customerSettlements,
  customerTargets,
  customerMember,
} from "../src/server/modules/customer/reads";
import type {
  CustomerOverview,
  CustomerRechargePage,
  CustomerSettlementPage,
} from "../src/shared/customer";
let ctx: TestContext,
  aCookie: string,
  bCookie: string,
  aId: number,
  bId: number,
  memberA: number,
  memberB: number,
  chargeA: number,
  chargeB: number,
  unknownCharge: number,
  pendingCharge: number,
  consumptionId: number,
  checkoutId: number,
  visitId: number;
let day: string, month: string;
const tz = "Asia/Shanghai";
const ownerActor = (): Actor => ({
  id: ctx.ownerId,
  username: "owner",
  displayName: "测试店主",
  role: "owner",
  duties: [],
  mustChangePassword: false,
});
const get = (url: string, cookie = ctx.owner) =>
  api(ctx.app, cookie, "GET", "/api/customer/" + url);
const post = async (
  path: string,
  body: Record<string, unknown>,
  cookie = ctx.owner,
) => {
  const r = await api(ctx.app, cookie, "POST", "/api/customer/" + path, {
    requestKey: randomUUID(),
    ...body,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
async function credit(
  rechargeId: number,
  sellerId: number,
  cookie: string,
  verified: boolean,
) {
  const r = await post(
    "credits/claim",
    {
      rechargeId,
      sellerId,
      firstKind: "first",
      ownerDepartment: "customer",
      expectedVersion: 0,
      reason: "合成原单归属核验",
    },
    cookie,
  );
  if (verified)
    await post(`credits/${r.id}/review`, {
      expectedVersion: 1,
      decision: "verify",
      reason: "合成核验通过",
    });
  return r.id;
}
beforeAll(async () => {
  ctx = await setup();
  aId = await createStaff(ctx.sql, {
    username: "customer_a",
    displayName: "合成客户经理甲",
    role: "account_manager",
    password: PASSWORD,
    mustChangePassword: false,
  });
  bId = await createStaff(ctx.sql, {
    username: "customer_b",
    displayName: "合成客户经理乙",
    role: "account_manager",
    password: PASSWORD,
    mustChangePassword: false,
  });
  aCookie = await login(ctx.app, "customer_a");
  bCookie = await login(ctx.app, "customer_b");
  memberA = (await createMember(ctx, "合成客户甲", "19900008101")).id;
  memberB = (await createMember(ctx, "合成客户乙", "19900008102")).id;
  const recharge = async (memberId: number, paid: number) => {
    const r = await api(
      ctx.app,
      ctx.owner,
      "POST",
      "/api/recharges",
      rechargeBody(memberId, paid),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.recharge.id as number;
  };
  chargeA = await recharge(memberA, 100000);
  chargeB = await recharge(memberB, 100000);
  unknownCharge = await recharge(memberA, 10000);
  pendingCharge = await recharge(memberA, 10000);
  await credit(chargeA, aId, aCookie, true);
  await credit(chargeB, bId, bCookie, true);
  await credit(pendingCharge, aId, aCookie, false);
  for (let i = 0; i < 51; i++) await recharge(memberA, 100);
  const ds = await api(
    ctx.app,
    ctx.owner,
    "POST",
    "/api/consumptions",
    consumeBody(memberA, 1234),
  );
  expect(ds.status, JSON.stringify(ds.body)).toBe(200);
  consumptionId = ds.body.consumption.id;
  expect(
    (
      await api(ctx.app, ctx.owner, "POST", "/api/frontdesk/tags/batch", {
        prefix: "C",
        from: 1,
        to: 1,
        width: 3,
        zone: "male",
      })
    ).status,
  ).toBe(200);
  const entry = await api(
    ctx.app,
    ctx.owner,
    "POST",
    "/api/frontdesk/checkins",
    {
      clientKey: randomUUID(),
      guests: [{ tagCode: "C001", zone: "male", memberId: memberA }],
    },
  );
  expect(entry.status, JSON.stringify(entry.body)).toBe(201);
  visitId = entry.body.visits[0].id;
  const preview = (
    await api(
      ctx.app,
      ctx.owner,
      "GET",
      `/api/frontdesk/checkout-preview?ids=${visitId}`,
    )
  ).body;
  const close = await api(
    ctx.app,
    ctx.owner,
    "POST",
    "/api/frontdesk/checkouts",
    {
      clientKey: randomUUID(),
      visitIds: [visitId],
      expectedTotal: preview.totalAmount,
      payments: [
        {
          method: "wallet",
          memberId: memberA,
          amount: 10000,
          expectedSplit: { principal: 10000, bonus: 0 },
        },
        { method: "cash", amount: preview.totalAmount - 10000 },
      ],
    },
  );
  expect(close.status, JSON.stringify(close.body)).toBe(200);
  checkoutId = close.body.id;
  const overview = await get("overview");
  expect(overview.status, JSON.stringify(overview.body)).toBe(200);
  day = overview.body.businessDate;
  month = day.slice(0, 7);
}, 60000);
afterAll(async () => ctx?.close());

it("keeps confirmed seller distinct from cashier, hides the unclaimed pool and enforces personal scope", async () => {
  const a = await get(`recharges?day=${day}`, aCookie);
  expect(a.status).toBe(200);
  expect(a.body.rows.map((r: any) => r.id).sort()).toEqual(
    [chargeA, pendingCharge].sort(),
  );
  const r = a.body.rows.find((r: any) => r.id === chargeA);
  expect(r.operator.id).toBe(ctx.ownerId);
  expect(r.credit.verifiedSeller.id).toBe(aId);
  expect(r.credit.ownerAtTrade).toBeNull();
  expect((await get(`recharges?managerId=${bId}`, aCookie)).status).toBe(403);
  expect((await get(`recharges/${chargeB}`, aCookie)).status).toBe(404);
  expect((await get(`recharges/${unknownCharge}`, aCookie)).status).toBe(404);
  expect(
    (await get("recharges?status=unclaimed", aCookie)).body.filteredTotal,
  ).toBe(0);
  expect((await get("overview", ctx.clerk)).status).toBe(403);
  expect(
    (await api(ctx.app, null, "GET", "/api/customer/overview")).status,
  ).toBe(401);
  const d = await get(`recharges/${chargeA}`, aCookie);
  expect(d.body.recharge.credit.verifiedSeller.id).toBe(aId);
});
it("paginates fifty rows while totals include the complete filtered population and rejects malformed parameters", async () => {
  const first = await get(`recharges?day=${day}&status=unclaimed`),
    last = await get(`recharges?day=${day}&status=unclaimed&offset=50`);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.filteredTotal).toBe(52);
  expect(first.body.rows).toHaveLength(50);
  expect(last.body.rows).toHaveLength(2);
  expect(first.body.totals.paidCents).toBe(15100);
  expect(last.body.totals).toEqual(first.body.totals);
  expect(first.body.hasMore).toBe(true);
  expect(last.body.hasMore).toBe(false);
  expect(
    new Set([...first.body.rows, ...last.body.rows].map((r: any) => r.id)).size,
  ).toBe(52);
  for (const q of [
    "day=2026-02-30",
    "offset=-1",
    "hour=24",
    "status=bogus",
    "day=2026-11-13&from=2026-11-01",
    "from=2026-11-14&to=2026-11-13",
  ])
    expect((await get("recharges?" + q)).status).toBe(400);
});
it("combines standalone wallet consumption once with checkout snapshots and preserves real payer splits", async () => {
  const r = await get(`settlements?day=${day}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.rows.map((x: any) => x.sourceKind).sort()).toEqual([
    "checkout",
    "consumption",
  ]);
  const direct = r.body.rows.find((x: any) => x.sourceKind === "consumption");
  expect(direct).toMatchObject({
    id: consumptionId,
    amountCents: 1234,
    principalCents: 1234,
    bonusCents: 0,
    cashReceivedCents: 0,
  });
  const c = await get(`settlements/${checkoutId}`);
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  expect(c.body.detail.lines.length).toBeGreaterThan(0);
  expect(c.body.payments.find((p: any) => p.method === "wallet")).toMatchObject(
    {
      payer: { id: memberA },
      discountMember: null,
      principalCents: 10000,
      bonusCents: 0,
    },
  );
  const d = await get(`settlements/${consumptionId}?source=consumption`);
  expect(d.body.detail).toBeNull();
  expect(d.body.consumption.id).toBe(consumptionId);
  const overview = await get("overview");
  expect(overview.body.metrics.standaloneWalletNetCents).toBe(1234);
  expect(overview.body.metrics.settlementNetCents).toBe(r.body.totals.netCents);
  expect(
    overview.body.payments.reduce(
      (s: number, p: any) => s + p.rechargeCents,
      0,
    ),
  ).toBe(225100);
  expect(overview.body.metrics.verifiedCreditCents).toBe(200000);
  expect(
    (await get("overview", aCookie)).body.metrics.verifiedCreditCents,
  ).toBe(100000);
});
it("reflects native standalone reversals on their actual business date without pretending they were checkout or visits", async () => {
  const tomorrow = new Date(day + "T12:00:00+08:00");
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  await reverse(
    { sql: ctx.sql, config: ctx.config },
    consumptionId,
    { idempotencyKey: randomUUID(), reason: "合成跨日冲回" },
    { actor: ownerActor(), at: tomorrow },
  );
  const nextDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(tomorrow);
  const today = await get(`overview?day=${day}`),
    next = await get(`overview?day=${nextDay}`);
  expect(today.body.metrics.standaloneWalletNetCents).toBe(1234);
  expect(next.body.metrics.standaloneWalletNetCents).toBe(-1234);
  expect(next.body.metrics.settlementCount).toBe(0);
  expect(next.body.metrics.visitCount).toBe(0);
  expect(
    next.body.hourly.find((h: any) => h.hour === 12).settlementNetCents,
  ).toBe(-1234);
  const noon = await get(`settlements?day=${nextDay}&hour=12`);
  expect(noon.body.rows).toHaveLength(1);
  expect(noon.body.totals.netCents).toBe(-1234);
  expect(
    (await get(`settlements?day=${nextDay}&hour=13`)).body.filteredTotal,
  ).toBe(0);
  expect((await get(`settlements?day=${nextDay}`)).body.rows[0]).toMatchObject({
    sourceKind: "consumption",
    id: consumptionId,
    netCents: -1234,
    status: "reversed",
  });
});
it("uses real targets only, protects personal targets and retains versions while shared department totals remain complete", async () => {
  const empty = await get(`targets?month=${month}`, aCookie);
  expect(empty.status, JSON.stringify(empty.body)).toBe(200);
  expect(empty.body.departmentTargetCents).toBeNull();
  expect(empty.body.rows[0].targetCents).toBeNull();
  expect(empty.body.rows[0].progress).toBeNull();
  await post("targets", {
    month,
    staffId: null,
    amountCents: 300000,
    expectedVersion: 0,
    reason: "合成部门目标",
  });
  await post("targets", {
    month,
    staffId: aId,
    amountCents: 120000,
    expectedVersion: 0,
    reason: "合成个人目标",
  });
  const r = await get(`targets?month=${month}`, aCookie);
  expect(r.body.rows.map((x: any) => x.manager.id)).toEqual([aId]);
  expect(r.body.departmentVerifiedCreditCents).toBe(200000);
  expect(r.body.departmentTargetCents).toBe(300000);
  expect(r.body.assignedTargetCents).toBe(120000);
  expect(r.body.allocationDifferenceCents).toBe(180000);
  expect(r.body.rows[0]).toMatchObject({
    targetCents: 120000,
    verifiedCreditCents: 100000,
    version: 1,
  });
  expect(r.body.history.length).toBe(2);
  expect((await get(`targets?managerId=${bId}`, aCookie)).status).toBe(403);
});
it("shares only member and visit projections, paginates the true ledger before filtering and never writes native records on reads", async () => {
  const snapshot = async () =>
    JSON.stringify({
      members: await ctx.sql`SELECT * FROM members ORDER BY id`,
      ledger: await ctx.sql`SELECT * FROM ledger_entries ORDER BY id`,
      lots: await ctx.sql`SELECT * FROM bonus_lots ORDER BY id`,
    });
  const before = await snapshot();
  const list = await get("members?unbound=1", aCookie);
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  expect(list.body.filteredTotal).toBe(2);
  const d = await get(
    `members/${memberA}?timelineMonth=${month}&timelineSection=recharge`,
    aCookie,
  );
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  expect(d.body.timeline).toHaveLength(50);
  expect(d.body.timelineHasMore).toBe(true);
  expect(d.body.timeline.every((x: any) => x.type === "recharge")).toBe(true);
  const next = await get(
    `members/${memberA}?timelineMonth=${month}&timelineSection=recharge&timelineOffset=50`,
    aCookie,
  );
  expect(next.body.timeline).toHaveLength(4);
  expect(next.body.timelineHasMore).toBe(false);
  expect(d.body.timeline.every((e: any) => e.rechargeId === null)).toBe(true);
  expect(
    next.body.timeline
      .filter((e: any) => e.rechargeId !== null)
      .map((e: any) => e.rechargeId)
      .sort(),
  ).toEqual([chargeA, pendingCharge].sort());
  const visit = await get(`visits/${visitId}`, aCookie);
  expect(visit.status).toBe(200);
  expect(visit.body.visit.member.id).toBe(memberA);
  expect(visit.body.lines.length).toBeGreaterThan(0);
  expect((await get("visits?day=1900-01-01", aCookie)).body.filteredTotal).toBe(
    0,
  );
  expect(
    (await api(ctx.app, aCookie, "GET", `/api/frontdesk/visits/${visitId}`))
      .status,
  ).toBe(403);
  expect(await snapshot()).toBe(before);
});

it("lets managers discover binding requests and shares actual service notes without giving staff the review pool", async () => {
  const request = await post(
    "bindings/requests",
    {
      memberId: memberA,
      toStaffId: aId,
      expectedVersion: 0,
      reason: "合成维护申请",
    },
    aCookie,
  );
  expect((await get("bindings?status=pending", aCookie)).status).toBe(403);
  const queue = await get("bindings?status=pending");
  expect(queue.status, JSON.stringify(queue.body)).toBe(200);
  expect(queue.body.filteredTotal).toBe(1);
  expect(queue.body.rows[0]).toMatchObject({
    id: request.id,
    member: { id: memberA },
    manager: { id: aId },
    version: 1,
    status: "pending",
  });
  await post(`bindings/requests/${request.id}/review`, {
    expectedVersion: 1,
    decision: "approve",
    reason: "合成批准",
  });
  const recorded = await post(
    "notes",
    {
      memberId: memberA,
      visitId,
      kind: "reception",
      occurredAt: new Date().toISOString(),
      outcome: "接待已完成",
      content: "合成接待服务记录",
      feedback: "明确演示",
      nextContactOn: null,
    },
    aCookie,
  );
  const v = await get(`visits/${visitId}`, bCookie);
  expect(v.body.notes[0]).toMatchObject({
    id: recorded.id,
    kind: "reception",
    content: "合成接待服务记录",
    author: { id: aId },
  });
  const m = await get(`members/${memberA}`, bCookie);
  expect(m.body.member.binding.maintainer.id).toBe(aId);
  expect(m.body.bindingRequests[0]).toMatchObject({
    status: "approved",
    version: 2,
  });
  expect((await get("bindings?status=pending")).body.filteredTotal).toBe(0);
});
