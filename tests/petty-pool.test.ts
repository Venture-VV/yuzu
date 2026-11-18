// 8.1.9 零采备用金（docs/ERP_V819.md 第 2 节，BJ1–BJ8；迁移 182）：
// 权限（供应链专用）、总额没配置、申用占用与超额、提交报销（未补单 / 已补单 + 采购单）、财务按申用登记报销 → 确认后回补 → 冲销后又占用、
// 撤回与作废的拦截、同一笔申用不能挂两张有效报销单、结果待确认、导出、自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let boss: string;
let buyer: string; // 采购经办 zhouyi：零采备用金的主人
let keeper: string; // 物资经办 lixiao：看不到
let coster: string; // 成本核算：登记报销
let approver: string; // 负责人：确认超门槛的报销
let buyerId: number;
let deptId: number;
let poId: number;
let poNo: string;
const use: Record<string, { id: number; version: number; docNo: string }> = {};

const board = async (cookie = buyer, query = '') => (await api(ctx.app, cookie, 'GET', `/api/erp/pool${query}`)).body;
const newUse = (body: Record<string, unknown> = {}, cookie = buyer, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/erp/pool/uses', { clientKey, useDate: today, applicantId: buyerId, purpose: '前台补货', content: '网购：一次性拖鞋 2 箱', amountCents: 30_000, ...body });
const claim = (body: Record<string, unknown> = {}, cookie = coster) =>
  api(ctx.app, cookie, 'POST', '/api/erp/expenses', {
    clientKey: randomUUID(),
    expenseDate: today,
    departmentId: deptId,
    handlerId: buyerId,
    purpose: '客用消耗',
    paySource: 'pool',
    invoiceType: 'receipt',
    taxRateBp: 0,
    lines: [{ name: '一次性拖鞋', category: 'low_value', unit: '箱', boughtMilli: 2000, receivedMilli: 2000, amountCents: 28_000 }],
    ...body,
  });
const refresh = async (name: string) => {
  const u = (await api(ctx.app, buyer, 'GET', `/api/erp/pool/uses/${use[name]!.id}`)).body;
  use[name] = { id: u.id, version: u.version, docNo: u.docNo };
  return u;
};

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyerId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'zhouyi'`)[0]!.id);
  await createStaff(ctx.sql, { username: 'pool-cost', displayName: '成本岗', role: 'backoffice', duties: ['cost'], password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'pool-appr', displayName: '负责人', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
  coster = await login(ctx.app, 'pool-cost');
  approver = await login(ctx.app, 'pool-appr');
  await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name: '供应链部' });
  deptId = (await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body.find((d: { name: string }) => d.name === '供应链部').id;
  const [po] = await ctx.sql<{ id: number; docNo: string }[]>`SELECT id, doc_no FROM purchase_orders WHERE status IN ('approved', 'closed') ORDER BY id LIMIT 1`;
  poId = Number(po!.id);
  poNo = po!.docNo;
}, 120_000);
afterAll(async () => ctx.close());

describe('零采备用金', () => {
  it('只给供应链（采购）与店主：仓库、财务看不到面板；设总额只有店主', async () => {
    expect((await api(ctx.app, keeper, 'GET', '/api/erp/pool')).status).toBe(403);
    expect((await api(ctx.app, coster, 'GET', '/api/erp/pool')).status).toBe(403);
    expect((await api(ctx.app, buyer, 'GET', '/api/erp/pool')).status).toBe(200);
    expect((await api(ctx.app, buyer, 'PUT', '/api/erp/pool/settings', { totalCents: 500_000, departmentId: deptId })).status).toBe(403);
  });

  it('没配置总额：面板写空、不能申用', async () => {
    const b = await board();
    expect(b.settings.totalCents).toBeNull();
    expect(b.summary).toMatchObject({ totalCents: null, remainingCents: null, occupiedCents: 0, pendingCount: 0 });
    expect((await newUse()).body.error.code).toBe('POOL_NOT_CONFIGURED');
    const saved = await api(ctx.app, boss, 'PUT', '/api/erp/pool/settings', { totalCents: 500_000, departmentId: deptId });
    expect(saved.body).toEqual({ totalCents: 500_000, departmentId: deptId });
    expect((await board()).departmentName).toBe('供应链部');
  });

  it('申用即占用；超过剩余可用拦下；同一编号原样重提只记一次', async () => {
    const key = randomUUID();
    const a = await newUse({}, buyer, key);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.use).toMatchObject({ state: 'open', amountCents: 30_000, applicant: { id: buyerId }, backfill: null, claim: null });
    expect(a.body.use.docNo).toMatch(/^LC\d{8}-\d{4}$/);
    use.u1 = a.body.use;
    expect((await newUse({}, buyer, key)).body).toMatchObject({ replayed: true, use: { id: a.body.use.id } });
    expect((await newUse({ amountCents: 31_000 }, buyer, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const b = await newUse({ amountCents: 250_000, content: '网购：前台电脑一台' });
    use.u2 = b.body.use;
    const over = await newUse({ amountCents: 300_000 });
    expect(over.body.error).toMatchObject({ code: 'POOL_EXCEEDED', details: { remainingCents: 220_000 } });
    expect((await newUse({ useDate: '2999-01-01' })).body.error.code).toBe('FUTURE_DATE');
    use.u3 = (await newUse({ amountCents: 10_000, content: '网购：抹布' })).body.use;
    expect((await board()).summary).toMatchObject({ totalCents: 500_000, occupiedCents: 290_000, remainingCents: 210_000, pendingCount: 3 });
  });

  it('提交报销：已补单要选已确认的采购单，未补单不选；版本号对不上拒绝；原样重提直接返回', async () => {
    const submit = (name: string, body: Record<string, unknown>) => api(ctx.app, buyer, 'POST', `/api/erp/pool/uses/${use[name]!.id}/submit`, { version: use[name]!.version, ...body });
    expect((await submit('u2', { backfill: 'done' })).body.error.code).toBe('PO_REQUIRED');
    expect((await submit('u1', { backfill: 'pending', purchaseOrderId: poId })).status).toBe(400);
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/pool/uses/${use.u1!.id}/submit`, { version: 99, backfill: 'pending' })).body.error.code).toBe('VERSION_CONFLICT');
    const ok1 = await submit('u1', { backfill: 'pending', note: '发票随后补' });
    expect(ok1.body).toMatchObject({ state: 'submitted', backfill: 'pending', purchaseOrder: null, submitNote: '发票随后补' });
    expect((await submit('u1', { backfill: 'pending', note: '发票随后补' })).status).toBe(200);
    expect((await submit('u1', { backfill: 'done', purchaseOrderId: poId })).body.error.code).toBe('ALREADY_SUBMITTED');
    const ok2 = await submit('u2', { backfill: 'done', purchaseOrderId: poId });
    expect(ok2.body).toMatchObject({ state: 'submitted', backfill: 'done', purchaseOrder: { id: poId, docNo: poNo } });
    await refresh('u1');
    await refresh('u2');
    // 选采购单的下拉：只有已确认、已关闭的
    const options = (await api(ctx.app, buyer, 'GET', `/api/erp/pool/po-options?q=${encodeURIComponent(poNo)}`)).body;
    expect(options.map((o: { id: number }) => o.id)).toContain(poId);
    expect(options.every((o: { status: string }) => ['approved', 'closed'].includes(o.status))).toBe(true);
    expect((await board()).summary.byState).toMatchObject({ open: { count: 1, cents: 10_000 }, submitted: { count: 2, cents: 280_000 } });
  });

  it('财务登记报销：只看得到已提交的申用；钱从零采备用金来要勾申用；确认后自动回补、冲销后又占用', async () => {
    expect((await api(ctx.app, buyer, 'GET', '/api/erp/expenses/pool-uses')).status).toBe(403);
    const forClaim = (await api(ctx.app, coster, 'GET', '/api/erp/expenses/pool-uses')).body;
    expect(forClaim.departmentId).toBe(deptId);
    const list = forClaim.uses;
    expect(list.map((u: { id: number }) => u.id).sort()).toEqual([use.u1!.id, use.u2!.id].sort());
    expect(list.find((u: { id: number }) => u.id === use.u2!.id)).toMatchObject({ backfill: 'done', purchaseOrderId: poId, poNo });
    // 互校
    expect((await claim({ poolUseIds: [] })).status).toBe(400);
    expect((await claim({ paySource: 'company', poolUseIds: [use.u1!.id] })).status).toBe(400);
    expect((await claim({ poolUseIds: [use.u3!.id] })).body.error.code).toBe('POOL_USE_NOT_SUBMITTED');
    // 采购经办登记不了报销（原有的权限）
    expect((await claim({ poolUseIds: [use.u1!.id] }, buyer)).status).toBe(403);
    // 门槛以内：登记即确认 → u1 回补
    const a = await claim({ poolUseIds: [use.u1!.id] });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.claim).toMatchObject({ status: 'confirmed', paySource: 'pool', advance: null, poolUses: [{ id: use.u1!.id, docNo: use.u1!.docNo, amountCents: 30_000 }] });
    expect((await refresh('u1')).state).toBe('reimbursed');
    expect((await board()).summary).toMatchObject({ occupiedCents: 260_000, remainingCents: 240_000, pendingCount: 2, reimbursedThisMonth: { count: 1, cents: 30_000 } });
    // 超门槛（¥2,000）：待确认 → 审核中，仍占用
    const b = await claim({ poolUseIds: [use.u2!.id], lines: [{ name: '前台电脑', category: 'fixed_asset', unit: '台', boughtMilli: 1000, receivedMilli: 1000, amountCents: 249_900 }] });
    expect(b.body.claim.status).toBe('submitted');
    expect((await refresh('u2')).state).toBe('reviewing');
    expect((await claim({ poolUseIds: [use.u2!.id] })).body.error.code).toBe('POOL_USE_CLAIMED');
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/pool/uses/${use.u2!.id}/unsubmit`, { version: use.u2!.version })).body.error.code).toBe('CLAIM_ACTIVE');
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/pool/uses/${use.u2!.id}/void`, { version: use.u2!.version, reason: '买错了' })).body.error.code).toBe('CLAIM_ACTIVE');
    expect((await board()).summary.byState.reviewing).toEqual({ count: 1, cents: 250_000 });
    // 负责人确认 → 回补
    expect((await api(ctx.app, approver, 'POST', `/api/erp/expenses/${b.body.claim.id}/approve`, {})).body.status).toBe('confirmed');
    expect((await refresh('u2')).state).toBe('reimbursed');
    expect((await board()).summary).toMatchObject({ occupiedCents: 10_000, remainingCents: 490_000, pendingCount: 1 });
    // 财务冲销 u1 的报销单 → u1 回到「已提交报销」，又占用；可以重新登记
    expect((await api(ctx.app, coster, 'POST', `/api/erp/expenses/${a.body.claim.id}/void`, { reason: '发票有误重开' })).body.status).toBe('voided');
    const u1 = await refresh('u1');
    expect(u1).toMatchObject({ state: 'submitted', claim: null });
    expect(u1.claims.map((c: { status: string }) => c.status)).toEqual(['voided']);
    expect((await board()).summary.occupiedCents).toBe(40_000);
    expect((await api(ctx.app, coster, 'GET', '/api/erp/expenses/pool-uses')).body.uses.map((u: { id: number }) => u.id)).toEqual([use.u1!.id]);
    // 面板按状态筛
    expect((await board(buyer, '?state=reimbursed')).uses.map((u: { id: number }) => u.id)).toEqual([use.u2!.id]);
  });

  it('更新补单（已报销的也能改）；撤回报销；作废以后不再占用', async () => {
    const u2 = await api(ctx.app, buyer, 'POST', `/api/erp/pool/uses/${use.u2!.id}/backfill`, { version: use.u2!.version, backfill: 'pending' });
    expect(u2.body).toMatchObject({ state: 'reimbursed', backfill: 'pending', purchaseOrder: null });
    await refresh('u2');
    const u1 = await api(ctx.app, buyer, 'POST', `/api/erp/pool/uses/${use.u1!.id}/backfill`, { version: use.u1!.version, backfill: 'done', purchaseOrderId: poId });
    expect(u1.body).toMatchObject({ state: 'submitted', backfill: 'done', purchaseOrder: { id: poId } });
    await refresh('u1');
    const back = await api(ctx.app, buyer, 'POST', `/api/erp/pool/uses/${use.u1!.id}/unsubmit`, { version: use.u1!.version });
    expect(back.body).toMatchObject({ state: 'open', backfill: 'done' });
    await refresh('u1');
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/pool/uses/${use.u3!.id}/void`, { version: use.u3!.version, reason: 'x' })).status).toBe(400);
    const v = await api(ctx.app, buyer, 'POST', `/api/erp/pool/uses/${use.u3!.id}/void`, { version: use.u3!.version, reason: '不买了' });
    expect(v.body).toMatchObject({ state: 'voided', voidReason: '不买了' });
    expect((await board()).summary).toMatchObject({ occupiedCents: 30_000, pendingCount: 1 });
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/pool/uses/${use.u3!.id}/submit`, { version: v.body.version, backfill: 'pending' })).body.error.code).toBe('USE_VOIDED');
    // 登记后内容不能改（触发器兜底）
    await expect(ctx.sql`UPDATE petty_pool_uses SET amount_cents = 1 WHERE id = ${use.u1!.id}`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM petty_pool_uses WHERE id = ${use.u1!.id}`).rejects.toThrow();
  });

  it('结果待确认：查回、作废以后原请求不再登记', async () => {
    const key = randomUUID();
    expect((await newUse({}, buyer, key)).status).toBe(201);
    expect((await api(ctx.app, buyer, 'GET', `/api/erp/ops/${key}?type=pool_use`)).body).toMatchObject({ found: true });
    const lost = randomUUID();
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'pool_use' })).status).toBe(403);
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'pool_use' })).body).toMatchObject({ found: false, abandoned: true });
    expect((await newUse({}, buyer, lost)).body.error.code).toBe('OP_ABANDONED');
    expect((await api(ctx.app, buyer, 'GET', `/api/erp/pool/uses/by-key/${key}`)).body.state).toBe('open');
  });

  it('导出台账；自检「零采备用金一致」', async () => {
    const csv = await api(ctx.app, buyer, 'GET', '/api/erp/pool/export');
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('申用金额（元）');
    expect(String(csv.body)).toContain(use.u2!.docNo);
    const checks = (await api(ctx.app, boss, 'GET', '/api/erp/expenses/checks')).body;
    expect(checks.find((c: { key: string }) => c.key === 'petty_pool')).toMatchObject({ ok: true });
    // 人为挂错：不是零采备用金的报销单挂申用 → 自检报出来
    const other = await api(ctx.app, coster, 'POST', '/api/erp/expenses', {
      clientKey: randomUUID(),
      expenseDate: today,
      departmentId: deptId,
      handlerId: buyerId,
      purpose: '办公',
      paySource: 'company',
      invoiceType: 'receipt',
      taxRateBp: 0,
      lines: [{ name: '打印纸', category: 'office', unit: '包', boughtMilli: 1000, receivedMilli: 1000, amountCents: 3_000 }],
    });
    await ctx.sql`INSERT INTO expense_claim_pool_uses (claim_id, use_id) VALUES (${other.body.claim.id}, ${use.u3!.id})`;
    const bad = (await api(ctx.app, boss, 'GET', '/api/erp/expenses/checks')).body.find((c: { key: string }) => c.key === 'petty_pool');
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('不是零采备用金的报销单挂了申用');
  });
});
