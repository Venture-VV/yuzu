// 库存第一段：期初、收货（含拒收）、领用 / 退回、直接耗用、报损、盘点（待核差异 → 负责人确认）、
// 退供应商、冲销，以及幂等、并发、权限与账实自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext, useLegacyQuoteThreshold } from './helpers';

let ctx: TestContext;
/** 物资经办（后勤人员，只有库存职责） */
let keeper: string;
/** 库存采购负责人（后勤人员，只有确认职责） */
let approver: string;
let today: string;
let deptId: number;
let supplierId: number;
/** 采购经办（收货时一起验收，#17） */
let buyerId: number;

const q = (n: number) => Math.round(n * 1000);

async function material(code: string, over: Record<string, unknown> = {}) {
  const res = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', {
    code,
    name: `测试物料${code}`,
    specification: '标准规格',
    inventoryUnit: '双',
    purchaseUnit: '箱',
    purchaseFactorMilli: q(100),
    ...over,
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as { id: number; stockMilli: number };
}

async function doc(cookie: string, body: Record<string, unknown>, key = randomUUID()) {
  return api(ctx.app, cookie, 'POST', '/api/inventory/docs', { clientKey: key, docDate: today, ...body });
}

async function okDoc(cookie: string, body: Record<string, unknown>) {
  const res = await doc(cookie, body);
  if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body.doc;
}

async function stockOf(id: number) {
  const res = await api(ctx.app, ctx.owner, 'GET', `/api/inventory/materials/${id}`);
  return res.body.stockMilli as number;
}

/** 已确认的采购单（v0.7.11 起收货必须按采购单，#19）：店主建单并确认 */
async function approvedPo(materialId: number, purchaseQtyMilli: number, priceCents: number) {
  const res = await api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', {
    clientKey: randomUUID(),
    supplierId,
    orderDate: today,
    approveNow: true,
    lines: [{ materialId, purchaseQtyMilli, priceCents }],
  });
  if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  expect(res.body.po.status).toBe('approved');
  return res.body.po as { id: number; lines: { id: number; materialId: number }[] };
}

/** 按采购单收货（一起验收的是采购经办） */
function receiptBody(po: { id: number; lines: { id: number; materialId: number }[] }, line: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    docType: 'receipt',
    supplierId,
    purchaseOrderId: po.id,
    coAcceptorId: buyerId,
    lines: [{ materialId: po.lines[0]!.materialId, poLineId: po.lines[0]!.id, ...line }],
    ...extra,
  };
}

async function opening(materialId: number, qtyMilli: number) {
  const d = await okDoc(ctx.owner, { docType: 'opening', approveNow: true, lines: [{ materialId, qtyMilli }] });
  expect(d.status).toBe('confirmed');
  return d;
}

beforeAll(async () => {
  ctx = await setup();
  await useLegacyQuoteThreshold(ctx);
  today = todayIn(ctx.config.timezone);
  await createStaff(ctx.sql, { username: 'keeper', displayName: '物资小林', role: 'backoffice', duties: ['stock'], password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'boss2', displayName: '负责人老周', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
  buyerId = await createStaff(ctx.sql, { username: 'buyer1', displayName: '采购小陈', role: 'backoffice', duties: ['purchase'], password: PASSWORD, mustChangePassword: false });
  keeper = await login(ctx.app, 'keeper');
  approver = await login(ctx.app, 'boss2');
  const deps = await api(ctx.app, ctx.owner, 'GET', '/api/inventory/departments');
  deptId = deps.body.find((d: { name: string }) => d.name === '浴区').id;
  const s = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'S001', name: '合成洗浴用品供应商' });
  supplierId = s.body.find((x: { code: string }) => x.code === 'S001').id;
});
afterAll(async () => ctx.close());

describe('核心案例（库存部分）：拖鞋 箱入双出、拒收、领用、盘点、退供应商', () => {
  it('最终库存 967 双，确认货款 1,800 元，退货扣减 18 元', async () => {
    const slipper = await material('M001', { name: '宾客一次性拖鞋', specification: '均码 · 独立包装' });

    await opening(slipper.id, q(100));
    expect(await stockOf(slipper.id)).toBe(q(100));

    // 采购单 10 箱（每箱 100 双、180 元）；首批到 10 箱，验收 8 箱、拒收 2 箱：拒收部分不入库、不计货款
    const po = await approvedPo(slipper.id, q(10), 18000);
    const r1 = await okDoc(keeper, {
      ...receiptBody(po, { deliveredMilli: q(1000), acceptedMilli: q(800), rejectReason: '外箱压损受潮' }),
      handler: '小林',
    });
    expect(r1.status).toBe('confirmed');
    expect(r1.noPo).toBe(false);
    expect(r1.coAcceptor.id).toBe(buyerId);
    expect(r1.warehouse).toMatchObject({ id: 1, kind: 'central' });
    expect(r1.amountCents).toBe(144000);
    expect(r1.lines[0].rejectedMilli).toBe(q(200));
    expect(await stockOf(slipper.id)).toBe(q(900));

    const r2 = await okDoc(keeper, receiptBody(po, { deliveredMilli: q(200), acceptedMilli: q(200) }));
    expect(r2.amountCents).toBe(36000);
    expect(await stockOf(slipper.id)).toBe(q(1100));

    // 浴区领用 120 双（按双录入）
    const issue = await okDoc(keeper, {
      docType: 'issue',
      departmentId: deptId,
      handler: '浴区阿梅',
      lines: [{ materialId: slipper.id, qtyMilli: q(120), enteredQtyMilli: q(120), enteredUnit: '双' }],
    });
    expect(issue.status).toBe('confirmed');
    expect(await stockOf(slipper.id)).toBe(q(980));

    // 盘点实数 977：提交后是「待核差异」，库存不变
    const count = await okDoc(keeper, { docType: 'count', lines: [{ materialId: slipper.id, countedMilli: q(977) }] });
    expect(count.status).toBe('submitted');
    expect(count.lines[0].bookMilli).toBe(q(980));
    expect(count.lines[0].qtyMilli).toBe(q(-3));
    expect(count.lines[0].diffReason).toBeNull();
    expect(await stockOf(slipper.id)).toBe(q(980));

    // 物资经办不能自己确认盘点调整
    const self = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${count.id}/approve`, {});
    expect(self.status).toBe(403);

    const approved = await api(ctx.app, approver, 'POST', `/api/inventory/docs/${count.id}/approve`, {
      countReasons: { [count.lines[0].id]: 'unknown' },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('confirmed');
    expect(approved.body.lines[0].diffReason).toBe('unknown');
    expect(await stockOf(slipper.id)).toBe(q(977));

    // 关联首批收货退供应商 10 双：扣款按原价换算 = 18 元，不超过免确认门槛（#18，默认 2000 元）不用负责人确认，
    // 先等供应商确认（#20，v0.7.12）：这时库存、货款都不动
    const ret = await okDoc(keeper, {
      docType: 'supplier_return',
      sourceDocId: r1.id,
      note: '部分拖鞋开胶',
      lines: [{ sourceLineId: r1.lines[0].id, qtyMilli: q(10) }],
    });
    expect(ret.status).toBe('awaiting_supplier');
    expect(ret.amountCents).toBe(1800);
    expect(await stockOf(slipper.id)).toBe(q(977));
    const retOk = await api(ctx.app, ctx.owner, 'POST', `/api/inventory/docs/${ret.id}/supplier-answer`, { agreed: true, date: today, note: '供应商同意扣款' });
    expect(retOk.body.status).toBe('confirmed');
    expect(retOk.body.supplierAnswer).toMatchObject({ agreed: true, date: today, note: '供应商同意扣款' });
    expect(await stockOf(slipper.id)).toBe(q(967));

    // 应付流水：1,440 + 360 − 18 = 1,782 元
    const [ap] = await ctx.sql<{ total: number }[]>`SELECT sum(amount_delta_cents) AS total FROM ap_entries WHERE supplier_id = ${supplierId}`;
    expect(ap!.total).toBe(178200);

    // 库存卡逐笔可追溯
    const card = await api(ctx.app, ctx.owner, 'GET', `/api/inventory/materials/${slipper.id}/card`);
    expect(card.body.moves.map((m: { moveType: string }) => m.moveType).reverse()).toEqual([
      'opening',
      'receipt',
      'receipt',
      'issue',
      'count_adjust',
      'supplier_return',
    ]);
    expect(card.body.moves[0].qtyAfterMilli).toBe(q(967));

    // 期间汇总：期初 100 + 入库 1000 − 领用 120 − 3 − 退货 10 = 967
    const sum = await api(ctx.app, ctx.owner, 'GET', `/api/inventory/summary?from=${today}&to=${today}`);
    const row = sum.body.find((r: { materialId: number }) => r.materialId === slipper.id);
    expect(row).toMatchObject({ begin: 0, opening: q(100), received: q(1000), issued: q(120), countAdjusted: q(-3), supplierReturned: q(10), closing: q(967) });

    // 已有后续退货的收货单不能冲销
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/inventory/docs/${r1.id}/void`, { reason: '测试冲销' });
    expect(v.status).toBe(409);
    expect(v.body.error.code).toBe('NOT_VOIDABLE');
  });
});

describe('包装换算与退回', () => {
  it('饮用水箱入瓶出：退回 12 瓶、报损 4 瓶', async () => {
    const water = await material('M018', { name: '瓶装饮用水', inventoryUnit: '瓶', purchaseUnit: '箱', purchaseFactorMilli: q(24) });
    await opening(water.id, q(48));
    const waterPo = await approvedPo(water.id, q(10), 3600);
    await okDoc(keeper, receiptBody(waterPo, { deliveredMilli: q(240), acceptedMilli: q(240) }));
    // 按箱录入 9 箱 = 216 瓶；录入数量与换算不一致会被拒绝
    const bad = await doc(keeper, {
      docType: 'issue',
      departmentId: deptId,
      handler: '水吧',
      lines: [{ materialId: water.id, qtyMilli: q(9), enteredQtyMilli: q(9), enteredUnit: '箱' }],
    });
    expect(bad.status).toBe(400);
    const issue = await okDoc(keeper, {
      docType: 'issue',
      departmentId: deptId,
      handler: '水吧',
      lines: [{ materialId: water.id, qtyMilli: q(216), enteredQtyMilli: q(9), enteredUnit: '箱' }],
    });
    expect(issue.lines[0].enteredUnit).toBe('箱');
    const issue2 = await okDoc(keeper, { docType: 'issue', departmentId: deptId, handler: '水吧', lines: [{ materialId: water.id, qtyMilli: q(4) }] });
    expect(await stockOf(water.id)).toBe(q(68));

    // 退回不能超过原领用
    const over = await doc(keeper, { docType: 'issue_return', sourceDocId: issue2.id, lines: [{ sourceLineId: issue2.lines[0].id, qtyMilli: q(5) }] });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('RETURN_EXCEEDS_SOURCE');

    const back = await okDoc(keeper, { docType: 'issue_return', sourceDocId: issue.id, lines: [{ sourceLineId: issue.lines[0].id, qtyMilli: q(12) }] });
    expect(back.status).toBe('confirmed');
    expect(back.department.id).toBe(deptId);
    expect(await stockOf(water.id)).toBe(q(80));

    // 报损需要负责人确认（模拟规则）；提交人有确认权限时可一步确认
    const dmg = await okDoc(keeper, { docType: 'damage', note: '搬运摔裂', lines: [{ materialId: water.id, qtyMilli: q(4) }] });
    expect(dmg.status).toBe('submitted');
    expect(await stockOf(water.id)).toBe(q(80));
    await api(ctx.app, approver, 'POST', `/api/inventory/docs/${dmg.id}/approve`, {});
    expect(await stockOf(water.id)).toBe(q(76));

    // 原领用单已有退回，不能直接冲销
    const detail = await api(ctx.app, ctx.owner, 'GET', `/api/inventory/docs/${issue.id}`);
    expect(detail.body.voidable.ok).toBe(false);
    expect(detail.body.children.map((c: { docNo: string }) => c.docNo)).toEqual([back.docNo]);
    expect(detail.body.lines[0].returnedMilli).toBe(q(12));
  });

  it('直接耗用只出库一次；小数位按物料精度校验', async () => {
    const bags = await material('M014', { name: '垃圾袋卷', inventoryUnit: '卷', purchaseUnit: '包', purchaseFactorMilli: q(10) });
    await opening(bags.id, q(10));
    const use = await okDoc(keeper, { docType: 'direct_use', note: '总库清洁', lines: [{ materialId: bags.id, qtyMilli: q(1) }] });
    expect(use.status).toBe('confirmed');
    expect(await stockOf(bags.id)).toBe(q(9));
    const frac = await doc(keeper, { docType: 'direct_use', note: '总库清洁', lines: [{ materialId: bags.id, qtyMilli: 1500 }] });
    expect(frac.status).toBe(400);

    const gel = await material('M099', { name: '按摩介质（称重）', inventoryUnit: '千克', purchaseUnit: '桶', purchaseFactorMilli: q(5), decimals: 3 });
    await opening(gel.id, q(5));
    await okDoc(keeper, { docType: 'direct_use', note: 'SPA 使用', lines: [{ materialId: gel.id, qtyMilli: 1250 }] });
    expect(await stockOf(gel.id)).toBe(3750);
  });
});

describe('期初、库存不足与冲销', () => {
  it('期初只能建一次；不足时阻止出库；冲销按原流水反向', async () => {
    const m = await material('M050', { name: '一次性浴帽' });
    await opening(m.id, q(10));
    const again = await doc(ctx.owner, { docType: 'opening', approveNow: true, lines: [{ materialId: m.id, qtyMilli: q(5) }] });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('OPENING_EXISTS');

    const short = await doc(keeper, { docType: 'issue', departmentId: deptId, handler: '浴区', lines: [{ materialId: m.id, qtyMilli: q(11) }] });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(m.id)).toBe(q(10));
    // 失败的提交不会留下单据
    const [cnt] = await ctx.sql<{ n: number }[]>`SELECT count(*) AS n FROM inv_docs d JOIN inv_doc_lines l ON l.doc_id = d.id WHERE l.material_id = ${m.id}`;
    expect(cnt!.n).toBe(1);

    const issue = await okDoc(keeper, { docType: 'issue', departmentId: deptId, handler: '浴区', lines: [{ materialId: m.id, qtyMilli: q(6) }] });
    expect(await stockOf(m.id)).toBe(q(4));
    // #21：库存冲销由仓库（物资经办）或财务成本岗做，负责人不再冲销（v0.7.11）
    const denied = await api(ctx.app, approver, 'POST', `/api/inventory/docs/${issue.id}/void`, { reason: '部门选错' });
    expect(denied.status).toBe(403);
    const v = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${issue.id}/void`, { reason: '部门选错' });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('voided');
    expect(v.body.voidReason).toBe('部门选错');
    expect(await stockOf(m.id)).toBe(q(10));
    // 再次冲销幂等，不再反向
    const v2 = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${issue.id}/void`, { reason: '部门选错' });
    expect(v2.status).toBe(200);
    expect(await stockOf(m.id)).toBe(q(10));
    // 已冲销的领用单不能再退回
    const ret = await doc(keeper, { docType: 'issue_return', sourceDocId: issue.id, lines: [{ sourceLineId: issue.lines[0].id, qtyMilli: q(1) }] });
    expect(ret.status).toBe(422);
  });
});

describe('盘点期间有新收发', () => {
  it('旧盘点结果不能覆盖新变动，需要按最新账面重新核对', async () => {
    const m = await material('M012', { name: '卷纸', inventoryUnit: '卷', purchaseUnit: '提', purchaseFactorMilli: q(10) });
    await opening(m.id, q(90));
    const count = await okDoc(keeper, { docType: 'count', action: 'save', lines: [{ materialId: m.id, countedMilli: q(89) }] });
    expect(count.status).toBe('draft');
    await okDoc(keeper, { docType: 'issue', departmentId: deptId, handler: '保洁', lines: [{ materialId: m.id, qtyMilli: q(10) }] });

    const detail = await api(ctx.app, keeper, 'GET', `/api/inventory/docs/${count.id}`);
    expect(detail.body.lines[0].stale).toBe(true);
    const submit = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${count.id}/submit`, {});
    expect(submit.status).toBe(409);
    expect(submit.body.error.code).toBe('COUNT_STALE');

    const refreshed = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${count.id}/refresh-book`, {});
    expect(refreshed.body.lines[0].bookMilli).toBe(q(80));
    expect(refreshed.body.lines[0].stale).toBe(false);
    // 员工按新账面重新核对实盘：79 卷
    const upd = await api(ctx.app, keeper, 'PUT', `/api/inventory/docs/${count.id}`, {
      docType: 'count',
      docDate: today,
      action: 'submit',
      lines: [{ materialId: m.id, countedMilli: q(79) }],
    });
    expect(upd.status).toBe(200);
    expect(upd.body.status).toBe('submitted');
    expect(upd.body.lines[0].qtyMilli).toBe(q(-1));

    // 负责人退回修改，说明原因；退回后库存不变
    const back = await api(ctx.app, approver, 'POST', `/api/inventory/docs/${count.id}/return`, { reason: '请再数一遍货架下层' });
    expect(back.body.status).toBe('returned');
    expect(back.body.returnedReason).toBe('请再数一遍货架下层');
    expect(await stockOf(m.id)).toBe(q(80));

    // 待确认期间又有收发：负责人确认时也会拦截
    const resubmit = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${count.id}/submit`, {});
    expect(resubmit.body.status).toBe('submitted');
    await okDoc(keeper, { docType: 'issue', departmentId: deptId, handler: '保洁', lines: [{ materialId: m.id, qtyMilli: q(1) }] });
    const late = await api(ctx.app, approver, 'POST', `/api/inventory/docs/${count.id}/approve`, {});
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('COUNT_STALE');
    expect(await stockOf(m.id)).toBe(q(79));
  });

  it('页面上的账面数与服务端不一致时拒绝建单（填实盘期间有收发）', async () => {
    const m = await material('M015', { name: '丁腈手套', inventoryUnit: '盒', purchaseUnit: '箱', purchaseFactorMilli: q(10) });
    await opening(m.id, q(4));
    // 员工看到账面 4 盒时开始数，期间别人领走 1 盒
    await okDoc(keeper, { docType: 'issue', departmentId: deptId, handler: 'SPA', lines: [{ materialId: m.id, qtyMilli: q(1) }] });
    const res = await doc(keeper, { docType: 'count', lines: [{ materialId: m.id, countedMilli: q(4), expectedBookMilli: q(4) }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COUNT_STALE');
    const ok = await doc(keeper, { docType: 'count', lines: [{ materialId: m.id, countedMilli: q(3), expectedBookMilli: q(3) }] });
    expect(ok.status).toBe(201);
    expect(ok.body.doc.status).toBe('confirmed');
  });

  it('没有差异的盘点直接生效，不产生调整流水', async () => {
    const m = await material('M013', { name: '抽纸', inventoryUnit: '包', purchaseUnit: '箱', purchaseFactorMilli: q(30) });
    await opening(m.id, q(60));
    const count = await okDoc(keeper, { docType: 'count', lines: [{ materialId: m.id, countedMilli: q(60) }] });
    expect(count.status).toBe('confirmed');
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*) AS n FROM stock_moves WHERE doc_id = ${count.id}`;
    expect(n!.n).toBe(0);
  });
});

describe('重复提交与并发', () => {
  it('同一操作编号重试只生效一次；改了内容的重放被拒绝', async () => {
    const m = await material('M060', { name: '牙具套装', inventoryUnit: '套' });
    await opening(m.id, q(50));
    const key = randomUUID();
    const body = { docType: 'issue', departmentId: deptId, handler: '前台', lines: [{ materialId: m.id, qtyMilli: q(5) }] };
    const [a, b] = await Promise.all([doc(keeper, body, key), doc(keeper, body, key)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.doc.id).toBe(b.body.doc.id);
    const c = await doc(keeper, body, key);
    expect(c.status).toBe(200);
    expect(c.body.replayed).toBe(true);
    expect(await stockOf(m.id)).toBe(q(45));

    const changed = await doc(keeper, { ...body, lines: [{ materialId: m.id, qtyMilli: q(6) }] }, key);
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    const found = await api(ctx.app, keeper, 'GET', `/api/inventory/docs/by-key/${key}`);
    expect(found.body.found).toBe(true);
    expect(found.body.doc.id).toBe(a.body.doc.id);
    const missing = await api(ctx.app, keeper, 'GET', `/api/inventory/docs/by-key/${randomUUID()}`);
    expect(missing.body.found).toBe(false);
  });

  it('并发领用不会产生负库存', async () => {
    const m = await material('M061', { name: '一次性梳子', inventoryUnit: '把' });
    await opening(m.id, q(10));
    const results = await Promise.all(
      Array.from({ length: 6 }, () => doc(keeper, { docType: 'issue', departmentId: deptId, handler: '浴区', lines: [{ materialId: m.id, qtyMilli: q(3) }] })),
    );
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(3);
    expect(results.filter((r) => r.status === 422).every((r) => r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect(await stockOf(m.id)).toBe(q(1));
  });

  it('同一单内多行同一物料合并校验库存', async () => {
    const m = await material('M062', { name: '剃须套装', inventoryUnit: '套' });
    await opening(m.id, q(5));
    const res = await doc(keeper, {
      docType: 'issue',
      departmentId: deptId,
      handler: '浴区',
      lines: [
        { materialId: m.id, qtyMilli: q(3) },
        { materialId: m.id, qtyMilli: q(3) },
      ],
    });
    expect(res.status).toBe(422);
    expect(await stockOf(m.id)).toBe(q(5));
  });
});

describe('职责权限', () => {
  it('库存职责不带来会员与财务权限；无职责的店员看不到库存', async () => {
    expect((await api(ctx.app, keeper, 'GET', '/api/members?q=1')).status).toBe(403);
    expect((await api(ctx.app, keeper, 'GET', '/api/ledger')).status).toBe(403);
    expect((await api(ctx.app, keeper, 'GET', `/api/settlements/${today}`)).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/inventory/materials')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/inventory/docs')).status).toBe(403);
    // 物资经办不能维护档案、不能一步确认
    expect((await api(ctx.app, keeper, 'POST', '/api/inventory/suppliers', { code: 'S900', name: '越权供应商' })).status).toBe(403);
    const m = await material('M070', { name: '洗手液补充装', inventoryUnit: '桶', purchaseUnit: '箱', purchaseFactorMilli: q(4) });
    const self = await doc(keeper, { docType: 'opening', approveNow: true, lines: [{ materialId: m.id, qtyMilli: q(2) }] });
    expect(self.status).toBe(403);
    // 负责人（只有确认职责）不能录入收发
    const byApprover = await doc(approver, { docType: 'direct_use', note: '测试', lines: [{ materialId: m.id, qtyMilli: q(1) }] });
    expect(byApprover.status).toBe(403);
    // 会话里的权限清单与服务端一致
    const me = await api(ctx.app, keeper, 'GET', '/api/auth/me');
    expect(me.body.permissions).toContain('inventory.operate');
    expect(me.body.permissions).not.toContain('member.read');
    expect(me.body.permissions).not.toContain('inventory.approve');
  });

  it('期初提交后由负责人确认；撤回只限本人或负责人', async () => {
    const m = await material('M071', { name: '润肤乳', inventoryUnit: '瓶' });
    const d = await okDoc(keeper, { docType: 'opening', lines: [{ materialId: m.id, qtyMilli: q(6) }] });
    expect(d.status).toBe('submitted');
    expect(await stockOf(m.id)).toBe(0);
    const cancel = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${d.id}/cancel`, { reason: '数错了' });
    expect(cancel.body.status).toBe('cancelled');
    const d2 = await okDoc(keeper, { docType: 'opening', lines: [{ materialId: m.id, qtyMilli: q(6) }] });
    const ok = await api(ctx.app, approver, 'POST', `/api/inventory/docs/${d2.id}/approve`, {});
    expect(ok.body.status).toBe('confirmed');
    expect(ok.body.approvals.map((a: { action: string }) => a.action)).toEqual(['create', 'submit', 'approve']);
    expect(await stockOf(m.id)).toBe(q(6));
  });
});

describe('数据自检', () => {
  it('结存、流水与单据全部一致', async () => {
    const res = await api(ctx.app, ctx.owner, 'GET', '/api/inventory/checks');
    expect(res.status).toBe(200);
    for (const item of res.body) expect(item, item.label).toMatchObject({ ok: true });
  });
});
