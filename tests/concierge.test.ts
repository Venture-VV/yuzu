import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  setup,
  api,
  login,
  createMember,
  type TestContext,
  PASSWORD,
} from "./helpers";
import { createStaff } from "../src/server/modules/staff";
import { can, permissionsOf } from "../src/shared/permissions";
import {
  reviewReceipt,
  applyCatalogMatches,
} from "../src/shared/concierge/receipt-review";
import { readWorkspace } from "../src/server/modules/concierge/store";
let ctx: TestContext,
  butler = "",
  manager = "",
  butlerId = 0,
  managerId = 0,
  memberId = "",
  secondId = "",
  uploadId = "",
  receiptId = "";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=";
const endpoint = "/api/concierge/workspace";
const mutate = (
  cookie: string,
  action: string,
  payload: Record<string, unknown>,
  requestId = randomUUID(),
) => api(ctx.app, cookie, "POST", endpoint, { action, payload, requestId });
async function workspace(cookie = ctx.owner) {
  const r = await api(ctx.app, cookie, "GET", endpoint);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
const member = (name: string, cardNo: string) => ({
  name,
  phone: "",
  cardNo,
  ownerId: String(butlerId),
  cardTier: "10万",
  preferences: "合成测试",
  source: "独立测试",
  joinedAt: "2026-11-11",
});
const receipt = (member: string, number = "SYNTHETIC-109") => ({
  memberId: member,
  number,
  store: "合成测试店",
  occurredAt: "2026-11-11T10:24:32.000Z",
  kind: "结算单",
  status: "已确认",
  amount: "109.00",
  payments: [{ method: "微信", amount: "109.00", memberId: "" }],
  items: [
    {
      name: "六式如啡(标准)",
      quantity: "1",
      unitPrice: "0.00",
      amount: "0.00",
      rawText: "合成咖啡",
    },
    {
      name: "合成服务",
      quantity: "1",
      unitPrice: "109.00",
      amount: "109.00",
      rawText: "合成服务",
    },
  ],
  totals: {
    subtotal: "109.00",
    due: "109.00",
    rounding: "0.00",
    paid: "109.00",
  },
  details: {},
  warnings: [],
  uploadIds: [uploadId],
  rawText: "仅用于隔离测试",
  itemsText: "合成明细",
  note: "非真实业务",
  review: { mode: "exceptions", checkedIssueKeys: [], summaryConfirmed: true },
});
describe("8.0.12 管家部原生集成", () => {
  beforeAll(async () => {
    ctx = await setup();
    butlerId = await createStaff(ctx.sql, {
      username: "concierge",
      displayName: "合成管家",
      role: "backoffice",
      duties: ["concierge"],
      password: PASSWORD,
      mustChangePassword: false,
    });
    managerId = await createStaff(ctx.sql, {
      username: "concierge_manager",
      displayName: "合成管家经理",
      role: "backoffice",
      duties: ["concierge_manager"],
      password: PASSWORD,
      mustChangePassword: false,
    });
    butler = await login(ctx.app, "concierge");
    manager = await login(ctx.app, "concierge_manager");
  });
  afterAll(async () => {
    await ctx?.close();
  });
  it("沿用企业登录；普通收银员无管家权限，管家无钱包或管理员工权限", async () => {
    expect((await api(ctx.app, null, "GET", endpoint)).status).toBe(401);
    expect((await api(ctx.app, ctx.clerk, "GET", endpoint)).status).toBe(403);
    expect(
      (await api(ctx.app, butler, "GET", "/api/members?q=合成")).status,
    ).toBe(403);
    expect(
      (
        await api(
          ctx.app,
          butler,
          "GET",
          "/api/concierge/native-members?q=合成",
        )
      ).status,
    ).toBe(403);
    expect(
      permissionsOf({ role: "backoffice", duties: ["concierge"] }),
    ).not.toContain("consume.create");
    expect(
      permissionsOf({ role: "backoffice", duties: ["concierge_manager"] }),
    ).not.toContain("staff.manage");
  });
  it("升级空名单，不自动纳入原生会员；从000001编码且收银卡号独立", async () => {
    await createMember(ctx, "原生旧会员", "19900001001");
    expect((await workspace()).members).toHaveLength(0);
    const r = await mutate(
      butler,
      "createMember",
      member("合成会员A", "CASH-001"),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    memberId = r.body.id;
    const b = await workspace();
    expect(b.members[0]).toMatchObject({
      code: "000001",
      cardNo: "CASH-001",
      nativeMemberId: null,
    });
    expect(b.team.find((t: any) => t.id === String(butlerId)).name).toBe(
      "合成管家",
    );
  });
  it("同编号重试只写一次；同编号换内容拒绝", async () => {
    const id = randomUUID(),
      payload = member("合成会员B", "CASH-002");
    const [a, b] = await Promise.all([
      mutate(butler, "createMember", payload, id),
      mutate(butler, "createMember", payload, id),
    ]);
    expect(a.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    secondId = a.body.id;
    expect((await workspace()).members.map((m: any) => m.code).sort()).toEqual([
      "000001",
      "000002",
    ]);
    expect(
      (await mutate(butler, "createMember", { ...payload, name: "改内容" }, id))
        .status,
    ).toBe(409);
  });
  it("版本冲突回滚；旧卡号唯一；操作人由登录身份获取", async () => {
    const m = (await workspace()).members.find((m: any) => m.id === memberId);
    const payload = {
      ...member("合成会员A更名", "CASH-001"),
      id: memberId,
      version: m.version,
      changeReason: "测试更正",
      actorName: "伪造人",
    };
    expect((await mutate(butler, "updateMember", payload)).status).toBe(200);
    expect((await mutate(butler, "updateMember", payload)).status).toBe(409);
    expect(
      (await mutate(butler, "createMember", member("重复卡", "CASH-001")))
        .status,
    ).toBe(409);
    const d = await workspace();
    expect(d.members.find((x: any) => x.id === memberId).updatedByName).toBe(
      "合成管家",
    );
  });
  it("人工余额追加、旧时间及并发版本受控，不写原生钱包", async () => {
    const payload = {
      memberId,
      amount: "30000.00",
      checkedAt: "2026-11-11T10:46:00.000Z",
      note: "合成核对",
      source: "收银人工核对",
      expectedBalanceId: null,
    };
    const a = await mutate(butler, "saveBalance", payload);
    expect(a.status).toBe(200);
    expect((await mutate(manager, "saveBalance", payload)).status).toBe(409);
    expect(
      (
        await mutate(butler, "saveBalance", {
          ...payload,
          checkedAt: "2026-11-10T00:00:00Z",
          expectedBalanceId: a.body.id,
        })
      ).status,
    ).toBe(400);
    const [native] =
      await ctx.sql`SELECT principal_balance,bonus_balance FROM members WHERE phone='19900001001'`;
    expect(native).toMatchObject({ principalBalance: 0, bonusBalance: 0 });
    expect((await workspace()).balances[0].amountCents).toBe(3000000);
  });
  it("原图以私有用途保存、去重；其他企业权限不能读取", async () => {
    const payload = { memberId, files: [{ mime: "image/png", data: png }] };
    const a = await api(
      ctx.app,
      butler,
      "POST",
      "/api/concierge/uploads",
      payload,
    );
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    uploadId = a.body.uploads[0].id;
    const b = await api(
      ctx.app,
      butler,
      "POST",
      "/api/concierge/uploads",
      payload,
    );
    expect(b.body.uploads[0].id).toBe(uploadId);
    expect(
      (
        await api(
          ctx.app,
          ctx.clerk,
          "GET",
          `/api/concierge/uploads/${uploadId}`,
        )
      ).status,
    ).toBe(403);
    const pic = await ctx.app.inject({
      url: `/api/concierge/uploads/${uploadId}`,
      headers: { cookie: butler },
    });
    expect(pic.statusCode).toBe(200);
    expect(pic.headers["cache-control"]).toContain("no-store");
    expect(pic.rawPayload).toEqual(Buffer.from(png, "base64"));
    const [image] =
      await ctx.sql`SELECT image_id FROM concierge_uploads WHERE id=${uploadId}`;
    expect(
      (
        await api(
          ctx.app,
          ctx.owner,
          "GET",
          `/api/erp/images/${image!.imageId}`,
        )
      ).status,
    ).not.toBe(200);
  });
  it("仅经理核准名称；不存价格；正常项整单确认且保留0元和实付", async () => {
    expect(
      (
        await mutate(butler, "saveCatalogItem", {
          name: "美式咖啡(标准)",
          aliases: [],
        })
      ).status,
    ).toBe(403);
    for (const c of [
      { name: "美式咖啡(标准)", aliases: ["六式如啡(标准)"] },
      { name: "合成服务", aliases: [] },
    ])
      expect((await mutate(manager, "saveCatalogItem", c)).status).toBe(200);
    const r = await mutate(butler, "saveReceipt", receipt(memberId));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    receiptId = r.body.id;
    const detail = await api(
      ctx.app,
      butler,
      "GET",
      `/api/concierge/receipts/${receiptId}`,
    );
    expect(detail.body.items[0]).toMatchObject({
      name: "美式咖啡(标准)",
      amountCents: 0,
      quantity: "1",
    });
    expect(detail.body.amountCents).toBe(10900);
    expect(detail.body.confirmedByName).toBe("合成管家");
    expect((await workspace()).balances[0].amountCents).toBe(3000000);
  });
  it("小数点错误、缺少金额及跳过整单确认不能靠勾选绕过", async () => {
    const a = receipt(memberId, "SYNTHETIC-BAD");
    a.items[1]!.amount = "";
    a.review.checkedIssueKeys = ["伪造异常键"] as never[];
    expect((await mutate(butler, "saveReceipt", a)).status).toBe(400);
    const b = receipt(memberId, "SYNTHETIC-NO-CONFIRM");
    b.review.summaryConfirmed = false;
    expect((await mutate(butler, "saveReceipt", b)).status).toBe(400);
  });
  it("重复结算单拦截；已确认更正只给经理并保留首次确认人", async () => {
    expect(
      (await mutate(butler, "saveReceipt", receipt(memberId))).status,
    ).toBe(409);
    const before = (
      await api(ctx.app, butler, "GET", `/api/concierge/receipts/${receiptId}`)
    ).body;
    expect(
      (
        await mutate(butler, "saveReceipt", {
          id: receiptId,
          version: before.version,
          note: "更改",
          reason: "测试",
        })
      ).status,
    ).toBe(403);
    const a = await mutate(manager, "saveReceipt", {
      id: receiptId,
      version: before.version,
      note: "经理补充",
      reason: "隔离测试",
    });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const after = (
      await api(ctx.app, manager, "GET", `/api/concierge/receipts/${receiptId}`)
    ).body;
    expect(after.confirmedByName).toBe(before.confirmedByName);
    expect(after.confirmedAt).toBe(before.confirmedAt);
    expect(after.note).toBe("经理补充");
  });
  it("余额证据只能挂当前会员或实际扣卡会员，不可串图", async () => {
    const b = (await workspace()).balances[0];
    expect(
      (
        await mutate(butler, "attachBalanceEvidence", {
          balanceId: b.id,
          uploadIds: [uploadId],
          receiptIds: [receiptId],
        })
      ).status,
    ).toBe(200);
    expect((await workspace()).balances[0].uploadIds).toContain(uploadId);
    const r = await mutate(butler, "saveBalance", {
      memberId: secondId,
      amount: "100.00",
      checkedAt: "2026-11-11T11:00:00Z",
      note: "B余额",
      expectedBalanceId: null,
      uploadIds: [uploadId],
    });
    expect(r.status).toBe(400);
  });
  it("首次余额核对内联关联的代付单也受保护，后续不能移除扣卡人", async () => {
    const payload = receipt(memberId, "SYNTHETIC-PAYER");
    payload.payments = [
      { method: "会员扣卡", amount: "109.00", memberId: secondId },
    ];
    const saved = await mutate(butler, "saveReceipt", payload);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const balance = await mutate(butler, "saveBalance", {
      memberId: secondId,
      amount: "100.00",
      checkedAt: "2026-11-11T12:00:00Z",
      note: "B代付余额依据",
      expectedBalanceId: null,
      receiptIds: [saved.body.id],
    });
    expect(balance.status).toBe(200);
    const change = await mutate(manager, "saveReceipt", {
      id: saved.body.id,
      version: 1,
      payments: [{ method: "微信", amount: "109.00", memberId: "" }],
      reason: "测试不能移除余额依据的实际扣卡人",
    });
    expect(change.status).toBe(400);
    expect(change.body.error.message).toContain("余额依据");
  });
  it("草稿更换会员而省略企业结账字段时仍重验保留的关联", async () => {
    const native = await createMember(ctx, "合成关联会员", "19900002001");
    await ctx.sql`UPDATE concierge_members SET native_member_id=${native.id} WHERE id=${memberId}`;
    const [checkout] =
      await ctx.sql`INSERT INTO checkouts(checkout_no,client_key,total_amount,paid_amount,business_date,operator_id,created_at) VALUES('SYNTHETIC-LINK',${randomUUID()},0,0,'2026-11-11',${ctx.ownerId},now()) RETURNING id`;
    const id = randomUUID();
    await ctx.sql`INSERT INTO concierge_records(id,kind,member_id,native_checkout_id,data,created_by,updated_by) VALUES(${id},'receipt',${memberId},${checkout!.id},${ctx.sql.json({ memberId, number: "LINK-DRAFT", store: "合成店", occurredAt: "", kind: "结算单", status: "待补全", amountCents: null, payments: [], uploadIds: [], rawText: "", itemsText: "" })},${ctx.ownerId},${ctx.ownerId})`;
    const changed = await mutate(manager, "saveReceipt", {
      id,
      version: 1,
      memberId: secondId,
      note: "省略旧企业结账字段仍须验同会员",
    });
    expect(changed.status).toBe(400);
  });
  it("协调资源冲突同样拦截待确认预约开始接待；不影响前台预约表", async () => {
    const p = {
      memberId,
      startAt: "2026-11-12T10:00:00Z",
      endAt: "2026-11-12T11:00:00Z",
      partySize: 1,
      service: "管家协调",
      resource: "合成资源",
      status: "已确认",
      hostId: String(butlerId),
      note: "",
    };
    expect((await mutate(butler, "createAppointment", p)).status).toBe(200);
    const b = await mutate(butler, "createAppointment", {
      ...p,
      memberId: secondId,
      status: "待确认",
    });
    expect(b.status).toBe(200);
    const v = await mutate(butler, "saveVisit", {
      memberId: secondId,
      appointmentId: b.body.id,
      hostId: String(butlerId),
      partySize: 1,
      status: "接待中",
    });
    expect(v.status).toBe(409);
    const [n] = await ctx.sql`SELECT count(*)::int AS n FROM bookings`;
    expect(n!.n).toBe(0);
  });
  it("交班只能本人或经理接收，改派需经理", async () => {
    const r = await mutate(butler, "saveTask", {
      memberId,
      kind: "交班",
      category: "其他",
      content: "合成交班",
      assigneeId: String(managerId),
      dueAt: "2026-11-12T10:00:00Z",
      status: "待接收",
      result: "",
      nextAction: "",
    });
    expect(r.status).toBe(200);
    expect(
      (
        await mutate(butler, "saveTask", {
          id: r.body.id,
          version: 1,
          memberId,
          kind: "交班",
          content: "合成交班",
          assigneeId: String(managerId),
          dueAt: "2026-11-12T10:00:00Z",
          status: "已接收",
        })
      ).status,
    ).toBe(403);
  });
  it("操作结果可查回；确认不再执行与原提交串行互斥", async () => {
    const id = randomUUID();
    const stop = await api(
      ctx.app,
      butler,
      "POST",
      `/api/concierge/ops/${id}/abandon`,
      {},
    );
    expect(stop.status).toBe(200);
    expect(
      (await mutate(butler, "saveNote", { memberId, content: "不应写入" }, id))
        .status,
    ).toBe(409);
    const found = await api(ctx.app, butler, "GET", `/api/concierge/ops/${id}`);
    expect(found.body).toMatchObject({ found: true, abandoned: true });
    expect(
      (await api(ctx.app, manager, "GET", `/api/concierge/ops/${id}`)).body
        .found,
    ).toBe(false);
  });
  it("审计列表轻量、详情按权限获取；备份完整且无认证秘密", async () => {
    const w = await workspace();
    const a = w.audits.find((a: any) => a.objectId === receiptId);
    expect(a).toBeTruthy();
    expect(a.after).toContain("已确认");
    const detail = await api(
      ctx.app,
      manager,
      "GET",
      `/api/concierge/audits/${a.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.after).toContain("经理补充");
    expect(
      (await api(ctx.app, butler, "GET", `/api/concierge/audits/${a.id}`))
        .status,
    ).toBe(404);
    expect(
      (await api(ctx.app, butler, "GET", "/api/concierge/backup")).status,
    ).toBe(403);
    const backup = await api(ctx.app, manager, "GET", "/api/concierge/backup");
    expect(backup.status).toBe(200);
    expect(backup.body.images).toHaveLength(1);
    expect(Object.keys(backup.body.tables)).not.toContain("staff");
    expect(JSON.stringify(backup.body)).not.toContain("password_hash");
    const csv = await api(
      ctx.app,
      manager,
      "GET",
      "/api/concierge/audits/export",
    );
    expect(csv.status).toBe(200);
    expect(csv.body).toContain("经理补充");
    expect(csv.body).toContain("隔离测试");
  });
  it("数据库保护余额、原图及修订历史不可覆盖或删除", async () => {
    const [b] =
      await ctx.sql`SELECT id FROM concierge_records WHERE kind='balance' LIMIT 1`;
    await expect(
      ctx.sql`UPDATE concierge_records SET data='{}' WHERE id=${b!.id}`,
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      ctx.sql`DELETE FROM concierge_uploads WHERE id=${uploadId}`,
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      ctx.sql`DELETE FROM concierge_revisions`,
    ).rejects.toMatchObject({ code: "P0001" });
  });
});
