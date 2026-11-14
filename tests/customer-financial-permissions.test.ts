// Synthetic records only, in this run's isolated test database.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { api, createMember, login, PASSWORD, setup, type TestContext } from "./helpers";
import { createStaff } from "../src/server/modules/staff";

let ctx: TestContext, employeeId: number, managerId: number, employee: string, manager: string;
let memberId: number, today: string, defaults: Record<string, string[]>;
let ownToday: number, otherToday: number, ownHistory: number, otherHistory: number, reversedHistory: number;
let ownCheckout: number, otherCheckout: number, historicCheckout: number, refundedCheckout: number, voidedCheckout: number;
let openVisit: number, closedVisit: number, cancelledVisit: number;
let sequence = 0;
const history = "2024-06-10";
const get = (path: string, cookie = employee) => api(ctx.app, cookie, "GET", "/api/customer/" + path);
const native = (path: string, cookie = employee) => api(ctx.app, cookie, "GET", "/api/" + path);
async function role(roleName: string, { add = [], remove = [] }: { add?: string[]; remove?: string[] } = {}) {
  const target = [...new Set([...defaults[roleName]!.filter((p) => !remove.includes(p)), ...add])];
  const response = await api(ctx.app, ctx.owner, "PUT", "/api/admin/permissions", { roles: { [roleName]: target } });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}
async function consume(operatorId: number, date: string, amount = 100, checkoutId: number | null = null, reversed = false) {
  const docNo = "CF-" + String(++sequence).padStart(6, "0"), when = date + "T12:00:00+08:00";
  const [row] = await ctx.sql`INSERT INTO consumptions(doc_no,member_id,total_amount,principal_amount,bonus_amount,deduction_rule,
    status,business_date,operator_id,created_at,checkout_id,note)
    VALUES(${docNo},${memberId},${amount},${amount},0,'principal_first',${reversed ? "reversed" : "completed"},${date},${operatorId},${when},${checkoutId},'金融权限合成私密备注') RETURNING id`;
  const id = Number(row!.id);
  await ctx.sql`INSERT INTO consumption_lines(consumption_id,name,unit_price,quantity,amount) VALUES(${id},'金融权限合成私密项目',${amount},1,${amount})`;
  await ctx.sql`INSERT INTO ledger_entries(member_id,entry_type,consumption_id,doc_no,principal_delta,bonus_delta,principal_after,bonus_after,business_date,operator_id,created_at)
    VALUES(${memberId},'consume',${id},${docNo},${-amount},0,0,0,${date},${operatorId},${when})`;
  if (reversed) {
    const [reversal] = await ctx.sql`INSERT INTO reversals(doc_no,consumption_id,member_id,principal_amount,bonus_amount,reason,business_date,operator_id,created_at)
      VALUES(${'CR-' + sequence},${id},${memberId},${amount},0,'历史原单当日冲回',${today},${operatorId},${today + "T13:00:00+08:00"}) RETURNING id`;
    await ctx.sql`INSERT INTO ledger_entries(member_id,entry_type,consumption_id,reversal_id,doc_no,principal_delta,bonus_delta,principal_after,bonus_after,business_date,operator_id)
      VALUES(${memberId},'reversal',${id},${reversal!.id},${'CR-' + sequence},${amount},0,${amount},0,${today},${operatorId})`;
  }
  return id;
}
async function visit(date: string, status: "open" | "settled" | "cancelled") {
  const code = String(++sequence).padStart(5, "0"), when = date + "T12:00:00+08:00",
    closedAt = status === "open" ? null : date + "T14:00:00+08:00";
  const [bill] = await ctx.sql`INSERT INTO bills(bill_no,kind,status,business_date,opened_at,closed_at)
    VALUES(${"CFB" + code},'visit','open',${date},${when},NULL) RETURNING id`;
  const [tag] = await ctx.sql`INSERT INTO hand_tags(code,zone) VALUES(${"CF" + code},'male') RETURNING id`;
  const [row] = await ctx.sql`INSERT INTO visits(visit_no,bill_id,tag_id,zone,member_id,status,business_date,checked_in_at,checked_in_by,checkin_key,closed_at)
    VALUES(${"CFV" + code},${bill!.id},${tag!.id},'male',${memberId},'open',${date},${when},${ctx.ownerId},${randomUUID()},NULL) RETURNING id`;
  await ctx.sql`INSERT INTO bill_lines(bill_id,source,name,unit_price,quantity,amount,post_key,business_date,posted_by,posted_at)
    VALUES(${bill!.id},'other','手牌权限合成私密项目',500,1,500,${randomUUID()},${date},${ctx.ownerId},${when})`;
  if (status === "cancelled") await ctx.sql`UPDATE bill_lines SET status='voided',void_reason='合成误开撤销',voided_by=${ctx.ownerId},voided_at=${closedAt} WHERE bill_id=${bill!.id}`;
  // Native posting maintains these cached bill facts in its transaction; this
  // direct fixture must write the same effective-line totals before closing.
  await ctx.sql`UPDATE bills SET amount_cents=${status === "cancelled" ? 0 : 500},line_count=${status === "cancelled" ? 0 : 1} WHERE id=${bill!.id}`;
  if (status !== "open") {
    await ctx.sql`UPDATE bills SET status=${status},closed_at=${closedAt} WHERE id=${bill!.id}`;
    await ctx.sql`UPDATE visits SET status=${status},closed_at=${closedAt},closed_by=${ctx.ownerId} WHERE id=${row!.id}`;
  }
  return { id: Number(row!.id), billId: Number(bill!.id) };
}
async function checkout(operatorId: number, date: string, voided = false) {
  const v = await visit(date, "settled"), docNo = "CFC" + String(++sequence).padStart(5, "0");
  const [row] = await ctx.sql`INSERT INTO checkouts(checkout_no,client_key,status,total_amount,paid_amount,business_date,operator_id,created_at,
    voided_at,voided_by,void_reason,void_business_date)
    VALUES(${docNo},${randomUUID()},${voided ? "voided" : "completed"},500,500,${date},${operatorId},${date + "T14:00:00+08:00"},
      ${voided ? today + "T15:00:00+08:00" : null},${voided ? ctx.ownerId : null},${voided ? "合成历史原单当日反结账" : null},${voided ? today : null}) RETURNING id`;
  const id = Number(row!.id), [ticket] = await ctx.sql`SELECT id,name FROM ticket_types WHERE is_default LIMIT 1`;
  await ctx.sql`INSERT INTO checkout_bills(checkout_id,bill_id,visit_id,amount,stay_minutes,ticket_type_id,ticket_name,ticket_segments,ticket_amount)
    VALUES(${id},${v.billId},${v.id},500,120,${ticket!.id},${ticket!.name},1,0)`;
  await ctx.sql`INSERT INTO checkout_payments(checkout_id,method,amount) VALUES(${id},'cash',500)`;
  return { id, visitId: v.id };
}
const snapshot = async () => JSON.stringify({
  members: await ctx.sql`SELECT * FROM members ORDER BY id`,
  ledger: await ctx.sql`SELECT * FROM ledger_entries ORDER BY id`,
  consumptions: await ctx.sql`SELECT * FROM consumptions ORDER BY id`,
  checkouts: await ctx.sql`SELECT * FROM checkouts ORDER BY id`,
  lots: await ctx.sql`SELECT * FROM bonus_lots ORDER BY id`,
});
async function queries<T>(fn: () => Promise<T>) {
  const statements: string[] = [], previous = ctx.sql.options.debug;
  ctx.sql.options.debug = (_id, text) => { statements.push(text); };
  try { return { response: await fn(), statements }; }
  finally { ctx.sql.options.debug = previous; }
}

beforeAll(async () => {
  ctx = await setup();
  employeeId = await createStaff(ctx.sql, { username: "financial_employee", displayName: "金融权限客户经理", role: "account_manager", password: PASSWORD, mustChangePassword: false });
  managerId = await createStaff(ctx.sql, { username: "financial_manager", displayName: "金融权限客户主管", role: "store_manager", password: PASSWORD, mustChangePassword: false });
  employee = await login(ctx.app, "financial_employee"); manager = await login(ctx.app, "financial_manager");
  defaults = (await native("admin/permissions", ctx.owner)).body.defaults;
  today = (await native("auth/me", ctx.owner)).body.today;
  memberId = (await createMember(ctx, "金融权限合成会员", "19900008601")).id;
  ownToday = await consume(employeeId, today);
  otherToday = await consume(ctx.ownerId, today);
  ownHistory = await consume(employeeId, history);
  otherHistory = await consume(ctx.ownerId, history);
  reversedHistory = await consume(employeeId, history, 100, null, true);
  for (let i = 0; i < 51; i++) await consume(employeeId, today, 1);
  ownCheckout = (await checkout(employeeId, today)).id;
  otherCheckout = (await checkout(ctx.ownerId, today)).id;
  historicCheckout = (await checkout(employeeId, history)).id;
  refundedCheckout = (await checkout(employeeId, history)).id;
  voidedCheckout = (await checkout(employeeId, history, true)).id;
  await ctx.sql`INSERT INTO refunds(refund_no,checkout_id,client_key,amount,reason,business_date,operator_id,created_at)
    VALUES('CF-HIST-REFUND',${refundedCheckout},${randomUUID()},50,'历史原单当日退款',${today},${ctx.ownerId},${today + "T16:00:00+08:00"})`;
  // Checkout ownership comes from its own native operator, not the payer's consume event.
  await consume(ctx.ownerId, today, 10, ownCheckout);
  await consume(employeeId, today, 10, otherCheckout);
  closedVisit = (await visit(history, "settled")).id;
  cancelledVisit = (await visit(today, "cancelled")).id;
  openVisit = (await visit(today, "open")).id;
  await ctx.sql`INSERT INTO customer_bindings(member_id,maintainer_staff_id,version) VALUES(${memberId},${employeeId},1)`;
}, 60000);
afterEach(async () => {
  for (const name of ["account_manager", "store_manager"]) await role(name);
});
afterAll(async () => ctx?.close());

it("does not turn customer.read or customer.manage into native financial permissions", async () => {
  const before = await snapshot();
  await role("account_manager", { remove: ["member.read", "ledger.readToday"] });
  expect((await native(`ledger?date=${history}`)).status).toBe(403);
  expect((await native(`members/${memberId}/activity`)).status).toBe(403);
  for (const path of [`settlements?day=${today}`, `settlements?day=${history}`, `settlements/${ownToday}?source=consumption`, `settlements/${otherHistory}?source=consumption`, `settlements/${ownCheckout}`, `settlements/${historicCheckout}`])
    expect((await get(path)).status, path).toBe(403);
  for (const path of ["overview", "members", "visits", "low-balances"])
    expect((await get(path)).status, path).toBe(200);
  await role("store_manager", { remove: ["member.read", "ledger.readToday"] });
  const meta = await get("overview", manager);
  expect(meta.body.capabilities).toMatchObject({ manage: true, financialReadToday: false, financialReadHistory: true, memberFinancialTimeline: false, financialScope: "all" });
  expect((await get(`settlements?day=${history}`, manager)).status).toBe(403);
  expect((await get(`settlements/${ownCheckout}`, manager)).status).toBe(403);
  expect((await get(`settlements/${otherHistory}?source=consumption`, ctx.owner)).status).toBe(200);
  expect(await snapshot()).toBe(before);
});

it("keeps default customer managers on their own current native operator records before totals, search and pagination", async () => {
  expect((await native(`ledger?date=${history}`)).status).toBe(403);
  expect((await get(`settlements?day=${history}`)).status).toBe(403);
  expect((await get(`settlements/${ownHistory}?source=consumption`)).status).toBe(403);
  expect((await get(`settlements/${historicCheckout}`)).status).toBe(403);
  const first = await get(`settlements?day=${today}`), last = await get(`settlements?day=${today}&offset=50`);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.rows).toHaveLength(50); expect(last.body.rows).toHaveLength(3);
  expect(first.body.filteredTotal).toBe(53);
  expect(first.body.totals.netCents).toBe(651);
  expect(last.body.totals).toEqual(first.body.totals);
  const all = [...first.body.rows, ...last.body.rows];
  expect(all.every((r: any) => r.operator.id === employeeId)).toBe(true);
  expect(all.some((r: any) => r.id === ownToday && r.sourceKind === "consumption")).toBe(true);
  expect(all.some((r: any) => r.id === otherToday && r.sourceKind === "consumption")).toBe(false);
  expect(first.body.capabilities).toMatchObject({ financialReadToday: true, financialReadHistory: false, financialScope: "self" });
  expect((await get(`settlements/${ownToday}?source=consumption`)).status).toBe(200);
  expect((await get(`settlements/${ownCheckout}`)).status).toBe(200);
  expect((await get(`settlements/${otherToday}?source=consumption`)).status).toBe(404);
  expect((await get(`settlements/${otherCheckout}`)).status).toBe(404);
  const [other] = await ctx.sql`SELECT doc_no FROM consumptions WHERE id=${otherToday}`;
  expect((await get(`settlements?day=${today}&q=${other!.docNo}`)).body.filteredTotal).toBe(0);
  // Native single-member access remains available; it cannot grant the customer batch endpoint history.
  expect((await native(`members/${memberId}/activity`)).status).toBe(200);
  expect((await native(`consumptions/${otherHistory}`)).status).toBe(200);
});

it("requires readToday even when history is granted and applies custom grants immediately without relogin", async () => {
  await role("account_manager", { add: ["ledger.readHistory"], remove: ["ledger.readToday"] });
  expect((await native(`ledger?date=${history}`)).status).toBe(403);
  expect((await get(`settlements?day=${history}`)).status).toBe(403);
  expect((await get(`settlements/${ownHistory}?source=consumption`)).status).toBe(403);
  await role("account_manager", { add: ["ledger.readHistory"] });
  expect((await native(`ledger?date=${history}`)).status).toBe(200);
  const scoped = await get(`settlements?day=${history}`);
  expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
  expect(scoped.body.rows.every((r: any) => r.operator.id === employeeId)).toBe(true);
  expect((await get(`settlements/${ownHistory}?source=consumption`)).status).toBe(200);
  expect((await get(`settlements/${otherHistory}?source=consumption`)).status).toBe(404);
  await role("account_manager", { add: ["ledger.readHistory", "customer.manage"] });
  const all = await get(`settlements?day=${history}`);
  expect(all.body.capabilities.financialScope).toBe("all");
  expect(all.body.rows.some((r: any) => r.operator.id === ctx.ownerId)).toBe(true);
  expect((await get(`settlements/${otherHistory}?source=consumption`)).status).toBe(200);
  await role("account_manager", { add: ["customer.manage"] });
  expect((await get(`settlements?day=${history}`)).status).toBe(403);
});

it("does not expose an old source document through its current-day refund, void or reversal", async () => {
  const ordinary = await get(`settlements?day=${today}`), owner = await get(`settlements?day=${today}`, ctx.owner),
    ownerLast = await get(`settlements?day=${today}&offset=50`, ctx.owner);
  const ownerRows = [...owner.body.rows, ...ownerLast.body.rows];
  for (const id of [refundedCheckout, voidedCheckout]) {
    expect(ordinary.body.rows.some((r: any) => r.sourceKind === "checkout" && r.id === id)).toBe(false);
    expect(ownerRows.some((r: any) => r.sourceKind === "checkout" && r.id === id)).toBe(true);
    expect((await get(`settlements/${id}`)).status).toBe(403);
  }
  expect(ownerRows.some((r: any) => r.sourceKind === "consumption" && r.id === reversedHistory)).toBe(true);
  expect((await get(`settlements/${reversedHistory}?source=consumption`)).status).toBe(403);
  expect((await get(`settlements?day=${today}&offset=100`)).body).toMatchObject({ rows: [], filteredTotal: 53 });
  await role("store_manager", { remove: ["ledger.readHistory"] });
  expect((await get(`settlements?day=${history}`, manager)).status).toBe(403);
  expect((await get(`settlements/${refundedCheckout}`, manager)).status).toBe(403);
  const managerToday = await get(`settlements?day=${today}`, manager);
  expect(managerToday.body.rows.every((r: any) => r.businessDate === today)).toBe(true);
  const shared = await get(`overview?day=${today}`), ownerShared = await get(`overview?day=${today}`, ctx.owner);
  expect(shared.body.metrics.settlementNetCents).toBe(ownerShared.body.metrics.settlementNetCents);
});

it("does not query financial timeline without member.read and preserves authorized single-member history with gated source links", async () => {
  await role("account_manager", { remove: ["member.read"] });
  const hidden = await queries(() => get(`members/${memberId}?timelineMonth=${history.slice(0, 7)}&timelineOffset=50`));
  expect(hidden.response.status).toBe(200);
  expect(hidden.response.body).toMatchObject({ timeline: [], timelineHasMore: false, capabilities: { memberFinancialTimeline: false } });
  expect(hidden.statements.some((q) => /FROM ledger_entries le/i.test(q))).toBe(false);
  expect((await native(`members/${memberId}/activity`)).status).toBe(403);
  await role("account_manager");
  const historical = await get(`members/${memberId}?timelineMonth=${history.slice(0, 7)}&timelineSection=consume`);
  expect(historical.body.timeline.length).toBeGreaterThan(0);
  expect(historical.body.timeline.every((r: any) => r.consumptionId === null && r.checkoutId === null)).toBe(true);
  const pages = [await get(`members/${memberId}`), await get(`members/${memberId}?timelineOffset=50`)];
  const events = pages.flatMap((r) => r.body.timeline);
  expect(events.some((r: any) => r.consumptionId === ownToday)).toBe(true);
  expect(events.some((r: any) => r.consumptionId === otherToday)).toBe(false);
  expect(events.some((r: any) => r.checkoutId === ownCheckout)).toBe(true);
  expect(events.some((r: any) => r.checkoutId === otherCheckout)).toBe(false);
});

it("keeps current hand-tag service items available while requiring native frontdesk access for closed or cancelled details", async () => {
  const current = await get(`visits/${openVisit}`);
  expect(current.body.linesReadable).toBe(true); expect(current.body.lines.length).toBeGreaterThan(0);
  for (const id of [closedVisit, cancelledVisit]) {
    expect((await native(`frontdesk/visits/${id}`)).status).toBe(403);
    const hidden = await queries(() => get(`visits/${id}`));
    expect(hidden.response.status).toBe(200);
    expect(hidden.response.body).toMatchObject({ linesReadable: false, lines: [] });
    expect(hidden.response.body.visit.amountCents).toBe(id === cancelledVisit ? 0 : 500);
    expect(hidden.statements.some((q) => /FROM bill_lines l JOIN visits/i.test(q))).toBe(false);
    const owner = await get(`visits/${id}`, ctx.owner);
    expect(owner.body.linesReadable).toBe(true); expect(owner.body.lines.length).toBeGreaterThan(0);
  }
  await role("account_manager", { add: ["frontdesk.read"] });
  expect((await get(`visits/${closedVisit}`)).body.linesReadable).toBe(true);
  await role("store_manager", { remove: ["frontdesk.read"] });
  expect((await get(`visits/${closedVisit}`, manager)).body).toMatchObject({ linesReadable: false, lines: [] });
});
