// 费用报销与备用金（v0.7.7，飞书需求 RQ-005 第一步，见 docs/EXPENSES.md）：
// 权限（D10）、固定选项与互校、超门槛确认（D13）、备用金按部门平账（D14）、现付供应商与按采购单报销、幂等与并发、自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let boss: string; // 演示店主 linlan
let keeper: string; // 物资经办（只读）
let buyer: string; // 采购经办 + 对账付款（可登记打款、不能登记报销）
let coster: string; // 成本核算
let approver: string; // 负责人
let deptA: number;
let deptB: number;
let costerId: number;
/** 采购经办 zhouyi：收货时一起验收（v0.7.11，#17） */
let buyerId: number;
const q = (n: number) => Math.round(n * 1000);
const daysAgo = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const supplier = async (code: string) => {
  const res = await api(ctx.app, ctx.owner, 'GET', '/api/inventory/suppliers?all=1');
  return res.body.find((s: { code: string }) => s.code === code);
};
const material = async (code: string) => {
  const res = await api(ctx.app, ctx.owner, 'GET', '/api/inventory/materials?all=1');
  return res.body.find((m: { code: string }) => m.code === code);
};

const advance = (cookie: string, body: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', '/api/erp/petty/advances', {
    clientKey: randomUUID(),
    departmentId: deptA,
    handlerId: costerId,
    advanceDate: today,
    amountCents: 100_000,
    method: 'wechat',
    evidence: '转账尾号 0001',
    ...body,
  });

const line = (over: Record<string, unknown> = {}) => ({
  name: '打印纸',
  category: 'office',
  unit: '包',
  boughtMilli: q(2),
  receivedMilli: q(2),
  amountCents: 6_000,
  ...over,
});

const claim = (cookie: string, body: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', '/api/erp/expenses', {
    clientKey: randomUUID(),
    expenseDate: today,
    departmentId: deptA,
    handlerId: costerId,
    purpose: '办公',
    paySource: 'company',
    invoiceType: 'receipt',
    taxRateBp: 0,
    lines: [line()],
    ...body,
  });

const settle = (cookie: string, advanceId: number, kind: 'return' | 'topup', amountCents: number, body: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', '/api/erp/petty/settlements', {
    clientKey: randomUUID(),
    advanceId,
    kind,
    settleDate: today,
    amountCents,
    method: 'cash',
    evidence: '现金当面点清',
    ...body,
  });

const getAdvance = async (id: number) => (await api(ctx.app, boss, 'GET', `/api/erp/petty/advances/${id}`)).body;

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  buyerId = (await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'zhouyi'`)[0]!.id;
  costerId = await createStaff(ctx.sql, { username: 'coster', displayName: '成本岗', role: 'backoffice', duties: ['cost'], password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'appr', displayName: '负责人', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
  coster = await login(ctx.app, 'coster');
  approver = await login(ctx.app, 'appr');
  const mk = async (name: string) => {
    await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name });
    const list = await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1');
    return list.body.find((d: { name: string }) => d.name === name).id as number;
  };
  deptA = await mk('采购部');
  deptB = await mk('水吧');
}, 120_000);
afterAll(async () => ctx.close());

describe('权限（D10：岗位 + 职责）', () => {
  it('成本核算登记报销与打款；对账付款只能登记打款；物资经办只读；前台店员看不到', async () => {
    expect((await claim(coster)).status).toBe(201);
    expect((await claim(buyer)).status).toBe(403);
    expect((await claim(keeper)).status).toBe(403);
    expect((await advance(buyer)).status).toBe(201);
    expect((await advance(keeper)).status).toBe(403);
    expect((await api(ctx.app, keeper, 'GET', `/api/erp/expenses?from=${today}&to=${today}`)).status).toBe(200);
    expect((await api(ctx.app, keeper, 'GET', `/api/erp/petty/daily?from=${today}&to=${today}`)).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/erp/expenses?from=${today}&to=${today}`)).status).toBe(403);
    // 导出：物资经办不能，负责人可以
    expect((await api(ctx.app, keeper, 'GET', `/api/erp/expenses/export?from=${today}&to=${today}`)).status).toBe(403);
    const csv = await api(ctx.app, approver, 'GET', `/api/erp/expenses/export?from=${today}&to=${today}`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('费用科目');
    // 只有成本核算职责的员工也能取部门（登记报销、打款要选部门）
    const depts = await api(ctx.app, coster, 'GET', '/api/inventory/departments');
    expect(depts.status).toBe(200);
    expect(depts.body.map((d: { id: number }) => d.id)).toEqual(expect.arrayContaining([deptA, deptB]));
    // v0.7.11 起成本核算可看库存（#21：库存冲销由仓库或成本岗做），但不能录入收发
    expect((await api(ctx.app, coster, 'GET', '/api/inventory/materials')).status).toBe(200);
    expect((await api(ctx.app, coster, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docType: 'direct_use', docDate: today, note: '越权测试', lines: [{ materialId: 1, qtyMilli: 1000 }] })).status).toBe(403);
    // 规则只有店主能改
    const rules = (await api(ctx.app, coster, 'GET', '/api/erp/expenses/rules')).body;
    expect(rules.approvalThresholdCents).toBe(200_000);
    expect((await api(ctx.app, coster, 'PUT', '/api/erp/expenses/rules', rules)).status).toBe(403);
  });
});

describe('费用报销：固定选项与互校', () => {
  it('用途、发票类型与税点、发票号、费用科目、差异原因、付款来源', async () => {
    const bad = async (body: Record<string, unknown>) => (await claim(coster, body)).body.error?.code ?? 'OK';
    expect(await bad({ purpose: '随便写' })).toBe('PURPOSE_INVALID');
    expect(await bad({ invoiceType: 'vat_special', taxRateBp: 0, invoiceNo: '12345678' })).toBe('TAX_RATE_MISMATCH');
    // 标了有发票却没有发票号：直接拦下
    expect(await bad({ invoiceType: 'vat_normal', taxRateBp: 300 })).toBe('INVOICE_NO_REQUIRED');
    expect(await bad({ invoiceType: 'vat_normal', taxRateBp: 300, invoiceNo: '04401234' })).toBe('OK');
    expect((await claim(coster, { lines: [line({ category: '杂费' })] })).status).toBe(400);
    expect(await bad({ lines: [line({ receivedMilli: q(1) })] })).toBe('DIFF_REASON_REQUIRED');
    expect(await bad({ lines: [line({ receivedMilli: q(1), diffReason: '缺 1 包，次日补发' })] })).toBe('OK');
    expect((await claim(coster, { paySource: 'petty' })).status).toBe(400);
    expect((await claim(coster, { expenseDate: '2099-01-01' })).body.error.code).toBe('FUTURE_DATE');
  });

  it('店主改规则：门槛、用途、发票类型；改后的选项立即生效', async () => {
    const rules = (await api(ctx.app, boss, 'GET', '/api/erp/expenses/rules')).body;
    const saved = await api(ctx.app, boss, 'PUT', '/api/erp/expenses/rules', { ...rules, purposes: [...rules.purposes, '团建'] });
    expect(saved.status).toBe(200);
    expect(saved.body.purposes).toContain('团建');
    expect((await claim(coster, { purpose: '团建' })).status).toBe(201);
    const dup = await api(ctx.app, boss, 'PUT', '/api/erp/expenses/rules', { ...rules, purposes: ['办公', '办公'] });
    expect(dup.status).toBe(400);
    await api(ctx.app, boss, 'PUT', '/api/erp/expenses/rules', rules);
  });
});

describe('费用确认（D13：单笔超 2000 元要负责人确认）', () => {
  it('不超过门槛登记即确认；超过的进待办，负责人确认、退回、重新提交、撤回', async () => {
    const small = await claim(coster, { lines: [line({ amountCents: 200_000 })] });
    expect(small.body.claim).toMatchObject({ status: 'confirmed', needsApproval: false, amountCents: 200_000 });

    const before = (await api(ctx.app, approver, 'GET', '/api/inventory/todo-count')).body.count;
    const big = await claim(coster, { lines: [line({ name: '投影仪', category: 'fixed_asset', unit: '台', boughtMilli: q(1), receivedMilli: q(1), amountCents: 200_001 })] });
    expect(big.body.claim).toMatchObject({ status: 'submitted', needsApproval: true });
    const id = big.body.claim.id;
    expect((await api(ctx.app, approver, 'GET', '/api/inventory/todo-count')).body.count).toBe(before + 1);

    // 成本核算不能自己确认，也不能在登记时同时确认
    expect((await api(ctx.app, coster, 'POST', `/api/erp/expenses/${id}/approve`, {})).status).toBe(403);
    expect((await claim(coster, { approveNow: true })).status).toBe(403);

    const ret = await api(ctx.app, approver, 'POST', `/api/erp/expenses/${id}/return`, { reason: '请补发票照片' });
    expect(ret.body).toMatchObject({ status: 'returned', returnedReason: '请补发票照片' });
    expect((await api(ctx.app, coster, 'POST', `/api/erp/expenses/${id}/resubmit`, {})).body.status).toBe('submitted');
    const ok = await api(ctx.app, approver, 'POST', `/api/erp/expenses/${id}/approve`, {});
    expect(ok.body).toMatchObject({ status: 'confirmed', confirmedByName: '负责人' });
    expect(ok.body.approvals.map((a: { action: string }) => a.action)).toEqual(['create', 'submit', 'return', 'submit', 'approve']);
    // 已确认的不能撤回，只能冲销
    expect((await api(ctx.app, coster, 'POST', `/api/erp/expenses/${id}/cancel`, { reason: '不要了' })).status).toBe(409);
    // #21：账务冲销由财务（成本核算、对账付款），负责人不再冲销（v0.7.11）
    expect((await api(ctx.app, approver, 'POST', `/api/erp/expenses/${id}/void`, { reason: '重复登记' })).status).toBe(403);
    expect((await api(ctx.app, coster, 'POST', `/api/erp/expenses/${id}/void`, { reason: '重复登记' })).body.status).toBe('voided');

    // 负责人也是店主：登记时可以同时确认
    const now = await claim(boss, { approveNow: true, lines: [line({ amountCents: 300_000 })] });
    expect(now.body.claim.status).toBe('confirmed');
  });

  it('报销单内容不可改、不能删（数据库兜底）', async () => {
    const c = (await claim(coster)).body.claim;
    await expect(ctx.sql`UPDATE expense_claims SET amount_cents = 1 WHERE id = ${c.id}`).rejects.toThrow(/不可修改/);
    await expect(ctx.sql`DELETE FROM expense_claims WHERE id = ${c.id}`).rejects.toThrow(/禁止删除/);
    await expect(ctx.sql`UPDATE expense_claim_lines SET amount_cents = 1 WHERE claim_id = ${c.id}`).rejects.toThrow();
  });
});

describe('备用金：按部门平账（D14）', () => {
  it('打款 − 支出 = 应退回；应退回 − 实际退回 = 未退回；花超了待补付', async () => {
    const a = (await advance(coster)).body.advance;
    expect(a).toMatchObject({ advanceCents: 100_000, spentCents: 0, dueCents: 100_000, outstandingCents: 100_000, state: 'open' });

    const spend = (amountCents: number, extra: Record<string, unknown> = {}) =>
      claim(coster, { paySource: 'petty', advanceId: a.id, lines: [line({ amountCents })], ...extra });
    expect((await spend(60_000)).body.claim.status).toBe('confirmed');
    // 待确认的不算进支出
    const pending = await spend(250_000);
    expect(pending.body.claim.status).toBe('submitted');
    let now = await getAdvance(a.id);
    expect(now).toMatchObject({ spentCents: 60_000, pendingCents: 250_000, dueCents: 40_000, outstandingCents: 40_000 });
    await api(ctx.app, approver, 'POST', `/api/erp/expenses/${pending.body.claim.id}/cancel`, { reason: '登记错了' });

    // 退回不能超过未退回
    expect((await settle(coster, a.id, 'return', 50_000)).body.error.code).toBe('RETURN_EXCEEDS');
    expect((await settle(coster, a.id, 'topup', 1_000)).body.error.code).toBe('NOTHING_TO_TOPUP');
    expect((await settle(coster, a.id, 'return', 30_000)).status).toBe(201);
    now = await getAdvance(a.id);
    expect(now).toMatchObject({ settledCents: 30_000, outstandingCents: 10_000, state: 'open' });
    const done = await settle(coster, a.id, 'return', 10_000);
    expect(done.body.advance).toMatchObject({ outstandingCents: 0, state: 'settled' });
    expect(done.body.advance.settlements.map((s: { docNo: string }) => s.docNo.slice(0, 2))).toEqual(['TH', 'TH']);

    // 之后又报了一笔（经办人垫钱）：待补付，公司补给经办人后平
    await spend(5_000);
    now = await getAdvance(a.id);
    expect(now).toMatchObject({ outstandingCents: -5_000, state: 'owed' });
    expect((await settle(coster, a.id, 'return', 1_000)).body.error.code).toBe('NOTHING_TO_RETURN');
    expect((await settle(coster, a.id, 'topup', 6_000)).body.error.code).toBe('TOPUP_EXCEEDS');
    const topup = await settle(buyer, a.id, 'topup', 5_000);
    expect(topup.body.advance).toMatchObject({ settledCents: 35_000, outstandingCents: 0, state: 'settled' });

    // 每日平账：当天、采购部
    const daily = (await api(ctx.app, keeper, 'GET', `/api/erp/petty/daily?from=${today}&to=${today}&departmentId=${deptA}`)).body;
    const row = daily.rows.find((r: { date: string }) => r.date === today);
    const mine = row.advances.find((x: { id: number }) => x.id === a.id);
    expect(mine).toMatchObject({ advanceCents: 100_000, spentCents: 65_000, dueCents: 35_000, settledCents: 35_000, outstandingCents: 0, state: 'settled' });
    expect(row.advanceCents - row.spentCents).toBe(row.dueCents);
    expect(row.dueCents - row.settledCents).toBe(row.outstandingCents);
    const csv = await api(ctx.app, buyer, 'GET', `/api/erp/petty/daily/export?from=${today}&to=${today}`);
    expect(String(csv.body)).toContain(a.docNo);
  });

  it('超过 7 天没退清标「超期未退」；别的部门的打款不能用；日期不能早于打款', async () => {
    const old = (await advance(coster, { advanceDate: daysAgo(10), amountCents: 20_000 })).body.advance;
    expect(old).toMatchObject({ state: 'overdue', ageDays: 10, outstandingCents: 20_000 });
    const list = await api(ctx.app, coster, 'GET', '/api/erp/petty/advances?unsettled=1');
    expect(list.body.some((x: { id: number; state: string }) => x.id === old.id && x.state === 'overdue')).toBe(true);
    const wrongDept = await claim(coster, { departmentId: deptB, paySource: 'petty', advanceId: old.id });
    expect(wrongDept.body.error.code).toBe('ADVANCE_DEPARTMENT_MISMATCH');
    expect((await settle(coster, old.id, 'return', 1_000, { settleDate: daysAgo(11) })).body.error.code).toBe('SETTLE_BEFORE_ADVANCE');
    const daily = (await api(ctx.app, coster, 'GET', `/api/erp/petty/daily?from=${daysAgo(30)}&to=${today}`)).body;
    expect(daily.openByDepartment.find((o: { department: { id: number } }) => o.department.id === deptA).overdue).toBeGreaterThanOrEqual(1);
  });

  it('冲销打款：下面还有有效的报销或退回时拒绝；冲销后不能再用', async () => {
    const a = (await advance(coster, { amountCents: 10_000 })).body.advance;
    const c = (await claim(coster, { paySource: 'petty', advanceId: a.id, lines: [line({ amountCents: 4_000 })] })).body.claim;
    const s = (await settle(coster, a.id, 'return', 6_000)).body;
    // #21：备用金的冲销由财务（成本核算、对账付款），负责人不能冲销（v0.7.11）
    expect((await api(ctx.app, approver, 'POST', `/api/erp/petty/advances/${a.id}/void`, { reason: '打错了' })).status).toBe(403);
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/petty/advances/${a.id}/void`, { reason: '打错了' })).status).toBe(403);
    expect((await api(ctx.app, coster, 'POST', `/api/erp/petty/advances/${a.id}/void`, { reason: '打错了' })).body.error.code).toBe('ADVANCE_IN_USE');
    await api(ctx.app, coster, 'POST', `/api/erp/expenses/${c.id}/void`, { reason: '打款错了' });
    await api(ctx.app, buyer, 'POST', `/api/erp/petty/settlements/${s.settlementId}/void`, { reason: '打款错了' });
    const voided = await api(ctx.app, coster, 'POST', `/api/erp/petty/advances/${a.id}/void`, { reason: '打错了' });
    expect(voided.body).toMatchObject({ status: 'voided', voidReason: '打错了' });
    expect((await claim(coster, { paySource: 'petty', advanceId: a.id })).body.error.code).toBe('ADVANCE_VOIDED');
    expect((await settle(coster, a.id, 'return', 100)).body.error.code).toBe('ADVANCE_VOIDED');
    await expect(ctx.sql`UPDATE petty_advances SET amount_cents = 1 WHERE id = ${a.id}`).rejects.toThrow(/不可修改/);
  });
});

describe('现付供应商与按采购单报销', () => {
  let cashSup: { id: number; code: string; name: string };
  let mat: { id: number };
  beforeAll(async () => {
    const s = await supplier('S004');
    // 只改结算方式时要带上原来的档案；不带结算方式的修改保持原样
    expect((await api(ctx.app, buyer, 'PUT', `/api/inventory/suppliers/${s.id}`, { code: s.code, name: s.name, settlement: 'cash' })).status).toBe(200);
    await api(ctx.app, buyer, 'PUT', `/api/inventory/suppliers/${s.id}`, { code: s.code, name: s.name, note: '网店' });
    cashSup = await supplier('S004');
    expect(cashSup).toMatchObject({ settlement: 'cash', note: '网店' });
    mat = await material('M016'); // 一次性护理床单，1 箱 = 500 张
  });

  const newPo = async (supplierId: number) => {
    const po = (await api(ctx.app, buyer, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      supplierId,
      orderDate: today,
      lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45_000 }],
    })).body.po;
    await api(ctx.app, approver, 'POST', `/api/purchase-orders/${po.id}/approve`, {});
    return po;
  };
  const receive = (po: { id: number; lines: { id: number }[] }, supplierId: number, accepted: number) =>
    api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId,
      purchaseOrderId: po.id,
      coAcceptorId: buyerId,
      lines: [{ materialId: mat.id, poLineId: po.lines[0]!.id, deliveredMilli: q(accepted), acceptedMilli: q(accepted) }],
    });

  it('现付供应商的收货不记应付、不能在货款里付款核销；按采购单报销取采购与到货数量，同一行只能报一次', async () => {
    const before = (await api(ctx.app, boss, 'GET', '/api/payables/overview')).body.suppliers.find((s: { code: string }) => s.code === 'S004');
    const po = await newPo(cashSup.id);
    const rc = await receive(po, cashSup.id, 500);
    expect(rc.status).toBe(201);
    const after = (await api(ctx.app, boss, 'GET', '/api/payables/overview')).body.suppliers.find((s: { code: string }) => s.code === 'S004');
    expect(after.receivedCents).toBe(before.receivedCents);
    const open = (await api(ctx.app, boss, 'GET', `/api/payables/suppliers/${cashSup.id}/open-items`)).body;
    expect(open.some((i: { id: number }) => i.id === rc.body.doc.id)).toBe(false);

    const candidates = (await api(ctx.app, coster, 'GET', `/api/erp/expenses/po-candidates?q=${po.docNo}`)).body;
    expect(candidates).toEqual([expect.objectContaining({ id: po.id, openLines: 1 })]);
    const forClaim = (await api(ctx.app, coster, 'GET', `/api/erp/expenses/po/${po.id}`)).body;
    const pl = forClaim.lines[0];
    expect(pl).toMatchObject({ boughtMilli: q(1000), receivedMilli: q(500), unit: '张', amountCents: 90_000, claimedBy: null });

    const byPo = (over: Record<string, unknown> = {}) =>
      claim(coster, {
        purchaseOrderId: po.id,
        purpose: '客用消耗',
        lines: [{ name: pl.name, category: 'low_value', unit: pl.unit, boughtMilli: pl.boughtMilli, receivedMilli: pl.receivedMilli, amountCents: 88_000, poLineId: pl.poLineId, ...over }],
      });
    expect((await byPo()).body.error.code).toBe('DIFF_REASON_REQUIRED');
    expect((await byPo({ receivedMilli: q(1000), diffReason: '' })).body.error.code).toBe('PO_CHANGED');
    const ok = await byPo({ diffReason: '另一箱下周到' });
    expect(ok.status).toBe(201);
    expect(ok.body.claim).toMatchObject({ status: 'confirmed', purchaseOrder: { id: po.id, docNo: po.docNo } });
    expect((await byPo({ diffReason: '另一箱下周到' })).body.error.code).toBe('PO_LINE_CLAIMED');
    // 已按采购单报销的收货单不能冲销（到货数量取自收货），先冲销报销（测试服回归报告，v0.7.11）
    const blocked = await api(ctx.app, keeper, 'POST', `/api/inventory/docs/${rc.body.doc.id}/void`, { reason: '测试冲销' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('NOT_VOIDABLE');
    expect(blocked.body.error.message).toContain(ok.body.claim.docNo);
    expect((await api(ctx.app, coster, 'GET', `/api/erp/expenses/po/${po.id}`)).body.lines[0].claimedBy).toBe(ok.body.claim.docNo);

    // 冲销后可以重新报
    await api(ctx.app, coster, 'POST', `/api/erp/expenses/${ok.body.claim.id}/void`, { reason: '金额登记错了' });
    expect((await byPo({ diffReason: '另一箱下周到', amountCents: 90_000 })).status).toBe(201);

    // 现付收货的退货也不记应付扣款
    const ret = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'supplier_return',
      docDate: today,
      sourceDocId: rc.body.doc.id,
      note: '破损',
      lines: [{ sourceLineId: rc.body.doc.lines[0].id, qtyMilli: q(10) }],
    });
    expect(ret.status).toBe(201);
    const retOk = await api(ctx.app, approver, 'POST', `/api/inventory/docs/${ret.body.doc.id}/approve`, {});
    expect(retOk.body).toMatchObject({ status: 'confirmed' });
    const final = (await api(ctx.app, boss, 'GET', '/api/payables/overview')).body.suppliers.find((s: { code: string }) => s.code === 'S004');
    expect(final.returnCreditCents).toBe(before.returnCreditCents);
    expect(final.balanceCents).toBe(before.balanceCents);
  });

  it('供应商改了结算方式：挂账收下的采购单不能再报销；已按采购单报销的，之后收货也不记应付', async () => {
    const s2 = await supplier('S002');
    const setSettlement = (settlement: 'credit' | 'cash') =>
      api(ctx.app, buyer, 'PUT', `/api/inventory/suppliers/${s2.id}`, { code: s2.code, name: s2.name, settlement });
    expect(s2.settlement).toBe('credit');
    // ① 挂账时收的货（已记应付），之后供应商改成现付：这张采购单仍按挂账，不能报销
    const credited = await newPo(s2.id);
    const rc1 = await receive(credited, s2.id, 500);
    expect(rc1.status).toBe(201);
    await setSettlement('cash');
    expect((await api(ctx.app, coster, 'GET', `/api/erp/expenses/po/${credited.id}`)).body.error.code).toBe('CREDIT_SUPPLIER');
    expect((await api(ctx.app, coster, 'GET', `/api/erp/expenses/po-candidates?q=${credited.docNo}`)).body).toEqual([]);
    const pl1 = credited.lines[0];
    const r1 = await claim(coster, {
      purchaseOrderId: credited.id,
      lines: [{ name: '床单', category: 'low_value', unit: '张', boughtMilli: q(1000), receivedMilli: q(500), diffReason: '分批到', amountCents: 45_000, poLineId: pl1.id }],
    });
    expect(r1.body.error.code).toBe('CREDIT_SUPPLIER');
    // 同一张采购单后面的收货也跟着挂账（记应付）
    const rc1b = await receive(credited, s2.id, 100);
    expect((await ctx.sql`SELECT settlement FROM inv_docs WHERE id = ${rc1b.body.doc.id}`)[0]!.settlement).toBe('credit');

    // ② 现付时按采购单报销（货还没到），之后供应商改回挂账：后来的收货仍按现付，不记应付
    const cashPo = await newPo(s2.id);
    const fc = (await api(ctx.app, coster, 'GET', `/api/erp/expenses/po/${cashPo.id}`)).body;
    const paid = await claim(coster, {
      purchaseOrderId: cashPo.id,
      purpose: '客用消耗',
      lines: [{ name: fc.lines[0].name, category: 'low_value', unit: fc.lines[0].unit, boughtMilli: q(1000), receivedMilli: 0, diffReason: '先付款后到货', amountCents: 90_000, poLineId: fc.lines[0].poLineId }],
    });
    expect(paid.status).toBe(201);
    await setSettlement('credit');
    const rc2 = await receive(cashPo, s2.id, 1000);
    expect(rc2.status).toBe(201);
    expect((await ctx.sql`SELECT settlement FROM inv_docs WHERE id = ${rc2.body.doc.id}`)[0]!.settlement).toBe('cash');
    expect((await ctx.sql`SELECT count(*)::int AS n FROM ap_entries WHERE inv_doc_id = ${rc2.body.doc.id}`)[0]!.n).toBe(0);
    const open = (await api(ctx.app, boss, 'GET', `/api/payables/suppliers/${s2.id}/open-items`)).body;
    expect(open.some((i: { id: number }) => i.id === rc2.body.doc.id)).toBe(false);
    expect(open.some((i: { id: number }) => i.id === rc1.body.doc.id)).toBe(true);
    for (const c of (await api(ctx.app, boss, 'GET', '/api/erp/expenses/checks')).body) expect(c, c.label).toMatchObject({ ok: true });
  });

  it('挂账供应商的采购单不能按采购单报销', async () => {
    const credit = await supplier('S001');
    expect(credit.settlement).toBe('credit');
    const po = await newPo(credit.id);
    expect((await api(ctx.app, coster, 'GET', `/api/erp/expenses/po/${po.id}`)).body.error.code).toBe('CREDIT_SUPPLIER');
    const r = await claim(coster, { purchaseOrderId: po.id, lines: [line({ poLineId: po.lines[0].id })] });
    expect(r.body.error.code).toBe('CREDIT_SUPPLIER');
  });
});

describe('幂等与并发', () => {
  it('同一操作编号只登记一次；内容不同拒绝；同时退回只成功一笔', async () => {
    const key = randomUUID();
    const body = { clientKey: key, expenseDate: today, departmentId: deptA, handlerId: costerId, purpose: '办公', paySource: 'company', invoiceType: 'none', taxRateBp: 0, lines: [line()] };
    const [x, y] = await Promise.all([api(ctx.app, coster, 'POST', '/api/erp/expenses', body), api(ctx.app, coster, 'POST', '/api/erp/expenses', body)]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(x.body.claim.id).toBe(y.body.claim.id);
    const byKey = await api(ctx.app, keeper, 'GET', `/api/erp/expenses/by-key/${key}`);
    expect(byKey.body.id).toBe(x.body.claim.id);
    const diff = await api(ctx.app, coster, 'POST', '/api/erp/expenses', { ...body, lines: [line({ amountCents: 1 })] });
    expect(diff.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    const a = (await advance(coster, { amountCents: 5_000 })).body.advance;
    const results = await Promise.all([settle(coster, a.id, 'return', 5_000), settle(buyer, a.id, 'return', 5_000)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await getAdvance(a.id)).outstandingCents).toBe(0);

    // 同一个操作编号同时提交两次（重提、连点）：两次都返回同一笔，不报「超过未退回」（v0.7.9 修正）
    const b2 = (await advance(coster, { amountCents: 3_000 })).body.advance;
    const sameKey = randomUUID();
    const twice = await Promise.all([settle(coster, b2.id, 'return', 3_000, { clientKey: sameKey }), settle(coster, b2.id, 'return', 3_000, { clientKey: sameKey })]);
    expect(twice.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(twice[0]!.body.settlementId).toBe(twice[1]!.body.settlementId);
    expect((await getAdvance(b2.id)).outstandingCents).toBe(0);
  });
});

describe('结果待确认：按编号查回与确认作废（v0.7.8）', () => {
  it('作废后原请求再到也不登记；已登记的作废只返回原单据；按原业务的权限作废，只拦同类型', async () => {
    const lookup = (cookie: string, key: string, type: string) => api(ctx.app, cookie, 'GET', `/api/erp/ops/${key}?type=${type}`);
    const abandon = (cookie: string, key: string, type: string) => api(ctx.app, cookie, 'POST', `/api/erp/ops/${key}/abandon`, { type, summary: '测试' });

    const k1 = randomUUID();
    expect((await lookup(coster, k1, 'expense_claim')).body).toEqual({ found: false, abandoned: false });
    expect((await abandon(keeper, k1, 'expense_claim')).status).toBe(403);
    expect((await abandon(coster, k1, 'expense_claim')).body).toEqual({ found: false, abandoned: true });
    const late = await claim(coster, { clientKey: k1 });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OP_ABANDONED');
    expect((await lookup(keeper, k1, 'expense_claim')).body).toEqual({ found: false, abandoned: true });
    // 别的类型的作废登记拦不下这一笔
    const k2 = randomUUID();
    await abandon(coster, k2, 'petty_advance');
    expect((await claim(coster, { clientKey: k2 })).status).toBe(201);
    // 已登记的：作废只返回原单据
    const k3 = randomUUID();
    const done = (await claim(coster, { clientKey: k3 })).body.claim;
    expect((await abandon(coster, k3, 'expense_claim')).body).toEqual({ found: true, abandoned: false, refId: done.id });
    expect((await abandon(coster, k3, 'petty_advance')).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 打款、退回补付
    const k4 = randomUUID();
    expect((await abandon(buyer, k4, 'petty_advance')).body.abandoned).toBe(true);
    expect((await advance(buyer, { clientKey: k4 })).body.error.code).toBe('OP_ABANDONED');
    const a = (await advance(coster, { amountCents: 2_000 })).body.advance;
    const k5 = randomUUID();
    const s = await settle(coster, a.id, 'return', 1_000, { clientKey: k5 });
    expect((await lookup(keeper, k5, 'petty_settlement')).body).toEqual({ found: true, abandoned: false, refId: s.body.settlementId, advanceId: a.id });
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/erp/ops/${k5}?type=petty_settlement`)).status).toBe(403);
  });

  it('报销列表的合计按全部单据算，不受列表张数限制', async () => {
    const list = (await api(ctx.app, boss, 'GET', `/api/erp/expenses?from=${today}&to=${today}`)).body;
    expect(list.truncated).toBe(false);
    expect(list.totals.count).toBe(list.claims.length);
    const confirmed = list.claims.filter((c: { status: string }) => c.status === 'confirmed').reduce((t: number, c: { amountCents: number }) => t + c.amountCents, 0);
    expect(list.totals.confirmedCents).toBe(confirmed);
  });
});

describe('自检', () => {
  it('费用报销单与明细一致、备用金台账一致、现付供应商的收货不记应付，全部通过；库存自检照旧', async () => {
    const checks = (await api(ctx.app, boss, 'GET', '/api/erp/expenses/checks')).body;
    expect(checks.map((c: { key: string }) => c.key)).toEqual(['expense_claims', 'petty_ledger', 'cash_receipts']);
    for (const c of checks) expect(c, c.label).toMatchObject({ ok: true });
    for (const c of (await api(ctx.app, boss, 'GET', '/api/inventory/checks')).body) expect(c, c.label).toMatchObject({ ok: true });
  });

  it('现付的收货被记了应付时，自检能查出来', async () => {
    const [rc] = await ctx.sql<{ id: number; supplierId: number; amountCents: number }[]>`
      SELECT id, supplier_id, amount_cents FROM inv_docs WHERE doc_type = 'receipt' AND settlement = 'cash' AND status = 'confirmed' LIMIT 1`;
    await ctx.sql`INSERT INTO ap_entries (supplier_id, entry_type, amount_delta_cents, inv_doc_id, entry_date, operator_id)
                  VALUES (${rc!.supplierId}, 'receipt', ${rc!.amountCents}, ${rc!.id}, ${today}, ${costerId})`;
    const checks = (await api(ctx.app, boss, 'GET', '/api/erp/expenses/checks')).body;
    expect(checks.find((c: { key: string }) => c.key === 'cash_receipts')).toMatchObject({ ok: false });
  });
});
