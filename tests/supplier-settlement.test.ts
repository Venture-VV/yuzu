// v0.7.12 供应商结算与库存采购收尾（飞书需求 RQ-002 第二步，docs/SUPPLIER_SETTLEMENT.md）：
// 退货待供应商确认（#20）、退货余额 / 预付款的核销与供应商退款（#25）、免确认门槛（#18）、分岗不兼任（#17）、
// 运费单独记费用（#15）、按可用天数提醒（#22）、供应商与期初未付批量导入（#16）、供应商往来的自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { inventoryChecks } from '../src/server/modules/inventory/reports';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let keeper: string; // 物资经办（仓库）
let buyer: string; // 采购经办
let buyerId: number;
let approver: string; // 负责人
let payer: string; // 对账付款
let coster: string; // 成本核算
let costerId: number;
let supplierId: number; // 挂账
let cashSupplierId: number; // 现付
let bathId: number;
let bathWh: number;

const q = (n: number) => Math.round(n * 1000);

async function material(code: string, over: Record<string, unknown> = {}) {
  const res = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', {
    code,
    name: `结算测试物料${code}`,
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

async function ok<T = Record<string, any>>(res: Promise<{ status: number; body: any }>, status = 201): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

async function approvedPo(materialId: number, purchaseQtyMilli: number, priceCents: number, sup = supplierId) {
  const r = await ok(api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', {
    clientKey: randomUUID(),
    supplierId: sup,
    orderDate: today,
    approveNow: true,
    lines: [{ materialId, purchaseQtyMilli, priceCents }],
  }));
  return r.po as { id: number; lines: { id: number; materialId: number }[] };
}

/** 按采购单收货（10 个 / 箱）：返回收货单 */
async function receive(materialId: number, boxes: number, priceCents: number, sup = supplierId) {
  const po = await approvedPo(materialId, q(boxes), priceCents, sup);
  const r = await ok(doc(keeper, {
    docType: 'receipt',
    supplierId: sup,
    purchaseOrderId: po.id,
    coAcceptorId: buyerId,
    lines: [{ materialId, poLineId: po.lines[0]!.id, deliveredMilli: q(boxes * 10), acceptedMilli: q(boxes * 10) }],
  }));
  expect(r.doc.status).toBe('confirmed');
  return r.doc as { id: number; amountCents: number; lines: { id: number }[] };
}

const returnOf = (receipt: { id: number; lines: { id: number }[] }, qty: number, cookie = keeper) =>
  doc(cookie, { docType: 'supplier_return', sourceDocId: receipt.id, note: '质量问题退货', lines: [{ sourceLineId: receipt.lines[0]!.id, qtyMilli: q(qty) }] });

const answer = (id: number, body: Record<string, unknown>, cookie = buyer) => api(ctx.app, cookie, 'POST', `/api/inventory/docs/${id}/supplier-answer`, body);
const centralStock = async (materialId: number) =>
  (await ctx.sql<{ s: number }[]>`SELECT stock_milli AS s FROM materials WHERE id = ${materialId}`)[0]!.s;
const balanceOf = async (sup = supplierId) =>
  (await api(ctx.app, payer, 'GET', '/api/payables/overview')).body.suppliers.find((s: { supplierId: number }) => s.supplierId === sup) as {
    balanceCents: number;
    creditCents: number;
    refundedCents: number;
  };
const openOf = async (docId: number, sup = supplierId) =>
  ((await api(ctx.app, payer, 'GET', `/api/payables/suppliers/${sup}/open-items`)).body as { id: number; kind: string; openCents: number; offsetCents: number; creditCents: number }[]).find(
    (i) => i.kind === 'receipt' && i.id === docId,
  )!;
const creditsOf = async (sup = supplierId) =>
  (await api(ctx.app, payer, 'GET', `/api/payables/suppliers/${sup}/credits`)).body as { kind: string; id: number; docNo: string; availableCents: number; canOffset: boolean }[];
const pay = (amountCents: number, allocations: unknown[], extra: Record<string, unknown> = {}, cookie = payer) =>
  api(ctx.app, cookie, 'POST', '/api/payables/payments', {
    clientKey: randomUUID(),
    supplierId,
    payDate: today,
    amountCents,
    method: 'bank_transfer',
    evidence: '流水尾号 0001',
    allocations,
    ...extra,
  });
const setThreshold = (cents: number) => ctx.sql`UPDATE settings SET value = ${String(cents)}::jsonb WHERE key = 'inventory_approval_threshold_cents'`;

async function checksOk() {
  for (const c of await inventoryChecks(ctx.sql)) expect(c, `${c.key} ${c.detail}`).toMatchObject({ ok: true });
}

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  const mk = (username: string, displayName: string, duties: string[]) =>
    createStaff(ctx.sql, { username, displayName, role: 'backoffice', duties: duties as never, password: PASSWORD, mustChangePassword: false });
  await mk('ss-keeper', '仓库小林', ['stock']);
  buyerId = await mk('ss-buyer', '采购小陈', ['purchase']);
  await mk('ss-appr', '负责人老周', ['approve']);
  await mk('ss-pay', '对账小王', ['payable']);
  costerId = await mk('ss-cost', '成本岗小吴', ['cost']);
  keeper = await login(ctx.app, 'ss-keeper');
  buyer = await login(ctx.app, 'ss-buyer');
  approver = await login(ctx.app, 'ss-appr');
  payer = await login(ctx.app, 'ss-pay');
  coster = await login(ctx.app, 'ss-cost');
  const list = (await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'SS01', name: '挂账测试供应商' })).body;
  supplierId = list.find((x: { code: string }) => x.code === 'SS01').id;
  const list2 = (await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'SS02', name: '现付测试供应商', settlement: 'cash' })).body;
  cashSupplierId = list2.find((x: { code: string }) => x.code === 'SS02').id;
  const [bath] = await ctx.sql<{ id: number; warehouseId: number }[]>`
    SELECT d.id, w.id AS warehouse_id FROM departments d JOIN warehouses w ON w.department_id = d.id WHERE d.name = '浴区'`;
  bathId = bath!.id;
  bathWh = bath!.warehouseId;
}, 60_000);
afterAll(async () => ctx.close());

describe('退货待供应商确认（#20）', () => {
  it('确认后先等供应商：库存、货款都不动；采购登记同意才出库扣款；不同意则撤回', async () => {
    const m = await material('SR01');
    const rc = await receive(m.id, 10, 1_000); // 10 箱 × 10 元 = 100 元
    expect(await centralStock(m.id)).toBe(q(100));
    // 退 20 个 = 20 元，不超过免确认门槛：不用负责人确认，直接等供应商
    const ret = (await ok(returnOf(rc, 20))).doc;
    expect(ret).toMatchObject({ status: 'awaiting_supplier', amountCents: 2_000, supplierAnswer: null, returnCredit: null });
    expect(await centralStock(m.id)).toBe(q(100));
    expect(await ctx.sql`SELECT 1 FROM ap_entries WHERE inv_doc_id = ${ret.id}`).toHaveLength(0);
    // 待供应商确认的退货占着可退数量
    expect((await returnOf(rc, 90)).body.error.code).toBe('RETURN_EXCEEDS_SOURCE');
    // 库存工作台「退货待供应商确认」点进的单据列表按这个状态筛选
    const listed = await api(ctx.app, keeper, 'GET', '/api/inventory/docs?type=supplier_return&status=awaiting_supplier');
    expect(listed.status).toBe(200);
    expect((listed.body as { id: number }[]).map((d) => d.id)).toContain(ret.id);
    // 物资经办不能登记供应商的答复（采购与供应商沟通）
    expect((await answer(ret.id, { agreed: true, date: today }, keeper)).status).toBe(403);
    expect((await answer(ret.id, { agreed: true, date: '2000-01-01' })).status).toBe(400);
    expect((await answer(ret.id, { agreed: false, note: '' })).status).toBe(400);
    // 待供应商确认的退货内容不能直接改库
    await expect(ctx.sql`UPDATE inv_docs SET amount_cents = 1 WHERE id = ${ret.id}`).rejects.toThrow(/等供应商确认的退货单内容不可修改/);
    await expect(ctx.sql`UPDATE inv_doc_lines SET qty_milli = 1 WHERE doc_id = ${ret.id}`).rejects.toThrow(/已生效单据的明细不可修改/);

    const agreed = await ok(answer(ret.id, { agreed: true, date: today, note: '对方业务员同意扣款' }), 200);
    expect(agreed).toMatchObject({ status: 'confirmed', supplierAnswer: { agreed: true, date: today, note: '对方业务员同意扣款', byName: '采购小陈' } });
    // 原收货单还没付：扣款全部抵原收货单，没有退货余额
    expect(agreed.returnCredit).toMatchObject({ settlement: 'credit', appliedCents: 2_000, offsetCents: 0, refundedCents: 0, availableCents: 0 });
    expect(await centralStock(m.id)).toBe(q(80));
    expect((await openOf(rc.id)).openCents).toBe(8_000);
    expect((await answer(ret.id, { agreed: true, date: today })).status).toBe(200); // 幂等

    const ret2 = (await ok(returnOf(rc, 10))).doc;
    const rejected = await ok(answer(ret2.id, { agreed: false, note: '供应商说是人为损坏' }), 200);
    expect(rejected).toMatchObject({ status: 'cancelled', returnedReason: '供应商不同意：供应商说是人为损坏', supplierAnswer: { agreed: false, date: null } });
    expect(await centralStock(m.id)).toBe(q(80));
    await checksOk();
  });

  it('超过免确认门槛的退货先负责人确认，再等供应商；等供应商时可以撤回', async () => {
    const m = await material('SR02');
    const rc = await receive(m.id, 30, 10_000); // 30 箱 × 100 元 = 3,000 元
    const ret = (await ok(returnOf(rc, 250))).doc; // 2,500 元，超过 2,000
    expect(ret.status).toBe('submitted');
    expect((await api(ctx.app, approver, 'POST', `/api/inventory/docs/${ret.id}/approve`, {})).body.status).toBe('awaiting_supplier');
    expect((await api(ctx.app, payer, 'POST', `/api/inventory/docs/${ret.id}/cancel`, { reason: '登记错了' })).status).toBe(403);
    const cancelled = await ok(api(ctx.app, keeper, 'POST', `/api/inventory/docs/${ret.id}/cancel`, { reason: '登记错了' }), 200);
    expect(cancelled.status).toBe('cancelled');
    expect(await centralStock(m.id)).toBe(q(300));
  });
});

describe('退货余额、预付款、核销与供应商退款（#25、#20）', () => {
  let rcB: { id: number; amountCents: number; lines: { id: number }[] };
  let retId: number;

  it('付清后才退货：扣款没抵到原收货单，记为退货余额；可以核销到新的收货、冲销后恢复', async () => {
    const m = await material('SC01');
    const before = (await balanceOf())?.balanceCents ?? 0;
    const rcA = await receive(m.id, 10, 1_000); // 100 元
    const p = await ok(pay(10_000, [{ kind: 'receipt', targetId: rcA.id, amountCents: 10_000 }]));
    expect(p.payment.status).toBe('confirmed'); // 不超过门槛，登记即确认
    const ret = (await ok(returnOf(rcA, 20))).doc;
    retId = ret.id;
    const agreed = await ok(answer(ret.id, { agreed: true, date: today }), 200);
    expect(agreed.returnCredit).toMatchObject({ appliedCents: 0, availableCents: 2_000 });
    expect(await creditsOf()).toEqual([expect.objectContaining({ kind: 'return', id: ret.id, availableCents: 2_000, canOffset: true })]);
    expect(await balanceOf()).toMatchObject({ balanceCents: before - 2_000, creditCents: 2_000 });

    rcB = await receive(m.id, 5, 1_000); // 50 元
    const offset = (cookie: string, amountCents: number, key = randomUUID()) =>
      api(ctx.app, cookie, 'POST', '/api/payables/offsets', {
        clientKey: key,
        supplierId,
        offsetDate: today,
        credit: { kind: 'return', id: ret.id },
        note: '退货款抵新货款',
        lines: [{ kind: 'receipt', targetId: rcB.id, amountCents }],
      });
    expect((await offset(buyer, 2_000)).status).toBe(403);
    expect((await offset(payer, 2_500)).body.error.code).toBe('OVER_CREDIT');
    const key = randomUUID();
    const created = await ok(offset(payer, 2_000, key));
    expect(created.offset).toMatchObject({ status: 'confirmed', amountCents: 2_000, credit: { kind: 'return', id: ret.id } });
    expect((await offset(payer, 2_000, key)).status).toBe(200); // 同一编号重提
    expect(await openOf(rcB.id)).toMatchObject({ offsetCents: 2_000, openCents: 3_000 });
    expect(await creditsOf()).toEqual([]);
    expect((await balanceOf()).balanceCents).toBe(before - 2_000 + 5_000);
    // 核销过的收货单、退货单都不能冲销
    expect((await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${rcB.id}/void`, { reason: '测试' })).body.error.code).toBe('NOT_VOIDABLE');
    expect((await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${ret.id}/void`, { reason: '测试' })).body.error.code).toBe('NOT_VOIDABLE');
    await checksOk();

    // 冲销核销（#21：财务，负责人不能）
    expect((await api(ctx.app, approver, 'POST', `/api/payables/offsets/${created.offset.id}/void`, { reason: '核销错了' })).status).toBe(403);
    const voided = await ok(api(ctx.app, payer, 'POST', `/api/payables/offsets/${created.offset.id}/void`, { reason: '核销错了' }), 200);
    expect(voided.status).toBe('voided');
    expect((await openOf(rcB.id)).openCents).toBe(5_000);
    expect((await creditsOf())[0]).toMatchObject({ id: ret.id, availableCents: 2_000 });
    await checksOk();
  });

  it('供应商退款：退货余额退回原付款账户，记应付流水；冲销后恢复', async () => {
    const before = await balanceOf();
    const refund = (amountCents: number) =>
      api(ctx.app, payer, 'POST', '/api/payables/refunds', {
        clientKey: randomUUID(),
        supplierId,
        refundDate: today,
        amountCents,
        method: 'bank_transfer',
        evidence: '到账尾号 7788',
        credit: { kind: 'return', id: retId },
      });
    expect((await refund(3_000)).body.error.code).toBe('OVER_CREDIT');
    const r = await ok(refund(2_000));
    expect(r.refund).toMatchObject({ status: 'confirmed', postsAp: true, amountCents: 2_000 });
    expect(await balanceOf()).toMatchObject({ balanceCents: before.balanceCents + 2_000, creditCents: 0, refundedCents: 2_000 });
    const st = (await api(ctx.app, payer, 'GET', `/api/payables/statement?supplierId=${supplierId}&from=${today}&to=${today}`)).body;
    expect(st.refundedCents).toBe(2_000);
    expect(st.rows.some((x: { kind: string; docKind: string }) => x.kind === 'refund' && x.docKind === 'supplier_refund')).toBe(true);
    // 已经退了款的退货不能冲销
    expect((await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${retId}/void`, { reason: '测试' })).body.error.code).toBe('NOT_VOIDABLE');
    await checksOk();
    const v = await ok(api(ctx.app, coster, 'POST', `/api/payables/refunds/${r.refund.id}/void`, { reason: '登记错了' }), 200);
    expect(v.status).toBe('voided');
    expect(await balanceOf()).toMatchObject({ balanceCents: before.balanceCents, creditCents: 2_000 });
    await checksOk();
  });

  it('预付款：核销合计小于付款时勾选「其余记为预付款」并写用途；预付款可以核销；用过的付款不能冲销', async () => {
    expect((await pay(3_000, [])).status).toBe(400);
    expect((await pay(3_000, [], { prepay: true })).status).toBe(400); // 要写用途
    const p = await ok(pay(3_000, [], { prepay: true, note: '订下月的货先付定金' }));
    expect(p.payment).toMatchObject({ status: 'confirmed', prepaidCents: 3_000, prepayAvailableCents: 3_000 });
    expect((await creditsOf()).find((c) => c.kind === 'prepayment')).toMatchObject({ id: p.payment.id, availableCents: 3_000, canOffset: true });
    const o = await ok(api(ctx.app, payer, 'POST', '/api/payables/offsets', {
      clientKey: randomUUID(),
      supplierId,
      offsetDate: today,
      credit: { kind: 'prepayment', id: p.payment.id },
      lines: [{ kind: 'receipt', targetId: rcB.id, amountCents: 3_000 }],
    }));
    expect(o.offset.credit).toMatchObject({ kind: 'prepayment', id: p.payment.id });
    expect((await openOf(rcB.id)).openCents).toBe(2_000);
    const detail = (await api(ctx.app, payer, 'GET', `/api/payables/payments/${p.payment.id}`)).body;
    expect(detail).toMatchObject({ prepayOffsetCents: 3_000, prepayAvailableCents: 0 });
    expect((await api(ctx.app, payer, 'POST', `/api/payables/payments/${p.payment.id}/void`, { reason: '测试' })).body.error.code).toBe('NOT_VOIDABLE');
    await checksOk();
  });

  it('有待确认的付款时，退货不去抢那部分：多出来的记退货余额，付款照常确认', async () => {
    const m = await material('SC02');
    const rc = await receive(m.id, 10, 1_000);
    await setThreshold(0);
    try {
      const p = await ok(pay(10_000, [{ kind: 'receipt', targetId: rc.id, amountCents: 10_000 }]));
      expect(p.payment.status).toBe('submitted');
      const ret = (await ok(returnOf(rc, 10))).doc;
      await ok(api(ctx.app, approver, 'POST', `/api/inventory/docs/${ret.id}/approve`, {}), 200);
      const agreed = await ok(answer(ret.id, { agreed: true, date: today }), 200);
      expect(agreed.returnCredit).toMatchObject({ appliedCents: 0, availableCents: 1_000 });
      expect((await api(ctx.app, approver, 'POST', `/api/payables/payments/${p.payment.id}/approve`, {})).body.status).toBe('confirmed');
    } finally {
      await setThreshold(200_000);
    }
    await checksOk();
  });

  it('现付供应商的退货：不记应付、不能核销，只能登记退款（不记应付流水）', async () => {
    const m = await material('SC03');
    const rc = await receive(m.id, 4, 1_000, cashSupplierId);
    const ret = (await ok(returnOf(rc, 10))).doc;
    const agreed = await ok(answer(ret.id, { agreed: true, date: today }), 200);
    expect(agreed.returnCredit).toMatchObject({ settlement: 'cash', appliedCents: 0, availableCents: 1_000 });
    expect(await ctx.sql`SELECT 1 FROM ap_entries WHERE inv_doc_id = ${ret.id}`).toHaveLength(0);
    const credit = (await creditsOf(cashSupplierId)).find((c) => c.id === ret.id)!;
    expect(credit).toMatchObject({ canOffset: false, availableCents: 1_000 });
    const offset = await api(ctx.app, payer, 'POST', '/api/payables/offsets', {
      clientKey: randomUUID(),
      supplierId: cashSupplierId,
      offsetDate: today,
      credit: { kind: 'return', id: ret.id },
      lines: [{ kind: 'receipt', targetId: rc.id, amountCents: 100 }],
    });
    expect(offset.body.error.code).toBe('CREDIT_NOT_OFFSETTABLE');
    const r = await ok(api(ctx.app, payer, 'POST', '/api/payables/refunds', {
      clientKey: randomUUID(),
      supplierId: cashSupplierId,
      refundDate: today,
      amountCents: 1_000,
      method: 'wechat',
      evidence: '微信转回',
      credit: { kind: 'return', id: ret.id },
    }));
    expect(r.refund.postsAp).toBe(false);
    expect(await ctx.sql`SELECT 1 FROM ap_entries WHERE supplier_refund_id = ${r.refund.id}`).toHaveLength(0);
    expect((await creditsOf(cashSupplierId)).find((c) => c.id === ret.id)).toBeUndefined();
    await checksOk();
  });
});

describe('免确认门槛（#18）', () => {
  it('采购单、期初未付、报损在门槛以内提交即生效，超过的等负责人确认；门槛改成 0 全部要确认', async () => {
    const m = await material('TH01', { refPriceCents: 1_000 });
    const noRef = await material('TH02');
    const po = (cents: number) =>
      api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId, orderDate: today, lines: [{ materialId: m.id, purchaseQtyMilli: q(1), priceCents: cents }] });
    expect((await ok(po(10_000))).po.status).toBe('approved');
    expect((await ok(po(300_000))).po.status).toBe('submitted');
    const opening = (cents: number) =>
      api(ctx.app, payer, 'POST', '/api/payables/openings', { clientKey: randomUUID(), supplierId, amountCents: cents, asOfDate: today, note: '门槛测试' });
    expect((await ok(opening(10_000))).opening.status).toBe('confirmed');
    expect((await ok(opening(300_000))).opening.status).toBe('submitted');
    await ok(doc(ctx.owner, { docType: 'opening', approveNow: true, lines: [{ materialId: m.id, qtyMilli: q(50) }, { materialId: noRef.id, qtyMilli: q(50) }] }));
    // 报损按物料参考价估算：1 个 = 1 元；没有参考价的照旧要确认
    expect((await ok(doc(keeper, { docType: 'damage', note: '破损', lines: [{ materialId: m.id, qtyMilli: q(2) }] }))).doc.status).toBe('confirmed');
    expect((await ok(doc(keeper, { docType: 'damage', note: '破损', lines: [{ materialId: noRef.id, qtyMilli: q(2) }] }))).doc.status).toBe('submitted');
    // 门槛在后台「规则总表 → 库存与采购」调
    const settings = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/settings')).body;
    expect(settings).toMatchObject({ approvalThresholdCents: 200_000, usageWindowDays: 28 });
    const saved = await ok(api(ctx.app, ctx.owner, 'PUT', '/api/inventory/settings', { ...settings, approvalThresholdCents: 0 }), 200);
    expect(saved.approvalThresholdCents).toBe(0);
    expect((await ok(po(10_000))).po.status).toBe('submitted');
    await ok(api(ctx.app, ctx.owner, 'PUT', '/api/inventory/settings', { ...settings, approvalThresholdCents: 200_000 }), 200);
  });
});

describe('分岗不兼任（#17）', () => {
  it('员工的职责跨组时拒绝保存；财务组内可以同时有；停用的员工不用先改', async () => {
    const create = (username: string, duties: string[]) =>
      api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, role: 'backoffice', duties, password: 'Strong-pass-2026' });
    const bad = await create('dc-1', ['stock', 'purchase']);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('DUTY_CONFLICT');
    expect(bad.body.error.message).toContain('仓库、采购');
    expect((await create('dc-2', ['approve', 'stock'])).body.error.code).toBe('DUTY_CONFLICT');
    expect((await create('dc-3', ['payable', 'cost'])).status).toBe(201);
    // 升级前就跨组的员工：保存时要先改成一组；停用可以直接保存
    const old = await createStaff(ctx.sql, { username: 'dc-old', displayName: '老员工', role: 'backoffice', duties: ['purchase', 'payable'], password: PASSWORD, mustChangePassword: false });
    const put = (active: boolean, duties: string[]) => api(ctx.app, ctx.owner, 'PUT', `/api/staff/${old}`, { displayName: '老员工', role: 'backoffice', duties, active });
    expect((await put(true, ['purchase', 'payable'])).body.error.code).toBe('DUTY_CONFLICT');
    expect((await put(false, ['purchase', 'payable'])).status).toBe(200);
    expect((await put(true, ['payable'])).status).toBe(200);
  });
});

describe('运费单独记费用（#15）', () => {
  it('费用科目有运费；运费单独一行、不关联采购单的物料行；账目自检第 6 条认运费', async () => {
    const claim = (lines: unknown[]) =>
      api(ctx.app, coster, 'POST', '/api/erp/expenses', {
        clientKey: randomUUID(),
        expenseDate: today,
        departmentId: bathId,
        handlerId: costerId,
        purpose: '其他',
        paySource: 'company',
        invoiceType: 'receipt',
        taxRateBp: 0,
        lines,
      });
    const freight = { name: '快递运费', category: 'freight', unit: '次', boughtMilli: q(1), receivedMilli: q(1), amountCents: 1_500 };
    const ok1 = await ok(claim([freight]));
    expect(ok1.claim.lines[0]).toMatchObject({ category: 'freight', poLineId: null });
    expect((await claim([{ ...freight, poLineId: 1 }])).status).toBe(400);
    const audit = (await api(ctx.app, coster, 'GET', '/api/erp/audit')).body;
    expect(audit.rules.find((r: { no: number }) => r.no === 6)).toMatchObject({ ok: true });
  });
});

describe('按可用天数提醒（#22）', () => {
  it('设了提醒天数的物料按近 28 天的用量算可用天数；少于提醒天数时提醒；部门小仓按耗用', async () => {
    const m = await material('CV01', { coverDays: 7 });
    await ok(doc(ctx.owner, { docType: 'opening', approveNow: true, lines: [{ materialId: m.id, qtyMilli: q(100) }] }));
    let mat = (await api(ctx.app, keeper, 'GET', `/api/inventory/materials/${m.id}`)).body;
    expect(mat).toMatchObject({ coverDays: 7, dailyUsageMilli: 0, daysOfCover: null, isLow: false });
    // 领料 56 个：日均 2 个，结存 44 个可用 22 天
    await ok(doc(keeper, { docType: 'issue', departmentId: bathId, handler: '浴区', lines: [{ materialId: m.id, qtyMilli: q(56) }] }));
    mat = (await api(ctx.app, keeper, 'GET', `/api/inventory/materials/${m.id}`)).body;
    expect(mat).toMatchObject({ dailyUsageMilli: q(2), daysOfCover: 22, isLow: false });
    // 再领 30 个：近 28 天用了 86 个，结存 14 个只够 4.5 天，少于 7 天
    await ok(doc(keeper, { docType: 'issue', departmentId: bathId, handler: '浴区', lines: [{ materialId: m.id, qtyMilli: q(30) }] }));
    mat = (await api(ctx.app, keeper, 'GET', `/api/inventory/materials/${m.id}`)).body;
    expect(mat).toMatchObject({ daysOfCover: 4.5, isLow: true });
    expect((await api(ctx.app, keeper, 'GET', '/api/inventory/overview')).body.lowCount).toBeGreaterThanOrEqual(1);
    // 部门小仓：盘点耗用 28 个（日均 1 个），结存 58 个可用 58 天
    const book = (await api(ctx.app, keeper, 'GET', `/api/inventory/warehouses/${bathWh}/stock`)).body.find((r: { materialId: number }) => r.materialId === m.id);
    expect(book.stockMilli).toBe(q(86));
    const count = await ok(doc(ctx.owner, { docType: 'count', warehouseId: bathWh, lines: [{ materialId: m.id, countedMilli: q(58), expectedBookMilli: q(86) }] }));
    expect(count.doc.status).toBe('confirmed');
    const row = (await api(ctx.app, keeper, 'GET', `/api/inventory/warehouses/${bathWh}/stock`)).body.find((r: { materialId: number }) => r.materialId === m.id);
    expect(row).toMatchObject({ stockMilli: q(58), coverDays: 7, dailyUsageMilli: q(1), daysOfCover: 58, isLow: false });
  });
});

describe('供应商与期初未付批量导入（#16）', () => {
  const file = (kind: string, csv: string, fileName = `${kind}.csv`) => ({ kind, fileName, csv });

  it('预览逐行校验；有问题整份不写；同一个文件只写一次；没有权限的看不到', async () => {
    const bad = file('suppliers', '编码,名称,联系人,电话,结算方式,备注\nIM01,导入供应商一,张三,13800000001,挂账,\nIM01,重复的编码,,,,\nIM03,,,,月付,');
    const preview = (await ok(api(ctx.app, ctx.owner, 'POST', '/api/payables/imports/preview', bad), 200)) as { rowCount: number; issues: { row: number; message: string }[] };
    expect(preview.rowCount).toBe(3);
    expect(preview.issues.map((i) => i.row)).toEqual([3, 4]);
    expect(preview.issues[0]!.message).toContain('与第 2 行重复');
    expect(preview.issues[1]!.message).toContain('名称为空');
    const rejected = await api(ctx.app, ctx.owner, 'POST', '/api/payables/imports', bad);
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('IMPORT_INVALID');
    expect(await ctx.sql`SELECT 1 FROM suppliers WHERE code = 'IM01'`).toHaveLength(0);
    expect((await api(ctx.app, keeper, 'POST', '/api/payables/imports/preview', bad)).status).toBe(403);

    const good = file('suppliers', '﻿名称,编码,结算方式\n导入供应商一,IM01,挂账\n导入供应商二,IM02,现付');
    const applied = await ok(api(ctx.app, ctx.owner, 'POST', '/api/payables/imports', good));
    expect(applied.import).toMatchObject({ kind: 'suppliers', rowCount: 2 });
    const rows = await ctx.sql<{ code: string; settlement: string; importId: number }[]>`SELECT code, settlement, import_id FROM suppliers WHERE code IN ('IM01', 'IM02') ORDER BY code`;
    expect(rows).toEqual([
      { code: 'IM01', settlement: 'credit', importId: applied.import.id },
      { code: 'IM02', settlement: 'cash', importId: applied.import.id },
    ]);
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/payables/imports', good);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, import: { id: applied.import.id } });
    expect((await ok(api(ctx.app, ctx.owner, 'POST', '/api/payables/imports/preview', good), 200)).duplicateOf).toMatchObject({ id: applied.import.id });
  });

  it('期初未付：免确认门槛以内的直接确认，超过的等负责人，可以一次确认整批', async () => {
    const csv = `供应商编码,金额,截至日期,备注\nIM01,"1,200.50",${today.replaceAll('-', '/')},对账确认\nIM01,3000,${today},`;
    const applied = await ok(api(ctx.app, payer, 'POST', '/api/payables/imports', file('opening_payables', csv)));
    expect(applied.import).toMatchObject({ kind: 'opening_payables', rowCount: 2, totalCents: 420_050 });
    const ops = await ctx.sql<{ amountCents: number; status: string }[]>`
      SELECT amount_cents, status FROM opening_payables WHERE import_id = ${applied.import.id} ORDER BY amount_cents`;
    expect(ops).toEqual([
      { amountCents: 120_050, status: 'confirmed' },
      { amountCents: 300_000, status: 'submitted' },
    ]);
    expect((await api(ctx.app, payer, 'POST', `/api/payables/imports/${applied.import.id}/approve-openings`, {})).status).toBe(403);
    expect((await ok(api(ctx.app, approver, 'POST', `/api/payables/imports/${applied.import.id}/approve-openings`, {}), 200)).approved).toBe(1);
    const unknown = await ok(api(ctx.app, payer, 'POST', '/api/payables/imports/preview', file('opening_payables', '供应商编码,金额,截至日期\nNOPE,10,2026-01-01\nIM01,-5,2026-01-01')), 200);
    expect(unknown.issues.map((i: { message: string }) => i.message)).toEqual([expect.stringContaining('没有编码为 NOPE'), expect.stringContaining('大于 0')]);
    await checksOk();
  });
});
