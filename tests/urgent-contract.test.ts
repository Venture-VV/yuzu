// 8.1.10 急采后补合同（docs/ERP_V8110.md 第 1 节，PENDING_DECISIONS CK18–CK22）：
//   · 急采生效时合计达到「急采补合同金额」（默认 ¥20,000）的记下要补合同；没达到的、金额线设 0 的不要求；
//   · 补上之前：付款申请、直接登记付款、预付款核销（带不带付款申请都拦）、现付供应商按补单采购单报销都拦（CONTRACT_REQUIRED）；
//   · 补合同：只能挂这家供应商的、生效中、到期日不早于下单日的采购合同（开始日可以晚于下单日）；超出合同价要写说明；
//     同一份重提照原样，挂上以后不能换；付过款（含预付款核销）或在付款申请里的不能补；挂上以后的货款照合同走；
//   · 待补合同清单：期限从生效那天算，超期为负数；采购的待办数算上。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { LEGAL_ITEM_KEYS, type ContractDetail } from '../src/shared/contracts';
import { shiftDate } from '../src/shared/labels';
import type { PurchaseOrder, PurchaseRules, UrgentContractDueRow } from '../src/shared/purchasing';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let buyer: string; // 采购：登记急采、补采购单、补合同、发起付款申请
let payer: string; // 财务：登记付款、报销
let keeper: string; // 仓库：到部门验收
let lawyer: string;
let mgr: string; // 负责人：审急采
let deptId: number;
let supplierId: number;
let otherSupplierId: number;
let matId: number;

const q = (n: number) => Math.round(n * 1000);
const allPass = () => LEGAL_ITEM_KEYS.map((key) => ({ key, verdict: 'pass', note: '' }));
async function ok<T = any>(res: Promise<{ status: number; body: any }>, status = 201): Promise<T> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
}
const approveAt = (cookie: string, requestId: number, level: number, extra: Record<string, unknown> = {}) => api(ctx.app, cookie, 'POST', `/api/approvals/${requestId}/approve`, { level, ...extra });

/** 签好的采购合同：单价 ¥2,500 / 个、200 个；预付段默认 0（prepayBp 给了按它，其余是到货段） */
async function signedContract(over: { supplierId?: number; startDate?: string; endDate?: string; priceCents?: number; prepayBp?: number } = {}) {
  const created = await ok(
    api(ctx.app, buyer, 'POST', '/api/erp/contracts', {
      clientKey: randomUUID(),
      category: 'purchase',
      supplierId: over.supplierId ?? supplierId,
      counterparty: '',
      content: {
        title: `补合同测试 ${randomUUID().slice(0, 6)}`,
        startDate: over.startDate ?? today,
        endDate: over.endDate ?? shiftDate(today, 365),
        totalCents: 50_000_000,
        taxRateBp: 1300,
        freightBearer: 'supplier',
        unloadingBearer: 'supplier',
        paymentTerms: [
          { stage: 'prepay', percentBp: over.prepayBp ?? 0 },
          { stage: 'delivery', percentBp: 10000 - (over.prepayBp ?? 0) },
          { stage: 'acceptance', percentBp: 0 },
          { stage: 'warranty', percentBp: 0 },
        ],
        warranty: { basis: 'acceptance', months: 0 },
        acceptance: { method: '按样品验收', signer: '仓库经办', penalty: '不合格退换' },
        note: '',
        lines: [{ materialId: matId, itemName: '', spec: '', unit: '', priceCents: over.priceCents ?? 250_000, taxRateBp: 1300, qtyMilli: q(200) }],
      },
    }),
  );
  let c = created.contract as ContractDetail;
  c = await ok(api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/submit`, { version: c.version }), 200);
  const rid = c.approval!.requestId;
  await ok(approveAt(payer, rid, 1), 200);
  await ok(approveAt(lawyer, rid, 2, { checklist: allPass() }), 200);
  await ok(approveAt(mgr, rid, 3), 200);
  c = (await api(ctx.app, buyer, 'GET', `/api/erp/contracts/${c.id}`)).body;
  return ok<ContractDetail>(api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/sign`, { version: c.version, signedOn: today, ourSignatory: '林岚', theirSignatory: '王经理' }), 200);
}

/** 登记一张急采并审批、到部门验收生效：qty 个 × 单价（元） */
async function urgentReceipt(qty: number, priceYuan: number, supplier = supplierId) {
  const rc = await ok(
    api(ctx.app, buyer, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId: supplier,
      urgent: true,
      departmentId: deptId,
      lines: [{ materialId: matId, deliveredMilli: q(qty), acceptedMilli: q(qty), priceCents: priceYuan * 100 }],
    }),
  );
  await ok(api(ctx.app, mgr, 'POST', `/api/inventory/docs/${rc.doc.id}/approve`, {}), 200);
  const verified = await ok(api(ctx.app, keeper, 'POST', `/api/inventory/docs/${rc.doc.id}/verify-urgent`, {}), 200);
  expect(verified.status).toBe('confirmed');
  return rc.doc as { id: number; docNo: string; amountCents: number };
}
const backfill = async (receiptId: number) => (await ok(api(ctx.app, buyer, 'POST', '/api/purchase-orders/backfill', { clientKey: randomUUID(), receiptDocId: receiptId }))).po as PurchaseOrder;
const needsContract = async (receiptId: number) => (await ctx.sql<{ n: boolean }[]>`SELECT needs_contract AS n FROM inv_docs WHERE id = ${receiptId}`)[0]!.n;
const dueList = async () => ok<UrgentContractDueRow[]>(api(ctx.app, buyer, 'GET', '/api/purchase-orders/contract-due'), 200);
const attach = (poId: number, body: Record<string, unknown>) => api(ctx.app, buyer, 'POST', `/api/purchase-orders/${poId}/contract`, body);
const payablesRequest = (receiptId: number, amountCents: number, supplier = supplierId) =>
  api(ctx.app, buyer, 'POST', '/api/erp/payments/requests', {
    clientKey: randomUUID(),
    expectedDate: today,
    purpose: '急采货款',
    source: { kind: 'payables', supplierId: supplier, targets: [{ kind: 'receipt', targetId: receiptId, amountCents }] },
  });
const invoice = (poId: number, amountCents: number) =>
  api(ctx.app, payer, 'POST', '/api/erp/payments/invoices', {
    clientKey: randomUUID(),
    supplierId,
    invoiceNo: `FP${randomUUID().slice(0, 8)}`,
    invoiceDate: today,
    totalCents: amountCents,
    taxCents: 0,
    taxRateBp: 1300,
    lines: [{ poId, amountCents }],
  });
const rules = async () => ok<PurchaseRules>(api(ctx.app, ctx.owner, 'GET', '/api/inventory/purchase-rules'), 200);
const saveRules = async (patch: Partial<PurchaseRules>) => {
  const { channels: _c, ...cur } = await rules();
  return api(ctx.app, ctx.owner, 'PUT', '/api/inventory/purchase-rules', { ...cur, ...patch });
};

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  payer = await login(ctx.app, 'qianfen', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  const staff = async (username: string, displayName: string, duties: ('approve' | 'legal')[]) => {
    await createStaff(ctx.sql, { username, displayName, role: 'backoffice', duties, password: PASSWORD, mustChangePassword: false });
    return login(ctx.app, username);
  };
  lawyer = await staff('uc_legal', '法务甲', ['legal']);
  mgr = await staff('uc_mgr', '负责人乙', ['approve']);
  deptId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM departments ORDER BY id LIMIT 1`)[0]!.id);
  const add = async (code: string, name: string) => {
    const list = (await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code, name })).body as { id: number; code: string }[];
    return list.find((x) => x.code === code)!.id;
  };
  supplierId = await add('UC01', '补合同测试供应商');
  otherSupplierId = await add('UC02', '补合同另一家');
  const m = await ok(api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', { code: 'UC-M1', name: '补合同测试物料', inventoryUnit: '个', purchaseUnit: '个', purchaseFactorMilli: q(1) }));
  matId = m.id;
}, 60_000);
afterAll(async () => ctx.close());

describe('急采后补合同', () => {
  it('设置：默认要补合同的线 ¥20,000、期限 15 天，范围核对', async () => {
    // 提需核库在用例基线里关着（tests/helpers.ts），默认开由 tests/switches-default.test.ts 核对
    expect(await rules()).toMatchObject({ urgentContractMinCents: 2_000_000, contractDueDays: 15, stockCheckHours: 24 });
    expect((await saveRules({ contractDueDays: 0 })).status).toBe(400);
    expect((await saveRules({ urgentContractMinCents: -1 })).status).toBe(400);
    expect((await saveRules({ stockCheckHours: 200 })).status).toBe(400);
  });

  it('生效时达到 ¥20,000 的要补合同，没达到的不要；补上之前付款申请、直接登记付款都拦；清单与待办数', async () => {
    const big = await urgentReceipt(10, 2_500); // ¥25,000
    const small = await urgentReceipt(2, 2_500); // ¥5,000
    expect(big.amountCents).toBe(2_500_000);
    expect(await needsContract(big.id)).toBe(true);
    expect(await needsContract(small.id)).toBe(false);

    // 还没补采购单、也没补合同：清单里有，期限 = 生效那天 + 15 天
    const row = (await dueList()).find((r) => r.receiptId === big.id)!;
    expect(row).toMatchObject({ docNo: big.docNo, poId: null, dueOn: shiftDate(today, 15), daysLeft: 15, amountCents: 2_500_000 });
    expect((await dueList()).some((r) => r.receiptId === small.id)).toBe(false);
    expect((await ok(api(ctx.app, buyer, 'GET', '/api/inventory/supply-todo'), 200)).contractDue).toBeGreaterThanOrEqual(1);

    // 补采购单以后照样要补合同：详情里写着期限
    const po = await backfill(big.id);
    const detail = await ok<PurchaseOrder>(api(ctx.app, buyer, 'GET', `/api/purchase-orders/${po.id}`), 200);
    expect(detail.contractDue).toEqual({ dueOn: shiftDate(today, 15), daysLeft: 15 });
    expect((await dueList()).find((r) => r.receiptId === big.id)).toMatchObject({ poId: po.id, poNo: po.docNo });

    // 付款申请、直接登记付款都拦
    expect((await payablesRequest(big.id, 1_000)).body.error.code).toBe('CONTRACT_REQUIRED');
    const direct = await api(ctx.app, payer, 'POST', '/api/payables/payments', {
      clientKey: randomUUID(),
      supplierId,
      payDate: today,
      amountCents: 1_000,
      method: 'bank_transfer',
      evidence: '流水尾号 0001',
      allocations: [{ kind: 'receipt', targetId: big.id, amountCents: 1_000 }],
    });
    expect(direct.body.error?.code, JSON.stringify(direct.body)).toBe('CONTRACT_REQUIRED');

    // 超期：把生效时间往前挪 20 天（已生效的单据有触发器拦改，测试库里临时关掉）
    await ctx.sql.begin(async (tx) => {
      await tx`ALTER TABLE inv_docs DISABLE TRIGGER inv_docs_guard`;
      await tx`UPDATE inv_docs SET confirmed_at = confirmed_at - interval '20 days' WHERE id = ${big.id}`;
      await tx`ALTER TABLE inv_docs ENABLE TRIGGER inv_docs_guard`;
    });
    expect((await dueList()).find((r) => r.receiptId === big.id)!.daysLeft).toBe(-5);
  });

  it('预付款带不带付款申请都不能核销到要补合同、还没补上的急采；补上以后带申请的照常核销（Codex 审查 8f01337）', async () => {
    const rc = await urgentReceipt(10, 2_500); // ¥25,000：要补合同
    expect(await needsContract(rc.id)).toBe(true);
    // 没带申请的预付款
    const loose = await ok<{ payment: { id: number; status: string } }>(
      api(ctx.app, payer, 'POST', '/api/payables/payments', {
        clientKey: randomUUID(),
        supplierId,
        payDate: today,
        amountCents: 2_000,
        method: 'bank_transfer',
        evidence: '流水尾号 0810',
        note: '零星预付',
        prepay: true,
        approveNow: false,
        allocations: [],
      }),
    );
    if (loose.payment.status !== 'confirmed') await ok(api(ctx.app, mgr, 'POST', `/api/payables/payments/${loose.payment.id}/approve`, {}), 200);
    // 带申请的预付款：合同预付段的付款申请批完、按申请登记付款，记为预付款
    const c = await signedContract({ prepayBp: 1000 });
    const req = await ok(
      api(ctx.app, buyer, 'POST', '/api/erp/payments/requests', {
        clientKey: randomUUID(),
        expectedDate: today,
        purpose: '预付款',
        source: { kind: 'contract', contractId: c.id, stage: 'prepay', amountCents: 100_000 },
      }),
    );
    const rid = req.request.approval.requestId;
    await ok(approveAt(payer, rid, 1), 200);
    await ok(approveAt(mgr, rid, 2), 200);
    const paid = await ok(
      api(ctx.app, payer, 'POST', `/api/erp/payments/requests/${req.request.id}/pay`, {
        clientKey: randomUUID(),
        payDate: today,
        method: 'bank_transfer',
        evidence: '流水尾号 0811',
        amountCents: 100_000,
        prepay: true,
      }),
    );
    const fromReq = Number(paid.payment.id);
    const offset = (creditId: number) =>
      api(ctx.app, payer, 'POST', '/api/payables/offsets', {
        clientKey: randomUUID(),
        supplierId,
        offsetDate: today,
        credit: { kind: 'prepayment', id: creditId },
        lines: [{ kind: 'receipt', targetId: rc.id, amountCents: 1_000 }],
      });
    expect((await offset(loose.payment.id)).body.error?.code).toBe('CONTRACT_REQUIRED');
    expect((await offset(fromReq)).body.error?.code).toBe('CONTRACT_REQUIRED');

    // 补上合同以后：带申请的预付款照常核销；没带申请的照 P7 先走付款申请
    const po = await backfill(rc.id);
    await ok(attach(po.id, { contractId: c.id }), 200);
    const after = await offset(fromReq);
    expect(after.status, JSON.stringify(after.body)).toBe(201);
    expect((await offset(loose.payment.id)).body.error?.code).toBe('PAYMENT_REQUEST_REQUIRED');
  });

  it('补合同：这家供应商、生效中、到期日不早于下单日（开始日可以晚）；超出合同价要说明；同一份重提照原样，挂上以后不能换', async () => {
    const rc = await urgentReceipt(10, 2_600); // ¥26,000，单价比合同高 ¥100
    const po = await backfill(rc.id);
    // 普通采购单不在这里补合同
    const normal = await ok(
      api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', {
        clientKey: randomUUID(),
        supplierId,
        orderDate: today,
        approveNow: true,
        lines: [{ materialId: matId, purchaseQtyMilli: q(1), priceCents: 1_000 }],
      }),
    );
    const later = await signedContract({ startDate: shiftDate(today, 3) }); // 补签：开始日晚于下单日
    expect((await attach(normal.po.id, { contractId: later.id })).body.error.code).toBe('NOT_BACKFILL');

    // 能选的合同：这家的、到期日不早于下单日；别家的不出现
    const others = await signedContract({ supplierId: otherSupplierId });
    const options = await ok<{ id: number }[]>(api(ctx.app, buyer, 'GET', `/api/purchase-orders/${po.id}/contract-options`), 200);
    expect(options.map((o) => o.id)).toContain(later.id);
    expect(options.map((o) => o.id)).not.toContain(others.id);
    expect((await attach(po.id, { contractId: others.id })).body.error.code).toBe('CONTRACT_MISMATCH');

    // 单价超过合同价：要写说明
    expect((await attach(po.id, { contractId: later.id })).body.error.code).toBe('CONTRACT_DEVIATION_REASON_REQUIRED');
    const done = await ok<PurchaseOrder>(attach(po.id, { contractId: later.id, contractNote: '急用，按当天市价' }), 200);
    expect(done.contract).toMatchObject({ id: later.id });
    expect(done.contractAddedByName).toBeTruthy();
    expect(done.contractNote).toBe('急用，按当天市价');
    // 同一份重提照原样；换另一份拒绝
    expect((await attach(po.id, { contractId: later.id, contractNote: '急用，按当天市价' })).status).toBe(200);
    const another = await signedContract();
    expect((await attach(po.id, { contractId: another.id, contractNote: '换一份' })).body.error.code).toBe('PO_CONTRACT_SET');

    // 补上以后：不在清单里、详情不再写期限；货款照合同走（应付货款来源的申请拒绝）
    expect((await dueList()).some((r) => r.receiptId === rc.id)).toBe(false);
    expect((await ok<PurchaseOrder>(api(ctx.app, buyer, 'GET', `/api/purchase-orders/${po.id}`), 200)).contractDue).toBeNull();
    expect((await payablesRequest(rc.id, 1_000)).body.error.code).toBe('RECEIPT_UNDER_CONTRACT');
  });

  it('合同在下单日以前就到期了的不能挂；已经在付款申请里的补单采购单不能补合同', async () => {
    const rc = await urgentReceipt(2, 2_500); // ¥5,000：不要求补合同，照样能补
    const po = await backfill(rc.id);
    const expired = await signedContract({ startDate: shiftDate(today, -400), endDate: shiftDate(today, -30) });
    expect((await attach(po.id, { contractId: expired.id })).body.error.code).toBe('CONTRACT_NOT_EFFECTIVE');
    // 不要求补合同的急采照常从应付货款付：登记发票、提付款申请以后就不能再补合同
    await ok(invoice(po.id, rc.amountCents));
    await ok(payablesRequest(rc.id, rc.amountCents));
    const c = await signedContract();
    expect((await attach(po.id, { contractId: c.id })).body.error.code).toBe('PO_ALREADY_PAID');
  });

  it('用预付款核销过（没冲销）的补单采购单不能补合同；那笔核销冲销了以后能补（Codex 审查 06f6d58）', async () => {
    const rc = await urgentReceipt(2, 2_500); // ¥5,000：不要求补合同，照常能核销
    expect(await needsContract(rc.id)).toBe(false);
    const po = await backfill(rc.id);
    const pre = await ok<{ payment: { id: number; status: string } }>(
      api(ctx.app, payer, 'POST', '/api/payables/payments', {
        clientKey: randomUUID(),
        supplierId,
        payDate: today,
        amountCents: 3_000,
        method: 'bank_transfer',
        evidence: '流水尾号 0812',
        note: '零星预付',
        prepay: true,
        approveNow: false,
        allocations: [],
      }),
    );
    if (pre.payment.status !== 'confirmed') await ok(api(ctx.app, mgr, 'POST', `/api/payables/payments/${pre.payment.id}/approve`, {}), 200);
    const off = await ok<{ offset: { id: number; docNo: string } }>(
      api(ctx.app, payer, 'POST', '/api/payables/offsets', {
        clientKey: randomUUID(),
        supplierId,
        offsetDate: today,
        credit: { kind: 'prepayment', id: pre.payment.id },
        lines: [{ kind: 'receipt', targetId: rc.id, amountCents: 1_000 }],
      }),
    );
    const c = await signedContract();
    const blocked = await attach(po.id, { contractId: c.id });
    expect(blocked.body.error?.code, JSON.stringify(blocked.body)).toBe('PO_ALREADY_PAID');
    expect(blocked.body.error.message).toContain(off.offset.docNo);
    // 冲销那笔核销以后能补
    await ok(api(ctx.app, payer, 'POST', `/api/payables/offsets/${off.offset.id}/void`, { reason: '核销错了单' }), 200);
    expect((await ok<PurchaseOrder>(attach(po.id, { contractId: c.id }), 200)).contract).toMatchObject({ id: c.id });
  });

  it('现付供应商的急采：要补合同、还没补上的不能按补单采购单报销；金额线设 0 以后不再要求', async () => {
    const cash = await ok(api(ctx.app, buyer, 'GET', `/api/inventory/suppliers`), 200);
    const s = (cash as { id: number; code: string; name: string }[]).find((x) => x.id === otherSupplierId)!;
    await ok(api(ctx.app, buyer, 'PUT', `/api/inventory/suppliers/${s.id}`, { code: s.code, name: s.name, settlement: 'cash' }), 200);
    const rc = await urgentReceipt(10, 2_500, otherSupplierId);
    expect(await needsContract(rc.id)).toBe(true);
    const po = await backfill(rc.id);
    const prefill = await api(ctx.app, ctx.owner, 'GET', `/api/erp/expenses/po/${po.id}/prefill`);
    expect(prefill.body.error?.code, JSON.stringify(prefill.body)).toBe('CONTRACT_REQUIRED');

    // 金额线设 0：新生效的急采不要求（已经生效的照旧要补）
    expect((await saveRules({ urgentContractMinCents: 0 })).status).toBe(200);
    const after = await urgentReceipt(10, 2_500);
    expect(await needsContract(after.id)).toBe(false);
    expect(await needsContract(rc.id)).toBe(true);
    expect((await saveRules({ urgentContractMinCents: 2_000_000 })).status).toBe(200);
  });
});
