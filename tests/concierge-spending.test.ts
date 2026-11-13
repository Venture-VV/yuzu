import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import {
  api,
  createMember,
  consumeBody,
  rechargeBody,
  setup,
  login,
  PASSWORD,
  type TestContext,
} from "./helpers";
import { createStaff } from "../src/server/modules/staff";
import type { NativeSpendingPage } from "../src/shared/concierge/types";
let ctx: TestContext, butler: string;
const get = (id: string, offset = 0, cookie = butler) =>
  api<NativeSpendingPage>(
    ctx.app,
    cookie,
    "GET",
    `/api/concierge/members/${id}/spending?offset=${offset}`,
  );
const profile = async (nativeMemberId: number) => {
  const r = await api(ctx.app, butler, "POST", "/api/concierge/workspace", {
    action: "createMember",
    requestId: randomUUID(),
    payload: { nativeMemberId },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id as string;
};
beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, {
    username: "spending_butler",
    displayName: "只读服务管家",
    role: "backoffice",
    duties: ["concierge"],
    password: PASSWORD,
    mustChangePassword: false,
  });
  butler = await login(ctx.app, "spending_butler");
});
afterAll(async () => ctx?.close());
it("reads actual standalone items and wallet split, detects reversal, never writes on GET and never exposes unrelated members", async () => {
  const a = await createMember(ctx, "扣费会员", "19900007101"),
    b = await createMember(ctx, "无关会员", "19900007102");
  const id = await profile(a.id),
    other = await profile(b.id);
  expect(
    (
      await api(
        ctx.app,
        ctx.owner,
        "POST",
        "/api/recharges",
        rechargeBody(a.id, 500000),
      )
    ).status,
  ).toBe(200);
  const spend = await api(
    ctx.app,
    ctx.owner,
    "POST",
    "/api/consumptions",
    consumeBody(a.id, 21600, {
      customLines: [
        { name: "合成足疗", amount: 16800 },
        { name: "合成简餐", amount: 4800 },
      ],
    }),
  );
  expect(spend.status, JSON.stringify(spend.body)).toBe(200);
  const snapshot = async () =>
    JSON.stringify({
      members: await ctx.sql`SELECT * FROM members ORDER BY id`,
      ledger: await ctx.sql`SELECT * FROM ledger_entries ORDER BY id`,
      concierge: await ctx.sql`SELECT * FROM concierge_records ORDER BY id`,
    });
  const before = await snapshot();
  const r = await get(id);
  expect(r.status).toBe(200);
  expect(r.body.records).toHaveLength(1);
  expect(r.body.records[0]).toMatchObject({
    id: spend.body.consumption.id,
    totalCents: 21600,
    principalCents: 21600,
    bonusCents: 0,
    status: "completed",
    checkout: null,
    payer: { id: a.id },
    items: [
      {
        name: "合成足疗",
        quantity: 1,
        unitPriceCents: 16800,
        amountCents: 16800,
      },
      { name: "合成简餐", quantity: 1, amountCents: 4800 },
    ],
  });
  expect(await snapshot()).toBe(before);
  expect((await get(other)).body.records).toEqual([]);
  expect((await get(id, 0, ctx.clerk)).status).toBe(403);
  expect(
    (
      await api(
        ctx.app,
        butler,
        "GET",
        `/api/consumptions/${spend.body.consumption.id}`,
      )
    ).status,
  ).toBe(403);
  const reverse = await api(
    ctx.app,
    ctx.owner,
    "POST",
    `/api/consumptions/${spend.body.consumption.id}/reverse`,
    { idempotencyKey: randomUUID(), reason: "合成撤销验收" },
  );
  expect(reverse.status, JSON.stringify(reverse.body)).toBe(200);
  expect((await get(id)).body.records[0]).toMatchObject({
    status: "reversed",
    reversal: { reason: "合成撤销验收" },
  });
});
it("frozen checkout snapshots distinguish the whole bill from each real wallet payer; merge reads all original payers once", async () => {
  const a = await createMember(ctx, "甲付款人", "19900007103"),
    b = await createMember(ctx, "乙付款人", "19900007104"),
    c = await createMember(ctx, "不扣卡会员", "19900007105");
  const id = await profile(a.id),
    bid = await profile(b.id),
    cid = await profile(c.id);
  for (const m of [a, b])
    expect(
      (
        await api(
          ctx.app,
          ctx.owner,
          "POST",
          "/api/recharges",
          rechargeBody(m.id, 100000),
        )
      ).status,
    ).toBe(200);
  expect(
    (
      await api(ctx.app, ctx.owner, "POST", "/api/frontdesk/tags/batch", {
        prefix: "T",
        from: 1,
        to: 3,
        width: 3,
        zone: "male",
      })
    ).status,
  ).toBe(200);
  const enter = await api(
    ctx.app,
    ctx.owner,
    "POST",
    "/api/frontdesk/checkins",
    {
      clientKey: randomUUID(),
      guests: [
        { tagCode: "T001", zone: "male", memberId: a.id },
        { tagCode: "T002", zone: "male", memberId: b.id },
      ],
    },
  );
  expect(enter.status, JSON.stringify(enter.body)).toBe(201);
  const ids = enter.body.visits.map((v: any) => v.id),
    preview = (
      await api(
        ctx.app,
        ctx.owner,
        "GET",
        `/api/frontdesk/checkout-preview?ids=${ids.join(",")}`,
      )
    ).body;
  const checkout = await api(
    ctx.app,
    ctx.owner,
    "POST",
    "/api/frontdesk/checkouts",
    {
      clientKey: randomUUID(),
      visitIds: ids,
      expectedTotal: preview.totalAmount,
      payments: [
        {
          method: "wallet",
          memberId: a.id,
          amount: 30000,
          expectedSplit: { principal: 30000, bonus: 0 },
        },
        {
          method: "wallet",
          memberId: b.id,
          amount: 15000,
          expectedSplit: { principal: 15000, bonus: 0 },
        },
        { method: "cash", amount: preview.totalAmount - 45000 },
      ],
    },
  );
  expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
  const record = (await get(id)).body.records[0]!;
  expect(record).toMatchObject({
    totalCents: 30000,
    checkout: { id: checkout.body.id, totalCents: preview.totalAmount },
  });
  expect(record.items.length).toBeGreaterThan(0);
  expect(record.items.every((i) => i.unitPriceCents === null)).toBe(true);
  expect(record.items.reduce((sum, i) => sum + i.amountCents, 0)).toBe(
    preview.totalAmount,
  );
  expect((await get(cid)).body.records).toHaveLength(0);
  const v = await api(
    ctx.app,
    ctx.owner,
    "POST",
    `/api/frontdesk/checkouts/${checkout.body.id}/void`,
    { clientKey: randomUUID(), reason: "反结账验收" },
  );
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  expect(
    (await get(id)).body.records.every(
      (r) => r.status === "reversed" && r.checkout?.status === "voided",
    ),
  ).toBe(true);
  // A same-day completed debit cannot be merged by native rules. Void it,
  // close the reopened visits using cash, then merge the reversed history.
  const again=(await api(ctx.app,ctx.owner,'GET',`/api/frontdesk/checkout-preview?ids=${ids.join(',')}`)).body;
  const release=await api(ctx.app,ctx.owner,'POST','/api/frontdesk/checkouts',{clientKey:randomUUID(),visitIds:ids,expectedTotal:again.totalAmount,payments:[{method:'cash',amount:again.totalAmount}]});
  expect(release.status,JSON.stringify(release.body)).toBe(200);
  const check = (
    await api(
      ctx.app,
      ctx.owner,
      "GET",
      `/api/members/${a.id}/merge-check?targetId=${b.id}`,
    )
  ).body;
  expect(
    (
      await api(ctx.app, ctx.owner, "POST", `/api/members/${a.id}/merge`, {
        clientKey: randomUUID(),
        targetId: b.id,
        reason: "同一付款人重复档案",
        expectedPrincipal: check.principal,
        expectedBonus: check.bonus,
      })
    ).status,
  ).toBe(200);
  const merged = (await get(id)).body.records;
  expect(merged).toHaveLength(2);
  expect(merged.reduce((sum, r) => sum + r.totalCents, 0)).toBe(45000);
  expect(new Set(merged.map((r) => r.payer.id))).toEqual(new Set([a.id, b.id]));
  expect((await get(bid)).body.records.map((r) => r.id)).toEqual(
    merged.map((r) => r.id),
  );

});
it("paginates without duplicate IDs and rejects malformed access", async () => {
  const m = await createMember(ctx, "分页会员", "19900007106");
  const id = await profile(m.id);
  expect(
    (
      await api(
        ctx.app,
        ctx.owner,
        "POST",
        "/api/recharges",
        rechargeBody(m.id, 500000),
      )
    ).status,
  ).toBe(200);
  for (let i = 0; i < 51; i++)
    expect(
      (
        await api(
          ctx.app,
          ctx.owner,
          "POST",
          "/api/consumptions",
          consumeBody(m.id, 100),
        )
      ).status,
    ).toBe(200);
  const a = (await get(id)).body,
    b = (await get(id, 50)).body;
  expect(a.records).toHaveLength(50);
  expect(a.hasMore).toBe(true);
  expect(b.records).toHaveLength(1);
  expect(b.hasMore).toBe(false);
  expect(new Set([...a.records, ...b.records].map((r) => r.id)).size).toBe(51);
  expect((await get(id, -1)).status).toBe(400);
  expect((await get("not-a-uuid")).status).toBe(404);
  expect((await get(randomUUID())).status).toBe(404);
});
