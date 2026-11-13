// v0.7.32 付款流（docs/PAYMENTS.md，P1–P12 待确认）：
//   · 付款计划按合同生效的那一版现算：计划金额（最后一段补齐）、可付条件（签署、到货比例、验收合格、质保期满且没有未处理的质量问题）；
//   · 付款申请走审批中心：默认 财务 → 负责人（≥ ¥50,000 加店主）；超过可付的按「提前付款」（多一级店主、不能批量同意）；
//     超过计划的拒绝；撤回、改了再提交、作废、结束；
//   · 批了以后按申请登记付款不再审：采购合同核销到这份合同的收货单或记预付款；服务合同登记合同付款（不进供应商往来）；
//     冲销后申请回到待付款；挂合同的货款不能直接登记付款、不能把没带申请的预付款核销上去；
//   · 三单：没登记发票、发票与收货差额超过 1% 或 ¥50 的挂起，财务放行（金额变了要重新放行）；预付段、服务合同不要求；
//   · 没挂合同的应付：选收货单 / 期初未付，别的申请占着的不能再申请；挂合同的收货单要从合同申请；
//   · 质保金台账、本周应付、待办数字；部门、仓库账号进不来；自检一致。
// 8.0.6 付款规则（店主 2026-11-10：照默认，有争议的不写死）：加店主一级的金额、挂合同的货款要不要先提申请、三单差额门槛、
//   质保金提前提醒天数、本周应付的周数在「付款规则」里改，改了立即生效（已经提交的申请不回头改）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvalChecks } from '../src/server/modules/approvals/engine';
import { todayIn } from '../src/server/modules/inventory/common';
import { paymentChecks } from '../src/server/modules/payments/ledger';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { LEGAL_ITEM_KEYS, type ContractDetail, type PaymentTerm } from '../src/shared/contracts';
import { addMonths, DEFAULT_PAYMENT_RULES, stageAmounts, threeWayToleranceText, withinTolerance, type ContractPaymentPlan, type PaymentRequestDetail, type WarrantyRow } from '../src/shared/payments';
import { shiftDate } from '../src/shared/labels';
import { api, login, PASSWORD, setup, type TestContext, useLegacyQuoteThreshold } from './helpers';

let ctx: TestContext;
let today: string;
let boss: string; // 店主
let buyer: string; // 采购（发起付款申请、维护合同）
let buyerId: number;
let payer: string; // 对账付款（财务、登记付款）
let keeper: string; // 仓库（收货）
let lawyer: string;
let mgr: string; // 负责人
let dept: string; // 部门账号
let supplierId: number;
let matId: number;

const q = (n: number) => Math.round(n * 1000);
const allPass = () => LEGAL_ITEM_KEYS.map((key) => ({ key, verdict: 'pass', note: '' }));
const terms = (prepay: number, delivery: number, acceptance: number, warranty: number): PaymentTerm[] => [
  { stage: 'prepay', percentBp: prepay * 100, condition: '签订后 7 天内' },
  { stage: 'delivery', percentBp: delivery * 100, condition: '到货后' },
  { stage: 'acceptance', percentBp: acceptance * 100, condition: '验收合格后' },
  { stage: 'warranty', percentBp: warranty * 100, condition: '质保期满' },
];
const approveAt = (cookie: string, requestId: number, level: number, extra: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', `/api/approvals/${requestId}/approve`, { level, comment: '', ...extra });

async function ok<T = any>(res: Promise<{ status: number; body: any }>, status = 201): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

/** 起草、审查（财务 → 法务 → 负责人）、签署一份合同 */
async function signedContract(over: { category?: string; supplierId?: number | null; counterparty?: string; totalCents?: number; paymentTerms?: PaymentTerm[]; warranty?: unknown; lines?: unknown[]; signedOn?: string } = {}) {
  const category = over.category ?? 'purchase';
  const total = over.totalCents ?? 1_000_000;
  const content = {
    title: `付款流测试合同 ${randomUUID().slice(0, 6)}`,
    startDate: today,
    endDate: shiftDate(today, 365),
    totalCents: total,
    taxRateBp: 1300,
    freightBearer: 'supplier',
    unloadingBearer: 'supplier',
    paymentTerms: over.paymentTerms ?? terms(20, 20, 50, 10),
    warranty: over.warranty ?? { basis: 'acceptance', months: 12 },
    acceptance: { method: '按样品验收', signer: '仓库经办', penalty: '不合格退换' },
    note: '',
    lines: over.lines ?? (category === 'purchase' ? [{ materialId: matId, itemName: '', spec: '', unit: '', priceCents: 50_00, taxRateBp: 1300, qtyMilli: q(200) }] : []),
  };
  const created = await ok(
    api(ctx.app, buyer, 'POST', '/api/erp/contracts', {
      clientKey: randomUUID(),
      category,
      supplierId: over.supplierId === undefined ? (category === 'purchase' ? supplierId : null) : over.supplierId,
      counterparty: over.counterparty ?? '',
      content,
    }),
  );
  let c = created.contract as ContractDetail;
  c = await ok(api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/submit`, { version: c.version }), 200);
  const rid = c.approval!.requestId;
  await ok(approveAt(payer, rid, 1), 200);
  await ok(approveAt(lawyer, rid, 2, { checklist: allPass() }), 200);
  await ok(approveAt(mgr, rid, 3), 200);
  c = (await api(ctx.app, buyer, 'GET', `/api/erp/contracts/${c.id}`)).body;
  expect(c.status).toBe('approved');
  c = await ok(api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/sign`, { version: c.version, signedOn: over.signedOn ?? today, ourSignatory: '林岚', theirSignatory: '王经理' }), 200);
  return c;
}

const plan = async (contractId: number, cookie = buyer) => ok<ContractPaymentPlan>(api(ctx.app, cookie, 'GET', `/api/erp/contracts/${contractId}/payment-plan`), 200);
const stageOf = (p: ContractPaymentPlan, stage: string) => p.stages.find((s) => s.stage === stage)!;
const request = (body: Record<string, unknown>, cookie = buyer) =>
  api(ctx.app, cookie, 'POST', '/api/erp/payments/requests', { clientKey: randomUUID(), expectedDate: today, purpose: '按合同付款', ...body });
const detail = async (id: number, cookie = payer) => ok<PaymentRequestDetail>(api(ctx.app, cookie, 'GET', `/api/erp/payments/requests/${id}`), 200);
/** 按默认的审批链批完（财务 → 负责人，提前付款再加店主） */
async function approveAll(r: PaymentRequestDetail) {
  const rid = r.approval!.requestId;
  await ok(approveAt(payer, rid, 1), 200);
  await ok(approveAt(mgr, rid, 2), 200);
  if (r.approval!.levels === 3) await ok(approveAt(boss, rid, 3), 200);
  const d = await detail(r.id);
  expect(d.status).toBe('approved');
  return d;
}
const payReq = (id: number, body: Record<string, unknown>, cookie = payer) =>
  api(ctx.app, cookie, 'POST', `/api/erp/payments/requests/${id}/pay`, { clientKey: randomUUID(), payDate: today, method: 'bank_transfer', evidence: '流水尾号 6688', ...body });

/** 按合同下采购单（确认）并全部收货：返回收货单 */
async function receiveUnderContract(contractId: number | null, boxes: number, priceCents = 50_00) {
  const po = await ok(
    api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      supplierId,
      orderDate: today,
      approveNow: true,
      ...(contractId ? { contractId } : {}),
      lines: [{ materialId: matId, purchaseQtyMilli: q(boxes), priceCents }],
    }),
  );
  expect(po.po.status, JSON.stringify(po.po)).toBe('approved');
  const rc = await ok(
    api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docDate: today,
      docType: 'receipt',
      supplierId,
      purchaseOrderId: po.po.id,
      coAcceptorId: buyerId,
      lines: [{ materialId: matId, poLineId: po.po.lines[0].id, deliveredMilli: q(boxes * 10), acceptedMilli: q(boxes * 10) }],
    }),
  );
  expect(rc.doc.status).toBe('confirmed');
  return { poId: po.po.id as number, receipt: rc.doc as { id: number; docNo: string; amountCents: number } };
}
const invoice = (lines: { poId: number; amountCents: number }[], extra: Record<string, unknown> = {}) =>
  api(ctx.app, payer, 'POST', '/api/erp/payments/invoices', {
    clientKey: randomUUID(),
    supplierId,
    invoiceNo: `FP${randomUUID().slice(0, 8)}`,
    invoiceDate: today,
    totalCents: lines.reduce((s, l) => s + l.amountCents, 0),
    taxCents: 0,
    taxRateBp: 1300,
    lines,
    ...extra,
  });

beforeAll(async () => {
  ctx = await setup();
  await useLegacyQuoteThreshold(ctx);
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  payer = await login(ctx.app, 'qianfen', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  const [b] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'zhouyi'`;
  buyerId = Number(b!.id);
  const staff = async (username: string, displayName: string, duties: ('approve' | 'legal' | 'request')[], departmentId: number | null = null) => {
    await createStaff(ctx.sql, { username, displayName, role: 'backoffice', duties, departmentId, password: PASSWORD, mustChangePassword: false });
    return login(ctx.app, username);
  };
  lawyer = await staff('pay_legal', '法务甲', ['legal']);
  mgr = await staff('pay_mgr', '负责人乙', ['approve']);
  const [d] = await ctx.sql<{ id: number }[]>`SELECT id FROM departments ORDER BY id LIMIT 1`;
  dept = await staff('pay_dept', '部门丙', ['request'], Number(d!.id));
  const list = (await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'PY01', name: '付款流测试供应商' })).body;
  supplierId = list.find((x: { code: string }) => x.code === 'PY01').id;
  const m = await ok(api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', { code: 'PY-M1', name: '付款流测试物料', inventoryUnit: '个', purchaseUnit: '箱', purchaseFactorMilli: q(10) }));
  matId = m.id;
}, 60_000);
afterAll(async () => ctx.close());

describe('计算', () => {
  it('计划金额按分取整，最后一个比例不为 0 的段补齐；月份相加按月底对齐；三单门槛 1% 且 ¥50', () => {
    expect(stageAmounts(10_001, terms(30, 0, 60, 10))).toEqual({ prepay: 3000, delivery: 0, acceptance: 6001, warranty: 1000 });
    const odd = stageAmounts(10_000, [
      { stage: 'prepay', percentBp: 3333 },
      { stage: 'delivery', percentBp: 3333 },
      { stage: 'acceptance', percentBp: 3334 },
      { stage: 'warranty', percentBp: 0 },
    ]);
    expect(odd).toEqual({ prepay: 3333, delivery: 3333, acceptance: 3334, warranty: 0 });
    expect(Object.values(stageAmounts(99_999, terms(30, 20, 40, 10))).reduce((s, x) => s + x, 0)).toBe(99_999);
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-06', 12)).toBe('2027-11-06');
    expect(addMonths('2026-11-06', 0)).toBe('2026-11-06');
    expect(withinTolerance(10_050, 10_000, 10_000)).toBe(true); // 差 5 角：没超过 100 元的 1%（1 元）
    expect(withinTolerance(10_150, 10_000, 10_000)).toBe(false); // 差 1.5 元：超过 1%
    expect(withinTolerance(1_000_050, 1_000_000, 1_000_000)).toBe(true); // 差 0.5 元，在 1% 与 ¥50 内
    expect(withinTolerance(1_006_000, 1_000_000, 1_000_000)).toBe(false); // 差 60 元，超过 ¥50
    // 门槛按付款规则（8.0.6）：0.5% 且 ¥30
    const tight = { threeWayPctBp: 50, threeWayCapCents: 3_000 };
    expect(withinTolerance(10_050, 10_000, 10_000, tight)).toBe(true); // 差 5 角 = 0.5%
    expect(withinTolerance(10_051, 10_000, 10_000, tight)).toBe(false);
    expect(withinTolerance(1_003_100, 1_000_000, 1_000_000, tight)).toBe(false); // 差 31 元，超过 ¥30
    expect(withinTolerance(1, 0, 0, { threeWayPctBp: 0, threeWayCapCents: 0 })).toBe(false); // 0 = 一分不差
    expect(threeWayToleranceText(DEFAULT_PAYMENT_RULES)).toBe('1% 且 ¥50');
    expect(threeWayToleranceText({ threeWayPctBp: 125, threeWayCapCents: 3_050 })).toBe('1.25% 且 ¥30.50');
  });
});

describe('付款流', () => {
  let c: ContractDetail; // 采购合同 ¥10,000：预付 20%、到货 20%、验收 50%、质保 10%（验收合格起 12 个月）
  let prepayReq: PaymentRequestDetail;
  let rc1: { poId: number; receipt: { id: number; docNo: string; amountCents: number } };

  it('付款计划：没签署不能申请；签署后预付可付，其余按条件', async () => {
    c = await signedContract();
    const p = await plan(c.id);
    expect(p).toMatchObject({ canRequest: true, payMode: 'ap', supplierId, plannedCents: 1_000_000, paidCents: 0, receivedCents: 0, settled: false });
    expect(p.stages.map((s) => [s.stage, s.plannedCents, s.payableCents])).toEqual([
      ['prepay', 200_000, 200_000],
      ['delivery', 200_000, 0],
      ['acceptance', 500_000, 0],
      ['warranty', 100_000, 0],
    ]);
    expect(stageOf(p, 'delivery').reason).toBe('还没有生效的收货单');
    expect(stageOf(p, 'acceptance').reason).toBe('还没登记验收');
    expect(p.warranty).toMatchObject({ startDate: null, dueDate: null, openIssues: 0 });
    // 部门、仓库账号看不到付款
    expect((await api(ctx.app, dept, 'GET', '/api/erp/payments/requests')).status).toBe(403);
    expect((await api(ctx.app, keeper, 'GET', '/api/erp/payments/requests')).status).toBe(403);
  });

  it('付款申请（预付）：财务 → 负责人；超过计划拒绝；同一编号重提返回原来那张', async () => {
    const over = await request({ source: { kind: 'contract', contractId: c.id, stage: 'prepay', amountCents: 200_001 } });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('REQUEST_OVER_PLAN');
    const clientKey = randomUUID();
    const body = { clientKey, source: { kind: 'contract', contractId: c.id, stage: 'prepay', amountCents: 200_000 }, expectedDate: today, purpose: '预付款' };
    const a = await api(ctx.app, buyer, 'POST', '/api/erp/payments/requests', body);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await api(ctx.app, buyer, 'POST', '/api/erp/payments/requests', body);
    expect(b.status).toBe(200);
    expect(b.body.request.id).toBe(a.body.request.id);
    prepayReq = a.body.request;
    expect(prepayReq).toMatchObject({ status: 'submitted', requestNo: expect.stringMatching(/^FS\d{8}-\d{4}$/), payee: '付款流测试供应商', early: false, threeWayRequired: false });
    expect(prepayReq.approval).toMatchObject({ levels: 2, stepLabels: ['财务', '负责人'] });
    // 已申请占着额度：再申请这一段拒绝
    expect((await request({ source: { kind: 'contract', contractId: c.id, stage: 'prepay', amountCents: 1 } })).body.error.code).toBe('REQUEST_OVER_PLAN');
    expect(stageOf(await plan(c.id), 'prepay')).toMatchObject({ requestedCents: 200_000, availableCents: 0, remainingCents: 0 });
    // 审批中心：采购不在财务这一级；详情里看得到这一段的情况
    const rid = prepayReq.approval!.requestId;
    expect((await approveAt(buyer, rid, 1)).status).toBe(403);
    const dv = await ok(api(ctx.app, mgr, 'GET', `/api/approvals/${rid}`), 200);
    expect(dv.doc).toMatchObject({ title: '付款申请', link: `/erp/payments/requests/${prepayReq.id}`, party: '付款流测试供应商' });
    expect(dv.doc.facts).toEqual(expect.arrayContaining([expect.objectContaining({ label: '预付段' })]));
    prepayReq = await approveAll(prepayReq);
  });

  it('按申请登记付款：不再审、登记即确认；记为预付款；付清后申请变已付清；冲销后回到待付款', async () => {
    // 不勾「其余记为预付款」不行
    expect((await payReq(prepayReq.id, { amountCents: 200_000 })).status).toBe(400);
    expect((await payReq(prepayReq.id, { amountCents: 200_001, prepay: true })).body.error.code).toBe('OVER_REQUEST');
    // 采购不能登记付款
    expect((await payReq(prepayReq.id, { amountCents: 200_000, prepay: true }, buyer)).status).toBe(403);
    const paid = await ok(payReq(prepayReq.id, { amountCents: 200_000, prepay: true }));
    expect(paid.request.status).toBe('paid');
    expect(paid.request.payments).toEqual([expect.objectContaining({ kind: 'payment', amountCents: 200_000, prepaidCents: 200_000, status: 'confirmed' })]);
    const payment = (await api(ctx.app, payer, 'GET', `/api/payables/payments/${paid.payment.id}`)).body;
    expect(payment).toMatchObject({ status: 'confirmed', note: `付款申请 ${prepayReq.requestNo} 预付`, prepaidCents: 200_000 });
    expect(stageOf(await plan(c.id), 'prepay')).toMatchObject({ paidCents: 200_000, requestedCents: 0, done: true });
    // 已付清的不能再付
    expect((await payReq(prepayReq.id, { amountCents: 1, prepay: true })).body.error.code).toBe('INVALID_STATE');
    // 冲销这笔付款：申请回到待付款；再登记一次
    const voided = await api(ctx.app, payer, 'POST', `/api/payables/payments/${paid.payment.id}/void`, { reason: '流水号登错' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect((await detail(prepayReq.id)).status).toBe('approved');
    expect(stageOf(await plan(c.id), 'prepay')).toMatchObject({ paidCents: 0, requestedCents: 200_000 });
    const again = await ok(payReq(prepayReq.id, { amountCents: 200_000, prepay: true }));
    expect(again.request.status).toBe('paid');
  });

  it('提前付款：超过可付的要勾「提前付款」写原因，多一级店主、不能批量同意；撤回、改了再提交、作废', async () => {
    const plain = await request({ source: { kind: 'contract', contractId: c.id, stage: 'acceptance', amountCents: 100_000 } });
    expect(plain.status).toBe(422);
    expect(plain.body.error.code).toBe('EARLY_REQUIRED');
    expect((await request({ source: { kind: 'contract', contractId: c.id, stage: 'acceptance', amountCents: 100_000 }, early: true, earlyReason: '' })).status).toBe(400);
    const early = (await ok(request({ source: { kind: 'contract', contractId: c.id, stage: 'acceptance', amountCents: 100_000 }, early: true, earlyReason: '供应商资金紧张，先付一部分' }))).request as PaymentRequestDetail;
    expect(early).toMatchObject({ early: true, status: 'submitted' });
    expect(early.approval).toMatchObject({ levels: 3, stepLabels: ['财务', '负责人', '店主'] });
    const card = (await api(ctx.app, payer, 'GET', '/api/approvals?tab=mine')).body.find((x: { docId: number; docKind: string }) => x.docKind === 'payment_request' && x.docId === early.id);
    expect(card).toMatchObject({ docType: 'payment_early', summary: expect.stringContaining('提前付款') });
    // 不能批量同意
    const batch = await api(ctx.app, payer, 'POST', '/api/approvals/batch-approve', { items: [{ id: early.approval!.requestId, level: 1 }], comment: '' });
    expect(batch.body.results[0]).toMatchObject({ ok: false, code: 'APPROVAL_NO_BATCH' });
    // 撤回：回到已退回；版本号对不上拒绝
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/payments/requests/${early.id}/withdraw`, { version: early.version + 5, reason: '金额要改' })).body.error.code).toBe('VERSION_CONFLICT');
    const w = await ok(api(ctx.app, buyer, 'POST', `/api/erp/payments/requests/${early.id}/withdraw`, { version: early.version, reason: '金额要改' }), 200);
    expect(w).toMatchObject({ status: 'returned', returnedReason: '撤回：金额要改', approval: expect.objectContaining({ status: 'cancelled' }) });
    // 改了再提交：从第一级重新走
    const re = await ok(
      api(ctx.app, buyer, 'POST', `/api/erp/payments/requests/${early.id}/resubmit`, {
        version: w.version,
        amountCents: 80_000,
        expectedDate: today,
        purpose: '按合同付款',
        early: true,
        earlyReason: '供应商资金紧张，先付一部分',
      }),
      200,
    );
    expect(re).toMatchObject({ status: 'submitted', amountCents: 80_000, approval: expect.objectContaining({ currentLevel: 1, levels: 3 }) });
    expect(re.approval.requestId).not.toBe(early.approval!.requestId);
    // 作废（没付过钱）：额度放出来
    const v = await ok(api(ctx.app, buyer, 'POST', `/api/erp/payments/requests/${early.id}/void`, { version: re.version, reason: '先不付了' }), 200);
    expect(v).toMatchObject({ status: 'voided', closedReason: '先不付了' });
    expect(stageOf(await plan(c.id), 'acceptance')).toMatchObject({ requestedCents: 0, remainingCents: 500_000 });
  });

  it('到货：按已收货占合同总价的比例放开；三单不齐挂起，登记发票后对得上；挂合同的货款不能直接付', async () => {
    rc1 = await receiveUnderContract(c.id, 100); // 100 箱 × 50 元 = 5,000 元
    expect(rc1.receipt.amountCents).toBe(500_000);
    let p = await plan(c.id);
    expect(p.receivedCents).toBe(500_000);
    expect(stageOf(p, 'delivery')).toMatchObject({ payableCents: 100_000, availableCents: 100_000 });
    expect(stageOf(p, 'delivery').reason).toContain('按比例放开');
    // 直接登记付款核销到合同的收货单：拒绝
    const direct = await api(ctx.app, payer, 'POST', '/api/payables/payments', {
      clientKey: randomUUID(),
      supplierId,
      payDate: today,
      amountCents: 1_000,
      method: 'bank_transfer',
      evidence: '流水尾号 0001',
      allocations: [{ kind: 'receipt', targetId: rc1.receipt.id, amountCents: 1_000 }],
    });
    expect(direct.status).toBe(422);
    expect(direct.body.error.code).toBe('PAYMENT_REQUEST_REQUIRED');
    // 没带申请的预付款也不能核销上去
    const loose = await ok(
      api(ctx.app, payer, 'POST', '/api/payables/payments', {
        clientKey: randomUUID(),
        supplierId,
        payDate: today,
        amountCents: 2_000,
        method: 'bank_transfer',
        evidence: '流水尾号 0002',
        note: '零星预付',
        prepay: true,
        approveNow: false,
        allocations: [],
      }),
    );
    if (loose.payment.status !== 'confirmed') await ok(api(ctx.app, mgr, 'POST', `/api/payables/payments/${loose.payment.id}/approve`, {}), 200);
    const off = await api(ctx.app, payer, 'POST', '/api/payables/offsets', {
      clientKey: randomUUID(),
      supplierId,
      offsetDate: today,
      credit: { kind: 'prepayment', id: loose.payment.id },
      lines: [{ kind: 'receipt', targetId: rc1.receipt.id, amountCents: 1_000 }],
    });
    expect(off.body.error.code).toBe('PAYMENT_REQUEST_REQUIRED');
    // 带申请的预付款照旧核销
    const fromReq = (await detail(prepayReq.id)).payments.find((x) => x.status === 'confirmed')!;
    const off2 = await api(ctx.app, payer, 'POST', '/api/payables/offsets', {
      clientKey: randomUUID(),
      supplierId,
      offsetDate: today,
      credit: { kind: 'prepayment', id: fromReq.id },
      lines: [{ kind: 'receipt', targetId: rc1.receipt.id, amountCents: 100_000 }],
    });
    expect(off2.status, JSON.stringify(off2.body)).toBe(201);

    // 三单：还没登记发票 → 到货款申请挂起
    const held = await request({ source: { kind: 'contract', contractId: c.id, stage: 'delivery', amountCents: 100_000 } });
    expect(held.status).toBe(422);
    expect(held.body.error.code).toBe('THREE_WAY_NOT_MATCHED');
    expect(held.body.error.message).toContain('还没登记发票');
    // 发票差 100 元（超过 ¥50）：仍挂起
    const inv = await ok(invoice([{ poId: rc1.poId, amountCents: 510_000 }]));
    expect(inv.invoice).toMatchObject({ status: 'valid', totalCents: 510_000, lines: [{ poId: rc1.poId, amountCents: 510_000 }] });
    const tw = await ok(api(ctx.app, payer, 'GET', `/api/erp/payments/three-way/po/${rc1.poId}`), 200);
    expect(tw).toMatchObject({ status: 'held', receivedCents: 500_000, invoicedCents: 510_000 });
    expect((await request({ source: { kind: 'contract', contractId: c.id, stage: 'delivery', amountCents: 100_000 } })).body.error.code).toBe('THREE_WAY_NOT_MATCHED');
    // 同一供应商同一发票号码只能有一张没作废的
    expect((await invoice([{ poId: rc1.poId, amountCents: 1_000 }], { invoiceNo: inv.invoice.invoiceNo })).body.error.code).toBe('INVOICE_DUPLICATE');
    // 作废那张，重新登记对的
    await ok(api(ctx.app, payer, 'POST', `/api/erp/payments/invoices/${inv.invoice.id}/void`, { reason: '金额登错' }), 200);
    await ok(invoice([{ poId: rc1.poId, amountCents: 500_000 }]));
    expect((await ok(api(ctx.app, payer, 'GET', `/api/erp/payments/three-way/po/${rc1.poId}`), 200)).status).toBe('matched');

    const dl = (await ok(request({ source: { kind: 'contract', contractId: c.id, stage: 'delivery', amountCents: 100_000 } }))).request as PaymentRequestDetail;
    expect(dl).toMatchObject({ threeWayRequired: true, threeWayOk: true, threeWay: [expect.objectContaining({ poId: rc1.poId, status: 'matched' })] });
    const approved = await approveAll(dl);
    // 核销只能到这份合同的收货单上
    const other = await receiveUnderContract(null, 1);
    expect((await payReq(approved.id, { amountCents: 100_000, allocations: [{ kind: 'receipt', targetId: other.receipt.id, amountCents: 100_000 }] })).body.error.code).toBe('ALLOCATION_NOT_IN_CONTRACT');
    const paid = await ok(payReq(approved.id, { amountCents: 100_000, allocations: [{ kind: 'receipt', targetId: rc1.receipt.id, amountCents: 100_000 }] }));
    expect(paid.request.status).toBe('paid');
    p = await plan(c.id);
    expect(stageOf(p, 'delivery')).toMatchObject({ paidCents: 100_000, availableCents: 0 });
  });

  it('三单放行：财务写原因放行，记下当时的金额；金额变了要重新放行', async () => {
    const rc = await receiveUnderContract(c.id, 20); // 1,000 元
    await ok(invoice([{ poId: rc.poId, amountCents: 108_000 }])); // 差 80 元
    const row = await ok(api(ctx.app, payer, 'GET', `/api/erp/payments/three-way/po/${rc.poId}`), 200);
    expect(row.status).toBe('held');
    const seen = { poTotalCents: row.poTotalCents, receivedCents: row.receivedCents, invoicedCents: row.invoicedCents };
    // 采购不能放行；看到的金额不对拒绝
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/payments/three-way/po/${rc.poId}/release`, { clientKey: randomUUID(), reason: '运费含在发票里', seen })).status).toBe(403);
    expect((await api(ctx.app, payer, 'POST', `/api/erp/payments/three-way/po/${rc.poId}/release`, { clientKey: randomUUID(), reason: '运费含在发票里', seen: { ...seen, invoicedCents: 1 } })).body.error.code).toBe('THREE_WAY_MOVED');
    const rel = await ok(api(ctx.app, payer, 'POST', `/api/erp/payments/three-way/po/${rc.poId}/release`, { clientKey: randomUUID(), reason: '运费含在发票里', seen }), 200);
    expect(rel.row).toMatchObject({ status: 'released', release: expect.objectContaining({ reason: '运费含在发票里', byName: '钱芬（对账付款）' }) });
    // 再登记一张发票：金额变了，放行失效
    await ok(invoice([{ poId: rc.poId, amountCents: 1_000 }]));
    const stale = await ok(api(ctx.app, payer, 'GET', `/api/erp/payments/three-way/po/${rc.poId}`), 200);
    expect(stale).toMatchObject({ status: 'held', releaseStale: true });
    // 挂起的采购单出现在三单列表里
    const listed = await ok<{ poId: number }[]>(api(ctx.app, payer, 'GET', '/api/erp/payments/three-way?pending=1'), 200);
    expect(listed.map((x) => x.poId)).toContain(rc.poId);
    // 按新的金额重新放行，合同的后面几段才能申请
    const seen2 = { poTotalCents: stale.poTotalCents, receivedCents: stale.receivedCents, invoicedCents: stale.invoicedCents };
    const rel2 = await ok(api(ctx.app, payer, 'POST', `/api/erp/payments/three-way/po/${rc.poId}/release`, { clientKey: randomUUID(), reason: '运费另开了一张', seen: seen2 }), 200);
    expect(rel2.row.status).toBe('released');
  });

  it('验收与质保：不合格要写怎么处理；合格放开验收段、质保起算；有未处理的质量问题质保段挂起', async () => {
    const acc = (body: Record<string, unknown>) => api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/acceptances`, { clientKey: randomUUID(), acceptedOn: today, signer: '仓库经办', note: '', ...body });
    expect((await acc({ result: 'fail' })).status).toBe(400);
    expect((await acc({ result: 'pass', acceptedOn: shiftDate(today, 1) })).status).toBe(400);
    // 付款的人不能登记验收（维护合同的人登记）
    expect((await api(ctx.app, payer, 'POST', `/api/erp/contracts/${c.id}/acceptances`, { clientKey: randomUUID(), acceptedOn: today, result: 'pass', signer: '仓库经办' })).status).toBe(403);
    await ok(acc({ result: 'fail', note: '包装破损，退换后复验' }));
    let p = await plan(c.id);
    expect(stageOf(p, 'acceptance')).toMatchObject({ payableCents: 0 });
    expect(stageOf(p, 'acceptance').reason).toContain('不合格');
    const passed = await ok(acc({ result: 'pass' }));
    p = passed.plan;
    expect(stageOf(p, 'acceptance')).toMatchObject({ payableCents: 500_000, availableCents: 500_000 });
    expect(p.warranty).toMatchObject({ startDate: today, dueDate: addMonths(today, 12), openIssues: 0 });
    expect(stageOf(p, 'warranty').reason).toContain('质保期到');
    // 质量问题
    const issue = await ok(api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/quality-issues`, { clientKey: randomUUID(), foundOn: today, description: '有 3 箱漏液' }));
    expect(issue.plan.warranty.openIssues).toBe(1);
    expect(stageOf(issue.plan, 'warranty').reason).toContain('未处理的质量问题');
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/contracts/quality-issues/${issue.id}/resolve`, { resolvedOn: shiftDate(today, -1), resolution: '已换货' })).status).toBe(400);
    await ok(api(ctx.app, buyer, 'POST', `/api/erp/contracts/quality-issues/${issue.id}/resolve`, { resolvedOn: today, resolution: '已换货' }), 200);
    expect((await plan(c.id)).warranty.openIssues).toBe(0);
    // 已处理的不能作废；数据库兜底：只能改一次
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/contracts/quality-issues/${issue.id}/void`, { reason: '登错了' })).body.error.code).toBe('INVALID_STATE');
    await expect(ctx.sql`UPDATE contract_quality_issues SET description = '改' WHERE id = ${issue.id}`).rejects.toThrow(/只能从未处理改成已处理或作废一次/);
    // 作废合格的那条：以最近一条没作废的（不合格）为准
    const passId = p.acceptances.find((a) => a.result === 'pass')!.id;
    await ok(api(ctx.app, buyer, 'POST', `/api/erp/contracts/acceptances/${passId}/void`, { reason: '验收日登错' }), 200);
    expect(stageOf(await plan(c.id), 'acceptance').payableCents).toBe(0);
    await ok(acc({ result: 'pass' }));
    // 质保金台账：未到期
    const rows = await ok<{ contractId: number; rowStatus: string; dueDate: string }[]>(api(ctx.app, payer, 'GET', '/api/erp/payments/warranty'), 200);
    expect(rows.find((r) => r.contractId === c.id)).toMatchObject({ rowStatus: 'running', dueDate: addMonths(today, 12) });
  });

  it('验收款：照常申请、批了付；单张申请付一部分后「结束」', async () => {
    const r = (await ok(request({ source: { kind: 'contract', contractId: c.id, stage: 'acceptance', amountCents: 500_000 } }))).request as PaymentRequestDetail;
    // ¥5,000 不到 ¥50,000：两级
    expect(r.approval!.levels).toBe(2);
    const a = await approveAll(r);
    await ok(payReq(a.id, { amountCents: 100_000, allocations: [{ kind: 'receipt', targetId: rc1.receipt.id, amountCents: 100_000 }] }));
    // 作废不行（已经付过钱），结束要「登记付款」的人
    const d = await detail(a.id);
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/payments/requests/${a.id}/void`, { version: d.version, reason: '不付了' })).body.error.code).toBe('REQUEST_HAS_PAYMENTS');
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/payments/requests/${a.id}/end`, { version: d.version, reason: '剩下的扣作违约金' })).status).toBe(403);
    const ended = await ok(api(ctx.app, payer, 'POST', `/api/erp/payments/requests/${a.id}/end`, { version: d.version, reason: '剩下的扣作违约金' }), 200);
    expect(ended).toMatchObject({ status: 'ended', paidCents: 100_000 });
    const st = stageOf(await plan(c.id), 'acceptance');
    expect(st).toMatchObject({ paidCents: 100_000, requestedCents: 0, done: true });
  });

  it('服务合同：没有供应商档案，批了以后登记合同付款（不进供应商往来）；冲销后回到待付款', async () => {
    const s = await signedContract({ category: 'service', supplierId: null, counterparty: '城南保洁公司', totalCents: 300_000, paymentTerms: terms(0, 0, 100, 0), warranty: { basis: 'acceptance', months: 0 } });
    let p = await plan(s.id);
    expect(p).toMatchObject({ payMode: 'direct', supplierId: null, payee: '城南保洁公司' });
    await ok(api(ctx.app, buyer, 'POST', `/api/erp/contracts/${s.id}/acceptances`, { clientKey: randomUUID(), acceptedOn: today, result: 'pass', signer: '店长' }));
    p = await plan(s.id);
    expect(stageOf(p, 'acceptance')).toMatchObject({ payableCents: 300_000 });
    const r = (await ok(request({ source: { kind: 'contract', contractId: s.id, stage: 'acceptance', amountCents: 300_000 } }))).request as PaymentRequestDetail;
    // 服务合同不要求三单
    expect(r).toMatchObject({ payMode: 'direct', threeWayRequired: false, threeWayOk: true });
    const a = await approveAll(r);
    expect((await payReq(a.id, { amountCents: 300_000 })).body.error.code).toBe('PAY_MODE_MISMATCH');
    const balanceBefore = (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ap_entries`)[0]!.n;
    const out = await ok(
      api(ctx.app, payer, 'POST', `/api/erp/payments/requests/${a.id}/payout`, { clientKey: randomUUID(), payDate: today, amountCents: 300_000, method: 'bank_transfer', evidence: '对公转账 1234' }),
    );
    expect(out.request).toMatchObject({ status: 'paid', payments: [expect.objectContaining({ kind: 'payout', amountCents: 300_000, docNo: expect.stringMatching(/^HF/) })] });
    expect((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ap_entries`)[0]!.n).toBe(balanceBefore);
    expect((await plan(s.id)).settled).toBe(true);
    await ok(api(ctx.app, payer, 'POST', `/api/erp/payments/payouts/${out.payoutId}/void`, { reason: '转错账户' }), 200);
    expect((await detail(a.id)).status).toBe('approved');
    expect((await plan(s.id)).settled).toBe(false);
    await expect(ctx.sql`DELETE FROM contract_payouts WHERE id = ${out.payoutId}`).rejects.toThrow(/不能删除/);
  });

  it('没挂合同的应付：选收货单申请，别的申请占着的不能再申请；挂合同的收货单要从合同申请', async () => {
    const free = await receiveUnderContract(null, 10); // 500 元
    await ok(invoice([{ poId: free.poId, amountCents: 50_000 }]));
    const items = await ok<{ id: number; kind: string; contractNo: string | null; requestedCents: number }[]>(api(ctx.app, buyer, 'GET', `/api/erp/payments/suppliers/${supplierId}/open-items`), 200);
    expect(items.find((i) => i.kind === 'receipt' && i.id === rc1.receipt.id)!.contractNo).toBe(c.contractNo);
    const underContract = await request({ source: { kind: 'payables', supplierId, targets: [{ kind: 'receipt', targetId: rc1.receipt.id, amountCents: 1_000 }] } });
    expect(underContract.body.error.code).toBe('RECEIPT_UNDER_CONTRACT');
    const r = (await ok(request({ source: { kind: 'payables', supplierId, targets: [{ kind: 'receipt', targetId: free.receipt.id, amountCents: 30_000 }] } }))).request as PaymentRequestDetail;
    expect(r).toMatchObject({ amountCents: 30_000, contractId: null, threeWayRequired: true, threeWayOk: true, targets: [expect.objectContaining({ docNo: free.receipt.docNo, amountCents: 30_000 })] });
    // 别的申请占着 300 元，没结清 500 元：再申请 300 元拒绝，200 元可以
    expect((await request({ source: { kind: 'payables', supplierId, targets: [{ kind: 'receipt', targetId: free.receipt.id, amountCents: 30_000 }] } })).body.error.code).toBe('OVER_REQUESTED');
    const second = (await ok(request({ source: { kind: 'payables', supplierId, targets: [{ kind: 'receipt', targetId: free.receipt.id, amountCents: 20_000 }] } }))).request;
    await ok(api(ctx.app, buyer, 'POST', `/api/erp/payments/requests/${second.id}/void`, { version: second.version, reason: '重复了' }), 200);
    // 没挂合同的不用按提前付款申请
    expect((await request({ source: { kind: 'payables', supplierId, targets: [{ kind: 'receipt', targetId: free.receipt.id, amountCents: 1_000 }] }, early: true, earlyReason: '急' })).status).toBe(400);
    const a = await approveAll(r);
    // 要全部核销到申请里选的货款上
    expect((await payReq(a.id, { amountCents: 30_000, prepay: true })).status).toBe(400);
    const paid = await ok(payReq(a.id, { amountCents: 30_000, allocations: [{ kind: 'receipt', targetId: free.receipt.id, amountCents: 30_000 }] }));
    expect(paid.request.status).toBe('paid');
    // 没挂合同的照旧可以直接登记付款
    const direct = await api(ctx.app, payer, 'POST', '/api/payables/payments', {
      clientKey: randomUUID(),
      supplierId,
      payDate: today,
      amountCents: 1_000,
      method: 'bank_transfer',
      evidence: '流水尾号 0003',
      allocations: [{ kind: 'receipt', targetId: free.receipt.id, amountCents: 1_000 }],
    });
    expect(direct.status, JSON.stringify(direct.body)).toBe(201);
  });

  it('大额走店主：申请金额 ≥ ¥50,000 的默认三级', async () => {
    // 合同 ¥300,000，预付 20% = ¥60,000
    const big = await signedContract({ totalCents: 30_000_000, lines: [{ materialId: matId, itemName: '', spec: '', unit: '', priceCents: 50_00, taxRateBp: 1300, qtyMilli: q(6000) }] });
    const r = (await ok(request({ source: { kind: 'contract', contractId: big.id, stage: 'prepay', amountCents: 5_000_000 } }))).request as PaymentRequestDetail;
    expect(r.approval).toMatchObject({ levels: 3, stepLabels: ['财务', '负责人', '店主'] });
    const small = (await ok(request({ source: { kind: 'contract', contractId: big.id, stage: 'prepay', amountCents: 999_999 } }))).request as PaymentRequestDetail;
    expect(small.approval!.levels).toBe(2);
  });

  it('质保期满可付、本周应付与待办', async () => {
    // 质保从签订日起算 1 个月，40 天前签的：已经满了
    const w = await signedContract({
      totalCents: 100_000,
      paymentTerms: terms(0, 0, 90, 10),
      warranty: { basis: 'signing', months: 1 },
      signedOn: shiftDate(today, -40),
      lines: [{ materialId: matId, itemName: '', spec: '', unit: '', priceCents: 50_00, taxRateBp: 1300, qtyMilli: q(20) }],
    });
    const p = await plan(w.id);
    expect(stageOf(p, 'warranty')).toMatchObject({ payableCents: 10_000, availableCents: 10_000 });
    const rows = await ok<{ contractId: number; rowStatus: string }[]>(api(ctx.app, payer, 'GET', '/api/erp/payments/warranty?filter=due'), 200);
    expect(rows.find((r) => r.contractId === w.id)).toMatchObject({ rowStatus: 'payable' });
    // 一张批了没付的申请（期望付款日下周）
    const r = (await ok(request({ source: { kind: 'contract', contractId: w.id, stage: 'warranty', amountCents: 10_000 }, expectedDate: shiftDate(today, 7) }))).request as PaymentRequestDetail;
    // 期望付款日不能早于今天
    expect((await request({ source: { kind: 'contract', contractId: w.id, stage: 'warranty', amountCents: 1 }, expectedDate: shiftDate(today, -1) })).status).toBe(400);
    await approveAll(r);
    const weekly = await ok(api(ctx.app, payer, 'GET', '/api/erp/payments/weekly'), 200);
    expect(weekly.weeks).toHaveLength(4);
    const items = weekly.weeks.flatMap((wk: { items: unknown[] }) => wk.items) as { kind: string; requestId: number | null; contractId: number | null; amountCents: number; date: string }[];
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'approved', requestId: r.id, amountCents: 10_000, date: shiftDate(today, 7) })]));
    // 合同 c：第二张收货让到货段多放开 ¥200（¥6,000 / ¥10,000 × ¥2,000 − 已付 ¥1,000）；验收段的申请「结束」了，不算可付未申请；
    // 质保还没到期、不在四周里
    expect(items.filter((i) => i.kind === 'available' && i.contractId === c.id)).toEqual([expect.objectContaining({ stage: 'delivery', amountCents: 20_000 })]);
    expect(weekly.totalCents).toBe(weekly.weeks.reduce((s: number, wk: { totalCents: number }) => s + wk.totalCents, 0));
    const csv = await api(ctx.app, payer, 'GET', '/api/erp/payments/weekly/export');
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('本周应付');
    const todo = await ok(api(ctx.app, payer, 'GET', '/api/erp/payments/todo'), 200);
    expect(todo.awaitingPayment).toBeGreaterThanOrEqual(1);
    expect(todo.warrantyDue).toBeGreaterThanOrEqual(1);
  });

  it('结果待确认：付款申请、发票按编号查回；作废后原请求晚到不登记', async () => {
    const fresh = await signedContract({ totalCents: 100_000, lines: [{ materialId: matId, itemName: '', spec: '', unit: '', priceCents: 50_00, taxRateBp: 1300, qtyMilli: q(20) }] });
    const key = randomUUID();
    const abandon = await api(ctx.app, buyer, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'payment_request', summary: '测试' });
    expect(abandon.status, JSON.stringify(abandon.body)).toBe(200);
    const late = await api(ctx.app, buyer, 'POST', '/api/erp/payments/requests', {
      clientKey: key,
      source: { kind: 'contract', contractId: fresh.id, stage: 'prepay', amountCents: 1_000 },
      expectedDate: today,
      purpose: '预付款',
    });
    expect(late.body.error.code).toBe('OP_ABANDONED');
    const r = await ok(request({ source: { kind: 'contract', contractId: fresh.id, stage: 'prepay', amountCents: 1_000 } }));
    const looked = await ok(api(ctx.app, buyer, 'GET', `/api/erp/ops/${(await ctx.sql<{ clientKey: string }[]>`SELECT client_key FROM payment_requests WHERE id = ${r.request.id}`)[0]!.clientKey}?type=payment_request`), 200);
    expect(looked).toMatchObject({ found: true, refId: r.request.id });
  });

  it('应付总览：没到期的质保金单独一列（不超过余额）', async () => {
    const ov = await ok(api(ctx.app, payer, 'GET', '/api/payables/overview'), 200);
    const row = ov.suppliers.find((s: { supplierId: number }) => s.supplierId === supplierId);
    expect(row.warrantyHeldCents).toBeGreaterThan(0);
    expect(row.warrantyHeldCents).toBeLessThanOrEqual(Math.max(0, row.balanceCents));
    expect(ov.totals.warrantyHeldCents).toBe(ov.suppliers.reduce((t: number, s: { warrantyHeldCents: number }) => t + s.warrantyHeldCents, 0));
  });

  it('自检一致', async () => {
    // 8.0.3 加了一项「进项发票台账」
    expect(await paymentChecks(ctx.sql)).toEqual([expect.objectContaining({ key: 'payments', ok: true }), expect.objectContaining({ key: 'input_invoices', ok: true })]);
    expect(await approvalChecks(ctx.sql)).toMatchObject({ ok: true });
  });
});

describe('付款规则（8.0.6）', () => {
  const RULES = '/api/erp/payments/rules';
  const setRules = (body: Record<string, unknown>, cookie = boss) => api(ctx.app, cookie, 'PUT', RULES, body);
  const contract = (totalCents: number, boxes: number, over: Parameters<typeof signedContract>[0] = {}) =>
    signedContract({ totalCents, lines: [{ materialId: matId, itemName: '', spec: '', unit: '', priceCents: 50_00, taxRateBp: 1300, qtyMilli: q(boxes) }], ...over });
  // 放回默认，别的用例照默认算
  afterAll(async () => {
    await ok(setRules({ ...DEFAULT_PAYMENT_RULES }), 200);
  });

  it('默认值；能看付款的能看，改要「修改经营规则设置」；只改提交的字段、记审计；不合格的拒绝；本周应付按周数', async () => {
    expect(await ok(api(ctx.app, payer, 'GET', RULES), 200)).toEqual(DEFAULT_PAYMENT_RULES);
    expect(await ok(api(ctx.app, buyer, 'GET', RULES), 200)).toEqual(DEFAULT_PAYMENT_RULES);
    expect((await api(ctx.app, dept, 'GET', RULES)).status).toBe(403);
    expect((await setRules({ weeklyWeeks: 2 }, payer)).status).toBe(403);
    expect((await setRules({ weeklyWeeks: 2 }, buyer)).status).toBe(403);
    expect(await ok(setRules({ weeklyWeeks: 2 }), 200)).toEqual({ ...DEFAULT_PAYMENT_RULES, weeklyWeeks: 2 });
    const [audit] = await ctx.sql<{ detail: { key: string; before: { weeklyWeeks: number }; after: { weeklyWeeks: number } } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'settings_updated' AND detail->>'key' = 'payment_rules' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail).toMatchObject({ before: { weeklyWeeks: 4 }, after: { weeklyWeeks: 2 } });
    for (const bad of [
      { weeklyWeeks: 0 },
      { weeklyWeeks: 13 },
      { threeWayPctBp: 10_001 },
      { threeWayCapCents: -1 },
      { warrantyRemindDays: 1.5 },
      { warrantyRemindDays: 366 },
      { ownerLevelCents: 0 },
      { requireRequestForContractGoods: 'no' },
    ]) {
      expect((await setRules(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    // 不合格的没写进去
    expect(await ok(api(ctx.app, payer, 'GET', RULES), 200)).toEqual({ ...DEFAULT_PAYMENT_RULES, weeklyWeeks: 2 });
    const weekly = await ok(api(ctx.app, payer, 'GET', '/api/erp/payments/weekly'), 200);
    expect(weekly.weeks).toHaveLength(2);
    expect(String((await api(ctx.app, payer, 'GET', '/api/erp/payments/weekly/export')).body)).toContain('2 周合计');
    await ok(setRules({ weeklyWeeks: 4 }), 200);
    expect((await ok(api(ctx.app, payer, 'GET', '/api/erp/payments/weekly'), 200)).weeks).toHaveLength(4);
  });

  it('三单差额门槛（P8）：收紧以后挂起、原因里写当时的门槛；放回以后又对得上', async () => {
    const rc = await receiveUnderContract(null, 20); // 1,000 元，没挂合同
    await ok(invoice([{ poId: rc.poId, amountCents: 100_800 }])); // 差 8 元：在 1%（10 元）且 ¥50 内
    const row = () => ok(api(ctx.app, payer, 'GET', `/api/erp/payments/three-way/po/${rc.poId}`), 200);
    expect((await row()).status).toBe('matched');
    await ok(setRules({ threeWayPctBp: 50 }), 200); // 0.5% = 5 元
    expect(await row()).toMatchObject({ status: 'held', reason: expect.stringContaining('超过 0.5% 且 ¥50') });
    await ok(setRules({ threeWayPctBp: 100, threeWayCapCents: 500 }), 200); // 1% 但封顶 ¥5
    expect(await row()).toMatchObject({ status: 'held', reason: expect.stringContaining('超过 1% 且 ¥5') });
    const pending = await ok<{ poId: number }[]>(api(ctx.app, payer, 'GET', '/api/erp/payments/three-way?pending=1'), 200);
    expect(pending.map((x) => x.poId)).toContain(rc.poId);
    await ok(setRules({ threeWayCapCents: 5_000 }), 200);
    expect((await row()).status).toBe('matched');
  });

  it('质保金提前提醒天数（P9）：两个月后到期的，默认不提醒，改成 90 天进待办', async () => {
    const w = await contract(100_000, 20, { paymentTerms: terms(0, 0, 90, 10), warranty: { basis: 'signing', months: 2 } });
    const due = async () => ok<WarrantyRow[]>(api(ctx.app, payer, 'GET', '/api/erp/payments/warranty?filter=due'), 200);
    const all = await ok<WarrantyRow[]>(api(ctx.app, payer, 'GET', '/api/erp/payments/warranty'), 200);
    expect(all.find((r) => r.contractId === w.id)).toMatchObject({ rowStatus: 'running' });
    expect((await due()).some((r) => r.contractId === w.id)).toBe(false);
    const before = (await ok(api(ctx.app, payer, 'GET', '/api/erp/payments/todo'), 200)).warrantyDue as number;
    await ok(setRules({ warrantyRemindDays: 90 }), 200);
    expect((await due()).find((r) => r.contractId === w.id)).toMatchObject({ rowStatus: 'due_soon' });
    expect((await ok(api(ctx.app, payer, 'GET', '/api/erp/payments/todo'), 200)).warrantyDue).toBe(before + 1);
    await ok(setRules({ warrantyRemindDays: 30 }), 200);
    expect((await due()).some((r) => r.contractId === w.id)).toBe(false);
  });

  it('加店主一级的金额（P5）：改了以后新提交的按新值、已经提交的不变；不勾为一律两级；提前付款照旧三级', async () => {
    // 合同 ¥600,000，预付 20% = ¥120,000
    const k = await contract(60_000_000, 12_000);
    const prepay = (amountCents: number) => ok(request({ source: { kind: 'contract', contractId: k.id, stage: 'prepay', amountCents } })).then((r) => r.request as PaymentRequestDetail);
    const before = await prepay(1_000_000); // ¥10,000：默认两级
    expect(before.approval).toMatchObject({ levels: 2, stepLabels: ['财务', '负责人'] });
    await ok(setRules({ ownerLevelCents: 1_000_000 }), 200); // 满 ¥10,000 加店主
    expect((await prepay(1_000_000)).approval).toMatchObject({ levels: 3, stepLabels: ['财务', '负责人', '店主'] });
    expect((await detail(before.id)).approval!.levels).toBe(2); // 已经提交的不回头改
    await ok(setRules({ ownerLevelCents: null }), 200); // 不加店主
    expect((await prepay(6_000_000)).approval).toMatchObject({ levels: 2, stepLabels: ['财务', '负责人'] }); // ¥60,000 也两级
    const early = await ok(
      request({ source: { kind: 'contract', contractId: k.id, stage: 'acceptance', amountCents: 1_000_000 }, early: true, earlyReason: '供应商资金周转' }),
    );
    expect((early.request as PaymentRequestDetail).approval!.levels).toBe(3); // 提前付款（P6）照旧三级
    await ok(setRules({ ownerLevelCents: DEFAULT_PAYMENT_RULES.ownerLevelCents }), 200);
    expect((await prepay(1_000_000)).approval!.levels).toBe(2);
  });

  it('挂合同的货款要先提申请（P7）：关掉以后可以直接登记付款，付款计划记在「不带付款申请的付款」；开回来又拦', async () => {
    const k = await contract(100_000, 20);
    const rc = await receiveUnderContract(k.id, 10); // 500 元
    const pay = (amountCents: number) =>
      api(ctx.app, payer, 'POST', '/api/payables/payments', {
        clientKey: randomUUID(),
        supplierId,
        payDate: today,
        amountCents,
        method: 'bank_transfer',
        evidence: '流水尾号 0806',
        allocations: [{ kind: 'receipt', targetId: rc.receipt.id, amountCents }],
      });
    expect((await pay(1_000)).body.error.code).toBe('PAYMENT_REQUEST_REQUIRED');
    await ok(setRules({ requireRequestForContractGoods: false }), 200);
    const direct = await pay(1_000);
    expect(direct.status, JSON.stringify(direct.body)).toBe(201);
    if (direct.body.payment.status !== 'confirmed') await ok(api(ctx.app, mgr, 'POST', `/api/payables/payments/${direct.body.payment.id}/approve`, {}), 200);
    const p = await plan(k.id);
    expect(p).toMatchObject({ legacyPaidCents: 1_000, paidCents: 0 }); // 不算在各段里
    // 关着时没带申请的预付款也能核销到合同的收货单上：同样记在「不带付款申请的付款」（Codex 审查 #82 b240f89 的 P2，8.0.7 补）
    const loose = await ok<{ payment: { id: number; status: string } }>(
      api(ctx.app, payer, 'POST', '/api/payables/payments', {
        clientKey: randomUUID(),
        supplierId,
        payDate: today,
        amountCents: 2_000,
        method: 'bank_transfer',
        evidence: '流水尾号 0807',
        note: '零星预付',
        prepay: true,
        approveNow: false,
        allocations: [],
      }),
    );
    if (loose.payment.status !== 'confirmed') await ok(api(ctx.app, mgr, 'POST', `/api/payables/payments/${loose.payment.id}/approve`, {}), 200);
    const offset = (amountCents: number) =>
      api(ctx.app, payer, 'POST', '/api/payables/offsets', {
        clientKey: randomUUID(),
        supplierId,
        offsetDate: today,
        credit: { kind: 'prepayment', id: loose.payment.id },
        lines: [{ kind: 'receipt', targetId: rc.receipt.id, amountCents }],
      });
    const off = await offset(1_500);
    expect(off.status, JSON.stringify(off.body)).toBe(201);
    expect(await plan(k.id)).toMatchObject({ legacyPaidCents: 2_500, paidCents: 0 });
    // 冲销了的核销不算
    await ok(api(ctx.app, payer, 'POST', `/api/payables/offsets/${off.body.offset.id}/void`, { reason: '核销错了单' }), 200);
    expect(await plan(k.id)).toMatchObject({ legacyPaidCents: 1_000 });
    await ok(setRules({ requireRequestForContractGoods: true }), 200);
    expect((await offset(500)).body.error.code).toBe('PAYMENT_REQUEST_REQUIRED');
    expect((await pay(1_000)).body.error.code).toBe('PAYMENT_REQUEST_REQUIRED');
    expect(await paymentChecks(ctx.sql)).toEqual([expect.objectContaining({ key: 'payments', ok: true }), expect.objectContaining({ key: 'input_invoices', ok: true })]);
  });
});
