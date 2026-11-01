// v0.7.11 两级库存（飞书需求 RQ-002 第一步，docs/WAREHOUSES.md）：总仓 + 部门小仓、领料与部门签收、部门盘点、
// 急采与补单、收货必须有采购单与一起验收、当月冲销与分工、部门停用、按仓的报表与自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
/** 上个月的 15 号（跨月冲销用） */
let lastMonth: string;
let keeper: string; // 物资经办（仓库）
let keeperId: number;
let buyerId: number; // 采购经办（一起验收）
let approver: string; // 负责人
let coster: string; // 财务成本岗
let costerId: number;
let payer: string; // 对账付款
let bath: string; // 浴区的部门申购
let bar: string; // 水吧的部门申购
let bathId: number;
let barId: number;
let bathWh: number;
let barWh: number;
let supplierId: number;

const q = (n: number) => Math.round(n * 1000);

async function material(code: string, over: Record<string, unknown> = {}) {
  const res = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', {
    code,
    name: `两级库存物料${code}`,
    inventoryUnit: '个',
    purchaseUnit: '箱',
    purchaseFactorMilli: q(10),
    ...over,
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as { id: number };
}

const doc = (cookie: string, body: Record<string, unknown>) =>
  api(ctx.app, cookie, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docDate: today, ...body });
const deptDoc = (cookie: string, body: Record<string, unknown>) =>
  api(ctx.app, cookie, 'POST', '/api/erp/dept-stock/docs', { clientKey: randomUUID(), docDate: today, ...body });

async function ok(res: Promise<{ status: number; body: { doc: Record<string, unknown> & { id: number; lines: { id: number }[] } } }>) {
  const r = await res;
  if (r.status !== 201) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body.doc;
}

async function opening(materialId: number, qtyMilli: number) {
  const d = await ok(doc(ctx.owner, { docType: 'opening', approveNow: true, lines: [{ materialId, qtyMilli }] }));
  expect(d.status).toBe('confirmed');
}

const central = async (materialId: number) =>
  (await ctx.sql<{ stock: number }[]>`SELECT stock_milli AS stock FROM materials WHERE id = ${materialId}`)[0]!.stock;
const deptStock = async (warehouseId: number, materialId: number) =>
  (await ctx.sql<{ stock: number }[]>`SELECT stock_milli AS stock FROM warehouse_stock WHERE warehouse_id = ${warehouseId} AND material_id = ${materialId}`)[0]
    ?.stock ?? 0;

async function approvedPo(materialId: number, purchaseQtyMilli: number, priceCents: number) {
  const res = await api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', {
    clientKey: randomUUID(),
    supplierId,
    orderDate: today,
    approveNow: true,
    lines: [{ materialId, purchaseQtyMilli, priceCents }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.po as { id: number; lines: { id: number; materialId: number }[] };
}

const issue = (materialId: number, qtyMilli: number, departmentId = bathId) =>
  ok(doc(keeper, { docType: 'issue', departmentId, handler: '部门同事', lines: [{ materialId, qtyMilli }] }));

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 17);
  lastMonth = d.toISOString().slice(0, 10);
  const depts = await ctx.sql<{ id: number; name: string; warehouseId: number }[]>`
    SELECT d.id, d.name, w.id AS warehouse_id FROM departments d JOIN warehouses w ON w.department_id = d.id`;
  bathId = depts.find((x) => x.name === '浴区')!.id;
  barId = depts.find((x) => x.name === '水吧')!.id;
  bathWh = depts.find((x) => x.name === '浴区')!.warehouseId;
  barWh = depts.find((x) => x.name === '水吧')!.warehouseId;
  const mk = (username: string, displayName: string, duties: string[], departmentId: number | null = null) =>
    createStaff(ctx.sql, { username, displayName, role: 'backoffice', duties: duties as never, departmentId, password: PASSWORD, mustChangePassword: false });
  keeperId = await mk('wh-keeper', '仓库小林', ['stock']);
  buyerId = await mk('wh-buyer', '采购小陈', ['purchase']);
  await mk('wh-appr', '负责人老周', ['approve']);
  costerId = await mk('wh-cost', '成本岗小吴', ['cost']);
  await mk('wh-pay', '对账小王', ['payable']);
  await mk('wh-bath', '浴区阿梅', ['request'], bathId);
  await mk('wh-bar', '水吧小李', ['request'], barId);
  keeper = await login(ctx.app, 'wh-keeper');
  approver = await login(ctx.app, 'wh-appr');
  coster = await login(ctx.app, 'wh-cost');
  payer = await login(ctx.app, 'wh-pay');
  bath = await login(ctx.app, 'wh-bath');
  bar = await login(ctx.app, 'wh-bar');
  const s = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'WS01', name: '两级库存测试供应商' });
  supplierId = s.body.find((x: { code: string }) => x.code === 'WS01').id;
}, 60_000);
afterAll(async () => ctx.close());

describe('迁移 029：仓库', () => {
  it('一个总仓 + 每个部门一个小仓；新建部门自动有小仓', async () => {
    const list = (await api(ctx.app, keeper, 'GET', '/api/inventory/warehouses')).body as { id: number; kind: string; name: string }[];
    expect(list[0]).toMatchObject({ id: 1, kind: 'central', name: '后勤总库' });
    expect(list.filter((w) => w.kind === 'department').map((w) => w.name)).toEqual(expect.arrayContaining(['浴区小仓', '水吧小仓', '保洁小仓']));
    await api(ctx.app, ctx.owner, 'POST', '/api/inventory/departments', { name: '健身房', sortOrder: 9 });
    const after = (await api(ctx.app, keeper, 'GET', '/api/inventory/warehouses')).body as { name: string }[];
    expect(after.map((w) => w.name)).toContain('健身房小仓');
    // 仓库只增不删、不改归属
    await expect(ctx.sql`DELETE FROM warehouses WHERE id = ${barWh}`).rejects.toThrow(/仓库不能删除/);
    await expect(ctx.sql`UPDATE warehouses SET department_id = ${bathId} WHERE id = ${barWh}`).rejects.toThrow(/仓库不能删除或改归属/);
  });
});

describe('领料：总仓出、部门小仓进；部门签收（#17）', () => {
  let m: { id: number };
  let issued: Awaited<ReturnType<typeof issue>>;

  it('领料生效后两边各一条流水；物料列表、库存卡、部门小仓结存按仓', async () => {
    m = await material('W001', { name: '一次性拖鞋', inventoryUnit: '双', purchaseUnit: '箱', purchaseFactorMilli: q(100) });
    await opening(m.id, q(100));
    issued = await issue(m.id, q(30));
    expect(issued).toMatchObject({ status: 'confirmed', warehouse: { id: bathWh, kind: 'department', name: '浴区小仓' }, deptSign: null });
    expect(await central(m.id)).toBe(q(70));
    expect(await deptStock(bathWh, m.id)).toBe(q(30));
    const mat = (await api(ctx.app, keeper, 'GET', `/api/inventory/materials/${m.id}`)).body;
    expect(mat).toMatchObject({ stockMilli: q(70), deptStockMilli: q(30) });

    const card = (await api(ctx.app, keeper, 'GET', `/api/inventory/materials/${m.id}/card`)).body;
    expect(card.warehouse).toMatchObject({ id: 1, kind: 'central' });
    expect(card.moves.map((x: { moveType: string; qtyAfterMilli: number }) => [x.moveType, x.qtyAfterMilli])).toEqual([
      ['issue', q(70)],
      ['opening', q(100)],
    ]);
    expect(card.balances).toEqual([
      { warehouseId: 1, name: '后勤总库', kind: 'central', stockMilli: q(70) },
      { warehouseId: bathWh, name: '浴区小仓', kind: 'department', stockMilli: q(30) },
    ]);
    const deptCard = (await api(ctx.app, keeper, 'GET', `/api/inventory/materials/${m.id}/card?warehouse=${bathWh}`)).body;
    expect(deptCard.moves.map((x: { moveType: string; qtyDeltaMilli: number; qtyAfterMilli: number }) => [x.moveType, x.qtyDeltaMilli, x.qtyAfterMilli])).toEqual([
      ['issue', q(30), q(30)],
    ]);
    expect((await api(ctx.app, keeper, 'GET', `/api/inventory/materials/${m.id}/card?warehouse=all`)).status).toBe(400);

    // 部门看自己的小仓；看不到别的部门，也没有「查看库存」
    const stock = await api(ctx.app, bath, 'GET', `/api/erp/dept-stock/${bathId}/stock`);
    expect(stock.body).toEqual([expect.objectContaining({ materialId: m.id, stockMilli: q(30), inventoryUnit: '双' })]);
    expect((await api(ctx.app, bar, 'GET', `/api/erp/dept-stock/${bathId}/stock`)).status).toBe(403);
    expect((await api(ctx.app, bath, 'GET', '/api/inventory/materials')).status).toBe(403);
    expect((await api(ctx.app, bath, 'GET', `/api/inventory/warehouses/${bathWh}/stock`)).status).toBe(403);
    const meta = (await api(ctx.app, bath, 'GET', '/api/erp/dept-stock/meta')).body;
    expect(meta).toMatchObject({ myDepartmentId: bathId, canOperate: true, canAudit: false, urgentCapCents: 200000, departments: [{ id: bathId, name: '浴区', warehouseId: bathWh }] });
    expect(meta.materials[0]).not.toHaveProperty('refPriceCents');
    // 成本岗能看所有部门
    const all = (await api(ctx.app, coster, 'GET', '/api/erp/dept-stock/meta')).body;
    expect(all.canAudit).toBe(true);
    expect(all.departments.map((x: { id: number }) => x.id)).toEqual(expect.arrayContaining([bathId, barId]));
  });

  it('部门签收：只有本部门能签，只签一次，写明差异；签收后不能改', async () => {
    const unsigned = await api(ctx.app, bath, 'GET', `/api/erp/dept-stock/${bathId}/docs?unsigned=1`);
    expect(unsigned.body.map((x: { id: number }) => x.id)).toContain(issued.id);
    expect(unsigned.body.find((x: { id: number }) => x.id === issued.id)).toMatchObject({ deptSigned: false, warehouseName: '浴区小仓' });
    // 库存页按仓筛单据：领料一头是总仓，按总仓、按浴区小仓都列出；水吧小仓不列
    const byWh = async (w: number) => (await api(ctx.app, keeper, 'GET', `/api/inventory/docs?warehouseId=${w}`)).body.map((x: { id: number }) => x.id);
    expect(await byWh(1)).toContain(issued.id);
    expect(await byWh(bathWh)).toContain(issued.id);
    expect(await byWh(barWh)).not.toContain(issued.id);
    expect((await api(ctx.app, bar, 'POST', `/api/erp/dept-stock/docs/${issued.id}/sign`, {})).status).toBe(403);
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/dept-stock/docs/${issued.id}/sign`, {})).status).toBe(403);
    const signed = await api(ctx.app, bath, 'POST', `/api/erp/dept-stock/docs/${issued.id}/sign`, { note: '少了 1 双，已告诉仓库' });
    expect(signed.status).toBe(200);
    expect(signed.body.deptSign).toMatchObject({ signedByName: '浴区阿梅', note: '少了 1 双，已告诉仓库' });
    expect(signed.body.approvals.map((a: { action: string }) => a.action)).toEqual(['create', 'submit', 'sign']);
    // 再签一次是幂等的，内容不变
    const again = await api(ctx.app, bath, 'POST', `/api/erp/dept-stock/docs/${issued.id}/sign`, { note: '改一下' });
    expect(again.body.deptSign.note).toBe('少了 1 双，已告诉仓库');
    expect((await api(ctx.app, bath, 'GET', `/api/erp/dept-stock/${bathId}/docs?unsigned=1`)).body.map((x: { id: number }) => x.id)).not.toContain(issued.id);
    await expect(ctx.sql`UPDATE inv_docs SET dept_sign_note = '偷偷改' WHERE id = ${issued.id}`).rejects.toThrow(/已签收/);
    // 部门入口的单据不带总仓结存（Codex 复审 P2）：领料单行上的「当前结存」是本部门小仓的
    const viewed = (await api(ctx.app, bath, 'GET', `/api/erp/dept-stock/docs/${issued.id}`)).body;
    expect(viewed.lines[0].stockMilli).toBe(await deptStock(bathWh, m.id));
    expect(viewed.lines[0].stockMilli).not.toBe(await central(m.id));
    // 不是领料单不用签收
    const op = await ok(deptDoc(bath, { docType: 'direct_use', warehouseId: bathWh, note: '客用', lines: [{ materialId: m.id, qtyMilli: q(1) }] }));
    expect((await api(ctx.app, bath, 'POST', `/api/erp/dept-stock/docs/${op.id}/sign`, {})).status).toBe(400);
  });

  it('领料退回：部门小仓出、总仓进；部门小仓不够时拒绝', async () => {
    // 浴区现在 29 双（30 − 耗用 1）
    const back = await ok(doc(keeper, { docType: 'issue_return', sourceDocId: issued.id, lines: [{ sourceLineId: issued.lines[0]!.id, qtyMilli: q(10) }] }));
    expect(back.status).toBe('confirmed');
    expect(await central(m.id)).toBe(q(80));
    expect(await deptStock(bathWh, m.id)).toBe(q(19));
    // 部门耗用后小仓只剩 4 双：退回 10 双不够
    await ok(deptDoc(bath, { docType: 'direct_use', warehouseId: bathWh, note: '客用', lines: [{ materialId: m.id, qtyMilli: q(15) }] }));
    const short = await doc(keeper, { docType: 'issue_return', sourceDocId: issued.id, lines: [{ sourceLineId: issued.lines[0]!.id, qtyMilli: q(10) }] });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(short.body.error.message).toContain('浴区小仓');
    expect(await central(m.id)).toBe(q(80));
    expect(await deptStock(bathWh, m.id)).toBe(q(4));
  });

  it('迁移前的领料（没有仓）：只出总仓，不用签收，退回只进总仓', async () => {
    const m2 = await material('W007', { name: '浴帽' });
    await opening(m2.id, q(20));
    const draft = await ok(doc(keeper, { docType: 'issue', action: 'save', departmentId: bathId, handler: '旧领用', lines: [{ materialId: m2.id, qtyMilli: q(5) }] }));
    await ctx.sql`UPDATE inv_docs SET warehouse_id = NULL WHERE id = ${draft.id}`;
    const legacy = (await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${draft.id}/submit`, {})).body;
    expect(legacy).toMatchObject({ status: 'confirmed', warehouse: null });
    expect(await central(m2.id)).toBe(q(15));
    expect(await deptStock(bathWh, m2.id)).toBe(0);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/dept-stock/docs/${legacy.id}/sign`, {})).status).toBe(403);
    // 退回的仓跟原领料单走：被改成部门小仓的退回草稿确认时拒绝（Codex 复审 P1，迁移的兜底）
    const odd = await ok(doc(keeper, { docType: 'issue_return', action: 'save', sourceDocId: legacy.id, lines: [{ sourceLineId: legacy.lines[0].id, qtyMilli: q(1) }] }));
    expect(odd.warehouse).toBeNull();
    await ctx.sql`UPDATE inv_docs SET warehouse_id = ${bathWh} WHERE id = ${odd.id}`;
    const mismatch = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${odd.id}/submit`, {});
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('SOURCE_WAREHOUSE_MISMATCH');
    await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${odd.id}/cancel`, { reason: '测试' });
    const back = await ok(doc(keeper, { docType: 'issue_return', sourceDocId: legacy.id, lines: [{ sourceLineId: legacy.lines[0].id, qtyMilli: q(2) }] }));
    expect(back.warehouse).toBeNull();
    expect(await central(m2.id)).toBe(q(17));
    expect(await deptStock(bathWh, m2.id)).toBe(0);
  });
});

describe('部门小仓的盘点、耗用、报损与期初', () => {
  it('部门盘点提交即生效、差异默认「耗用」；成本岗可给任何部门盘点；越权与总仓单据被拒绝', async () => {
    const m = await material('W002', { name: '洗发水小瓶', inventoryUnit: '瓶' });
    await opening(m.id, q(50));
    await issue(m.id, q(20));
    const count = await ok(
      deptDoc(bath, { docType: 'count', warehouseId: bathWh, lines: [{ materialId: m.id, countedMilli: q(12), expectedBookMilli: q(20) }] }),
    );
    expect(count).toMatchObject({ status: 'confirmed', warehouse: { id: bathWh } });
    expect(count.lines[0]).toMatchObject({ bookMilli: q(20), qtyMilli: q(-8), diffReason: 'consumed' });
    expect(await deptStock(bathWh, m.id)).toBe(q(12));
    expect(await central(m.id)).toBe(q(30));
    // 页面上的账面与部门小仓不一致：拒绝
    const stale = await deptDoc(bath, { docType: 'count', warehouseId: bathWh, lines: [{ materialId: m.id, countedMilli: q(12), expectedBookMilli: q(20) }] });
    expect(stale.body.error.code).toBe('COUNT_STALE');
    // 成本岗（每月 1 号到部门盘点）
    const audit = await ok(deptDoc(coster, { docType: 'count', warehouseId: bathWh, lines: [{ materialId: m.id, countedMilli: q(11) }] }));
    expect(audit.status).toBe('confirmed');
    expect(await deptStock(bathWh, m.id)).toBe(q(11));
    // 别的部门、总仓、领料都不能从部门入口登记
    expect((await deptDoc(bar, { docType: 'count', warehouseId: bathWh, lines: [{ materialId: m.id, countedMilli: q(1) }] })).status).toBe(403);
    expect((await deptDoc(bath, { docType: 'count', warehouseId: 1, lines: [{ materialId: m.id, countedMilli: q(1) }] })).status).toBe(400);
    expect((await deptDoc(bath, { docType: 'issue', departmentId: bathId, handler: 'x', lines: [{ materialId: m.id, qtyMilli: q(1) }] })).status).toBe(400);
    // 仓库不能给部门小仓登记耗用（部门自己或成本岗）
    expect((await doc(keeper, { docType: 'direct_use', warehouseId: bathWh, note: '越权', lines: [{ materialId: m.id, qtyMilli: q(1) }] })).status).toBe(403);
    // 部门小仓的报损仍要负责人确认
    const dmg = await ok(deptDoc(bath, { docType: 'damage', warehouseId: bathWh, note: '摔碎', lines: [{ materialId: m.id, qtyMilli: q(1) }] }));
    expect(dmg.status).toBe('submitted');
    expect((await api(ctx.app, approver, 'POST', `/api/inventory/docs/${dmg.id}/approve`, {})).body.status).toBe('confirmed');
    expect(await deptStock(bathWh, m.id)).toBe(q(10));
    // 部门列表里的「对象」是部门
    const list = (await api(ctx.app, bath, 'GET', `/api/erp/dept-stock/${bathId}/docs`)).body;
    expect(list.find((x: { id: number }) => x.id === dmg.id)).toMatchObject({ partyName: '浴区', warehouseName: '浴区小仓' });
  });

  it('部门小仓的期初：每个仓每个物料只能一次，要负责人确认', async () => {
    const m = await material('W003', { name: '柠檬片' });
    const o = await ok(deptDoc(bar, { docType: 'opening', warehouseId: barWh, lines: [{ materialId: m.id, qtyMilli: q(5) }] }));
    expect(o.status).toBe('submitted');
    await api(ctx.app, approver, 'POST', `/api/inventory/docs/${o.id}/approve`, {});
    expect(await deptStock(barWh, m.id)).toBe(q(5));
    expect(await central(m.id)).toBe(0);
    const again = await ok(deptDoc(bar, { docType: 'opening', warehouseId: barWh, lines: [{ materialId: m.id, qtyMilli: q(1) }] }));
    const r = await api(ctx.app, approver, 'POST', `/api/inventory/docs/${again.id}/approve`, {});
    expect(r.body.error.code).toBe('OPENING_EXISTS');
    // 只在部门小仓有流水：库存单位、精度、是否受管同样不能再改（Codex 复审 P1）
    const before = (await api(ctx.app, ctx.owner, 'GET', `/api/inventory/materials/${m.id}`)).body;
    expect(before).toMatchObject({ hasMoves: false, anyMoves: true });
    const body = { code: 'W003', name: '柠檬片', inventoryUnit: '个', purchaseUnit: '箱', purchaseFactorMilli: q(10) };
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/inventory/materials/${m.id}`, { ...body, inventoryUnit: '片' })).body.error.code).toBe('UNIT_LOCKED');
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/inventory/materials/${m.id}`, { ...body, tracked: false })).body.error.code).toBe('TRACKED_LOCKED');
    // 总仓的期初不受部门小仓影响
    await opening(m.id, q(3));
    expect(await central(m.id)).toBe(q(3));
  });
});

describe('收货必须有采购单（#19），采购和仓库一起验收（#17）', () => {
  it('没有采购单不能收货；一起验收的要是另一个在职的采购经办', async () => {
    const m = await material('W004', { name: '纸巾' });
    const noPo = await doc(keeper, { docType: 'receipt', supplierId, lines: [{ materialId: m.id, deliveredMilli: q(10), acceptedMilli: q(10), priceCents: 1000 }] });
    expect(noPo.status).toBe(422);
    expect(noPo.body.error.code).toBe('PO_REQUIRED');
    const po = await approvedPo(m.id, q(1), 1000);
    const body = (coAcceptorId: number | null) => ({
      docType: 'receipt',
      supplierId,
      purchaseOrderId: po.id,
      coAcceptorId,
      lines: [{ materialId: m.id, poLineId: po.lines[0]!.id, deliveredMilli: q(10), acceptedMilli: q(10) }],
    });
    expect((await doc(keeper, body(null))).status).toBe(400);
    expect((await doc(keeper, body(keeperId))).status).toBe(400);
    const notBuyer = await doc(keeper, body(costerId));
    expect(notBuyer.body.error.code).toBe('CO_ACCEPTOR_INVALID');
    const r = await ok(doc(keeper, body(buyerId)));
    expect(r).toMatchObject({ status: 'confirmed', coAcceptor: { id: buyerId, name: '采购小陈' }, noPo: false, warehouse: { id: 1 } });
    expect(await central(m.id)).toBe(q(10));
  });
});

describe('急采（#19）', () => {
  it('部门登记（不超过上限）→ 仓库验收后进部门小仓 → 部门补采购单并自己确认', async () => {
    const m = await material('W005', { name: '应急灯泡', purchaseUnit: '箱', purchaseFactorMilli: q(10) });
    const urgent = (cookie: string, priceCents: number, accepted = q(20), departmentId = bathId) =>
      deptDoc(cookie, {
        docType: 'receipt',
        urgent: true,
        departmentId,
        supplierId,
        handler: '浴区阿梅',
        lines: [{ materialId: m.id, deliveredMilli: accepted, acceptedMilli: accepted, priceCents }],
      });
    // 1 箱 2,100 元超过 2,000 元的上限
    const over = await urgent(bath, 210_000, q(10));
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('URGENT_OVER_CAP');
    // 别的部门不能替浴区登记；仓库不能登记急采
    expect((await urgent(bar, 15_000)).status).toBe(403);
    expect((await doc(keeper, { docType: 'receipt', urgent: true, departmentId: bathId, supplierId, lines: [{ materialId: m.id, deliveredMilli: q(20), acceptedMilli: q(20), priceCents: 15_000 }] })).status).toBe(403);

    const rc = await ok(urgent(bath, 15_000));
    expect(rc).toMatchObject({ status: 'submitted', urgent: true, noPo: true, urgentCapCents: 200_000, amountCents: 30_000, warehouse: { id: bathWh }, department: { id: bathId } });
    expect(await deptStock(bathWh, m.id)).toBe(0);
    expect((await api(ctx.app, keeper, 'GET', '/api/inventory/overview')).body.urgentToVerify).toBe(1);
    // 登记的部门不能自己验收
    expect((await api(ctx.app, bath, 'POST', `/api/inventory/docs/${rc.id}/verify-urgent`, {})).status).toBe(403);
    const verified = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${rc.id}/verify-urgent`, {});
    expect(verified.body.status).toBe('confirmed');
    expect(await deptStock(bathWh, m.id)).toBe(q(20));
    expect(await central(m.id)).toBe(0);
    const [ap] = await ctx.sql<{ total: number }[]>`SELECT coalesce(sum(amount_delta_cents), 0) AS total FROM ap_entries WHERE inv_doc_id = ${rc.id}`;
    expect(ap!.total).toBe(30_000);
    expect((await api(ctx.app, keeper, 'GET', '/api/inventory/overview')).body).toMatchObject({ urgentToVerify: 0, urgentToBackfill: 1 });

    // 登记后上限调低：仓库确认时按当时的上限再核对
    const rc2 = await ok(urgent(bath, 15_000));
    const settings = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/settings')).body;
    await api(ctx.app, ctx.owner, 'PUT', '/api/inventory/settings', { ...settings, urgentCapCents: 20_000 });
    const late = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${rc2.id}/verify-urgent`, {});
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('URGENT_OVER_CAP');
    await api(ctx.app, ctx.owner, 'PUT', '/api/inventory/settings', settings);
    await api(ctx.app, bath, 'POST', `/api/erp/dept-stock/docs/${rc2.id}/cancel`, { reason: '重复登记' });

    // 部门补采购单，自己确认（#19）；别的部门不能补
    expect((await api(ctx.app, bar, 'POST', `/api/erp/dept-stock/docs/${rc.id}/backfill`, { clientKey: randomUUID() })).status).toBe(403);
    const bf = await api(ctx.app, bath, 'POST', `/api/erp/dept-stock/docs/${rc.id}/backfill`, { clientKey: randomUUID() });
    expect(bf.status, JSON.stringify(bf.body)).toBe(201);
    expect(bf.body.status).toBe('approved');
    const po = (await api(ctx.app, ctx.owner, 'GET', `/api/purchase-orders/${bf.body.poId}`)).body;
    expect(po).toMatchObject({ backfill: true, status: 'approved', totalCents: 30_000, receiving: 'full' });
    expect(po.approvals.map((a: { action: string; reason: string }) => [a.action, a.reason])).toEqual([
      ['create', ''],
      ['submit', ''],
      ['approve', '急采补单，部门确认'],
    ]);
    const linked = (await api(ctx.app, bath, 'GET', `/api/erp/dept-stock/docs/${rc.id}`)).body;
    expect(linked.purchaseOrder.id).toBe(bf.body.poId);
    // 部门看不到与全公司历史成交价的比较；库存页照常有
    expect(linked.lines[0]).not.toHaveProperty('compare');
    expect((await api(ctx.app, keeper, 'GET', `/api/inventory/docs/${rc.id}`)).body.lines[0]).toHaveProperty('compare');
    expect(await deptStock(bathWh, m.id)).toBe(q(20));
    const [ap2] = await ctx.sql<{ total: number }[]>`SELECT coalesce(sum(amount_delta_cents), 0) AS total FROM ap_entries WHERE supplier_id = ${supplierId}`;
    expect(ap2!.total).toBeGreaterThanOrEqual(30_000);
    const again = await api(ctx.app, bath, 'POST', `/api/erp/dept-stock/docs/${rc.id}/backfill`, { clientKey: randomUUID() });
    expect(again.body.error.code).toBe('BACKFILL_LINKED');
    expect((await api(ctx.app, keeper, 'GET', '/api/inventory/overview')).body.urgentToBackfill).toBe(0);
  });
});

describe('冲销：当月发生的当月冲销完（#21）与分工', () => {
  it('库存单据：仓库与成本岗可以冲销，负责人不能；跨月不能冲销', async () => {
    const m = await material('W006', { name: '洗手液' });
    await opening(m.id, q(10));
    const old = await ok(doc(keeper, { docType: 'direct_use', docDate: lastMonth, note: '上月漏记', lines: [{ materialId: m.id, qtyMilli: q(1) }] }));
    const detail = (await api(ctx.app, keeper, 'GET', `/api/inventory/docs/${old.id}`)).body;
    expect(detail.voidable.ok).toBe(false);
    expect(detail.voidable.reason).toContain('跨月不能冲销');
    const cross = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${old.id}/void`, { reason: '登记错了' });
    expect(cross.status).toBe(422);
    expect(cross.body.error.code).toBe('VOID_CROSS_MONTH');

    const cur = await ok(doc(keeper, { docType: 'direct_use', note: '本月', lines: [{ materialId: m.id, qtyMilli: q(2) }] }));
    expect((await api(ctx.app, approver, 'POST', `/api/inventory/docs/${cur.id}/void`, { reason: '登记错了' })).status).toBe(403);
    const v = await api(ctx.app, coster, 'POST', `/api/inventory/docs/${cur.id}/void`, { reason: '登记错了' });
    expect(v.body.status).toBe('voided');
    expect(await central(m.id)).toBe(q(9));

    // 部门小仓的单据冲销按原流水回到部门小仓
    await issue(m.id, q(4), barId);
    const use = await ok(deptDoc(bar, { docType: 'direct_use', warehouseId: barWh, note: '客用', lines: [{ materialId: m.id, qtyMilli: q(3) }] }));
    expect(await deptStock(barWh, m.id)).toBe(q(1));
    const v2 = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${use.id}/void`, { reason: '其实没用' });
    expect(v2.body.status).toBe('voided');
    expect(await deptStock(barWh, m.id)).toBe(q(4));
    expect(await central(m.id)).toBe(q(5));
  });

  it('付款、期初未付、报销、备用金：财务冲销，跨月不能冲销', async () => {
    // 期初未付（确认在本月）+ 上月的付款
    const opening = await api(ctx.app, payer, 'POST', '/api/payables/openings', { clientKey: randomUUID(), supplierId, amountCents: 50_000, asOfDate: today, note: '测试期初' });
    expect(opening.status, JSON.stringify(opening.body)).toBe(201);
    await api(ctx.app, approver, 'POST', `/api/payables/openings/${opening.body.opening.id}/approve`, {});
    const pay = await api(ctx.app, payer, 'POST', '/api/payables/payments', {
      clientKey: randomUUID(),
      supplierId,
      payDate: lastMonth,
      amountCents: 10_000,
      method: 'bank_transfer',
      evidence: '流水尾号 0001',
      allocations: [{ kind: 'opening', targetId: opening.body.opening.id, amountCents: 10_000 }],
    });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    await api(ctx.app, approver, 'POST', `/api/payables/payments/${pay.body.payment.id}/approve`, {});
    expect((await api(ctx.app, approver, 'POST', `/api/payables/payments/${pay.body.payment.id}/void`, { reason: '登记错了' })).status).toBe(403);
    const cross = await api(ctx.app, payer, 'POST', `/api/payables/payments/${pay.body.payment.id}/void`, { reason: '登记错了' });
    expect(cross.body.error.code).toBe('VOID_CROSS_MONTH');
    // 成本核算能看货款、冲销本月的付款（Codex 复审 P2：原来能冲销却看不到）
    const curPay = await api(ctx.app, payer, 'POST', '/api/payables/payments', {
      clientKey: randomUUID(),
      supplierId,
      payDate: today,
      amountCents: 5_000,
      method: 'bank_transfer',
      evidence: '流水尾号 0002',
      allocations: [{ kind: 'opening', targetId: opening.body.opening.id, amountCents: 5_000 }],
    });
    await api(ctx.app, approver, 'POST', `/api/payables/payments/${curPay.body.payment.id}/approve`, {});
    expect((await api(ctx.app, coster, 'GET', `/api/payables/payments/${curPay.body.payment.id}`)).status).toBe(200);
    expect((await api(ctx.app, coster, 'GET', '/api/payables/overview')).status).toBe(200);
    const voided = await api(ctx.app, coster, 'POST', `/api/payables/payments/${curPay.body.payment.id}/void`, { reason: '登记错了' });
    expect(voided.body.status).toBe('voided');

    // 报销与备用金：上月的不能冲销，本月的成本岗可以
    const claim = (expenseDate: string) =>
      api(ctx.app, coster, 'POST', '/api/erp/expenses', {
        clientKey: randomUUID(),
        expenseDate,
        departmentId: bathId,
        handlerId: costerId,
        purpose: '办公',
        paySource: 'company',
        invoiceType: 'receipt',
        taxRateBp: 0,
        lines: [{ name: '打印纸', category: 'office', unit: '包', boughtMilli: q(1), receivedMilli: q(1), amountCents: 3_000 }],
      });
    const oldClaim = (await claim(lastMonth)).body.claim;
    expect(oldClaim.status).toBe('confirmed');
    expect((await api(ctx.app, coster, 'POST', `/api/erp/expenses/${oldClaim.id}/void`, { reason: '重复' })).body.error.code).toBe('VOID_CROSS_MONTH');
    const curClaim = (await claim(today)).body.claim;
    expect((await api(ctx.app, coster, 'POST', `/api/erp/expenses/${curClaim.id}/void`, { reason: '重复' })).body.status).toBe('voided');
    const adv = await api(ctx.app, coster, 'POST', '/api/erp/petty/advances', {
      clientKey: randomUUID(),
      departmentId: bathId,
      handlerId: costerId,
      advanceDate: lastMonth,
      amountCents: 10_000,
      method: 'wechat',
      evidence: '转账尾号 0002',
    });
    expect(adv.status, JSON.stringify(adv.body)).toBe(201);
    expect((await api(ctx.app, coster, 'POST', `/api/erp/petty/advances/${adv.body.advance.id}/void`, { reason: '打错了' })).body.error.code).toBe('VOID_CROSS_MONTH');
  });
});

describe('部门停用', () => {
  it('小仓有存货时不能停用；清空后可以；停用后不能再领料', async () => {
    const m = await material('W008', { name: '毛巾' });
    await opening(m.id, q(10));
    const gymId = (await ctx.sql<{ id: number }[]>`SELECT id FROM departments WHERE name = '健身房'`)[0]!.id;
    const gymWh = (await ctx.sql<{ id: number }[]>`SELECT id FROM warehouses WHERE department_id = ${gymId}`)[0]!.id;
    await issue(m.id, q(3), gymId);
    const put = (active: boolean) => api(ctx.app, ctx.owner, 'PUT', `/api/inventory/departments/${gymId}`, { name: '健身房', active, sortOrder: 9 });
    const blocked = await put(false);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('DEPT_STOCK_NOT_EMPTY');
    expect(blocked.body.error.message).toContain('毛巾 3 个');
    // 盘点到 0（店主替部门盘）后可以停用
    await ok(deptDoc(ctx.owner, { docType: 'count', warehouseId: gymWh, lines: [{ materialId: m.id, countedMilli: 0 }] }));
    expect((await put(false)).status).toBe(200);
    const late = await doc(keeper, { docType: 'issue', departmentId: gymId, handler: 'x', lines: [{ materialId: m.id, qtyMilli: q(1) }] });
    expect(late.status).toBe(422);
    expect((await put(true)).status).toBe(200);
  });
});

describe('按仓的收发汇总与自检', () => {
  it('总仓、部门小仓、全部合计；各仓结存与流水一致', async () => {
    const [m] = await ctx.sql<{ id: number }[]>`SELECT id FROM materials WHERE code = 'W001'`;
    const row = async (warehouse: string) =>
      ((await api(ctx.app, keeper, 'GET', `/api/inventory/summary?from=${today}&to=${today}&warehouse=${warehouse}`)).body as { materialId: number }[]).find(
        (r) => r.materialId === m!.id,
      );
    // 总仓：期初 100 − 领料 30 + 退回 10 = 80
    expect(await row('1')).toMatchObject({ opening: q(100), issued: q(30), issueReturned: q(10), closing: q(80) });
    // 浴区小仓：领进 30 − 耗用 1 − 退回 10 − 耗用 15 = 4（部门小仓的领料是进、退回是出）
    expect(await row(String(bathWh))).toMatchObject({ begin: 0, issued: q(30), issueReturned: q(10), directUsed: q(16), closing: q(4) });
    // 全部合计：领料、退回是调拨，一出一进抵消
    expect(await row('all')).toMatchObject({ opening: q(100), issued: 0, issueReturned: 0, directUsed: q(16), closing: q(84) });
    // 部门小仓只列有过收发的物料
    const bar = (await api(ctx.app, keeper, 'GET', `/api/inventory/summary?from=${today}&to=${today}&warehouse=${bathWh}`)).body as { code: string }[];
    expect(bar.some((r) => r.code === 'W003')).toBe(false);
    const csv = await api(ctx.app, keeper, 'GET', `/api/inventory/summary/export?from=${today}&to=${today}&warehouse=${bathWh}`);
    expect(String(csv.body)).toContain('从总仓领料（进）');
    expect(String(csv.body)).toContain('浴区小仓 收发汇总');

    const checks = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/checks')).body as { key: string; ok: boolean; detail: string }[];
    expect(checks.map((c) => c.key)).toEqual(
      expect.arrayContaining(['stock_equals_moves', 'dept_stock_equals_moves', 'move_chain', 'move_warehouse', 'receipt_po', 'dept_warehouses']),
    );
    for (const c of checks) expect(c, `${c.key} ${c.detail}`).toMatchObject({ ok: true });
  });

  it('自检能查出部门小仓结存被改动', async () => {
    const [m] = await ctx.sql<{ id: number }[]>`SELECT id FROM materials WHERE code = 'W001'`;
    await ctx.sql`UPDATE warehouse_stock SET stock_milli = stock_milli + 1000 WHERE warehouse_id = ${bathWh} AND material_id = ${m!.id}`;
    const checks = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/checks')).body as { key: string; ok: boolean; detail: string }[];
    const bad = checks.find((c) => c.key === 'dept_stock_equals_moves')!;
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('浴区小仓');
    await ctx.sql`UPDATE warehouse_stock SET stock_milli = stock_milli - 1000 WHERE warehouse_id = ${bathWh} AND material_id = ${m!.id}`;
  });
});
