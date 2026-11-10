// 8.0.7 A3.4 上线前全流程试跑（docs/ERP_V807.md 第 3.4 节；店主 D-1 照 docs/TRIAL_RUN.md 在演练库上走同一条路）：
//   ⓪ 供应商准入（营业执照、负责人准入）
//   ① 需求：部门申购提需求单，采购审核通过
//   ② 比价：采购从需求单发起询价，两家报价，定标
//   ③ 合同：采购起草（单价表、付款节点：到货付 100%），财务 → 法务 → 负责人审查，签署；询价单转采购单、挂合同，提交即确认（CG04）
//   ④ 收货：仓库按采购单收货（采购不参与，CG10；管效期的物料填批号与到期日），临期批次列出
//   ⑤ 领用与耗用：仓库领到部门，部门签收，部门耗用记用途与经办人
//   ⑥ 报销：备用金打款给成本核算，向现付供应商买零星物品、收货，按采购单报销，结余退回、打款结清
//   ⑦ 付款：财务登记发票（三单对得上），采购发起到货款付款申请，财务 → 负责人审批，财务按申请登记付款
//   ⑧ 对账确认：按批次登记对账，生成链接，供应商不用登录打开、确认无误
//   ⑨ 平账：供应商没有没付的收货单，合同的到货段付清，备用金结清，需求单显示已下单；所有自检全过。
// 每一步用该岗位的账号（不用店主一把做完），用到的数都在这里固定，便于和 TRIAL_RUN.md 对照。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { consistencyChecks } from '../src/server/ops/consistency';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { LEGAL_ITEM_KEYS, type ContractDetail } from '../src/shared/contracts';
import { shiftDate } from '../src/shared/labels';
import type { ContractPaymentPlan, PaymentRequestDetail } from '../src/shared/payments';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let boss: string; // 店主 linlan
let buyer: string; // 采购经办 zhouyi
let keeper: string; // 物资经办（仓库） lixiao
let payer: string; // 对账付款（财务） qianfen
let mgr: string; // 库存采购负责人
let lawyer: string; // 法务
let coster: string; // 成本核算
let bathUser: string; // 浴区的部门申购
let costerId: number;
let bathId: number;
let bathWh: number;

const q = (n: number) => Math.round(n * 1000);
async function ok<T = any>(res: Promise<{ status: number; body: any }>, status = 201): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const approveAt = (cookie: string, requestId: number, level: number, extra: Record<string, unknown> = {}) =>
  ok(api(ctx.app, cookie, 'POST', `/api/approvals/${requestId}/approve`, { level, comment: '', ...extra }), 200);

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  payer = await login(ctx.app, 'qianfen', 'yuzu2026');
  const [bath] = await ctx.sql<{ id: number; warehouseId: number }[]>`
    SELECT d.id, w.id AS warehouse_id FROM departments d JOIN warehouses w ON w.department_id = d.id WHERE d.name = '浴区'`;
  bathId = Number(bath!.id);
  bathWh = Number(bath!.warehouseId);
  const staff = async (username: string, displayName: string, duties: ('approve' | 'legal' | 'cost' | 'request')[], departmentId: number | null = null) => {
    const id = await createStaff(ctx.sql, { username, displayName, role: 'backoffice', duties, departmentId, password: PASSWORD, mustChangePassword: false });
    return { id: Number(id), cookie: await login(ctx.app, username) };
  };
  mgr = (await staff('flow_mgr', '负责人周', ['approve'])).cookie;
  lawyer = (await staff('flow_legal', '法务吴', ['legal'])).cookie;
  const c = await staff('flow_cost', '成本核算郑', ['cost']);
  coster = c.cookie;
  costerId = c.id;
  bathUser = (await staff('flow_bath', '浴区阿兰', ['request'], bathId)).cookie;
}, 120_000);
afterAll(async () => ctx.close());

describe('ERP 全流程试跑（8.0.7）', () => {
  it('需求 → 比价 → 合同 → 收货 → 领用与耗用 → 报销 → 付款 → 对账确认 → 平账，最后各模块自检全过', async () => {
    // ⓪ 供应商与物料：新供应商是「待准入」，有营业执照后由负责人准入；物料管效期（保质期一年）
    const suppliers = await ok<{ id: number; code: string; admission: string }[]>(api(ctx.app, boss, 'POST', '/api/inventory/suppliers', { code: 'FL01', name: '全流程精油供应商' }));
    const sup = suppliers.find((s) => s.code === 'FL01')!;
    expect(sup.admission).toBe('pending');
    await ok(api(ctx.app, buyer, 'POST', `/api/inventory/suppliers/${sup.id}/licenses`, { kind: 'business', licenseNo: 'FL-2026-001', validUntil: shiftDate(today, 400) }));
    expect((await ok(api(ctx.app, mgr, 'POST', `/api/inventory/suppliers/${sup.id}/admission`, { action: 'approve', note: '证照齐全' }), 200)).admission).toBe('approved');
    const rival = ((await api(ctx.app, boss, 'GET', '/api/inventory/suppliers?all=1')).body as { id: number; code: string }[]).find((s) => s.code === 'S002')!;
    const mat = await ok<{ id: number; name: string }>(
      api(ctx.app, boss, 'POST', '/api/inventory/materials', {
        code: 'FL-M1',
        name: '全流程护理精油',
        inventoryUnit: '瓶',
        purchaseUnit: '箱',
        purchaseFactorMilli: q(10),
        expiryTracked: true,
        shelfLifeDays: 365,
      }),
    );

    // ① 需求：浴区要 3 箱，采购审核通过
    const req = await ok<{ request: { id: number } }>(
      api(ctx.app, bathUser, 'POST', '/api/erp/requests', {
        clientKey: randomUUID(),
        lines: [{ materialId: mat.id, name: mat.name, qtyMilli: q(3), purpose: '客用消耗', unit: '箱', link: '', details: '', imageIds: [] }],
      }),
    );
    const approvedReq = await ok<{ id: number; status: string; lines: { id: number }[] }>(api(ctx.app, buyer, 'POST', `/api/erp/requests/${req.request.id}/approve`, {}), 200);
    expect(approvedReq.status).toBe('approved');
    const reqLineId = approvedReq.lines[0]!.id;

    // ② 比价：带上需求行发起询价，两家报价，定标给单价低的那家
    const ev = (
      await ok<{ event: { id: number; lines: { id: number }[] } }>(
        api(ctx.app, buyer, 'POST', '/api/purchase-sourcing', {
          clientKey: randomUUID(),
          title: '护理精油 3 箱',
          needBy: today,
          lines: [{ materialId: mat.id, purchaseQtyMilli: q(3), requestLineIds: [reqLineId] }],
        }),
      )
    ).event;
    const evLine = ev.lines[0]!.id;
    const quote = (supplierId: number, priceCents: number) =>
      ok(api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ev.id}/quotes`, { clientKey: randomUUID(), payTerms: '到货付款', supplierId, prices: [{ lineId: evLine, priceCents }] }), 200);
    await quote(sup.id, 12_000);
    await quote(rival.id, 13_500);
    const quotes = (await api(ctx.app, buyer, 'GET', `/api/purchase-sourcing/${ev.id}`)).body.quotes as { id: number; supplier: { id: number } }[];
    const winner = quotes.find((x) => x.supplier.id === sup.id)!;
    expect((await ok(api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ev.id}/award`, { quoteId: winner.id, reason: '单价低、证照齐全' }), 200)).status).toBe('awarded');

    // ③ 合同：¥360（3 箱 × ¥120），到货付 100%；财务 → 法务 → 负责人审查，签署
    const created = await ok<{ contract: ContractDetail }>(
      api(ctx.app, buyer, 'POST', '/api/erp/contracts', {
        clientKey: randomUUID(),
        category: 'purchase',
        supplierId: sup.id,
        counterparty: '',
        content: {
          title: '全流程护理精油采购合同',
          startDate: today,
          endDate: shiftDate(today, 365),
          totalCents: 36_000,
          taxRateBp: 1300,
          freightBearer: 'supplier',
          unloadingBearer: 'supplier',
          paymentTerms: [
            { stage: 'prepay', percentBp: 0, condition: '不预付' },
            { stage: 'delivery', percentBp: 10_000, condition: '到货、发票齐后付清' },
            { stage: 'acceptance', percentBp: 0, condition: '' },
            { stage: 'warranty', percentBp: 0, condition: '' },
          ],
          warranty: { basis: 'acceptance', months: 12 },
          acceptance: { method: '按样品验收', signer: '仓库经办', penalty: '不合格退换' },
          note: '',
          lines: [{ materialId: mat.id, itemName: '', spec: '', unit: '', priceCents: 12_000, taxRateBp: 1300, qtyMilli: q(3) }],
        },
      }),
    );
    let contract = await ok<ContractDetail>(api(ctx.app, buyer, 'POST', `/api/erp/contracts/${created.contract.id}/submit`, { version: created.contract.version }), 200);
    const crid = contract.approval!.requestId;
    await approveAt(payer, crid, 1);
    await approveAt(lawyer, crid, 2, { checklist: LEGAL_ITEM_KEYS.map((key) => ({ key, verdict: 'pass', note: '' })) });
    await approveAt(mgr, crid, 3);
    contract = (await api(ctx.app, buyer, 'GET', `/api/erp/contracts/${contract.id}`)).body;
    expect(contract.status).toBe('approved');
    contract = await ok(api(ctx.app, buyer, 'POST', `/api/erp/contracts/${contract.id}/sign`, { version: contract.version, signedOn: today, ourSignatory: '林岚', theirSignatory: '王经理' }), 200);
    expect(contract.status).toBe('signed');

    // 询价单转采购单（带着需求行），挂上合同，提交：行都来自审核过的需求单，提交即确认（CG04）
    const drafted = (await ok<{ po: { id: number; docNo: string; lines: { id: number }[] } }>(api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ev.id}/order`, { clientKey: randomUUID() }))).po;
    const poLineId = drafted.lines[0]!.id;
    await ok(
      api(ctx.app, buyer, 'PUT', `/api/purchase-orders/${drafted.id}`, {
        supplierId: sup.id,
        orderDate: today,
        action: 'save',
        contractId: contract.id,
        lines: [{ id: poLineId, materialId: mat.id, purchaseQtyMilli: q(3), priceCents: 12_000, requestLineIds: [reqLineId] }],
      }),
      200,
    );
    const po = await ok<{ id: number; docNo: string; status: string }>(api(ctx.app, buyer, 'POST', `/api/purchase-orders/${drafted.id}/submit`, {}), 200);
    expect(po.status).toBe('approved');

    // ④ 收货：仓库按采购单收 30 瓶（采购不参与验收），管效期的填批号与到期日（20 天后到期，在临期提醒的 30 天内）
    const receipt = (
      await ok<{ doc: { id: number; docNo: string; status: string; amountCents: number } }>(
        api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
          clientKey: randomUUID(),
          docDate: today,
          docType: 'receipt',
          supplierId: sup.id,
          purchaseOrderId: po.id,
          lines: [{ materialId: mat.id, poLineId, deliveredMilli: q(30), acceptedMilli: q(30), batchNo: 'FL-B01', expiresOn: shiftDate(today, 20) }],
        }),
      )
    ).doc;
    expect(receipt).toMatchObject({ status: 'confirmed', amountCents: 36_000 });
    const lotsAfterReceipt = (await api(ctx.app, keeper, 'GET', '/api/inventory/expiry-lots')).body as { materialId: number; batchNo: string; remainingMilli: number; daysLeft: number }[];
    expect(lotsAfterReceipt.filter((l) => l.materialId === mat.id)).toEqual([expect.objectContaining({ batchNo: 'FL-B01', remainingMilli: q(30), daysLeft: 20 })]);

    // ⑤ 领用与耗用：仓库领 10 瓶到浴区，浴区签收，耗用 4 瓶记用途「客用消耗」（经办人默认自己）
    const issued = (await ok<{ doc: { id: number; status: string } }>(api(ctx.app, keeper, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docDate: today, docType: 'issue', departmentId: bathId, handler: '浴区阿兰', lines: [{ materialId: mat.id, qtyMilli: q(10) }] }))).doc;
    expect(issued.status).toBe('confirmed');
    await ok(api(ctx.app, bathUser, 'POST', `/api/erp/dept-stock/docs/${issued.id}/sign`, { note: '数量对' }), 200);
    const used = (
      await ok<{ doc: { status: string; usePurpose: string; useHandler: { name: string } } }>(
        api(ctx.app, bathUser, 'POST', '/api/erp/dept-stock/docs', {
          clientKey: randomUUID(),
          docType: 'direct_use',
          docDate: today,
          warehouseId: bathWh,
          note: '贵宾区补充',
          purpose: '客用消耗',
          lines: [{ materialId: mat.id, qtyMilli: q(4) }],
        }),
      )
    ).doc;
    expect(used).toMatchObject({ status: 'confirmed', usePurpose: '客用消耗', useHandler: { name: '浴区阿兰' } });
    const deptStock = await ctx.sql<{ stock: string }[]>`SELECT stock_milli::text AS stock FROM warehouse_stock WHERE warehouse_id = ${bathWh} AND material_id = ${mat.id}`;
    expect(Number(deptStock[0]!.stock)).toBe(q(6));
    // 总仓剩 20 瓶，都是这一批
    const lots = (await api(ctx.app, keeper, 'GET', '/api/inventory/expiry-lots')).body as { materialId: number; remainingMilli: number }[];
    expect(lots.find((l) => l.materialId === mat.id)?.remainingMilli).toBe(q(20));

    // ⑥ 报销：备用金打款 ¥500 给成本核算（浴区）；向现付供应商买零星物品 ¥450，收货后按采购单报销；结余 ¥50 退回，打款结清
    const cashSup = ((await api(ctx.app, boss, 'GET', '/api/inventory/suppliers?all=1')).body as { id: number; code: string; name: string }[]).find((s) => s.code === 'S004')!;
    await ok(api(ctx.app, buyer, 'PUT', `/api/inventory/suppliers/${cashSup.id}`, { code: cashSup.code, name: cashSup.name, settlement: 'cash' }), 200);
    const adv = (
      await ok<{ advance: { id: number; docNo: string } }>(
        api(ctx.app, coster, 'POST', '/api/erp/petty/advances', {
          clientKey: randomUUID(),
          departmentId: bathId,
          handlerId: costerId,
          advanceDate: today,
          amountCents: 50_000,
          method: 'wechat',
          evidence: '转账尾号 0807',
        }),
      )
    ).advance;
    const smallMat = await ok<{ id: number }>(api(ctx.app, boss, 'POST', '/api/inventory/materials', { code: 'FL-M2', name: '全流程一次性拖鞋', inventoryUnit: '双', purchaseUnit: '包', purchaseFactorMilli: q(50) }));
    const cashPo = (
      await ok<{ po: { id: number; docNo: string; lines: { id: number }[] } }>(
        api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId: cashSup.id, orderDate: today, lines: [{ materialId: smallMat.id, purchaseQtyMilli: q(3), priceCents: 15_000 }] }),
      )
    ).po;
    const cashPoNow = (await api(ctx.app, buyer, 'GET', `/api/purchase-orders/${cashPo.id}`)).body as { status: string };
    if (cashPoNow.status !== 'approved') expect((await ok(api(ctx.app, mgr, 'POST', `/api/purchase-orders/${cashPo.id}/approve`, {}), 200)).status).toBe('approved');
    const cashReceipt = (
      await ok<{ doc: { id: number } }>(
        api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
          clientKey: randomUUID(),
          docDate: today,
          docType: 'receipt',
          supplierId: cashSup.id,
          purchaseOrderId: cashPo.id,
          lines: [{ materialId: smallMat.id, poLineId: cashPo.lines[0]!.id, deliveredMilli: q(150), acceptedMilli: q(150) }],
        }),
      )
    ).doc;
    // 现付的收货不记应付（种子数据里这家原来挂账收过货，那些照旧在）
    const cashOpen = (await api(ctx.app, payer, 'GET', `/api/payables/suppliers/${cashSup.id}/open-items`)).body as { id: number }[];
    expect(cashOpen.some((i) => i.id === cashReceipt.id)).toBe(false);
    const forClaim = (await api(ctx.app, coster, 'GET', `/api/erp/expenses/po/${cashPo.id}`)).body as {
      lines: { name: string; unit: string; boughtMilli: number; receivedMilli: number; amountCents: number; poLineId: number }[];
    };
    const pl = forClaim.lines[0]!;
    expect(pl.amountCents).toBe(45_000);
    const claim = (
      await ok<{ claim: { id: number; status: string; amountCents: number } }>(
        api(ctx.app, coster, 'POST', '/api/erp/expenses', {
          clientKey: randomUUID(),
          expenseDate: today,
          departmentId: bathId,
          handlerId: costerId,
          purpose: '客用消耗',
          paySource: 'petty',
          advanceId: adv.id,
          invoiceType: 'receipt',
          taxRateBp: 0,
          purchaseOrderId: cashPo.id,
          lines: [{ name: pl.name, category: 'low_value', unit: pl.unit, boughtMilli: pl.boughtMilli, receivedMilli: pl.receivedMilli, amountCents: pl.amountCents, poLineId: pl.poLineId }],
        }),
      )
    ).claim;
    expect(claim).toMatchObject({ status: 'confirmed', amountCents: 45_000 });
    const settled = await ok<{ advance: { state: string; outstandingCents: number } }>(
      api(ctx.app, coster, 'POST', '/api/erp/petty/settlements', { clientKey: randomUUID(), advanceId: adv.id, kind: 'return', settleDate: today, amountCents: 5_000, method: 'cash', evidence: '现金当面点清' }),
    );
    expect(settled.advance).toMatchObject({ state: 'settled', outstandingCents: 0 });

    // ⑦ 付款：财务登记发票 ¥360（三单对得上）；采购发起到货款申请，财务 → 负责人；财务按申请登记付款，核销到这张收货单
    await ok(
      api(ctx.app, payer, 'POST', '/api/erp/payments/invoices', {
        clientKey: randomUUID(),
        supplierId: sup.id,
        invoiceNo: 'FL20261110',
        invoiceDate: today,
        totalCents: 36_000,
        taxCents: 0,
        taxRateBp: 1300,
        lines: [{ poId: po.id, amountCents: 36_000 }],
      }),
    );
    expect((await ok<{ status: string }>(api(ctx.app, payer, 'GET', `/api/erp/payments/three-way/po/${po.id}`), 200)).status).toBe('matched');
    const planBefore = await ok<ContractPaymentPlan>(api(ctx.app, buyer, 'GET', `/api/erp/contracts/${contract.id}/payment-plan`), 200);
    expect(planBefore.stages.find((s) => s.stage === 'delivery')).toMatchObject({ plannedCents: 36_000, availableCents: 36_000 });
    const preq = (
      await ok<{ request: PaymentRequestDetail }>(
        api(ctx.app, buyer, 'POST', '/api/erp/payments/requests', {
          clientKey: randomUUID(),
          expectedDate: today,
          purpose: '到货款',
          source: { kind: 'contract', contractId: contract.id, stage: 'delivery', amountCents: 36_000 },
        }),
      )
    ).request;
    expect(preq).toMatchObject({ status: 'submitted', threeWayOk: true });
    await approveAt(payer, preq.approval!.requestId, 1);
    await approveAt(mgr, preq.approval!.requestId, 2);
    const paid = await ok<{ request: { status: string } }>(
      api(ctx.app, payer, 'POST', `/api/erp/payments/requests/${preq.id}/pay`, {
        clientKey: randomUUID(),
        payDate: today,
        method: 'bank_transfer',
        evidence: '流水尾号 3600',
        amountCents: 36_000,
        allocations: [{ kind: 'receipt', targetId: receipt.id, amountCents: 36_000 }],
      }),
    );
    expect(paid.request.status).toBe('paid');

    // ⑧ 对账确认：按批次登记这张收货单，生成链接；供应商不用登录打开、确认无误；门店这边看到回复
    const recon = (await ok<{ reconciliation: { id: number } }>(api(ctx.app, payer, 'POST', '/api/payables/reconciliations', { clientKey: randomUUID(), supplierId: sup.id, kind: 'batch', docIds: [receipt.id] }))).reconciliation;
    const link = await ok<{ token: string }>(api(ctx.app, payer, 'POST', `/api/payables/reconciliations/${recon.id}/links`, {}));
    const pub = await ctx.app.inject({ method: 'GET', url: `/api/public/recon/${link.token}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().snapshot).toMatchObject({ supplierName: '全流程精油供应商', kind: 'batch' });
    const reply = await ctx.app.inject({ method: 'POST', url: `/api/public/recon/${link.token}/reply`, payload: { answer: 'confirmed', name: '供应商会计' } });
    expect(reply.statusCode).toBe(200);
    const reconView = (await api(ctx.app, payer, 'GET', `/api/payables/reconciliations/${recon.id}`)).body as { link: { reply: string; replyName: string } };
    expect(reconView.link).toMatchObject({ reply: 'confirmed', replyName: '供应商会计' });

    // ⑨ 平账：供应商没有没付的收货单；合同到货段付清；需求单显示已下单（采购单号）；所有自检全过
    const open = (await api(ctx.app, payer, 'GET', `/api/payables/suppliers/${sup.id}/open-items`)).body as { id: number; openCents: number }[];
    expect(open.filter((i) => i.openCents > 0)).toEqual([]);
    const balance = ((await api(ctx.app, payer, 'GET', '/api/payables/overview')).body.suppliers as { supplierId: number; balanceCents: number }[]).find((x) => x.supplierId === sup.id);
    expect(balance?.balanceCents).toBe(0);
    const planAfter = await ok<ContractPaymentPlan>(api(ctx.app, buyer, 'GET', `/api/erp/contracts/${contract.id}/payment-plan`), 200);
    expect(planAfter.stages.find((s) => s.stage === 'delivery')).toMatchObject({ paidCents: 36_000, availableCents: 0 });
    const reqView = (await api(ctx.app, bathUser, 'GET', `/api/erp/requests/${req.request.id}`)).body as { lines: { progress: { po: { docNo: string } | null } }[] };
    expect(reqView.lines[0]!.progress.po).toMatchObject({ docNo: po.docNo });
    const checks = await consistencyChecks(ctx.sql, ctx.config.timezone);
    expect(checks.length).toBeGreaterThan(40);
    for (const c of checks) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }, 120_000);
});
