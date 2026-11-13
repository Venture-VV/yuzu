// Synthetic fixtures in the dedicated TEST_DATABASE_URL only. No operational database is used.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSnapshot } from "../src/server/db";
import {
  loadInsightMember,
  loadMemberInsights,
  readInsightCalendar,
} from "../src/server/modules/concierge/insights";
import { createStaff } from "../src/server/modules/staff";
import type { MemberInsights } from "../src/shared/concierge/insights-types";
import {
  api,
  consumeBody,
  login,
  PASSWORD,
  rechargeBody,
  setup,
  type TestContext,
} from "./helpers";

const timezone = "Asia/Shanghai";
const at = new Date("2024-03-31T04:30:00.000Z"); // 12:30 local; month anniversaries retain this time.
let ctx: TestContext;
let butler: string;
let sequence = 0;
let recent: number, one: number, three: number, six: number, twelve: number;
let never: number,
  cancelled: number,
  future: number,
  source: number,
  target: number;
let serviceId: string;

async function member(
  name: string,
  createdAt: string,
  grade = 0,
  tier: number | null = null,
) {
  const n = ++sequence;
  const [row] = await ctx.sql<{ id: number }[]>`INSERT INTO members
    (member_no,name,phone,created_by,created_at,grade,tier,cycle_start,cycle_end,grade_version)
    VALUES (${"INSIGHT" + String(n).padStart(5, "0")},${name},${"199" + String(n).padStart(8, "0")},${ctx.ownerId},${createdAt},
      ${grade},${tier},${grade ? "2024-01-01" : null},${grade ? "2024-12-31" : null},${grade ? 1 : 0}) RETURNING id`;
  return Number(row!.id);
}

async function visit(
  memberId: number,
  checkedAt: string,
  status: "settled" | "cancelled" = "settled",
) {
  const code = randomUUID();
  const [bill] = await ctx.sql<
    { id: number }[]
  >`INSERT INTO bills(bill_no,kind,status,business_date,opened_at,closed_at)
    VALUES(${"INS-" + code},'visit',${status},${checkedAt.slice(0, 10)},${checkedAt},${checkedAt}) RETURNING id`;
  const [tag] = await ctx.sql<
    { id: number }[]
  >`INSERT INTO hand_tags(code,zone) VALUES(${"I" + String(++sequence).padStart(5, "0")},'male') RETURNING id`;
  await ctx.sql`INSERT INTO visits(visit_no,bill_id,tag_id,zone,member_id,status,business_date,
    checked_in_at,checked_in_by,checkin_key,closed_at,closed_by)
    VALUES(${"IV-" + code},${bill!.id},${tag!.id},'male',${memberId},${status},${checkedAt.slice(0, 10)},
      ${checkedAt},${ctx.ownerId},${randomUUID()},${checkedAt},${ctx.ownerId})`;
}

const insights = (query: unknown = {}) =>
  readSnapshot(ctx.sql, (db) => loadMemberInsights(db, timezone, query, at));
const detail = (id: number) =>
  readSnapshot(ctx.sql, (db) => loadInsightMember(db, timezone, id, at));

describe("concierge all-native member insights", () => {
  beforeAll(async () => {
    ctx = await setup();
    await createStaff(ctx.sql, {
      username: "insights_butler",
      displayName: "会员情况管家",
      role: "backoffice",
      duties: ["concierge"],
      password: PASSWORD,
      mustChangePassword: false,
    });
    butler = await login(ctx.app, "insights_butler");
    recent = await member("近期到访", "2024-03-01T00:00:00Z");
    one = await member("满一月", "2024-02-01T00:00:00Z", 2, 1);
    three = await member("满三月", "2024-02-10T00:00:00Z");
    six = await member("满六月", "2024-01-15T00:00:00Z");
    twelve = await member("满十二月", "2023-01-01T00:00:00Z", 1, 2);
    never = await member("永未到访", "2024-03-02T00:00:00Z");
    cancelled = await member("撤销入场", "2024-03-03T00:00:00Z");
    future = await member("未来入场", "2024-03-04T00:00:00Z", 3, 2);
    source = await member("合并来源旧名", "2022-01-01T00:00:00Z");
    target = await member("合并主账号", "2024-03-05T00:00:00Z");
    await visit(recent, "2024-03-30T18:00:00Z");
    await visit(recent, "2024-03-29T18:00:00Z");
    await visit(one, "2024-02-29T04:30:00.000Z");
    await visit(three, "2023-12-31T04:30:00.000Z");
    await visit(six, "2023-09-30T04:30:00.000Z");
    await visit(twelve, "2023-03-31T04:30:00.000Z");
    await visit(cancelled, "2024-03-30T04:30:00Z", "cancelled");
    await visit(future, "2024-03-31T04:30:00.001Z");
    await visit(source, "2024-02-29T04:30:00.001Z");
    await visit(target, "2022-12-01T04:30:00Z");
    const linked = await api(
      ctx.app,
      butler,
      "POST",
      "/api/concierge/workspace",
      {
        action: "createMember",
        requestId: randomUUID(),
        payload: { nativeMemberId: source },
      },
    );
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    serviceId = linked.body.id;
    expect(
      (
        await api(ctx.app, ctx.owner, "POST", `/api/members/${source}/cards`, {
          clientKey: randomUUID(),
          cardNo: "INSIGHTMERGE",
        })
      ).status,
    ).toBe(200);
    const merged = await api(
      ctx.app,
      ctx.owner,
      "POST",
      `/api/members/${source}/merge`,
      {
        clientKey: randomUUID(),
        targetId: target,
        reason: "合成账号合并",
        expectedPrincipal: 0,
        expectedBonus: 0,
      },
    );
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    for (let i = 0; i < 51; i++)
      await member(
        `分页会员${String(i).padStart(2, "0")}`,
        "2020-01-01T00:00:00Z",
      );
    // Valid native activity without frontdesk admission must never establish a visit.
    expect(
      (
        await api(
          ctx.app,
          ctx.owner,
          "POST",
          "/api/recharges",
          rechargeBody(never, 10000),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await api(
          ctx.app,
          ctx.owner,
          "POST",
          "/api/consumptions",
          consumeBody(never, 100),
        )
      ).status,
    ).toBe(200);
    const [roomType] = await ctx.sql<
      { id: number }[]
    >`INSERT INTO room_types(name,kind,price) VALUES('合成预约房型','daily',100) RETURNING id`;
    await ctx.sql`INSERT INTO bookings(booking_no,kind,source,status,member_id,room_type_id,starts_at,ends_at,hold_until,
      business_date,created_by,client_key,request_hash)
      VALUES('INSIGHTS-BOOKING','room','phone','confirmed',${never},${roomType!.id},'2024-03-30T04:00:00Z',
        '2024-03-30T05:00:00Z','2024-03-30T04:30:00Z','2024-03-30',${ctx.ownerId},${randomUUID()},${"0".repeat(64)})`;
    // Frozen final members remain in the population; overdue grade/gift reads must stay read only.
    await ctx.sql`UPDATE members SET status='frozen' WHERE id=${future}`;
    await ctx.sql`UPDATE members SET cycle_start='2023-01-01',cycle_end='2023-12-31',bonus_balance=20000 WHERE id=${twelve}`;
    await ctx.sql`INSERT INTO bonus_lots(member_id,source,amount,remaining,expires_at) VALUES
      (${twelve},'restored',5000,5000,'2024-03-01T00:00:00Z'),(${twelve},'restored',15000,15000,'2024-12-01T00:00:00Z')`;
  }, 60000);
  afterAll(async () => ctx?.close());

  it("clamps calendar months at leap/non-leap month ends and uses local natural months", async () => {
    const leap = await readSnapshot(ctx.sql, (db) =>
      readInsightCalendar(db, timezone, at),
    );
    expect(leap.one).toBe("2024-02-29T04:30:00.000Z");
    expect(leap.three).toBe("2023-12-31T04:30:00.000Z");
    expect(leap.six).toBe("2023-09-30T04:30:00.000Z");
    const ordinary = await readSnapshot(ctx.sql, (db) =>
      readInsightCalendar(db, timezone, new Date("2023-03-31T04:30:00Z")),
    );
    expect(ordinary.one).toBe("2023-02-28T04:30:00.000Z");
    const year = await readSnapshot(ctx.sql, (db) =>
      readInsightCalendar(db, timezone, new Date("2024-02-29T04:30:00Z")),
    );
    expect(year.twelve).toBe("2023-02-28T04:30:00.000Z");
    const midnight = await readSnapshot(ctx.sql, (db) =>
      readInsightCalendar(db, timezone, new Date("2024-02-29T16:30:00Z")),
    );
    expect(midnight.day).toBe("2024-03-01");
    expect(midnight.monthStart).toBe("2024-02-29T16:00:00.000Z");
    expect(midnight.previousMonthStart).toBe("2024-01-31T16:00:00.000Z");
  });

  it("counts final native accounts once, uses only actual admission, and keeps groups exclusive", async () => {
    const result = await insights();
    expect(result.stats).toEqual({
      totalMembers: 60,
      visitedLastMonth: 2,
      newThisMonth: 5,
      newLastMonth: 2,
      newDelta: 3,
      dormantThreeMonths: 3,
      neverVisited: 54,
    });
    expect(result.dormancyGroups).toEqual({
      oneToThree: 1,
      threeToSix: 1,
      sixToTwelve: 1,
      twelvePlus: 1,
      never: 54,
    });
    expect(result.tiers).toHaveLength(7);
    expect(result.tiers.find((t) => t.grade === 2)?.count).toBe(1);
    expect(result.tiers.find((t) => t.grade === 3)?.count).toBe(1);
    expect(result.tiers.reduce((sum, t) => sum + t.count, 0)).toBe(60);
    expect((await detail(recent)).daysSinceLastVisit).toBe(0);
    for (const id of [never, cancelled, future])
      expect(await detail(id)).toMatchObject({
        lastVisitAt: null,
        daysSinceLastVisit: null,
        dormancyBucket: "never",
      });
    expect((await detail(one)).dormancyBucket).toBe("oneToThree");
    expect((await detail(three)).dormancyBucket).toBe("threeToSix");
    expect((await detail(six)).dormancyBucket).toBe("sixToTwelve");
    expect((await detail(twelve)).dormancyBucket).toBe("twelvePlus");
  });

  it("reads visits and service references across the complete merge family, including card/name lookup", async () => {
    const merged = await detail(source);
    expect(merged).toMatchObject({
      id: target,
      lastVisitAt: "2024-02-29T04:30:00.001Z",
      dormancyBucket: "recent",
      profiles: [{ id: serviceId, code: "000001" }],
    });
    expect(await detail(target)).toEqual(merged);
    for (const q of ["合并来源旧名", "INSIGHT-MERGE"]) {
      const result = await insights({ q });
      expect(result.members.map((m) => m.id)).toEqual([target]);
    }
  });

  it("filters and paginates without changing global stats, preserving grade zero and exact boundaries", async () => {
    const baseline = await insights();
    const first = await insights({ q: "分页会员" }),
      second = await insights({ q: "分页会员", offset: 50 });
    expect(first.members).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(second.members).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(
      new Set([...first.members, ...second.members].map((m) => m.id)).size,
    ).toBe(51);
    const filtered = await insights({ grade: "2", bucket: "oneToThree" });
    expect(filtered.members.map((m) => m.id)).toEqual([one]);
    const zero = await insights({ grade: "0" });
    expect(zero.members.every((m) => m.grade === 0)).toBe(true);
    for (const result of [first, second, filtered, zero]) {
      expect(result.stats).toEqual(baseline.stats);
      expect(result.dormancyGroups).toEqual(baseline.dormancyGroups);
      expect(result.tiers).toEqual(baseline.tiers);
    }
    await expect(insights({ offset: -1 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(insights({ grade: 99 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(insights({ bucket: "unknown" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(insights({ q: "\u0000" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("projects overdue grades and available gifts without financial writes or automatic service enrollment", async () => {
    const snapshot = async () =>
      JSON.stringify({
        members: await ctx.sql`SELECT * FROM members ORDER BY id`,
        lots: await ctx.sql`SELECT * FROM bonus_lots ORDER BY id`,
        ledger: await ctx.sql`SELECT * FROM ledger_entries ORDER BY id`,
        services: await ctx.sql`SELECT * FROM concierge_members ORDER BY id`,
        grades: await ctx.sql`SELECT * FROM member_grade_events ORDER BY id`,
      });
    const before = await snapshot();
    const result = await detail(twelve);
    expect(result).toMatchObject({
      grade: 0,
      bonusCents: 15000,
      totalCents: 15000,
      profiles: [],
    });
    await insights();
    expect(await snapshot()).toBe(before);
  });

  it("serves only limited read-only summaries with concierge permission, including unenrolled member details", async () => {
    const denied = await api(
      ctx.app,
      ctx.clerk,
      "GET",
      "/api/concierge/member-insights",
    );
    expect(denied.status).toBe(403);
    expect(
      (await api(ctx.app, null, "GET", "/api/concierge/member-insights"))
        .status,
    ).toBe(401);
    const list = await api<MemberInsights>(
      ctx.app,
      butler,
      "GET",
      "/api/concierge/member-insights?q=满一月",
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.members[0]?.id).toBe(one);
    const single = await api(
      ctx.app,
      butler,
      "GET",
      `/api/concierge/member-insights/${one}`,
    );
    expect(single.status).toBe(200);
    expect(single.body.member.profiles).toEqual([]);
    expect(single.body.member).not.toHaveProperty("note");
    expect(single.body.member).not.toHaveProperty("birthday");
    expect(single.body.member).not.toHaveProperty("events");
    expect(single.body.member).not.toHaveProperty("password_hash");
    expect(
      (await api(ctx.app, butler, "GET", `/api/members/${one}`)).status,
    ).toBe(403);
    expect(
      (
        await api(
          ctx.app,
          butler,
          "GET",
          "/api/concierge/member-insights?offset=-1",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api(
          ctx.app,
          butler,
          "GET",
          "/api/concierge/member-insights/not-a-number",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api(
          ctx.app,
          butler,
          "GET",
          "/api/concierge/member-insights/999999999",
        )
      ).status,
    ).toBe(404);
  });
});
