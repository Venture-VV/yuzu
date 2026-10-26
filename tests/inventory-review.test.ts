// Mac 独立复审：采购改版后的草稿、价格口径与付款 / 冲销竞态。
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
beforeAll(async () => { ctx = await setup(); today = todayIn(ctx.config.timezone); });
afterAll(async () => ctx?.close());

const post = (path: string, body: unknown) => api(ctx.app, ctx.owner, 'POST', path, body);
async function fixture() {
  const code = randomUUID().slice(0, 8);
  const supplier = await post('/api/inventory/suppliers', { code, name: `复审供应商${code}` });
  const material = await post('/api/inventory/materials', { code, name: `复审物料${code}`, inventoryUnit: '瓶', purchaseUnit: '箱', purchaseFactorMilli: 10000 });
  expect(supplier.status).toBe(201);
  expect(material.status).toBe(201);
  return { supplierId: supplier.body.find((s: { code: string }) => s.code === code).id as number, materialId: material.body.id as number };
}
async function orderAndDraft() {
  const f = await fixture();
  const po = await post('/api/purchase-orders', { clientKey: randomUUID(), supplierId: f.supplierId, orderDate: today, approveNow: true,
    lines: [{ materialId: f.materialId, purchaseQtyMilli: 1000, priceCents: 1000 }] });
  expect(po.status, JSON.stringify(po.body)).toBe(201);
  const receiptBody = { docType: 'receipt', docDate: today, supplierId: f.supplierId, purchaseOrderId: po.body.po.id,
    lines: [{ materialId: f.materialId, poLineId: po.body.po.lines[0].id, deliveredMilli: 10000, acceptedMilli: 10000 }] };
  const draft = await post('/api/inventory/docs', { clientKey: randomUUID(), ...receiptBody, action: 'save' });
  expect(draft.status).toBe(201);
  return { ...f, po: po.body.po, draft: draft.body.doc, receiptBody };
}

it.each(['price', 'supplier', 'material'] as const)('收货与采购改版交错（%s）时，旧快照不能入账', async (change) => {
  const f = await fixture();
  const other = await fixture();
  const order = await post('/api/purchase-orders', { clientKey: randomUUID(), supplierId: f.supplierId, orderDate: today, approveNow: true,
    lines: [{ materialId: f.materialId, purchaseQtyMilli: 1000, priceCents: 1000 }] });
  expect(order.status).toBe(201);
  const po = order.body.po;
  await ctx.sql`INSERT INTO doc_counters (doc_type, business_date, last_no) VALUES ('inv_receipt', ${today}, 0) ON CONFLICT DO NOTHING`;
  let release!: () => void;
  let acquired!: () => void;
  const locked = new Promise<void>((resolve) => { acquired = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocker = ctx.sql.begin(async (tx) => {
    await tx`SELECT last_no FROM doc_counters WHERE doc_type = 'inv_receipt' AND business_date = ${today} FOR UPDATE`;
    acquired(); await gate;
  });
  await locked;
  const receipt = post('/api/inventory/docs', { clientKey: randomUUID(), docType: 'receipt', docDate: today, supplierId: f.supplierId, purchaseOrderId: po.id,
    lines: [{ materialId: f.materialId, poLineId: po.lines[0].id, deliveredMilli: 10000, acceptedMilli: 10000 }] });
  try {
    await waitForLock('%INSERT INTO doc_counters%');
    const revision = await post(`/api/purchase-orders/${po.id}/revise`, {
      supplierId: change === 'supplier' ? other.supplierId : f.supplierId, orderDate: today, approveNow: true,
      lines: [{ id: po.lines[0].id, materialId: change === 'material' ? other.materialId : f.materialId, purchaseQtyMilli: 1000, priceCents: change === 'price' ? 2000 : 1000 }],
    });
    expect(revision.status, JSON.stringify(revision.body)).toBe(200);
  } finally { release(); await blocker; }
  const result = await receipt;
  expect(result.status, JSON.stringify(result.body)).toBe(409);
  expect(result.body.error.code).toBe('PO_RECEIPT_STALE');
  const [stock] = await ctx.sql<{ stock: number }[]>`SELECT stock_milli AS stock FROM materials WHERE id = ${f.materialId}`;
  expect(stock!.stock).toBe(0);
  const entries = await ctx.sql`SELECT id FROM ap_entries WHERE supplier_id = ${f.supplierId}`;
  expect(entries).toHaveLength(0);
});

async function waitForLock(pattern: string) {
  for (let i = 0; i < 150; i++) {
    const rows = await ctx.sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
      AND wait_event_type = 'Lock' AND query LIKE ${pattern}`;
    if (rows.length) return;
    await delay(10);
  }
  throw new Error(`没有观察到预期的并发交错：${pattern}`);
}

const priceBasisOf = async (id: number) => (await ctx.sql<{ priceBasis: string }[]>`SELECT price_basis FROM inv_docs WHERE id = ${id}`)[0]!.priceBasis;

it('按单收货的价格口径沿用采购单，直接收货草稿重录时使用当前口径', async () => {
  const f = await orderAndDraft();
  const originalBasis = f.po.priceBasis;
  await ctx.sql`UPDATE settings SET value = '"不含税到货价"'::jsonb WHERE key = 'inventory_price_basis'`;
  const receipt = await post('/api/inventory/docs', { clientKey: randomUUID(), ...f.receiptBody });
  expect(receipt.status).toBe(201);
  expect(await priceBasisOf(receipt.body.doc.id)).toBe(originalBasis);
  const direct = await post('/api/inventory/docs', { clientKey: randomUUID(), ...f.receiptBody, purchaseOrderId: null, action: 'save',
    lines: [{ materialId: f.materialId, deliveredMilli: 1000, acceptedMilli: 1000, priceCents: 1000 }] });
  await ctx.sql`UPDATE settings SET value = '"含税到货价"'::jsonb WHERE key = 'inventory_price_basis'`;
  const edited = await api(ctx.app, ctx.owner, 'PUT', `/api/inventory/docs/${direct.body.doc.id}`, { ...f.receiptBody, purchaseOrderId: null,
    lines: [{ materialId: f.materialId, deliveredMilli: 1000, acceptedMilli: 1000, priceCents: 1000 }] });
  expect(edited.status).toBe(200);
  expect(await priceBasisOf(edited.body.id)).toBe('含税到货价');
});

it('付款与收货冲销交错时，付款不得核销到已冲销的收货单', async () => {
  const f = await fixture();
  const receipt = await post('/api/inventory/docs', { clientKey: randomUUID(), docType: 'receipt', docDate: today, supplierId: f.supplierId,
    lines: [{ materialId: f.materialId, deliveredMilli: 10000, acceptedMilli: 10000, priceCents: 1000 }] });
  expect(receipt.status).toBe(201);
  let release!: () => void;
  let acquired!: () => void;
  const locked = new Promise<void>((resolve) => { acquired = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocker = ctx.sql.begin(async (tx) => {
    await tx`SELECT id FROM materials WHERE id = ${f.materialId} FOR UPDATE`;
    acquired();
    await gate;
  });
  await locked;
  const voiding = post(`/api/inventory/docs/${receipt.body.doc.id}/void`, { reason: '复审冲销竞态' });
  let payment: ReturnType<typeof post> | undefined;
  try {
    // 等到冲销已完成前置校验、正在等待库存锁；随后插入付款，稳定重现两种操作的交错。
    let waiting = false;
    for (let i = 0; i < 150; i++) {
      const rows = await ctx.sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock' AND query LIKE '%FROM materials WHERE id IN%'`;
      if (rows.length) { waiting = true; break; }
      await delay(10);
    }
    expect(waiting).toBe(true);
    let finished = false;
    payment = post('/api/payables/payments', { clientKey: randomUUID(), supplierId: f.supplierId, payDate: today, amountCents: 1000,
      method: 'cash', evidence: '复审合成凭据', allocations: [{ kind: 'receipt', targetId: receipt.body.doc.id, amountCents: 1000 }] });
    void payment.then(() => { finished = true; });
    for (let i = 0; i < 150 && !finished; i++) {
      const rows = await ctx.sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock' AND (query LIKE '%FROM inv_docs%' OR query LIKE '%INSERT INTO payment_allocations%')`;
      if (rows.length) break;
      await delay(10);
    }
  } finally { release(); await blocker; }
  expect((await voiding).status).toBe(200);
  expect(payment).toBeDefined();
  const result = await payment!;
  expect(result.status, JSON.stringify(result.body)).toBe(422);
  expect(result.body.error.code).toBe('ALLOCATION_TARGET_INVALID');
  const [balance] = await ctx.sql<{ amount: number }[]>`SELECT coalesce(sum(amount_delta_cents), 0) AS amount FROM ap_entries WHERE supplier_id = ${f.supplierId}`;
  expect(balance!.amount).toBe(0);
});
