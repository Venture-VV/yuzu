// 库存与采购第二段：合成数据的预期结果、采购单（版本、确认、分批收货、关闭）、先收货后补单、
// 付款核销（不超额、不重复、并发）、对账单与权限。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { demoData, seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let boss: string; // 演示店主 linlan
let keeper: string; // 物资经办
let buyer: string; // 采购经办（v0.7.12 分岗不兼任：对账付款另有其人）
let payer: string; // 对账付款
let approver: string; // 只有负责人职责
let buyerId: number; // 收货时一起验收的采购经办（v0.7.11，#17）
const demo = demoData();
const q = (n: number) => Math.round(n * 1000);

const byCode = async (code: string) => {
  const res = await api(ctx.app, ctx.owner, 'GET', '/api/inventory/materials?all=1');
  return res.body.find((m: { code: string }) => m.code === code);
};
const supplierId = async (code: string) => {
  const res = await api(ctx.app, ctx.owner, 'GET', '/api/inventory/suppliers?all=1');
  return res.body.find((s: { code: string }) => s.code === code).id as number;
};

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  const result = await seedInventoryDemo(ctx.sql, ctx.config);
  expect(result.skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  payer = await login(ctx.app, 'qianfen', 'yuzu2026');
  buyerId = (await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'zhouyi'`)[0]!.id;
  await createStaff(ctx.sql, { username: 'appr', displayName: '负责人', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
  approver = await login(ctx.app, 'appr');
}, 120_000);
afterAll(async () => ctx.close());

describe('合成数据：与附件预期结果逐项一致', () => {
  it('20 项试点物料的期末库存', async () => {
    const res = await api(ctx.app, boss, 'GET', `/api/inventory/summary?from=2026-10-01&to=${today}`);
    for (const e of demo.expected.inventory) {
      const row = res.body.find((r: { code: string }) => r.code === e.materialCode);
      expect(row, e.materialCode).toBeTruthy();
      expect({ code: e.materialCode, closing: row.closing, received: row.received, issued: row.issued, returned: row.issueReturned, direct: row.directUsed, damaged: row.damaged, count: row.countAdjusted, supplierReturn: row.supplierReturned }).toEqual({
        code: e.materialCode,
        closing: q(Number(e.closing)),
        received: q(Number(e.received)),
        issued: q(Number(e.issued)),
        returned: q(Number(e.issueReturns)),
        direct: q(Number(e.directUsed)),
        damaged: q(Number(e.damaged)),
        count: q(Number(e.approvedCountAdjustment)),
        supplierReturn: q(Number(e.supplierReturns)),
      });
    }
  });

  it('两级库存（v0.7.11）：领料进领料部门的小仓，部门小仓结存 = 领料 − 退回；领料都待部门签收', async () => {
    const expected = new Map<string, number>();
    const issueDept = new Map(demo.issues.map((i) => [i.id, i.department]));
    for (const i of demo.issues) for (const l of i.lines) expected.set(`${i.department}|${l.materialCode}`, (expected.get(`${i.department}|${l.materialCode}`) ?? 0) + q(Number(l.quantity)));
    for (const r of demo.issueReturns) {
      const k = `${issueDept.get(r.sourceIssueId)}|${r.materialCode}`;
      expected.set(k, expected.get(k)! - q(Number(r.quantity)));
    }
    const rows = await ctx.sql<{ dept: string; code: string; stock: number }[]>`
      SELECT d.name AS dept, m.code, ws.stock_milli AS stock FROM warehouse_stock ws
      JOIN warehouses w ON w.id = ws.warehouse_id JOIN departments d ON d.id = w.department_id JOIN materials m ON m.id = ws.material_id
      WHERE ws.stock_milli <> 0`;
    expect(new Map(rows.map((r) => [`${r.dept}|${r.code}`, r.stock]))).toEqual(new Map([...expected].filter(([, v]) => v !== 0)));
    const unsigned = await api(ctx.app, boss, 'GET', '/api/inventory/docs?type=issue&unsigned=1');
    expect(unsigned.body).toHaveLength(demo.issues.length);
  });

  it('供应商货款：期初未付 + 收货 − 退货 − 付款 = 余额', async () => {
    const res = await api(ctx.app, boss, 'GET', '/api/payables/overview');
    for (const e of demo.expected.suppliers) {
      const s = res.body.suppliers.find((x: { code: string }) => x.code === e.supplierCode);
      expect({ code: s.code, opening: s.openingCents, received: s.receivedCents, credit: s.returnCreditCents, paid: s.paidCents, balance: s.balanceCents }).toEqual({
        code: e.supplierCode,
        opening: e.openingPayableCents,
        received: e.receivedCents,
        credit: e.returnCreditCents,
        paid: e.paidCents,
        balance: e.closingPayableCents,
      });
    }
    const t = demo.expected.totals;
    expect(res.body.totals).toEqual({
      openingCents: t.openingPayableCents,
      receivedCents: t.receivedCents,
      returnCreditCents: t.returnCreditCents,
      paidCents: t.paidCents,
      refundedCents: 0,
      balanceCents: t.closingPayableCents,
      creditCents: 0,
    });
  });

  it('核心订单 PO-001：确认货款 1,800、退货 18、已付 1,000、未付 782；拒收的 2 箱未入库未计款', async () => {
    const list = await api(ctx.app, boss, 'GET', '/api/purchase-orders');
    const s001 = await supplierId('S001');
    const po001 = list.body.filter((p: { supplierId: number }) => p.supplierId === s001).find((p: { summary: string }) => p.summary.includes('拖鞋'));
    const po = (await api(ctx.app, boss, 'GET', `/api/purchase-orders/${po001.id}`)).body;
    const c = demo.expected.canonicalOrder;
    expect(po.totalCents).toBe(180000);
    expect(po.receivedCents).toBe(c.acceptedAmountCents);
    expect(po.returnCreditCents).toBe(c.returnCreditCents);
    expect(po.paidCents).toBe(c.paidCents);
    expect(po.unpaidCents).toBe(c.unpaidCents);
    expect(po.receiving).toBe('full');
    expect(po.receipts).toHaveLength(2);
    const slipper = await byCode('M001');
    expect(slipper.stockMilli).toBe(q(Number(c.closingStockQuantity)));
    const first = (await api(ctx.app, boss, 'GET', `/api/inventory/docs/${po.receipts[0].id}`)).body;
    expect(first.lines[0]).toMatchObject({ deliveredMilli: q(1000), qtyMilli: q(800), rejectedMilli: q(200), amountCents: 144000 });
  });

  it('同规格比价：洗发水 110 → 115 元/桶，+4.55%', async () => {
    const pc = demo.expected.priceComparison;
    const m = await byCode(pc.materialCode);
    const docs = await api(ctx.app, boss, 'GET', `/api/inventory/docs?type=receipt&materialId=${m.id}`);
    const newest = (await api(ctx.app, boss, 'GET', `/api/inventory/docs/${docs.body[0].id}`)).body;
    const line = newest.lines.find((l: { materialId: number }) => l.materialId === m.id);
    expect(line.priceCents).toBe(pc.newUnitPriceCents);
    expect(line.compare.baseline.priceCents).toBe(pc.oldUnitPriceCents);
    expect(line.compare.changePercent).toBe(Number(pc.changePercent));
    // 采购单上同样显示（比较对象排除本单自己的收货）
    const po = (await api(ctx.app, boss, 'GET', `/api/purchase-orders/${newest.purchaseOrder.id}`)).body;
    expect(po.lines[0].compare.changePercent).toBe(4.55);
    // 没有可比历史时不计算
    const first = (await api(ctx.app, boss, 'GET', `/api/inventory/docs/${docs.body[1].id}`)).body;
    expect(first.lines.find((l: { materialId: number }) => l.materialId === m.id).compare).toEqual({ baseline: null, changePercent: null });
  });

  it('低库存提醒与待处理事项', async () => {
    const res = await api(ctx.app, boss, 'GET', '/api/inventory/materials');
    expect(res.body.filter((m: { isLow: boolean }) => m.isLow).map((m: { code: string }) => m.code).sort()).toEqual([...demo.expected.lowStockCodes].sort());
    // PO-008 尚未批准：没有收货、入库或应付
    const pending = await api(ctx.app, boss, 'GET', '/api/purchase-orders?status=submitted');
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0]).toMatchObject({ receivedCents: 0, receiving: 'none' });
    // CT-002 待核差异 -1 卷，卷纸仍为 90 卷
    expect((await byCode('M012')).stockMilli).toBe(q(90));
    const counts = await api(ctx.app, boss, 'GET', '/api/inventory/docs?type=count&status=submitted');
    expect(counts.body).toHaveLength(1);
  });

  it('自检全部通过；再次执行跳过；试用环境与已有真实数据时拒绝', async () => {
    const checks = await api(ctx.app, boss, 'GET', '/api/inventory/checks');
    for (const c of checks.body) expect(c, c.label).toMatchObject({ ok: true });
    expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(true);
    await expect(seedInventoryDemo(ctx.sql, { ...ctx.config, env: 'trial' })).rejects.toThrow(/试用/);
    await expect(seedInventoryDemo(ctx.sql, { ...ctx.config, env: 'production' })).rejects.toThrow(/正式/);
  });
});

describe('采购单', () => {
  let sup: number;
  let mat: { id: number };
  beforeAll(async () => {
    sup = await supplierId('S004');
    mat = await byCode('M016'); // 一次性护理床单，1 箱 = 500 张
  });

  const newPo = (cookie: string, body: Record<string, unknown> = {}) =>
    api(ctx.app, cookie, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      supplierId: sup,
      orderDate: today,
      lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45000 }],
      ...body,
    });
  const receive = (poId: number, poLineId: number, accepted: number, cookie = keeper) =>
    api(ctx.app, cookie, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId: sup,
      purchaseOrderId: poId,
      coAcceptorId: buyerId,
      lines: [{ materialId: mat.id, poLineId, deliveredMilli: q(accepted), acceptedMilli: q(accepted) }],
    });

  it('确认后才能收货；分批收货不能超出未到数量；改版保留旧版本并重新确认；关闭后不能再收', async () => {
    expect((await newPo(keeper)).status).toBe(403);
    const created = await newPo(buyer);
    expect(created.status).toBe(201);
    const po = created.body.po;
    expect(po.status).toBe('submitted');
    expect(po.lines[0]).toMatchObject({ baseQtyMilli: q(1000), amountCents: 90000 });
    // 有同口径成交价（RC-005 的 450 元/箱）
    expect(po.lines[0].compare.changePercent).toBe(0);

    const early = await receive(po.id, po.lines[0].id, 500);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('PO_NOT_APPROVED');
    // 采购经办不能自己确认
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/approve`, {})).status).toBe(403);
    expect((await api(ctx.app, approver, 'POST', `/api/purchase-orders/${po.id}/approve`, {})).body.status).toBe('approved');

    const r1 = await receive(po.id, po.lines[0].id, 500);
    expect(r1.status).toBe(201);
    expect(r1.body.doc.amountCents).toBe(45000);
    const over = await receive(po.id, po.lines[0].id, 600);
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('RECEIPT_EXCEEDS_ORDER');
    let detail = (await api(ctx.app, buyer, 'GET', `/api/purchase-orders/${po.id}`)).body;
    expect(detail.receiving).toBe('partial');

    const revise = (lines: unknown) => api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/revise`, { supplierId: sup, orderDate: today, lines });
    const below = await revise([{ id: po.lines[0].id, materialId: mat.id, purchaseQtyMilli: 500, priceCents: 45000 }]);
    expect(below.body.error.code).toBe('PO_QTY_BELOW_RECEIVED');
    const reprice = await revise([{ id: po.lines[0].id, materialId: mat.id, purchaseQtyMilli: q(3), priceCents: 46000 }]);
    expect(reprice.body.error.code).toBe('PO_PRICE_LOCKED');
    const ok = await revise([{ id: po.lines[0].id, materialId: mat.id, purchaseQtyMilli: q(3), priceCents: 45000 }]);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'submitted', revision: 2, totalCents: 135000 });
    expect(ok.body.revisions[0]).toMatchObject({ revision: 1 });
    expect(ok.body.revisions[0].snapshot.totalCents).toBe(90000);
    // 改版待确认期间不能收货
    expect((await receive(po.id, po.lines[0].id, 500)).body.error.code).toBe('PO_NOT_APPROVED');
    await api(ctx.app, approver, 'POST', `/api/purchase-orders/${po.id}/approve`, {});
    expect((await receive(po.id, po.lines[0].id, 500)).status).toBe(201);

    // 已有收货的采购单不能撤回，只能关闭
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/cancel`, { reason: '不要了' })).status).toBe(409);
    const closed = await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/close`, { reason: '供应商缺货，剩余不再到货' });
    expect(closed.body.status).toBe('closed');
    expect((await receive(po.id, po.lines[0].id, 500)).body.error.code).toBe('PO_NOT_APPROVED');
    detail = (await api(ctx.app, buyer, 'GET', `/api/purchase-orders/${po.id}`)).body;
    expect(detail.lines[0].receivedMilli).toBe(q(1000));
    expect(detail.approvals.map((a: { action: string }) => a.action)).toEqual(['create', 'submit', 'approve', 'revise', 'submit', 'approve', 'close']);
  });

  it('同一操作编号只建一张采购单', async () => {
    const key = randomUUID();
    const body = { clientKey: key, supplierId: sup, orderDate: today, action: 'save', lines: [{ materialId: mat.id, purchaseQtyMilli: q(1), priceCents: 45000 }] };
    const [a, b] = await Promise.all([api(ctx.app, buyer, 'POST', '/api/purchase-orders', body), api(ctx.app, buyer, 'POST', '/api/purchase-orders', body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.po.id).toBe(b.body.po.id);
  });

  it('急采与补单：部门登记、仓库验收后进部门小仓；补单只关联原收货，不再入库、不再形成应付（v0.7.11，#19）', async () => {
    const material = async () => (await api(ctx.app, boss, 'GET', '/api/inventory/materials')).body.find((m: { id: number }) => m.id === mat.id);
    const before = await material();
    const balance = async () => (await api(ctx.app, boss, 'GET', '/api/payables/overview')).body.suppliers.find((s: { supplierId: number }) => s.supplierId === sup).balanceCents;
    // 没有采购单不能收货（#19）
    const direct = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId: sup,
      lines: [{ materialId: mat.id, deliveredMilli: q(500), acceptedMilli: q(500), priceCents: 45000 }],
    });
    expect(direct.status).toBe(422);
    expect(direct.body.error.code).toBe('PO_REQUIRED');
    // 浴区的部门申购登记急采
    const [dept] = await ctx.sql<{ id: number }[]>`SELECT id FROM departments WHERE name = '浴区'`;
    await createStaff(ctx.sql, { username: 'bath-req', displayName: '浴区申购', role: 'backoffice', duties: ['request'], departmentId: dept!.id, password: PASSWORD, mustChangePassword: false });
    const deptUser = await login(ctx.app, 'bath-req');
    const rc = await api(ctx.app, deptUser, 'POST', '/api/erp/dept-stock/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId: sup,
      urgent: true,
      departmentId: dept!.id,
      lines: [{ materialId: mat.id, deliveredMilli: q(500), acceptedMilli: q(500), priceCents: 45000 }],
    });
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    expect(rc.body.doc).toMatchObject({ status: 'submitted', urgent: true, noPo: true, urgentCapCents: 200000, amountCents: 45000 });
    // 仓库到部门验收后生效：进部门小仓，总仓不变
    const verified = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${rc.body.doc.id}/verify-urgent`, {});
    expect(verified.body.status).toBe('confirmed');
    const afterReceipt = await balance();
    expect((await material()).stockMilli).toBe(before.stockMilli);
    expect((await material()).deptStockMilli).toBe(before.deptStockMilli + q(500));

    const bf = await api(ctx.app, buyer, 'POST', '/api/purchase-orders/backfill', { clientKey: randomUUID(), receiptDocId: rc.body.doc.id });
    expect(bf.status).toBe(201);
    expect(bf.body.po).toMatchObject({ backfill: true, status: 'submitted', totalCents: 45000 });
    const again = await api(ctx.app, buyer, 'POST', '/api/purchase-orders/backfill', { clientKey: randomUUID(), receiptDocId: rc.body.doc.id });
    expect(again.body.error.code).toBe('BACKFILL_EXISTS');
    const ok = await api(ctx.app, approver, 'POST', `/api/purchase-orders/${bf.body.po.id}/approve`, {});
    expect(ok.body).toMatchObject({ status: 'approved', receiving: 'full', receivedCents: 45000 });
    const linked = (await api(ctx.app, boss, 'GET', `/api/inventory/docs/${rc.body.doc.id}`)).body;
    expect(linked.purchaseOrder.id).toBe(bf.body.po.id);
    expect((await material()).deptStockMilli).toBe(before.deptStockMilli + q(500));
    expect(await balance()).toBe(afterReceipt);
    // 补单不能当作普通采购单继续收货
    const open = await api(ctx.app, keeper, 'GET', `/api/purchase-orders?open=1&supplierId=${sup}`);
    expect(open.body.some((p: { id: number }) => p.id === bf.body.po.id)).toBe(false);
  });
});

describe('付款登记', () => {
  it('不能超额、不能重复核销；核销合计必须等于付款；并发时只有一笔成功', async () => {
    const s2 = await supplierId('S002');
    const items = (await api(ctx.app, payer, 'GET', `/api/payables/suppliers/${s2}/open-items`)).body;
    // RC-003 1,214 元已付 1,000；RC-008 230 元未付
    const rc003 = items.find((i: { amountCents: number }) => i.amountCents === 121400);
    const rc008 = items.find((i: { amountCents: number }) => i.amountCents === 23000);
    expect(rc003.openCents).toBe(21400);
    expect(rc008.openCents).toBe(23000);

    const pay = (allocations: unknown[], amountCents: number, key = randomUUID(), cookie = payer) =>
      api(ctx.app, cookie, 'POST', '/api/payables/payments', { clientKey: key, supplierId: s2, payDate: today, amountCents, method: 'bank_transfer', evidence: '流水尾号 0423', allocations });

    expect((await pay([{ kind: 'receipt', targetId: rc003.id, amountCents: 30000 }], 30000)).body.error.code).toBe('OVER_ALLOCATION');
    // 核销合计小于付款金额：没勾「其余记为预付款」拒绝（v0.7.12 起可以留预付款）
    expect((await pay([{ kind: 'receipt', targetId: rc003.id, amountCents: 10000 }], 20000)).status).toBe(400);
    expect((await pay([{ kind: 'receipt', targetId: rc003.id, amountCents: 10000 }], 10000, randomUUID(), keeper)).status).toBe(403);
    // 采购经办不兼对账付款（#17）
    expect((await pay([{ kind: 'receipt', targetId: rc003.id, amountCents: 10000 }], 10000, randomUUID(), buyer)).status).toBe(403);
    // 别的供应商的收货单不能核销
    const s1 = await supplierId('S001');
    const s1Items = (await api(ctx.app, payer, 'GET', `/api/payables/suppliers/${s1}/open-items`)).body;
    expect((await pay([{ kind: 'receipt', targetId: s1Items[0].id, amountCents: 100 }], 100)).body.error.code).toBe('ALLOCATION_TARGET_INVALID');

    // 两笔并发付款同时核销 RC-008 全额：只有一笔成功
    const results = await Promise.all([pay([{ kind: 'receipt', targetId: rc008.id, amountCents: 23000 }], 23000), pay([{ kind: 'receipt', targetId: rc008.id, amountCents: 23000 }], 23000)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const created = results.find((r) => r.status === 201)!.body.payment;
    expect(created.status).toBe('submitted');
    // 待确认的付款不计入余额，但占用未结清金额
    const after = (await api(ctx.app, payer, 'GET', `/api/payables/suppliers/${s2}/open-items`)).body.find((i: { id: number }) => i.id === rc008.id);
    expect(after).toMatchObject({ pendingCents: 23000, openCents: 0 });

    const before = (await api(ctx.app, boss, 'GET', '/api/payables/overview')).body.suppliers.find((s: { supplierId: number }) => s.supplierId === s2).balanceCents;
    const confirmed = await api(ctx.app, approver, 'POST', `/api/payables/payments/${created.id}/approve`, {});
    expect(confirmed.body.status).toBe('confirmed');
    const mid = (await api(ctx.app, boss, 'GET', '/api/payables/overview')).body.suppliers.find((s: { supplierId: number }) => s.supplierId === s2).balanceCents;
    expect(mid).toBe(before - 23000);

    // 演示数据的收货在 10 月：跨月不能冲销（#21，v0.7.11）；已有付款核销的收货单不能冲销另见两级库存的测试
    const voidReceipt = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${rc008.id}/void`, { reason: '测试冲销' });
    expect(voidReceipt.body.error.code).toBe(today.startsWith('2026-10') ? 'NOT_VOIDABLE' : 'VOID_CROSS_MONTH');

    // 冲销付款（#21：账务冲销由财务，负责人不能冲销）：余额恢复，货款重新可以核销
    expect((await api(ctx.app, approver, 'POST', `/api/payables/payments/${created.id}/void`, { reason: '付款登记错了供应商' })).status).toBe(403);
    const voided = await api(ctx.app, payer, 'POST', `/api/payables/payments/${created.id}/void`, { reason: '付款登记错了供应商' });
    expect(voided.body.status).toBe('voided');
    const end = (await api(ctx.app, boss, 'GET', '/api/payables/overview')).body.suppliers.find((s: { supplierId: number }) => s.supplierId === s2).balanceCents;
    expect(end).toBe(before);
    const reopened = (await api(ctx.app, payer, 'GET', `/api/payables/suppliers/${s2}/open-items`)).body.find((i: { id: number }) => i.id === rc008.id);
    expect(reopened.openCents).toBe(23000);
  });

  it('对账单：上期结余 + 本期各项 = 期末，与余额一致；导出受权限控制', async () => {
    const s1 = await supplierId('S001');
    const st = (await api(ctx.app, payer, 'GET', `/api/payables/statement?supplierId=${s1}&from=2026-10-01&to=${today}`)).body;
    expect(st.beginCents).toBe(0);
    expect(st.endCents).toBe(st.beginCents + st.openingCents + st.receivedCents - st.returnCreditCents - st.paidCents + st.refundedCents);
    expect(st.endCents).toBe(310200);
    expect(st.rows.at(-1).balanceCents).toBe(st.endCents);
    // 退货后供应商对 RC-001 的未结清：1,440 − 18 − 1,000 = 422
    const rc001 = st.openItems.find((i: { amountCents: number }) => i.amountCents === 144000);
    expect(rc001).toMatchObject({ creditCents: 1800, offsetCents: 0, paidCents: 100000, openCents: 42200 });
    expect(st.credits).toEqual([]);
    expect((await api(ctx.app, keeper, 'GET', `/api/payables/statement?supplierId=${s1}&from=2026-10-01&to=${today}`)).status).toBe(403);
    expect((await api(ctx.app, keeper, 'GET', `/api/payables/statement/export?supplierId=${s1}&from=2026-10-01&to=${today}`)).status).toBe(403);
    // 对账付款职责可以导出
    const csv = await api(ctx.app, payer, 'GET', `/api/payables/statement/export?supplierId=${s1}&from=2026-10-01&to=${today}`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('3102.00');
  });

  it('期初未付：已核销的不能冲销', async () => {
    const s3 = await supplierId('S003');
    const openings = (await api(ctx.app, payer, 'GET', `/api/payables/openings?supplierId=${s3}`)).body;
    expect(openings[0]).toMatchObject({ amountCents: 20000, paidCents: 20000, status: 'confirmed' });
    const v = await api(ctx.app, payer, 'POST', `/api/payables/openings/${openings[0].id}/void`, { reason: '测试' });
    expect(v.body.error.code).toBe('NOT_VOIDABLE');
  });
});
