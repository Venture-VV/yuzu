// 8.0.21 开票申请（docs/FINANCE_V8021.md 第 3 节，CW-B / CW2 / CW13–CW15；迁移 143）
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/server/lib/context';
import { FENCED_OPS } from '../src/server/lib/fences';
import { checkout, type CheckoutInputData } from '../src/server/modules/frontdesk/checkout';
import { checkin } from '../src/server/modules/frontdesk/visits';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

const H = 3_600_000;
let ctx: TestContext;
let clerk: Actor;
let deps: { sql: TestContext['sql']; config: TestContext['config'] };
let payer: string;
let today: string;
let tagNo = 0;

const enterAndPay = async (payments: CheckoutInputData['payments'], memberId?: number, actor: Actor = clerk) => {
  tagNo += 1;
  const r = await checkin(deps, { clientKey: randomUUID(), guests: [{ tagCode: `K${String(tagNo).padStart(3, '0')}`, zone: 'male', ...(memberId ? { memberId } : {}) }] }, { actor: clerk, at: new Date(Date.now() - H) });
  const total = (payments ?? []).reduce((s, p) => s + p.amount, 0);
  return checkout(deps, { clientKey: randomUUID(), visitIds: [r.visits[0]!.id], expectedTotal: total, payments }, { actor, at: new Date() });
};
const ask = (body: Record<string, unknown>, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', '/api/invoice-requests', { clientKey: randomUUID(), titleType: 'personal', title: '王先生', ...body });
const source = async (type: string, id: number, cookie = ctx.clerk) => (await api(ctx.app, cookie, 'GET', `/api/invoice-requests/source?type=${type}&id=${id}`)).body;

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  clerk = { id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk', duties: [], mustChangePassword: false };
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'K', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  await createStaff(ctx.sql, { username: 'kp-payer', displayName: '对账小钱', role: 'backoffice', duties: ['payable'] as never, password: PASSWORD, mustChangePassword: false });
  payer = await login(ctx.app, 'kp-payer');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
}, 60_000);
afterAll(async () => ctx.close());

describe('开票申请', () => {
  it('结账单：只按现金类实收开（储值不算），减掉退款；同一笔只能开一次；作废后能重新申请；反结账以后标红', async () => {
    const m = await createMember(ctx, '开票会员');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 100_000))).status).toBe(200);
    const done = await enterAndPay([{ method: 'wallet', memberId: m.id, amount: 20_000, expectedSplit: { principal: 20_000, bonus: 0 } }, { method: 'wechat', amount: 29_900, ref: '尾号 8888' }], m.id);
    const info = await source('checkout', done.id);
    expect(info).toMatchObject({ no: done.checkoutNo, invoiceableCents: 29_900, voided: false, active: null, partyName: '开票会员' });
    // 超过可开金额、个人开专票、专票没税号：拒绝
    expect((await ask({ sourceType: 'checkout', sourceId: done.id, amountCents: 30_000 })).body.error.code).toBe('AMOUNT_OVER');
    expect((await ask({ sourceType: 'checkout', sourceId: done.id, amountCents: 100, invoiceKind: 'special' })).status).toBe(400);
    expect((await ask({ sourceType: 'checkout', sourceId: done.id, amountCents: 100, titleType: 'company', title: '某公司', invoiceKind: 'special' })).status).toBe(400);
    // 申请：操作编号重提返回同一张
    const body = { clientKey: randomUUID(), sourceType: 'checkout', sourceId: done.id, amountCents: 29_900, titleType: 'company', title: '某某科技有限公司', taxNo: '91440300ma5xxxxx1a', email: 'fp@example.com' };
    const first = await api(ctx.app, ctx.clerk, 'POST', '/api/invoice-requests', body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.request).toMatchObject({ status: 'requested', taxNo: '91440300MA5XXXXX1A', sourceNo: done.checkoutNo, amountCents: 29_900 });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/invoice-requests', body)).body.replayed).toBe(true);
    expect((await ask({ sourceType: 'checkout', sourceId: done.id, amountCents: 100 })).body.error.code).toBe('INVOICE_REQUEST_EXISTS');
    const id = first.body.request.id;
    // 店员处理不了；财务手工登记已开（带 PDF）
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/erp/sales-invoices/${id}/issue`, { version: 1, invoiceNo: 'X1', invoiceDate: today })).status).toBe(403);
    const pdf = Buffer.from('%PDF-1.4\n% test\n').toString('base64');
    const issued = await api(ctx.app, payer, 'POST', `/api/erp/sales-invoices/${id}/issue`, { version: 1, invoiceNo: '26440000000000000001', invoiceDate: today, pdf: { name: 'a.pdf', data: pdf } });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body).toMatchObject({ status: 'issued', issuedVia: 'manual', hasFile: true, version: 2 });
    const file = await ctx.app.inject({ method: 'GET', url: `/api/erp/sales-invoices/${id}/file`, headers: { cookie: payer } });
    expect(file.statusCode).toBe(200);
    // 内容不能改（数据库兜底）
    await expect(ctx.sql`UPDATE invoice_requests SET amount_cents = 1 WHERE id = ${id}`).rejects.toThrow(/不能改/);
    // 反结账不拦；已开的标「来源已作废」
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${done.id}/void`, { reason: '收款方式记错' })).status).toBe(200);
    const red = (await api(ctx.app, payer, 'GET', '/api/erp/sales-invoices?status=red')).body;
    expect(red.rows.map((r: { id: number }) => r.id)).toContain(id);
    expect(red.counts.redFlag).toBeGreaterThanOrEqual(1);
    expect((await source('checkout', done.id)).invoiceableCents).toBe(0);
    // 红冲 = 作废（写原因）；旧版本号拒绝
    expect((await api(ctx.app, payer, 'POST', `/api/erp/sales-invoices/${id}/void`, { version: 1, reason: '来源已反结账' })).body.error.code).toBe('INVOICE_REQUEST_CHANGED');
    const voided = await api(ctx.app, payer, 'POST', `/api/erp/sales-invoices/${id}/void`, { version: 2, reason: '来源已反结账' });
    expect(voided.body).toMatchObject({ status: 'voided', voidReason: '来源已反结账' });
    // 反结账的来源不能再申请
    expect((await ask({ sourceType: 'checkout', sourceId: done.id, amountCents: 100 })).body.error.code).toBe('SOURCE_VOIDED');
  });

  it('会员充值按实收开（赠金不开）；交给服务商开（模拟），记对外调用；驳回的不占「只能开一次」', async () => {
    const m = await createMember(ctx, '充值开票');
    const rc = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 50_000));
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    const rid = rc.body.recharge.id;
    const info = await source('recharge', rid);
    expect(info).toMatchObject({ invoiceableCents: 50_000, partyName: '充值开票' });
    expect(info.basis.join('')).toContain('充值实收');
    const req = (await ask({ sourceType: 'recharge', sourceId: rid, amountCents: 50_000 })).body.request;
    const issued = await api(ctx.app, payer, 'POST', `/api/erp/sales-invoices/${req.id}/provider`, { version: 1 });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body).toMatchObject({ status: 'issued', issuedVia: 'mock', hasFile: true });
    expect(issued.body.invoiceNo).toMatch(/^99\d{18}$/);
    const [call] = await ctx.sql<{ ok: boolean; mode: string; action: string }[]>`SELECT ok, mode, action FROM integration_calls WHERE ref_type = 'invoice_request' AND ref_id = ${req.id}`;
    expect(call).toMatchObject({ ok: true, mode: 'mock', action: 'issue' });
    // 驳回
    const done2 = await enterAndPay([{ method: 'alipay', amount: 49_900, ref: '尾号 1' }]);
    const r2 = (await ask({ sourceType: 'checkout', sourceId: done2.id, amountCents: 10_000 })).body.request;
    const rej = await api(ctx.app, payer, 'POST', `/api/erp/sales-invoices/${r2.id}/reject`, { version: 1, reason: '抬头不对，请重新申请' });
    expect(rej.body).toMatchObject({ status: 'rejected' });
    // 驳回的不占「同一笔只能开一次」
    expect((await ask({ sourceType: 'checkout', sourceId: done2.id, amountCents: 10_000 })).status).toBe(201);
  });

  it('服务商没接时「交给服务商开」拒绝；协议单位回款能申请；确认作废接进全店那一套', async () => {
    expect(FENCED_OPS).toContain('invoice_request');
    // 关掉模拟：服务商没接
    const saved = ctx.config.integrations;
    try {
      ctx.config.integrations = { mock: false, liveConfigured: [] };
      const done = await enterAndPay([{ method: 'cash', amount: 49_900 }]);
      const r = (await ask({ sourceType: 'checkout', sourceId: done.id, amountCents: 100 })).body.request;
      expect((await api(ctx.app, payer, 'POST', `/api/erp/sales-invoices/${r.id}/provider`, { version: 1 })).body.error.code).toBe('EINVOICE_OFF');
      expect((await api(ctx.app, payer, 'GET', '/api/erp/sales-invoices')).body.providerMode).toBe('off');
    } finally {
      ctx.config.integrations = saved;
    }
    const acc = (await api(ctx.app, ctx.owner, 'POST', '/api/erp/receivables/accounts', { code: 'KP01', name: '开票协议单位', creditLimitCents: 100_000 })).body;
    const accountId = acc.find((a: { code: string }) => a.code === 'KP01').id;
    // 先挂账一笔（值班经理），再登记回款
    const manager: Actor = { ...clerk, displayName: '值班经理', role: 'duty_manager' };
    await enterAndPay([{ method: 'on_account', accountId, signer: '张会计', amount: 49_900 } as never], undefined, manager);
    const [owed] = await ctx.sql<{ n: string }[]>`SELECT coalesce(sum(amount_cents), 0)::text AS n FROM ar_charges WHERE account_id = ${accountId}`;
    const amount = Number(owed!.n);
    expect(amount).toBeGreaterThan(0);
    const col = await api(ctx.app, payer, 'POST', '/api/erp/receivables/collections', { clientKey: randomUUID(), accountId, collectedOn: today, method: 'bank_transfer', amountCents: amount, evidence: '网银 001' });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    const colId = col.body.collection?.id ?? col.body.id;
    // 店员看不了回款的开票
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/invoice-requests/source?type=ar_collection&id=${colId}`)).status).toBe(403);
    expect((await source('ar_collection', colId, payer)).partyName).toBe('开票协议单位');
    const req = await ask({ sourceType: 'ar_collection', sourceId: colId, amountCents: amount, titleType: 'company', title: '开票协议单位', taxNo: '91110000100000000X', invoiceKind: 'special' }, payer);
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    // 确认作废以后同一个编号不再生效
    const key = randomUUID();
    const fence = await api(ctx.app, ctx.clerk, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'invoice_request' });
    expect([200, 201]).toContain(fence.status);
    const done3 = await enterAndPay([{ method: 'cash', amount: 49_900 }]);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/invoice-requests', { clientKey: key, sourceType: 'checkout', sourceId: done3.id, amountCents: 100, titleType: 'personal', title: '某' })).body.error.code).toBe('OP_ABANDONED');
  });
});
