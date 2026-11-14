// Same-source service extensions. All writes use the isolated TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  createMember,
  login,
  PASSWORD,
  rechargeBody,
  setup,
  type TestContext,
} from "./helpers";
import { createStaff } from "../src/server/modules/staff";
import { recharge } from "../src/server/modules/wallet";
import type { Actor } from "../src/server/lib/context";
import type { WorkspaceData } from "../src/shared/concierge/types";
let ctx: TestContext, butler: string;
const path = "/api/concierge/workspace";
const mutate = (
  action: string,
  payload: Record<string, unknown>,
  cookie = butler,
) =>
  api(ctx.app, cookie, "POST", path, {
    action,
    payload,
    requestId: randomUUID(),
  });
const workspace = async () =>
  (await api<WorkspaceData>(ctx.app, butler, "GET", path)).body;
const revision = async () =>
  (await api(ctx.app, butler, "GET", "/api/concierge/revision")).body.revision;
async function enroll(nativeMemberId: number) {
  const r = await mutate("createMember", {
    nativeMemberId,
    joinedAt: "2026-11-13",
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id as string;
}
const appointment = (
  memberId: string,
  resourceKey: string,
  extra: Record<string, unknown> = {},
) => ({
  memberId,
  resourceKey,
  service: "伪造需求",
  resource: "伪造名称",
  startAt: "2026-12-01T02:00:00Z",
  endAt: "2026-12-01T03:00:00Z",
  partySize: 1,
  hostId: "",
  status: "已确认",
  ...extra,
});

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, {
    username: "links_butler",
    displayName: "联动管家",
    role: "backoffice",
    duties: ["concierge"],
    password: PASSWORD,
    mustChangePassword: false,
  });
  butler = await login(ctx.app, "links_butler");
});
afterAll(async () => ctx?.close());

describe("front desk identity and live wallet projection", () => {
  it("front desk members are immediately searchable by one Chinese character, formatted phone, member number and physical card; only a narrow DTO is exposed", async () => {
    const m = await createMember(ctx, "榕树会员", "19900006101");
    expect((await workspace()).members).toHaveLength(0);
    const card = await api(
      ctx.app,
      ctx.clerk,
      "POST",
      `/api/members/${m.id}/cards`,
      { clientKey: randomUUID(), cardNo: "LINK6101" },
    );
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    const [native] =
      await ctx.sql`SELECT member_no FROM members WHERE id=${m.id}`;
    for (const q of ["榕", "199 0000-6101", native!.memberNo, "LINK-6101"]) {
      const r = await api(
        ctx.app,
        butler,
        "GET",
        `/api/concierge/native-members?q=${encodeURIComponent(q)}`,
      );
      expect(r.status).toBe(200);
      expect(r.body.members[0]).toMatchObject({
        id: m.id,
        name: "榕树会员",
        profiles: [],
        totalCents: 0,
      });
      expect(Object.keys(r.body.members[0]).sort()).toEqual(
        [
          "id",
          "memberNo",
          "name",
          "phone",
          "status",
          "gradeLabel",
          "grade",
          "tier",
          "cycleEnd",
          "graceUntil",
          "principalCents",
          "bonusCents",
          "totalCents",
          "profiles",
        ].sort(),
      );
    }
    expect(
      (await api(ctx.app, butler, "GET", `/api/members/${m.id}`)).status,
    ).toBe(403);
    expect(
      (
        await api(
          ctx.app,
          butler,
          "POST",
          "/api/recharges",
          rechargeBody(m.id, 500000),
        )
      ).status,
    ).toBe(403);
    expect(
      (await mutate("createMember", { name: "另造会员", phone: "19900006102" }))
        .status,
    ).toBe(400);
    const id = await enroll(m.id);
    const ws = await workspace();
    expect(ws.members.find((x) => x.id === id)).toMatchObject({
      code: "000001",
      name: "榕树会员",
      nativeMemberId: m.id,
      nativeMember: { grade: 0, totalCents: 0 },
    });
    expect(
      (await mutate("createMember", { nativeMemberId: m.id })).status,
    ).toBe(409);
  });

  it("native identity, projected grade and principal plus bonus change revision without rewriting the service extension or manual balance history", async () => {
    const m = await createMember(ctx, "联动原名", "19900006103");
    const id = await enroll(m.id);
    expect(
      (
        await mutate("saveBalance", {
          memberId: id,
          amount: "999.00",
          expectedBalanceId: null,
          source: "历史收银核对",
          note: "只作历史凭证",
        })
      ).status,
    ).toBe(200);
    const receipt = await mutate("saveReceipt", {
      memberId: id,
      number: "LINK-RECEIPT",
      store: "合成店",
      kind: "结算单",
      occurredAt: "2026-11-13T02:00:00Z",
      status: "待核对",
      amount: "10.00",
      items: [],
      totals: {},
      details: {},
      payments: [],
      uploadIds: [],
      rawText: "",
      itemsText: "",
      warnings: [],
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
    const before = await revision();
    const paid = await api(
      ctx.app,
      ctx.owner,
      "POST",
      "/api/recharges",
      rechargeBody(m.id, 5_000_000, 500_000, { bonusMode: "custom" }),
    );
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const edited = await api(
      ctx.app,
      ctx.owner,
      "PUT",
      `/api/members/${m.id}`,
      {
        name: "联动新名",
        phone: "19900006104",
        phoneReason: "会员本人更正",
        note: "不向管家公开的内部备注",
      },
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(await revision()).not.toBe(before);
    const ws = await workspace(),
      member = ws.members.find((x) => x.id === id)!;
    expect(member).toMatchObject({
      name: "联动新名",
      phone: "19900006104",
      version: 1,
      nativeMember: {
        grade: 4,
        tier: 0,
        principalCents: 5_000_000,
        bonusCents: 500_000,
        totalCents: 5_500_000,
      },
    });
    expect(member.nativeMember!.gradeLabel).toContain("L4");
    for (const q of ["联动新名", "19900006104", "联动原名"]) {
      const list = await api(
        ctx.app,
        butler,
        "GET",
        `/api/concierge/receipts?q=${q}`,
      );
      expect(list.body.receipts.map((r: any) => r.id)).toContain(
        receipt.body.id,
      );
    }
    expect(ws.balances.find((x) => x.memberId === id)!.amountCents).toBe(99900);
    expect(JSON.stringify(member)).not.toContain("不向管家公开");
    const detail = await api(
      ctx.app,
      butler,
      "GET",
      `/api/concierge/native-members/${m.id}`,
    );
    expect(detail.body.member.totalCents).toBe(5_500_000);
    expect(
      (
        await mutate("updateMember", {
          id,
          version: 1,
          nativeMemberId: "",
          reason: "不许摘掉",
        })
      ).status,
    ).toBe(400);
    const other = await createMember(ctx, "另一会员", "19900006105");
    expect(
      (
        await mutate("updateMember", {
          id,
          version: 1,
          nativeMemberId: other.id,
          reason: "不许员工换人",
        })
      ).status,
    ).toBe(403);
    // Native identity fields cannot be silently changed through service editing.
    const saved = await mutate("updateMember", {
      id,
      version: 1,
      nativeMemberId: m.id,
      name: "冒名",
      phone: "19900006999",
      serviceAlias: "新名先生",
      reason: "补接待称呼",
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await workspace()).members.find((x) => x.id === id)).toMatchObject({
      name: "联动新名",
      phone: "19900006104",
      serviceAlias: "新名先生",
    });
  });

  it("expired bonus is excluded by read projection, with no expiry, grade or financial writes caused by concierge reads", async () => {
    const m = await createMember(ctx, "到期赠金", "19900006106");
    await enroll(m.id);
    const owner: Actor = {
      id: ctx.ownerId,
      username: "owner",
      displayName: "测试店主",
      role: "owner",
      duties: [],
      mustChangePassword: false,
    };
    await ctx.sql`INSERT INTO settings(key,value) VALUES('custom_bonus_valid_days','1'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
    await recharge(
      { sql: ctx.sql, config: ctx.config },
      {
        ...rechargeBody(m.id, 500000, 10000),
        paymentMethod: "cash",
        paymentConfirmed: true,
        bonusMode: "custom",
        bonusValidDays: 1,
      },
      { actor: owner, at: new Date(Date.now() - 3 * 86400000) },
    );
    const snapshot = async () =>
      JSON.stringify({
        members: await ctx.sql`SELECT * FROM members ORDER BY id`,
        ledger: await ctx.sql`SELECT * FROM ledger_entries ORDER BY id`,
        lots: await ctx.sql`SELECT * FROM bonus_lots ORDER BY id`,
        expiries: await ctx.sql`SELECT * FROM bonus_expiries ORDER BY id`,
      });
    const before = await snapshot();
    const ws = await workspace();
    expect(
      ws.members.find((x) => x.nativeMemberId === m.id)!.nativeMember,
    ).toMatchObject({
      principalCents: 500000,
      bonusCents: 0,
      totalCents: 500000,
    });
    await revision();
    expect(await snapshot()).toBe(before);
  });

  it("merged native members keep original service references while reading the canonical member and preventing another service enrollment", async () => {
    const a = await createMember(ctx, "合并旧客", "19900006107"),
      b = await createMember(ctx, "合并主客", "19900006108");
    const id = await enroll(a.id),
      before = await revision();
    const check = (
      await api(
        ctx.app,
        ctx.owner,
        "GET",
        `/api/members/${a.id}/merge-check?targetId=${b.id}`,
      )
    ).body;
    const merged = await api(
      ctx.app,
      ctx.owner,
      "POST",
      `/api/members/${a.id}/merge`,
      {
        clientKey: randomUUID(),
        targetId: b.id,
        reason: "同一人重复建档",
        expectedPrincipal: check.principal,
        expectedBonus: check.bonus,
      },
    );
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(await revision()).not.toBe(before);
    expect((await workspace()).members.find((x) => x.id === id)).toMatchObject({
      nativeMemberId: a.id,
      name: "合并主客",
      nativeMember: { id: b.id, name: "合并主客" },
    });
    const search = (
      await api(ctx.app, butler, "GET", "/api/concierge/native-members?q=合并")
    ).body.members;
    expect(search.filter((x: any) => x.id === b.id)).toHaveLength(1);
    expect(search.find((x: any) => x.id === b.id).profiles[0].id).toBe(id);
    expect(
      (await mutate("createMember", { nativeMemberId: b.id })).status,
    ).toBe(409);
    expect(
      (
        await mutate("updateMember", {
          id,
          version: 1,
          nativeMemberId: a.id,
          reason: "合并后补资料",
          preferences: "安静区域",
        })
      ).status,
    ).toBe(200);
  });
});

describe("native resource catalogs and physical identity", () => {
  it("uses real space/area/capacity, table and room IDs; prevents overlaps and preserves historic names when catalogs change", async () => {
    const memberId = await enroll(
      (await createMember(ctx, "资源会员", "19900006109")).id,
    );
    const [floor] = await ctx.sql`SELECT id FROM floors ORDER BY id LIMIT 1`;
    const [zone] =
      await ctx.sql`INSERT INTO zones(floor_id,name) VALUES(${floor!.id},'按摩专区') RETURNING id`;
    const space = async (code: string, name: string) =>
      (
        await ctx.sql`INSERT INTO spaces(code,floor_id,zone_id,business_type,capacity,display_name) VALUES(${code},${floor!.id},${zone!.id},'按摩房',3,${name}) RETURNING id`
      )[0]!;
    const a = await space("GJ101", "松风"),
      b = await space("GJ102", "竹影");
    const [table] =
      await ctx.sql`INSERT INTO dining_tables(name,area,seats) VALUES('松风包厢','中餐厅',8) RETURNING id`;
    const [type] =
      await ctx.sql`INSERT INTO room_types(name,kind,price) VALUES('合成大床房','daily',30000) RETURNING id`;
    const [room] =
      await ctx.sql`INSERT INTO rooms(room_no,room_type_id) VALUES('GJ101',${type!.id}) RETURNING id`;
    const options = (await workspace()).resourceOptions!;
    expect(options.find((r) => r.key === `space:${a.id}`)).toMatchObject({
      categoryLabel: "按摩房",
      capacity: 3,
      active: true,
    });
    expect(options.find((r) => r.key === `space:${a.id}`)!.group).toContain(
      "3人间",
    );
    expect(
      options.find((r) => r.key === `dining_table:${table!.id}`),
    ).toMatchObject({ categoryLabel: "餐厅", group: "中餐厅" });
    const first = await mutate(
      "createAppointment",
      appointment(memberId, `space:${a.id}`),
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(
      (
        await mutate(
          "createAppointment",
          appointment(memberId, `space:${a.id}`),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await mutate(
          "createAppointment",
          appointment(memberId, `space:${b.id}`),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await mutate(
          "createAppointment",
          appointment(memberId, `dining_table:${table!.id}`),
        )
      ).status,
    ).toBe(200);
    const rooms = await mutate(
      "createAppointment",
      appointment(memberId, `room:${room!.id}`, {
        startAt: "2026-12-02T02:00:00Z",
        endAt: "2026-12-02T03:00:00Z",
      }),
    );
    expect(rooms.status, JSON.stringify(rooms.body)).toBe(200);
    const [stored] =
      await ctx.sql`SELECT native_space_id,native_table_id,native_room_id,data FROM concierge_records WHERE id=${first.body.id}`;
    expect(stored).toMatchObject({
      nativeSpaceId: a.id,
      nativeTableId: null,
      nativeRoomId: null,
    });
    expect(stored!.data.resource).toContain("松风");
    expect(stored!.data.resource).not.toContain("伪造");
    const before = await revision();
    await ctx.sql`UPDATE spaces SET display_name='松风新名',active=false WHERE id=${a.id}`;
    expect(await revision()).not.toBe(before);
    expect(
      (
        await mutate("saveVisit", {
          memberId,
          appointmentId: first.body.id,
          hostId: "",
          partySize: 1,
          status: "接待中",
        })
      ).status,
    ).toBe(400);
    const notes = await mutate(
      "updateAppointment",
      appointment(memberId, `space:${a.id}`, {
        id: first.body.id,
        version: 1,
        note: "停用后补充说明",
        reason: "补说明",
      }),
    );
    expect(notes.status, JSON.stringify(notes.body)).toBe(200);
    const ws = await workspace(),
      saved = ws.appointments.find((x) => x.id === first.body.id)!;
    expect(saved.resource).toBe(stored!.data.resource);
    expect(saved.nativeResource!.label).toContain("松风新名");
    expect(
      (
        await mutate(
          "updateAppointment",
          appointment(memberId, `space:${a.id}`, {
            id: first.body.id,
            version: 2,
            startAt: "2026-12-03T02:00:00Z",
            endAt: "2026-12-03T03:00:00Z",
            reason: "改时间",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await mutate(
          "updateAppointment",
          appointment(memberId, `space:${a.id}`, {
            id: first.body.id,
            version: 2,
            status: "已取消",
            reason: "资源停用取消",
          }),
        )
      ).status,
    ).toBe(200);
    const group = options.find((r) => r.key === `space:${b.id}`)!.group;
    for (let i = 0; i < 2; i++) {
      const request = await mutate(
        "createAppointment",
        appointment(memberId, "", {
          resourceCategory: "space:按摩房",
          resourceGroup: group,
        }),
      );
      expect(request.status, JSON.stringify(request.body)).toBe(200);
      expect(
        (await workspace()).appointments.find((x) => x.id === request.body.id),
      ).toMatchObject({ resourceKey: "", resource: "", resourceGroup: group });
    }
    // Binding a room to its space later cannot change the room key or bypass an old space reservation.
    await ctx.sql`UPDATE rooms SET space_id=${b.id} WHERE id=${room!.id}`;
    const updated = (await workspace()).resourceOptions!;
    expect(updated.find((r) => r.key === `room:${room!.id}`)).toBeDefined();
    expect(updated.find((r) => r.key === `space:${b.id}`)!.active).toBe(false);
    expect(
      (
        await mutate(
          "createAppointment",
          appointment(memberId, `room:${room!.id}`),
        )
      ).status,
    ).toBe(409);
  });
});
