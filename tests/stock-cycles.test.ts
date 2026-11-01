// v0.7.13 Batch 4 收尾（docs/STOCK_CYCLES.md）：台面日耗品与称重（#14）、每月盘点与供应商对账提醒、对账登记（#23）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shiftDate } from '../src/shared/labels';
import { todayIn } from '../src/server/modules/inventory/common';
import { monthStartOf, reconReminders, shiftMonth, stocktakeProgress } from '../src/server/modules/inventory/cycles';
import { inventoryChecks } from '../src/server/modules/inventory/reports';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let keeper: string; // 物资经办（仓库）
let buyer: string; // 采购经办
let buyerId: number;
let payer: string; // 对账付款
let coster: string; // 成本核算
let bath: string; // 浴区的部门申购
let supplierId: number;
let bathId: number;
let bathWh: number;

const q = (n: number) => Math.round(n * 1000);

async function ok<T = Record<string, any>>(res: Promise<{ status: number; body: any }>, status = 201): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

async function material(code: string, over: Record<string, unknown> = {}) {
  return ok<{ id: number; counterUse: boolean; weighed: boolean }>(
    api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', {
      code,
      name: `周期测试物料${code}`,
      inventoryUnit: '个',
      purchaseUnit: '箱',
      purchaseFactorMilli: q(10),
      ...over,
    }),
  );
}
const updateMaterial = async (id: number, patch: Record<string, unknown>) => {
  const cur = (await api(ctx.app, ctx.owner, 'GET', `/api/inventory/materials/${id}`)).body;
  return api(ctx.app, ctx.owner, 'PUT', `/api/inventory/materials/${id}`, {
    code: cur.code,
    name: cur.name,
    category: cur.category,
    specification: cur.specification,
    inventoryUnit: cur.inventoryUnit,
    decimals: cur.decimals,
    purchaseUnit: cur.purchaseUnit,
    purchaseFactorMilli: cur.purchaseFactorMilli,
    refPriceCents: cur.refPriceCents,
    defaultSupplierId: cur.defaultSupplierId,
    lowStockMilli: cur.lowStockMilli,
    coverDays: cur.coverDays,
    counterUse: cur.counterUse,
    weighed: cur.weighed,
    tracked: cur.tracked,
    active: cur.active,
    note: cur.note,
    ...patch,
  });
};

const doc = (cookie: string, body: Record<string, unknown>) =>
  api(ctx.app, cookie, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docDate: today, ...body });
const deptDoc = (cookie: string, body: Record<string, unknown>) =>
  api(ctx.app, cookie, 'POST', '/api/erp/dept-stock/docs', { clientKey: randomUUID(), docDate: today, ...body });

async function approvedPo(materialId: number, purchaseQtyMilli: number, priceCents: number, orderDate = today) {
  const r = await ok(api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', {
    clientKey: randomUUID(),
    supplierId,
    orderDate,
    approveNow: true,
    lines: [{ materialId, purchaseQtyMilli, priceCents }],
  }));
  return r.po as { id: number; lines: { id: number; materialId: number }[] };
}

/** 按采购单收货：qtyMilli 是库存单位的数量 */
async function receivePo(po: { id: number; lines: { id: number }[] }, materialId: number, qtyMilli: number, docDate = today) {
  return doc(keeper, {
    docType: 'receipt',
    docDate,
    supplierId,
    purchaseOrderId: po.id,
    coAcceptorId: buyerId,
    lines: [{ materialId, poLineId: po.lines[0]!.id, deliveredMilli: qtyMilli, acceptedMilli: qtyMilli }],
  });
}

async function stockIn(materialId: number, boxes: number) {
  const po = await approvedPo(materialId, q(boxes), 1_000);
  const r = await ok(receivePo(po, materialId, q(boxes * 10)));
  expect(r.doc.status).toBe('confirmed');
  return r.doc as { id: number; amountCents: number };
}

const issue = (materialId: number, qtyMilli: number) =>
  doc(keeper, { docType: 'issue', departmentId: bathId, handler: '浴区同事', lines: [{ materialId, qtyMilli }] });

const deptStock = async (materialId: number) =>
  (await ctx.sql<{ s: number }[]>`SELECT coalesce((SELECT stock_milli FROM warehouse_stock WHERE warehouse_id = ${bathWh} AND material_id = ${materialId}), 0) AS s`)[0]!.s;
const centralStock = async (materialId: number) =>
  (await ctx.sql<{ s: number }[]>`SELECT stock_milli AS s FROM materials WHERE id = ${materialId}`)[0]!.s;

async function checksOk() {
  for (const c of await inventoryChecks(ctx.sql)) expect(c, `${c.key} ${c.detail}`).toMatchObject({ ok: true });
}

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  const [b] = await ctx.sql<{ id: number; warehouseId: number }[]>`
    SELECT d.id, w.id AS warehouse_id FROM departments d JOIN warehouses w ON w.department_id = d.id WHERE d.name = '浴区'`;
  bathId = b!.id;
  bathWh = b!.warehouseId;
  const mk = (username: string, displayName: string, duties: string[], departmentId: number | null = null) =>
    createStaff(ctx.sql, { username, displayName, role: 'backoffice', duties: duties as never, departmentId, password: PASSWORD, mustChangePassword: false });
  await mk('sc-keeper', '仓库小林', ['stock']);
  buyerId = await mk('sc-buyer', '采购小陈', ['purchase']);
  await mk('sc-pay', '对账小王', ['payable']);
  await mk('sc-cost', '成本岗小吴', ['cost']);
  await mk('sc-bath', '浴区小赵', ['request'], bathId);
  keeper = await login(ctx.app, 'sc-keeper');
  buyer = await login(ctx.app, 'sc-buyer');
  payer = await login(ctx.app, 'sc-pay');
  coster = await login(ctx.app, 'sc-cost');
  bath = await login(ctx.app, 'sc-bath');
  const list = (await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'SC01', name: '周期测试供应商' })).body;
  supplierId = list.find((x: { code: string }) => x.code === 'SC01').id;
}, 60_000);
afterAll(async () => ctx.close());

describe('台面日耗品（#14）', () => {
  it('领到部门即算耗用：部门小仓不留结存，领料单标出自动耗用；冲销整张领料单都回去', async () => {
    const m = await material('CU01', { counterUse: true });
    expect(m.counterUse).toBe(true);
    await stockIn(m.id, 5); // 50 个
    const r = await ok(issue(m.id, q(12)));
    expect(r.doc.status).toBe('confirmed');
    expect(r.doc.lines[0]).toMatchObject({ autoConsumed: true, counterUse: true });
    expect(await centralStock(m.id)).toBe(q(38));
    expect(await deptStock(m.id)).toBe(0);
    // 部门小仓的流水：领料 +12、耗用 −12（同一张领料单）
    const moves = await ctx.sql<{ moveType: string; qty: number; after: number }[]>`
      SELECT move_type, qty_delta_milli AS qty, qty_after_milli AS after FROM stock_moves
      WHERE doc_id = ${r.doc.id} AND warehouse_id = ${bathWh} ORDER BY id`;
    expect(moves).toEqual([
      { moveType: 'issue', qty: q(12), after: q(12) },
      { moveType: 'direct_use', qty: -q(12), after: 0 },
    ]);
    // 部门的收发汇总里算耗用
    const sum = (await api(ctx.app, keeper, 'GET', `/api/inventory/summary?from=${today}&to=${today}&warehouse=${bathWh}`)).body as {
      materialId: number;
      issued: number;
      directUsed: number;
      closing: number;
    }[];
    expect(sum.find((x) => x.materialId === m.id)).toMatchObject({ issued: q(12), directUsed: q(12), closing: 0 });
    await checksOk();

    // 不能退回（已经算耗用）
    const ret = await doc(keeper, { docType: 'issue_return', sourceDocId: r.doc.id, handler: 'x', lines: [{ sourceLineId: r.doc.lines[0].id, qtyMilli: q(2) }] });
    expect(ret.status).toBe(422);
    expect(ret.body.error.code).toBe('COUNTER_USE_NOT_ALLOWED');

    // 冲销整张领料单：先冲自动耗用、再冲领料，部门小仓不会变负
    const v = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${r.doc.id}/void`, { reason: '数量登记错了' });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('voided');
    expect(await centralStock(m.id)).toBe(q(50));
    expect(await deptStock(m.id)).toBe(0);
    await checksOk();
  });

  it('部门小仓不登记台面日耗品的期初、耗用、报损、盘点；结存列表不提醒', async () => {
    const m = await material('CU02', { counterUse: true, coverDays: 3 });
    await stockIn(m.id, 2);
    await ok(issue(m.id, q(5)));
    for (const body of [
      { docType: 'opening', warehouseId: bathWh, lines: [{ materialId: m.id, qtyMilli: q(1) }] },
      { docType: 'direct_use', warehouseId: bathWh, note: '客用', lines: [{ materialId: m.id, qtyMilli: q(1) }] },
      { docType: 'damage', warehouseId: bathWh, note: '破损', lines: [{ materialId: m.id, qtyMilli: q(1) }] },
      { docType: 'count', warehouseId: bathWh, lines: [{ materialId: m.id, countedMilli: q(3), expectedBookMilli: 0 }] },
    ]) {
      const res = await deptDoc(bath, body);
      expect(res.status, `${body.docType} ${JSON.stringify(res.body)}`).toBe(422);
      expect(res.body.error.code).toBe('COUNTER_USE_NOT_ALLOWED');
    }
    // 总仓的耗用照常
    expect((await doc(keeper, { docType: 'direct_use', note: '仓库自用', lines: [{ materialId: m.id, qtyMilli: q(1) }] })).status).toBe(201);
    // 部门小仓的结存列表：标出台面日耗品，不按可用天数提醒
    const stock = (await api(ctx.app, bath, 'GET', `/api/erp/dept-stock/${bathId}/stock`)).body as { materialId: number; counterUse: boolean; isLow: boolean; stockMilli: number }[];
    expect(stock.find((x) => x.materialId === m.id)).toMatchObject({ counterUse: true, isLow: false, stockMilli: 0 });
    // 部门的物料列表带上标记（页面上部门的期初、耗用、报损、盘点不列它）
    const meta = (await api(ctx.app, bath, 'GET', '/api/erp/dept-stock/meta')).body as { materials: { id: number; counterUse: boolean }[] };
    expect(meta.materials.find((x) => x.id === m.id)?.counterUse).toBe(true);
  });

  it('部门小仓还有结存时不能改成台面日耗品；清零后可以，之后的急采验收即算耗用', async () => {
    const m = await material('CU03');
    await stockIn(m.id, 2);
    await ok(issue(m.id, q(6)));
    expect(await deptStock(m.id)).toBe(q(6));
    const bad = await updateMaterial(m.id, { counterUse: true });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('COUNTER_USE_DEPT_STOCK');
    expect(bad.body.error.message).toContain('浴区');
    // 部门登记耗用清零后可以
    await ok(deptDoc(bath, { docType: 'direct_use', warehouseId: bathWh, note: '客用', lines: [{ materialId: m.id, qtyMilli: q(6) }] }));
    expect((await updateMaterial(m.id, { counterUse: true })).status).toBe(200);

    // 急采：验收生效时进部门小仓即算耗用
    const rc = await ok(deptDoc(bath, {
      docType: 'receipt',
      urgent: true,
      departmentId: bathId,
      supplierId,
      lines: [{ materialId: m.id, deliveredMilli: q(4), acceptedMilli: q(4), priceCents: 1_000 }],
    }));
    expect(rc.doc.status).toBe('submitted');
    const verified = await ok(api(ctx.app, keeper, 'POST', `/api/inventory/docs/${rc.doc.id}/verify-urgent`, {}), 200);
    expect(verified.status).toBe('confirmed');
    expect(verified.lines[0].autoConsumed).toBe(true);
    expect(await deptStock(m.id)).toBe(0);
    await checksOk();
  });

  it('提交后才改成台面日耗品的部门盘点单，生效时同样拒绝', async () => {
    const m = await material('CU04');
    await stockIn(m.id, 1);
    // 部门盘点单先存草稿（账面 0），物料再改成台面日耗品
    const draft = await ok(deptDoc(bath, { docType: 'count', action: 'save', warehouseId: bathWh, lines: [{ materialId: m.id, countedMilli: q(2), expectedBookMilli: 0 }] }));
    expect((await updateMaterial(m.id, { counterUse: true })).status).toBe(200);
    const sub = await api(ctx.app, bath, 'POST', `/api/erp/dept-stock/docs/${draft.doc.id}/submit`, {});
    expect(sub.status).toBe(409);
    expect(sub.body.error.code).toBe('COUNTER_USE_NOT_ALLOWED');
    expect(await deptStock(m.id)).toBe(0);
  });
});

describe('称重（#14）', () => {
  it('称重物料要有小数位；已有流水的物料可以增加小数位，不能减少', async () => {
    const bad = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', {
      code: 'WG00',
      name: '整数称重',
      inventoryUnit: '斤',
      purchaseUnit: '斤',
      purchaseFactorMilli: q(1),
      weighed: true,
    });
    expect(bad.status).toBe(400);
    const m = await material('WG01', { inventoryUnit: '斤', purchaseUnit: '斤', purchaseFactorMilli: q(1) });
    await ok(receivePo(await approvedPo(m.id, q(10), 1_200), m.id, q(10)));
    // 已有流水：改成 2 位小数并勾选称重可以
    const up = await updateMaterial(m.id, { decimals: 2, weighed: true });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ decimals: 2, weighed: true });
    // 减少小数位不行
    const down = await updateMaterial(m.id, { decimals: 1 });
    expect(down.status).toBe(422);
    expect(down.body.error.code).toBe('UNIT_LOCKED');
  });

  it('按实际称重收货：可以比订购数量多出容差（默认 10%），货款按实收重量；超过容差照样拒绝', async () => {
    const m = await material('WG02', { inventoryUnit: '斤', decimals: 2, purchaseUnit: '斤', purchaseFactorMilli: q(1), weighed: true });
    const po = await approvedPo(m.id, q(20), 1_500); // 订 20 斤，15 元 / 斤
    // 第一批称了 20.6 斤
    const r1 = await ok(receivePo(po, m.id, q(20.6)));
    expect(r1.doc).toMatchObject({ status: 'confirmed', amountCents: 30_900 });
    // 再收 1.4 斤正好到 22 斤（容差 10% 的上限）
    const r2 = await ok(receivePo(po, m.id, q(1.4)));
    expect(r2.doc.amountCents).toBe(2_100);
    // 再多 0.01 斤就超了
    const over = await receivePo(po, m.id, q(0.01));
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('RECEIPT_EXCEEDS_ORDER');
    expect(over.body.error.message).toContain('称重容差');
    // 采购单：实收 22 斤，到齐
    const detail = (await api(ctx.app, ctx.owner, 'GET', `/api/purchase-orders/${po.id}`)).body;
    expect(detail.lines[0]).toMatchObject({ weighed: true, receivedMilli: q(22), baseQtyMilli: q(20) });
    expect(detail.receiving).toBe('full');

    // 不是称重的物料仍不能多收
    const n = await material('WG03', { inventoryUnit: '斤', decimals: 2, purchaseUnit: '斤', purchaseFactorMilli: q(1) });
    const po2 = await approvedPo(n.id, q(20), 1_500);
    const over2 = await receivePo(po2, n.id, q(20.5));
    expect(over2.status).toBe(422);
    expect(over2.body.error.code).toBe('RECEIPT_EXCEEDS_ORDER');

    // 容差可调（0 = 不能多收）
    const s = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/settings')).body;
    expect(s.weighTolerancePct).toBe(10);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/inventory/settings', { ...s, weighTolerancePct: 0 })).status).toBe(200);
    const po3 = await approvedPo(m.id, q(5), 1_500);
    expect((await receivePo(po3, m.id, q(5.1))).status).toBe(422);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/inventory/settings', { ...s, weighTolerancePct: 10 })).status).toBe(200);
    await checksOk();
  });
});

describe('每月盘点提醒（#23）', () => {
  it('月初有结存的物料都在本月的盘点单里盘到才算盘完；部门小仓不算台面日耗品', async () => {
    const a = await material('ST01');
    const b = await material('ST02');
    const c = await material('ST03', { counterUse: true });
    await stockIn(a.id, 1);
    await stockIn(b.id, 1);
    await stockIn(c.id, 1);
    await ok(issue(a.id, q(3)));
    await ok(issue(c.id, q(3)));
    // 「月初」取现在：上面这些结存都算月初有的
    const at = (await ctx.sql<{ at: Date }[]>`SELECT now() AS at`)[0]!.at;
    const central = { id: 1, name: '总仓', kind: 'central' as const, departmentId: null };
    const dept = { id: bathWh, name: '浴区小仓', kind: 'department' as const, departmentId: bathId };
    const before = await stocktakeProgress(ctx.sql, [central, dept], { bookBefore: at, from: today, to: today });
    const mine = (w: number, ids: number[]) => before.find((x) => x.warehouseId === w)!.missing.filter((x) => ids.includes(x.materialId)).map((x) => x.materialId);
    expect(mine(1, [a.id, b.id, c.id]).sort()).toEqual([a.id, b.id, c.id].sort());
    // 部门小仓：只有 a（c 是台面日耗品，没有结存）
    expect(mine(bathWh, [a.id, b.id, c.id])).toEqual([a.id]);

    // 部门盘点 a：部门小仓盘完（这个测试库里浴区小仓别的物料也要看，所以只核对 a 不在缺的里）
    const book = await deptStock(a.id);
    await ok(deptDoc(bath, { docType: 'count', warehouseId: bathWh, lines: [{ materialId: a.id, countedMilli: book, expectedBookMilli: book }] }));
    const after = await stocktakeProgress(ctx.sql, [central, dept], { bookBefore: at, from: today, to: today });
    expect(after.find((x) => x.warehouseId === bathWh)!.missing.map((x) => x.materialId)).not.toContain(a.id);
    // 总仓的盘点单提交（等负责人确认）也算盘到
    const cb = await centralStock(b.id);
    const cnt = await ok(doc(keeper, { docType: 'count', lines: [{ materialId: b.id, countedMilli: cb, expectedBookMilli: cb }] }));
    expect(['submitted', 'confirmed']).toContain(cnt.doc.status);
    const after2 = await stocktakeProgress(ctx.sql, [central], { bookBefore: at, from: today, to: today });
    expect(after2[0]!.missing.map((x) => x.materialId)).not.toContain(b.id);
    expect(after2[0]!.missing.map((x) => x.materialId)).toContain(a.id);
  });

  it('提醒接口：总仓给仓库看，所有部门小仓给成本岗看；本部门在「本部门小仓」里看', async () => {
    const k = (await ok(api(ctx.app, keeper, 'GET', '/api/inventory/cycles/stocktake'), 200)) as { warehouses: { kind: string }[]; startDate: string; dueDate: string };
    expect(k.warehouses.map((w) => w.kind)).toEqual(['central']);
    expect(k.startDate).toBe(`${today.slice(0, 7)}-01`);
    expect(k.dueDate).toBe(`${today.slice(0, 7)}-04`);
    const c = (await ok(api(ctx.app, coster, 'GET', '/api/inventory/cycles/stocktake'), 200)) as { warehouses: { kind: string }[] };
    expect(c.warehouses.some((w) => w.kind === 'department')).toBe(true);
    expect((await api(ctx.app, bath, 'GET', '/api/inventory/cycles/stocktake')).status).toBe(403);
    const d = (await ok(api(ctx.app, bath, 'GET', `/api/erp/dept-stock/${bathId}/stocktake`), 200)) as { warehouses: { warehouseId: number }[] };
    expect(d.warehouses.map((w) => w.warehouseId)).toEqual([bathWh]);
  });
});

describe('对账提醒与登记（#23）', () => {
  it('月结：上个月有往来的供应商次月初提醒，登记后不再提醒，之后数字变了提示有变动；同一月份不能登记两次', async () => {
    const m = await material('RC01');
    const rc = await stockIn(m.id, 3); // 本月的收货
    // 「次月 1 号」的提醒：对本月
    const nextMonthDay = shiftMonth(monthStartOf(today), 1);
    const month = today.slice(0, 7);
    const actor = { id: 0, role: 'owner' } as never;
    const r1 = await reconReminders(ctx.sql, actor, ctx.config.timezone, nextMonthDay);
    expect(r1.monthly).toMatchObject({ month, active: true, overdue: false, startDate: nextMonthDay, dueDate: shiftDate(nextMonthDay, 5) });
    expect(r1.monthly.items.find((i) => i.supplierId === supplierId)).toMatchObject({ state: 'pending', reconciliationId: null });

    // 这个月还没过完，不能登记
    const early = await api(ctx.app, payer, 'POST', '/api/payables/reconciliations', { clientKey: randomUUID(), supplierId, kind: 'month', month });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('MONTH_NOT_ENDED');

    // 上个月（没有往来）可以登记：数字都是 0 或上月的余额
    const prev = shiftMonth(monthStartOf(today), -1).slice(0, 7);
    const key = randomUUID();
    const reg = await ok(api(ctx.app, payer, 'POST', '/api/payables/reconciliations', { clientKey: key, supplierId, kind: 'month', month: prev, note: '与供应商核对一致' }));
    expect(reg.reconciliation).toMatchObject({ kind: 'month', month: prev, changed: false, voided: null });
    // 同一编号重复提交：返回原登记
    const again = await ok(api(ctx.app, payer, 'POST', '/api/payables/reconciliations', { clientKey: key, supplierId, kind: 'month', month: prev, note: '与供应商核对一致' }), 200);
    expect(again.replayed).toBe(true);
    expect(again.reconciliation.id).toBe(reg.reconciliation.id);
    // 同一月份再登记一条：拒绝
    const dup = await api(ctx.app, payer, 'POST', '/api/payables/reconciliations', { clientKey: randomUUID(), supplierId, kind: 'month', month: prev });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('RECON_EXISTS');
    // 采购不能登记月结
    expect((await api(ctx.app, buyer, 'POST', '/api/payables/reconciliations', { clientKey: randomUUID(), supplierId, kind: 'month', month: prev })).status).toBe(403);

    // 对「本月」的提醒在次月登记以后消失：直接写一条登记（模拟次月登记）
    const t = (await ctx.sql<{ e: number }[]>`SELECT coalesce(sum(amount_delta_cents), 0) AS e FROM ap_entries WHERE supplier_id = ${supplierId}`)[0]!.e;
    const [ownerRow] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE role = 'owner' ORDER BY id LIMIT 1`;
    const begin = (await ctx.sql<{ e: number }[]>`SELECT coalesce(sum(amount_delta_cents), 0) AS e FROM ap_entries WHERE supplier_id = ${supplierId} AND entry_date < ${monthStartOf(today)}`)[0]!.e;
    const received = (await ctx.sql<{ e: number }[]>`
      SELECT coalesce(sum(e.amount_delta_cents), 0) AS e FROM ap_entries e JOIN inv_docs d ON d.id = e.inv_doc_id
      WHERE e.supplier_id = ${supplierId} AND e.entry_date >= ${monthStartOf(today)} AND d.doc_type = 'receipt'`)[0]!.e;
    await ctx.sql`
      INSERT INTO supplier_reconciliations (supplier_id, kind, period_month, begin_cents, opening_cents, received_cents, return_credit_cents,
                                            paid_cents, refunded_cents, end_cents, total_cents, created_by)
      VALUES (${supplierId}, 'month', ${monthStartOf(today)}, ${begin}, 0, ${received}, 0, 0, 0, ${t}, ${t}, ${ownerRow!.id})`;
    const r2 = await reconReminders(ctx.sql, actor, ctx.config.timezone, nextMonthDay);
    expect(r2.monthly.items.find((i) => i.supplierId === supplierId)).toBeUndefined();
    // 之后冲销本月的一张收货：登记后有变动
    expect((await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${rc.id}/void`, { reason: '送错了' })).status).toBe(200);
    const r3 = await reconReminders(ctx.sql, actor, ctx.config.timezone, nextMonthDay);
    expect(r3.monthly.items.find((i) => i.supplierId === supplierId)).toMatchObject({ state: 'changed' });

    // 撤销上个月的登记：写原因，留经办人；撤销后可以重新登记
    const v = await ok(api(ctx.app, payer, 'POST', `/api/payables/reconciliations/${reg.reconciliation.id}/void`, { reason: '金额核错了' }), 200);
    expect(v.voided).toMatchObject({ reason: '金额核错了' });
    expect((await api(ctx.app, payer, 'POST', '/api/payables/reconciliations', { clientKey: randomUUID(), supplierId, kind: 'month', month: prev })).status).toBe(201);
    await checksOk();
  });

  it('新建时就选按批次：记下当天；不选按月结；现付供应商也存着对账方式但不提醒', async () => {
    const list = (await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'SC02', name: '新建即按批次', reconcileCycle: 'batch' })).body;
    expect(list.find((x: { code: string }) => x.code === 'SC02')).toMatchObject({ reconcileCycle: 'batch', reconcileSince: today });
    const list2 = (await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'SC03', name: '默认月结' })).body;
    expect(list2.find((x: { code: string }) => x.code === 'SC03')).toMatchObject({ reconcileCycle: 'monthly', reconcileSince: null });
  });

  it('按批次：改成按批次以后的每张收货单提醒对账，采购可以勾选几张登记；一张只能登记一次；冲销后提示有变动', async () => {
    // 之前的收货不翻旧账
    const m = await material('RC02');
    const old = await stockIn(m.id, 1);
    const cur = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/suppliers')).body.find((s: { id: number }) => s.id === supplierId);
    const put = await api(ctx.app, ctx.owner, 'PUT', `/api/inventory/suppliers/${supplierId}`, { ...cur, reconcileCycle: 'batch' });
    expect(put.status).toBe(200);
    expect(put.body.find((s: { id: number }) => s.id === supplierId)).toMatchObject({ reconcileCycle: 'batch', reconcileSince: today });
    const r1 = await ok(api(ctx.app, buyer, 'GET', '/api/payables/cycles'), 200);
    // 改成按批次当天的收货（包括 old，同一天）在提醒里；月结里不再有这个供应商
    expect(r1.canBatch).toBe(true);
    expect(r1.canMonthly).toBe(false);
    expect(r1.monthly.items.find((i: { supplierId: number }) => i.supplierId === supplierId)).toBeUndefined();
    expect(r1.batch.map((i: { docId: number }) => i.docId)).toContain(old.id);

    const a = await stockIn(m.id, 2);
    const b = await stockIn(m.id, 3);
    const r2 = await ok(api(ctx.app, payer, 'GET', '/api/payables/cycles'), 200);
    const item = r2.batch.find((i: { docId: number }) => i.docId === a.id);
    expect(item).toMatchObject({ state: 'pending', dueDate: shiftDate(today, 3), overdue: false, amountCents: a.amountCents });

    // 采购登记两张
    const reg = await ok(api(ctx.app, buyer, 'POST', '/api/payables/reconciliations', { clientKey: randomUUID(), supplierId, kind: 'batch', docIds: [a.id, b.id] }));
    expect(reg.reconciliation).toMatchObject({ kind: 'batch', totalCents: a.amountCents + b.amountCents });
    expect(reg.reconciliation.docs.map((d: { docId: number }) => d.docId)).toEqual([a.id, b.id]);
    const r3 = await ok(api(ctx.app, payer, 'GET', '/api/payables/cycles'), 200);
    expect(r3.batch.map((i: { docId: number }) => i.docId)).not.toContain(a.id);
    // 一张只能登记一次
    const dup = await api(ctx.app, payer, 'POST', '/api/payables/reconciliations', { clientKey: randomUUID(), supplierId, kind: 'batch', docIds: [b.id] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('RECON_DOC_TAKEN');
    // 别的供应商的单、仓库没有权限
    expect((await api(ctx.app, keeper, 'POST', '/api/payables/reconciliations', { clientKey: randomUUID(), supplierId, kind: 'batch', docIds: [old.id] })).status).toBe(403);

    // 冲销已登记的收货单：提醒「登记后有变动」
    expect((await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${b.id}/void`, { reason: '整单退回' })).status).toBe(200);
    const r4 = await ok(api(ctx.app, payer, 'GET', '/api/payables/cycles'), 200);
    expect(r4.batch.find((i: { docId: number }) => i.docId === b.id)).toMatchObject({ state: 'changed', voided: true, reconciliationId: reg.reconciliation.id });
    const detail = await ok(api(ctx.app, payer, 'GET', `/api/payables/reconciliations/${reg.reconciliation.id}`), 200);
    expect(detail.changed).toBe(true);
    await checksOk();
    // 改回月结
    await api(ctx.app, ctx.owner, 'PUT', `/api/inventory/suppliers/${supplierId}`, { ...cur, reconcileCycle: 'monthly' });
  });

  it('结果待确认：作废过的编号晚到不登记；查回能找到已登记的', async () => {
    const prev2 = shiftMonth(monthStartOf(today), -2).slice(0, 7);
    const key = randomUUID();
    const ab = await api(ctx.app, payer, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'supplier_recon', summary: '月结对账' });
    expect(ab.status).toBe(200);
    expect(ab.body).toMatchObject({ found: false, abandoned: true });
    const late = await api(ctx.app, payer, 'POST', '/api/payables/reconciliations', { clientKey: key, supplierId, kind: 'month', month: prev2 });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OP_ABANDONED');

    const key2 = randomUUID();
    const reg = await ok(api(ctx.app, payer, 'POST', '/api/payables/reconciliations', { clientKey: key2, supplierId, kind: 'month', month: prev2 }));
    const look = await ok(api(ctx.app, payer, 'GET', `/api/erp/ops/${key2}?type=supplier_recon`), 200);
    expect(look).toMatchObject({ found: true, refId: reg.reconciliation.id });
    // 内容不同的同一编号：拒绝
    const conflictRes = await api(ctx.app, payer, 'POST', '/api/payables/reconciliations', { clientKey: key2, supplierId, kind: 'month', month: prev2, note: '改了' });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('对账登记只追加：不能改、不能删', async () => {
    const [r] = await ctx.sql<{ id: number }[]>`SELECT id FROM supplier_reconciliations ORDER BY id LIMIT 1`;
    await expect(ctx.sql`UPDATE supplier_reconciliations SET note = '改' WHERE id = ${r!.id}`).rejects.toThrow(/不可修改/);
    await expect(ctx.sql`DELETE FROM supplier_reconciliations WHERE id = ${r!.id}`).rejects.toThrow(/禁止删除/);
  });

  it('规则可调：盘点日、对账日、宽限天数', async () => {
    const s = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/settings')).body;
    expect(s).toMatchObject({ stocktakeDay: 1, stocktakeGraceDays: 3, monthlyReconDay: 1, monthlyReconGraceDays: 5, batchReconGraceDays: 3 });
    const bad = await api(ctx.app, ctx.owner, 'PUT', '/api/inventory/settings', { ...s, stocktakeDay: 29 });
    expect(bad.status).toBe(400);
    const put = await api(ctx.app, ctx.owner, 'PUT', '/api/inventory/settings', { ...s, stocktakeDay: 5, stocktakeGraceDays: 2, batchReconGraceDays: 7 });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ stocktakeDay: 5, stocktakeGraceDays: 2, batchReconGraceDays: 7 });
    const k = (await api(ctx.app, keeper, 'GET', '/api/inventory/cycles/stocktake')).body;
    expect(k).toMatchObject({ startDate: `${today.slice(0, 7)}-05`, dueDate: `${today.slice(0, 7)}-07` });
    // 不传新规则的旧页面保存：保持原样
    const { stocktakeDay: _d, stocktakeGraceDays: _g, weighTolerancePct: _w, monthlyReconDay: _m, monthlyReconGraceDays: _mg, batchReconGraceDays: _b, ...legacy } = put.body;
    const keep = await api(ctx.app, ctx.owner, 'PUT', '/api/inventory/settings', legacy);
    expect(keep.body).toMatchObject({ stocktakeDay: 5, batchReconGraceDays: 7 });
    await api(ctx.app, ctx.owner, 'PUT', '/api/inventory/settings', s);
  });
});
