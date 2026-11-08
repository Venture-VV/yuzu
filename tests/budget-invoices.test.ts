// 费用预算与进项发票台账（8.0.3，docs/BUDGET_INVOICES.md，默认 BI01–BI12 待确认）：
//   · 预算：部门 × 科目的额度从某月起每月沿用；占用口径；80% 黄灯；超预算不拦登记、走「超预算报销」（原审批链后加一级店主）；
//     退回后再提交重新核对；同一部门同一科目串行；只有店主能设额度、保存时核对页面看到的额度；
//   · 顺带修的潜伏问题：门槛以内、但命中审批规则的报销登记时不再报错；
//   · 台账：报销的专票普票自动进台账、同一张不能报销两次、撤回以后重新关联、台账直接登记、三单的发票不能再报销、
//     标认证（所属期、版本号、一批）、异常票、待办数字、作废的限制、照片、自检。

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shiftDate } from '../src/shared/labels';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { consistencyChecks } from '../src/server/ops/consistency';
import { loadLedger } from '../src/server/modules/invoices';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let month: string;
let boss: string; // 演示店主 linlan：设预算、店主那一级审批
let payer: string; // 对账付款 qianfen：登记三单的发票、管理进项发票
let buyer: string; // 采购经办 zhouyi：编采购单
let coster: string; // 成本核算：登记报销、管理进项发票
let approver: string; // 负责人：确认超门槛的报销
let costerId: number;
let deptA: number;
let deptB: number;
let deptC: number;
let deptD: number;
const q = (n: number) => Math.round(n * 1000);

const line = (over: Record<string, unknown> = {}) => ({ name: '打印纸', category: 'office', unit: '包', boughtMilli: q(1), receivedMilli: q(1), amountCents: 10_000, ...over });
const claim = (body: Record<string, unknown> = {}, cookie = coster) =>
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
const ok = async (p: Promise<{ status: number; body: any }>, status = 201) => {
  const r = await p;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const grid = async (m = month, cookie = boss) => (await api(ctx.app, cookie, 'GET', `/api/erp/expenses/budgets?month=${m}`)).body;
const cellOf = (g: any, departmentId: number, category = 'office') => g.rows.find((r: any) => r.departmentId === departmentId).cells.find((c: any) => c.category === category);
const setBudget = async (departmentId: number, amountCents: number | null, m = month, category = 'office') => {
  const seen = cellOf(await grid(m), departmentId, category).budgetCents;
  return api(ctx.app, boss, 'PUT', '/api/erp/expenses/budgets', { month: m, cells: [{ departmentId, category, amountCents, seenCents: seen }] });
};
const approveClaim = (id: number, cookie: string) => api(ctx.app, cookie, 'POST', `/api/erp/expenses/${id}/approve`, {});
const ledger = async (query = '') => (await api(ctx.app, payer, 'GET', `/api/erp/invoices${query}`)).body;
const special = (no: string, over: Record<string, unknown> = {}) => ({ invoiceType: 'vat_special', taxRateBp: 1300, invoiceNo: no, ...over });
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]).toString('base64');

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  month = today.slice(0, 7);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  payer = await login(ctx.app, 'qianfen', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  costerId = await createStaff(ctx.sql, { username: 'coster', displayName: '成本岗', role: 'backoffice', duties: ['cost'], password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'appr', displayName: '负责人', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
  coster = await login(ctx.app, 'coster');
  approver = await login(ctx.app, 'appr');
  const mk = async (name: string) => {
    await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name });
    const list = await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1');
    return list.body.find((d: { name: string }) => d.name === name).id as number;
  };
  deptA = await mk('预算甲部');
  deptB = await mk('预算乙部');
  deptC = await mk('预算丙部');
  deptD = await mk('预算丁部');
}, 120_000);
afterAll(async () => ctx.close());

describe('费用预算（BI01–BI06）', () => {
  it('只有店主能设额度；额度从这个月起每月沿用，改下个月不影响这个月；保存时核对页面看到的额度', async () => {
    expect((await api(ctx.app, coster, 'GET', `/api/erp/expenses/budgets?month=${month}`)).status).toBe(200);
    const denied = await api(ctx.app, coster, 'PUT', '/api/erp/expenses/budgets', { month, cells: [{ departmentId: deptA, category: 'office', amountCents: 100_000, seenCents: null }] });
    expect(denied.status).toBe(403);
    expect(cellOf(await grid(), deptA)).toMatchObject({ budgetCents: null, fromMonth: null, level: 'none' });
    const saved = await ok(setBudget(deptA, 100_000), 200);
    expect(saved.changed).toBe(1);
    expect(cellOf(saved.grid, deptA)).toMatchObject({ budgetCents: 100_000, fromMonth: month });
    const next = shiftDate(`${month}-01`, 40).slice(0, 7);
    expect(cellOf(await grid(next), deptA)).toMatchObject({ budgetCents: 100_000, fromMonth: month });
    await ok(setBudget(deptA, 200_000, next), 200);
    expect(cellOf(await grid(), deptA)).toMatchObject({ budgetCents: 100_000 });
    expect(cellOf(await grid(next), deptA)).toMatchObject({ budgetCents: 200_000, fromMonth: next });
    // 别人刚改过：页面看到的额度对不上，整批拒绝
    const stale = await api(ctx.app, boss, 'PUT', '/api/erp/expenses/budgets', { month, cells: [{ departmentId: deptA, category: 'office', amountCents: 150_000, seenCents: 90_000 }] });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('BUDGET_CHANGED');
    // 和现在一样的不动
    expect((await ok(setBudget(deptA, 100_000), 200)).changed).toBe(0);
  });

  it('占用 = 待确认、退回、已确认的报销明细；达到 80% 黄灯；撤回、冲销的不算；登记页带出额度与已占用', async () => {
    await ok(setBudget(deptB, 100_000), 200);
    const c1 = (await ok(claim({ departmentId: deptB, lines: [line({ amountCents: 70_000 })] }))).claim;
    expect(c1).toMatchObject({ status: 'confirmed', overBudget: false });
    expect(c1.budgetCheck).toEqual([{ category: 'office', month, budgetCents: 100_000, usedBeforeCents: 0, claimCents: 70_000 }]);
    expect(cellOf(await grid(), deptB)).toMatchObject({ usedCents: 70_000, confirmedCents: 70_000, pendingCents: 0, level: 'ok' });
    const c2 = (await ok(claim({ departmentId: deptB, lines: [line({ amountCents: 15_000 }), line({ name: '运费', category: 'freight', amountCents: 5_000 })] }))).claim;
    expect(c2.overBudget).toBe(false);
    // 运费没设额度，不算进核对
    expect(c2.budgetCheck).toEqual([{ category: 'office', month, budgetCents: 100_000, usedBeforeCents: 70_000, claimCents: 15_000 }]);
    expect(cellOf(await grid(), deptB)).toMatchObject({ usedCents: 85_000, level: 'warn' });
    const usage = (await api(ctx.app, coster, 'GET', `/api/erp/expenses/budgets/usage?departmentId=${deptB}&date=${today}`)).body;
    expect(usage.cells.find((c: any) => c.category === 'office')).toMatchObject({ budgetCents: 100_000, usedCents: 85_000, level: 'warn' });
    expect(usage.cells.find((c: any) => c.category === 'freight')).toMatchObject({ budgetCents: null, usedCents: 5_000, level: 'none' });
    // 冲销以后额度回来
    expect((await api(ctx.app, payer, 'POST', `/api/erp/expenses/${c2.id}/void`, { reason: '登错了' })).status).toBe(200);
    expect(cellOf(await grid(), deptB)).toMatchObject({ usedCents: 70_000, level: 'ok' });
  });

  it('门槛以内超预算：不拦登记，走「超预算报销」一级店主；负责人批不了，店主批了生效', async () => {
    await ok(setBudget(deptC, 50_000), 200);
    await ok(claim({ departmentId: deptC, lines: [line({ amountCents: 40_000 })] }));
    const over = (await ok(claim({ departmentId: deptC, lines: [line({ amountCents: 20_000 })] }))).claim;
    expect(over).toMatchObject({ status: 'submitted', overBudget: true, needsApproval: true });
    expect(over.budgetCheck).toEqual([{ category: 'office', month, budgetCents: 50_000, usedBeforeCents: 40_000, claimCents: 20_000 }]);
    expect(over.approval).toMatchObject({ docType: 'expense_over_budget', currentLevel: 1 });
    expect(over.approval.stepLabels).toEqual(['店主']);
    // 审批页的摘要写着超了多少
    const card = (await api(ctx.app, boss, 'GET', `/api/approvals/${over.approval.requestId}`)).body;
    expect(card.doc.facts.find((f: { label: string }) => f.label === '超预算').value).toContain('超出 ¥100.00');
    expect((await approveClaim(over.id, approver)).status).toBe(403);
    expect((await ok(approveClaim(over.id, boss), 200)).status).toBe('confirmed');
  });

  it('门槛以上超预算：负责人 → 店主两级；店主为「超预算报销」建的规则优先', async () => {
    await ok(setBudget(deptD, 300_000), 200);
    await ok(claim({ departmentId: deptD, lines: [line({ amountCents: 100_000 })] }));
    const big = (await ok(claim({ departmentId: deptD, lines: [line({ amountCents: 250_000 })] }))).claim;
    expect(big).toMatchObject({ status: 'submitted', overBudget: true });
    expect(big.approval.stepLabels).toEqual(['负责人', '店主']);
    expect((await ok(approveClaim(big.id, approver), 200)).status).toBe('submitted');
    expect((await ok(approveClaim(big.id, boss), 200)).status).toBe('confirmed');
    // 店主建了「超预算报销」的规则：按规则（一级财务）
    const rule = await api(ctx.app, boss, 'POST', '/api/approvals/rules', { clientKey: randomUUID(), docType: 'expense_over_budget', minCents: 0, steps: [{ group: 'finance' }], note: '超预算财务看' });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const ruled = (await ok(claim({ departmentId: deptD, lines: [line({ amountCents: 10_000 })] }))).claim;
    expect(ruled.approval.stepLabels).toEqual(['财务']);
    const r = rule.body.rules.find((x: { id: number }) => x.id === rule.body.id);
    await ok(api(ctx.app, boss, 'POST', `/api/approvals/rules/${r.id}/active`, { version: r.version, active: false }), 200);
  });

  it('退回后重新提交按现在的额度再核对：额度调高以后不再超预算（退回的再提交照旧要确认）', async () => {
    const [dept] = await ctx.sql<{ id: number }[]>`INSERT INTO departments (name) VALUES ('预算戊部') RETURNING id`;
    const d = Number(dept!.id);
    await ok(setBudget(d, 10_000), 200);
    const c = (await ok(claim({ departmentId: d, lines: [line({ amountCents: 30_000 })] }))).claim;
    expect(c.overBudget).toBe(true);
    await ok(api(ctx.app, boss, 'POST', `/api/erp/expenses/${c.id}/return`, { reason: '超预算，先调额度' }), 200);
    await ok(setBudget(d, 50_000), 200);
    const again = await ok(api(ctx.app, coster, 'POST', `/api/erp/expenses/${c.id}/resubmit`, {}), 200);
    expect(again).toMatchObject({ status: 'submitted', overBudget: false });
    expect(again.budgetCheck).toEqual([{ category: 'office', month, budgetCents: 50_000, usedBeforeCents: 0, claimCents: 30_000 }]);
    expect(again.approval).toMatchObject({ docType: 'expense_claim' });
    expect(again.approval.stepLabels).toEqual(['负责人']);
  });

  it('两张同时登记：同一部门同一科目串行，只有后登记的那张算超预算', async () => {
    const [dept] = await ctx.sql<{ id: number }[]>`INSERT INTO departments (name) VALUES ('预算己部') RETURNING id`;
    const d = Number(dept!.id);
    await ok(setBudget(d, 100_000), 200);
    const [a, b] = await Promise.all([claim({ departmentId: d, lines: [line({ amountCents: 60_000 })] }), claim({ departmentId: d, lines: [line({ amountCents: 60_000 })] })]);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect([a.body.claim.overBudget, b.body.claim.overBudget].sort()).toEqual([false, true]);
  });

  it('门槛以内、命中了审批规则的报销：登记进审批，不再报错（报销单的守护放开「要不要审批」）', async () => {
    const rule = await api(ctx.app, boss, 'POST', '/api/approvals/rules', { clientKey: randomUUID(), docType: 'expense_claim', minCents: 0, maxCents: 1_000, steps: [{ group: 'owner' }], note: '十块以内店主看' });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const small = (await ok(claim({ lines: [line({ amountCents: 500 })] }))).claim;
    expect(small).toMatchObject({ status: 'submitted', needsApproval: true, overBudget: false });
    expect(small.approval.stepLabels).toEqual(['店主']);
    expect((await ok(approveClaim(small.id, boss), 200)).status).toBe('confirmed');
    const r = rule.body.rules.find((x: { id: number }) => x.id === rule.body.id);
    await ok(api(ctx.app, boss, 'POST', `/api/approvals/rules/${r.id}/active`, { version: r.version, active: false }), 200);
  });
});

describe('进项发票台账（BI07–BI12）', () => {
  it('报销的专票自动进台账：待认证、来源报销，开票方与税额按填的或按税点算；普票不用认证；收据不进台账', async () => {
    const c = (await ok(claim({ ...special('ZP-0001'), invoiceIssuer: '城南文具店', lines: [line({ amountCents: 11_300 })] }))).claim;
    expect(c.invoice).toMatchObject({ invoiceNo: 'ZP-0001', issuerName: '城南文具店', certStatus: 'pending' });
    const inv = (await api(ctx.app, payer, 'GET', `/api/erp/invoices/${c.invoice.id}`)).body;
    expect(inv).toMatchObject({ source: 'expense', kindLabel: '增值税专用发票', totalCents: 11_300, taxCents: 1_300, taxRateBp: 1300, invoiceDate: today, anomalies: [] });
    expect(inv.claim).toMatchObject({ id: c.id, docNo: c.docNo });
    expect(inv.certDueDate).toBe(shiftDate(today, 360));
    const normal = (await ok(claim({ invoiceType: 'vat_normal', taxRateBp: 300, invoiceNo: 'PP-0001', invoiceIssuer: '城南文具店', invoiceTaxCents: 291, lines: [line({ amountCents: 10_000 })] }))).claim;
    const n = (await api(ctx.app, payer, 'GET', `/api/erp/invoices/${normal.invoice.id}`)).body;
    expect(n).toMatchObject({ certStatus: 'not_required', certDueDate: null, taxCents: 291 });
    const receipt = (await ok(claim())).claim;
    expect(receipt.invoice).toBeNull();
    // 收据不能选台账的发票
    expect((await claim({ invoiceId: c.invoice.id })).status).toBe(400);
  });

  it('同一张发票不能报销两次；报销撤回以后重新登记，关联回原来那张', async () => {
    const first = (await ok(claim({ ...special('ZP-0002'), invoiceIssuer: '城北五金', lines: [line({ amountCents: 22_600 })] }))).claim;
    const twice = await claim({ ...special('ZP-0002'), invoiceIssuer: '城北五金', lines: [line({ amountCents: 22_600 })] });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toMatchObject({ code: 'INVOICE_ALREADY_CLAIMED', details: { docNo: first.docNo } });
    // 选台账的那张也一样拦
    expect((await claim({ ...special('ZP-0002'), invoiceId: first.invoice.id })).body.error.code).toBe('INVOICE_ALREADY_CLAIMED');
    // 门槛以内的已确认，冲销以后空出来
    await ok(api(ctx.app, payer, 'POST', `/api/erp/expenses/${first.id}/void`, { reason: '金额登错' }), 200);
    const again = (await ok(claim({ ...special('ZP-0002'), invoiceIssuer: '城北五金', lines: [line({ amountCents: 22_600 })] }))).claim;
    expect(again.invoice.id).toBe(first.invoice.id);
    const [cnt] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM supplier_invoices WHERE invoice_no = 'ZP-0002'`;
    expect(cnt!.n).toBe(1);
  });

  it('台账里直接登记的发票：报销时按号码关联；同一开票方同一号码不能登记两次；登错类型、开票日拒绝', async () => {
    const body = { clientKey: randomUUID(), kind: 'vat_special', invoiceNo: 'ZP-0003', issuerName: '城西印刷', invoiceDate: today, totalCents: 33_900, taxCents: 3_900, taxRateBp: 1300 };
    const created = await ok(api(ctx.app, coster, 'POST', '/api/erp/invoices', body));
    expect(created.invoice).toMatchObject({ source: 'manual', certStatus: 'pending', issuerName: '城西印刷' });
    // 操作编号重提返回原来那张
    expect((await ok(api(ctx.app, coster, 'POST', '/api/erp/invoices', body), 200)).replayed).toBe(true);
    const dup = await api(ctx.app, coster, 'POST', '/api/erp/invoices', { ...body, clientKey: randomUUID() });
    expect(dup.body.error.code).toBe('INVOICE_DUPLICATE');
    expect((await api(ctx.app, coster, 'POST', '/api/erp/invoices', { ...body, clientKey: randomUUID(), invoiceNo: 'SJ-1', kind: 'receipt' })).body.error.code).toBe('INVOICE_TYPE_INVALID');
    expect((await api(ctx.app, coster, 'POST', '/api/erp/invoices', { ...body, clientKey: randomUUID(), invoiceNo: 'ZP-9', invoiceDate: shiftDate(today, 1) })).status).toBe(400);
    // 物资经办不能登记
    const keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
    expect((await api(ctx.app, keeper, 'POST', '/api/erp/invoices', { ...body, clientKey: randomUUID(), invoiceNo: 'ZP-8' })).status).toBe(403);
    const linked = (await ok(claim({ ...special(' zp-0003 '), invoiceIssuer: '城西印刷', lines: [line({ amountCents: 33_900 })] }))).claim;
    expect(linked.invoice.id).toBe(created.invoice.id);
    const lookup = (await api(ctx.app, coster, 'GET', '/api/erp/invoices/lookup?no=zp-0003')).body;
    expect(lookup).toEqual([expect.objectContaining({ id: created.invoice.id, usedBy: linked.docNo, inPayables: false })]);
  });

  it('三单匹配里分到采购单的发票不能再报销', async () => {
    const sups = (await api(ctx.app, boss, 'GET', '/api/inventory/suppliers?all=1')).body as { id: number; code: string; name: string }[];
    const sup = sups.find((s) => s.code === 'S004')!;
    const mats = (await api(ctx.app, boss, 'GET', '/api/inventory/materials?all=1')).body as { id: number; code: string }[];
    const po = await ok(api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId: sup.id, orderDate: today, lines: [{ materialId: mats.find((m) => m.code === 'M016')!.id, purchaseQtyMilli: q(1), priceCents: 45_000 }] }));
    const inv = await ok(
      api(ctx.app, payer, 'POST', '/api/erp/payments/invoices', {
        clientKey: randomUUID(),
        supplierId: sup.id,
        invoiceNo: 'ZP-0004',
        invoiceDate: today,
        totalCents: 45_000,
        taxCents: 5_177,
        taxRateBp: 1300,
        lines: [{ poId: po.po.id, amountCents: 45_000 }],
      }),
    );
    const row = (await api(ctx.app, payer, 'GET', `/api/erp/invoices/${inv.invoice.id}`)).body;
    expect(row).toMatchObject({ source: 'three_way', certStatus: 'pending', pos: [{ id: po.po.id, amountCents: 45_000 }] });
    const blocked = await claim({ ...special('ZP-0004'), invoiceIssuer: sup.name, lines: [line({ amountCents: 45_000 })] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('INVOICE_IN_PAYABLES');
  });

  it('标认证：所属期、版本号、一批；改回待认证；作废的不能改', async () => {
    const a = (await ok(claim({ ...special('ZP-0101'), invoiceIssuer: '城东批发', lines: [line({ amountCents: 1_130 })] }))).claim.invoice.id as number;
    const b = (await ok(claim({ ...special('ZP-0102'), invoiceIssuer: '城东批发', lines: [line({ amountCents: 1_130 })] }))).claim.invoice.id as number;
    const c = (await ok(claim({ ...special('ZP-0103'), invoiceIssuer: '城东批发', lines: [line({ amountCents: 1_130 })] }))).claim.invoice.id as number;
    const cur = (await api(ctx.app, payer, 'GET', `/api/erp/invoices/${a}`)).body;
    expect((await api(ctx.app, payer, 'POST', `/api/erp/invoices/${a}/cert`, { status: 'certified', version: cur.certVersion })).status).toBe(400);
    expect((await api(ctx.app, payer, 'POST', `/api/erp/invoices/${a}/cert`, { status: 'certified', period: '2099-01', version: cur.certVersion })).status).toBe(400);
    const done = await ok(api(ctx.app, payer, 'POST', `/api/erp/invoices/${a}/cert`, { status: 'certified', period: month, version: cur.certVersion }), 200);
    expect(done).toMatchObject({ certStatus: 'certified', certPeriod: month, certByName: '钱芬（对账付款）', certDueDate: null });
    const stale = await api(ctx.app, payer, 'POST', `/api/erp/invoices/${a}/cert`, { status: 'pending', version: cur.certVersion });
    expect(stale.body.error.code).toBe('CERT_CHANGED');
    const back = await ok(api(ctx.app, payer, 'POST', `/api/erp/invoices/${a}/cert`, { status: 'pending', note: '勾选错了', version: done.certVersion }), 200);
    expect(back).toMatchObject({ certStatus: 'pending', certPeriod: null, certNote: '勾选错了' });
    const batch = await ok(api(ctx.app, payer, 'POST', '/api/erp/invoices/cert-batch', { ids: [c, a, b, a], period: month }), 200);
    expect(batch).toEqual({ certified: 3, skipped: [] });
    expect((await ok(api(ctx.app, payer, 'POST', '/api/erp/invoices/cert-batch', { ids: [a], period: month }), 200)).skipped).toEqual(['ZP-0101']);
    expect((await ledger('?view=certified')).invoices.map((r: any) => r.id)).toEqual(expect.arrayContaining([a, b, c]));
    // 采购经办看不到台账
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/invoices/cert-batch`, { ids: [a], period: month })).status).toBe(403);
  });

  it('异常票：重号、税额不符、税率不符、超过认证期限、开票方未填；导航的待办数字', async () => {
    const mk = (over: Record<string, unknown>) =>
      ok(api(ctx.app, payer, 'POST', '/api/erp/invoices', { clientKey: randomUUID(), kind: 'vat_special', invoiceDate: today, totalCents: 11_300, taxCents: 1_300, taxRateBp: 1300, issuerName: '异常测试甲', ...over }));
    const dupA = (await mk({ invoiceNo: 'YC-001' })).invoice;
    const dupB = (await mk({ invoiceNo: 'YC-001', issuerName: '异常测试乙' })).invoice;
    const tax = (await mk({ invoiceNo: 'YC-002', taxCents: 900 })).invoice;
    const rate = (await mk({ invoiceNo: 'YC-003', taxRateBp: 0, taxCents: 0 })).invoice;
    const old = (await mk({ invoiceNo: 'YC-004', invoiceDate: shiftDate(today, -400) })).invoice;
    const noIssuer = (await ok(claim({ ...special('YC-005'), lines: [line({ amountCents: 11_300 })] }))).claim.invoice;
    const get = async (id: number) => (await api(ctx.app, payer, 'GET', `/api/erp/invoices/${id}`)).body.anomalies;
    expect(await get(dupA.id)).toEqual(['duplicate_no']);
    expect(await get(dupB.id)).toEqual(['duplicate_no']);
    expect(await get(tax.id)).toEqual(['tax_mismatch']);
    expect(await get(rate.id)).toEqual(['rate_not_allowed']);
    expect(await get(old.id)).toEqual(['cert_overdue']);
    expect(await get(noIssuer.id)).toEqual(['issuer_missing']);
    const anomalies = (await ledger('?view=anomaly')).invoices.map((r: any) => r.id);
    expect(anomalies).toEqual(expect.arrayContaining([dupA.id, dupB.id, tax.id, rate.id, old.id, noIssuer.id]));
    // 待办：过了期限的一张；规则改成 7 天提醒 + 认证期限 5 天：今天开的也进待办
    expect((await api(ctx.app, payer, 'GET', '/api/erp/invoices/todo')).body).toMatchObject({ overdue: 1 });
    const rules = (await api(ctx.app, boss, 'GET', '/api/erp/expenses/rules')).body;
    await ok(api(ctx.app, boss, 'PUT', '/api/erp/expenses/rules', { ...rules, invoiceCertifyDays: 5 }), 200);
    const due = (await api(ctx.app, payer, 'GET', '/api/erp/invoices/todo')).body;
    expect(due.due).toBeGreaterThan(5);
    expect((await ledger('?view=due')).invoices.length).toBe(due.due);
    // 旧页面保存（不传新加的几项）不会冲掉
    const { budgetWarnPercent: _w, invoiceCertifyDays: _d, invoiceRemindDays: _r, invoiceTaxToleranceCents: _t, ...legacy } = rules;
    await ok(api(ctx.app, boss, 'PUT', '/api/erp/expenses/rules', legacy), 200);
    expect((await api(ctx.app, boss, 'GET', '/api/erp/expenses/rules')).body.invoiceCertifyDays).toBe(5);
    await ok(api(ctx.app, boss, 'PUT', '/api/erp/expenses/rules', { ...rules, invoiceCertifyDays: 360 }), 200);
  });

  it('作废：挂在有效报销单上的不能作废，撤回报销以后可以；三单的要货款权限', async () => {
    const c = (await ok(claim({ ...special('ZF-001'), invoiceIssuer: '作废测试', lines: [line({ amountCents: 300_000 })] }))).claim;
    expect(c.status).toBe('submitted');
    const blocked = await api(ctx.app, coster, 'POST', `/api/erp/invoices/${c.invoice.id}/void`, { reason: '登错了' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('INVOICE_IN_CLAIM');
    await ok(api(ctx.app, coster, 'POST', `/api/erp/expenses/${c.id}/cancel`, { reason: '重新登记' }), 200);
    expect((await ok(api(ctx.app, coster, 'POST', `/api/erp/invoices/${c.invoice.id}/void`, { reason: '登错了' }), 200)).status).toBe('voided');
    // 作废的不能再标认证、再挂照片；报销按号码找时不再找到它
    expect((await api(ctx.app, coster, 'POST', `/api/erp/invoices/${c.invoice.id}/cert`, { status: 'not_required', version: 1 })).body.error.code).toBe('INVOICE_VOIDED');
    const fresh = (await ok(claim({ ...special('ZF-001'), invoiceIssuer: '作废测试', lines: [line({ amountCents: 1_000 })] }))).claim;
    expect(fresh.invoice.id).not.toBe(c.invoice.id);
    // 三单的发票：成本核算（没有货款权限）作废不了
    const threeWay = (await ledger('?source=three_way')).invoices[0];
    expect((await api(ctx.app, coster, 'POST', `/api/erp/invoices/${threeWay.id}/void`, { reason: '测试' })).status).toBe(403);
  });

  it('照片：图片与 PDF、同一份只挂一次、最多 9 份、作废的不能再挂；PDF 能下载', async () => {
    const inv = (await ok(claim({ ...special('ZP-PHOTO'), invoiceIssuer: '照片测试', lines: [line({ amountCents: 1_130 })] }))).claim.invoice.id;
    const img = png();
    const first = await ok(api(ctx.app, coster, 'POST', `/api/erp/invoices/${inv}/attachments`, { name: '发票正面', mime: 'image/png', data: img }));
    expect(first).toHaveLength(1);
    expect((await ok(api(ctx.app, coster, 'POST', `/api/erp/invoices/${inv}/attachments`, { mime: 'image/png', data: img }))).length).toBe(1);
    const pdf = Buffer.from('%PDF-1.4\n% yuzu invoice test\n').toString('base64');
    const withPdf = await ok(api(ctx.app, coster, 'POST', `/api/erp/invoices/${inv}/attachments`, { name: '电子发票.pdf', mime: 'application/pdf', data: pdf }));
    const pdfRow = withPdf.find((a: { kind: string }) => a.kind === 'pdf');
    const dl = await ctx.app.inject({ method: 'GET', url: pdfRow.url, headers: { cookie: payer } });
    expect(dl.statusCode).toBe(200);
    expect(dl.body.startsWith('%PDF-')).toBe(true);
    for (let i = 0; i < 7; i++) await ok(api(ctx.app, coster, 'POST', `/api/erp/invoices/${inv}/attachments`, { mime: 'image/png', data: png() }));
    const full = await api(ctx.app, coster, 'POST', `/api/erp/invoices/${inv}/attachments`, { mime: 'image/png', data: png() });
    expect(full.body.error.code).toBe('ATTACHMENT_LIMIT');
    expect((await api(ctx.app, payer, 'GET', `/api/erp/invoices/${inv}`)).body).toMatchObject({ attachmentCount: 9 });
  });

  it('自检全 ✓；台账导出 CSV', async () => {
    const bad = (await consistencyChecks(ctx.sql, ctx.config.timezone)).filter((c) => !c.ok);
    expect(bad, JSON.stringify(bad)).toEqual([]);
    expect((await consistencyChecks(ctx.sql, ctx.config.timezone)).some((c) => c.label.startsWith('进项发票台账'))).toBe(true);
    const csv = await ctx.app.inject({ method: 'GET', url: '/api/erp/invoices/export?view=all', headers: { cookie: payer } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('发票号码');
    expect(csv.body).toContain('ZP-0001');
  });

  // 8.0.3 测试会话 P2（PR #77 · 1a1069a）：列表先取最新 1000 张、再在内存里筛「认证将到期」「异常票」，旧的逾期票查不到。
  // 放在最后：插的 1000 张新票不影响前面的用例。
  it('1000 张新票 + 1 张旧逾期票：将到期、异常视图都在 SQL 里先筛再取，旧票照样列出；上方数字不受张数限制；SQL 与逐张标记同一口径', async () => {
    const before = (await ledger('?view=due')).invoices.length;
    const old = (
      await ok(
        api(ctx.app, payer, 'POST', '/api/erp/invoices', {
          clientKey: randomUUID(),
          kind: 'vat_special',
          invoiceNo: 'OLD-OVERDUE',
          issuerName: '旧票供应商',
          invoiceDate: shiftDate(today, -403),
          totalCents: 11_300,
          taxCents: 1_300,
          taxRateBp: 1300,
        }),
      )
    ).invoice;
    // 与报销金额不符：台账里的票 113 元，报销 50 元按号码关联上
    await ok(
      api(ctx.app, payer, 'POST', '/api/erp/invoices', {
        clientKey: randomUUID(),
        kind: 'vat_special',
        invoiceNo: 'MISMATCH-1',
        issuerName: '金额不符店',
        invoiceDate: today,
        totalCents: 11_300,
        taxCents: 1_300,
        taxRateBp: 1300,
      }),
    );
    const mismatch = (await ok(claim({ ...special('MISMATCH-1'), invoiceIssuer: '金额不符店', lines: [line({ amountCents: 5_000 })] }))).claim.invoice;
    await ctx.sql`
      INSERT INTO supplier_invoices (invoice_no, issuer_name, invoice_date, total_cents, tax_cents, tax_rate_bp, client_key, request_hash, created_by,
                                     source, kind, kind_label, cert_status)
      SELECT 'BULK-' || g, '批量新票', ${today}::date, 11300, 1300, 1300, gen_random_uuid(), 'bulk', ${costerId}, 'manual', 'vat_special', '增值税专用发票', 'pending'
      FROM generate_series(1, 1000) g`;

    const todo = (await api(ctx.app, payer, 'GET', '/api/erp/invoices/todo')).body;
    const due = await ledger('?view=due');
    expect(due.invoices.map((r: any) => r.id)).toContain(old.id);
    expect(due.invoices.length).toBe(before + 1);
    expect(due.invoices.length).toBe(todo.due);
    expect(due.counts.due).toBe(todo.due);
    expect(due.truncated).toBe(false);
    // 全部有效：最新 1000 张，标明截断；待认证的数字按全部算
    const all = await ledger('?view=all');
    expect(all.invoices).toHaveLength(1000);
    expect(all.truncated).toBe(true);
    expect(all.invoices.map((r: any) => r.id)).not.toContain(old.id);
    expect(all.counts.pending).toBeGreaterThan(1000);
    // 异常票：旧逾期票、与报销金额不符的都在
    const anomaly = await ledger('?view=anomaly');
    expect(anomaly.invoices.map((r: any) => r.id)).toEqual(expect.arrayContaining([old.id, mismatch.id]));
    expect(anomaly.invoices.find((r: any) => r.id === old.id).anomalies).toEqual(['cert_overdue']);
    expect(anomaly.invoices.find((r: any) => r.id === mismatch.id).anomalies).toEqual(['amount_mismatch']);
    expect(anomaly.counts.anomaly).toBe(anomaly.invoices.length);
    // SQL 的筛法与逐张算的异常标记一致（这个文件里造过重号、税额不符、税率不符、过期、开票方未填、金额不符）
    const everything = await loadLedger(ctx.sql, { view: 'all' }, today, 100_000);
    const flagged = everything.invoices.filter((r) => r.anomalies.length > 0).map((r) => r.id).sort((x, y) => x - y);
    const viaSql = (await loadLedger(ctx.sql, { view: 'anomaly' }, today, 100_000)).invoices.map((r) => r.id).sort((x, y) => x - y);
    expect(viaSql).toEqual(flagged);
    expect(new Set(everything.invoices.flatMap((r) => r.anomalies))).toEqual(
      new Set(['duplicate_no', 'tax_mismatch', 'rate_not_allowed', 'cert_overdue', 'amount_mismatch', 'issuer_missing']),
    );
    const dueAll = (await loadLedger(ctx.sql, { view: 'due' }, today, 100_000)).invoices.map((r) => r.id).sort((x, y) => x - y);
    const dueJs = everything.invoices
      .filter((r) => r.certDueDate !== null && r.certDueDate <= shiftDate(today, 7))
      .map((r) => r.id)
      .sort((x, y) => x - y);
    expect(dueAll).toEqual(dueJs);
    // 导出不受列表 1000 张的限制
    const csv = await ctx.app.inject({ method: 'GET', url: '/api/erp/invoices/export?view=all', headers: { cookie: payer } });
    expect(csv.body).toContain('OLD-OVERDUE');
  }, 60_000);
});
