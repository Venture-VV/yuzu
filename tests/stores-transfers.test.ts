// 多店多仓与门店间调拨（8.0.22，docs/MULTISTORE_V8022.md 第 8 节，MD-B）：新门店自动有主仓；
// 调出时调出仓扣减、记在途；调入按实收，短少写原因；在途的可以撤回（原数退回）；调拨生成的单据不能单独冲销；
// 同一个操作编号重提返回同一张；同一家店里的仓之间不能调拨。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/lib/dates';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let ft: number;
let ftMain: number;
let materialId: number;
let today: string;
const q = (n: number) => n * 1000;

const centralStock = async () => Number((await ctx.sql<{ s: number }[]>`SELECT stock_milli AS s FROM materials WHERE id = ${materialId}`)[0]!.s);
const whStock = async (warehouseId: number) =>
  Number((await ctx.sql<{ s: number }[]>`SELECT coalesce((SELECT stock_milli FROM warehouse_stock WHERE warehouse_id = ${warehouseId} AND material_id = ${materialId}), 0) AS s`)[0]!.s);
const send = (qty: number, extra: Record<string, unknown> = {}) =>
  api(ctx.app, ctx.owner, 'POST', '/api/inventory/transfers', { clientKey: randomUUID(), fromWarehouseId: 1, toWarehouseId: ftMain, lines: [{ materialId, qtyMilli: q(qty) }], ...extra });

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  const entity = await api(ctx.app, ctx.owner, 'POST', '/api/admin/entities', { name: '福田主体' });
  ft = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'FT', name: '福田店', entityId: entity.body.id })).body.id;
  const m = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', {
    code: 'DB-01',
    name: '调拨用的毛巾',
    inventoryUnit: '条',
    decimals: 0,
    purchaseUnit: '包',
    purchaseFactorMilli: q(10),
    refPriceCents: 500,
  });
  expect(m.status, JSON.stringify(m.body)).toBe(201);
  materialId = m.body.id;
  const opening = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/docs', {
    clientKey: randomUUID(),
    docDate: today,
    docType: 'opening',
    approveNow: true,
    lines: [{ materialId, qtyMilli: q(100) }],
  });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);
}, 90_000);
afterAll(async () => ctx.close());

describe('门店间调拨', () => {
  it('新门店自动有主仓，仓库清单带门店；福田店的扣料默认从它的主仓扣', async () => {
    const [w] = await ctx.sql<{ id: number; name: string }[]>`SELECT id, name FROM warehouses WHERE store_id = ${ft} AND kind = 'store_main'`;
    expect(w?.name).toBe('福田店主仓');
    ftMain = Number(w!.id);
    const list = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/warehouses')).body as { id: number; storeId: number; storeName: string; kind: string }[];
    expect(list.find((x) => x.id === ftMain)).toMatchObject({ kind: 'store_main', storeId: ft, storeName: '福田店' });
    const [rules] = await ctx.sql<{ value: { saleWarehouseId: number; recipeWarehouseId: number } }[]>`
      SELECT value FROM store_settings WHERE store_id = ${ft} AND key = 'stock_usage_rules'`;
    expect(rules!.value).toMatchObject({ saleWarehouseId: ftMain, recipeWarehouseId: ftMain });
  });

  it('调出：总仓扣减、在途；同一个编号重提返回同一张；同一家店里的仓之间不能调拨', async () => {
    const key = randomUUID();
    const body = { clientKey: key, fromWarehouseId: 1, toWarehouseId: ftMain, note: '开业备货', lines: [{ materialId, qtyMilli: q(30) }] };
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/transfers', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: 'in_transit', fromWarehouseId: 1, toWarehouseId: ftMain, toName: '福田店主仓' });
    expect(r.body.transferNo).toMatch(/^DB\d{8}-\d{4}$/);
    expect(await centralStock()).toBe(q(70));
    expect(await whStock(ftMain)).toBe(0);
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/transfers', body);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(r.body.id);
    expect(await centralStock()).toBe(q(70));
    // 同一个编号、不同内容：拒绝
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/inventory/transfers', { ...body, note: '改了' })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 本店的两个仓之间：拒绝
    const [dept] = await ctx.sql<{ id: number }[]>`SELECT id FROM warehouses WHERE kind = 'department' AND store_id = 1 ORDER BY id LIMIT 1`;
    if (dept) expect((await send(1, { toWarehouseId: Number(dept.id) })).body.error.code).toBe('SAME_STORE');
    // 调出的单据是一张已生效的「调拨调出」，不能单独冲销
    const [out] = await ctx.sql<{ docType: string; status: string }[]>`SELECT doc_type, status FROM inv_docs WHERE id = ${r.body.outDocId}`;
    expect(out).toEqual({ docType: 'transfer_out', status: 'confirmed' });
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/inventory/docs/${r.body.outDocId}/void`, { reason: '试一下冲销' });
    expect(v.body.error?.code).toBe('NOT_VOIDABLE');

    // 调入：实收 28，少 2 条写原因；不写原因拒绝；多于调出拒绝
    const recv = (lines: unknown[], version = r.body.version) => api(ctx.app, ctx.owner, 'POST', `/api/inventory/transfers/${r.body.id}/receive`, { expectedVersion: version, lines });
    expect((await recv([{ materialId, receivedMilli: q(28) }])).body.error.code).toBe('VARIANCE_REASON');
    expect((await recv([{ materialId, receivedMilli: q(31) }])).body.error.code).toBe('RECEIVED_OVER');
    const done = await recv([{ materialId, receivedMilli: q(28), varianceReason: '路上弄湿两条' }]);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'received' });
    expect(done.body.lines[0]).toMatchObject({ qtyMilli: q(30), receivedMilli: q(28), varianceReason: '路上弄湿两条' });
    expect(await whStock(ftMain)).toBe(q(28));
    expect(await centralStock()).toBe(q(70));
    // 再调入一次：已经调入了
    expect((await recv([{ materialId, receivedMilli: q(28), varianceReason: '再来' }], done.body.version)).body.error.code).toBe('TRANSFER_CLOSED');
    // 流水：总仓一条调出、福田店主仓一条调入
    const moves = await ctx.sql<{ moveType: string; warehouseId: number; qty: number }[]>`
      SELECT move_type, warehouse_id, qty_delta_milli AS qty FROM stock_moves WHERE material_id = ${materialId} AND move_type LIKE 'transfer_%' ORDER BY id`;
    expect(moves.map((m) => [m.moveType, Number(m.warehouseId), Number(m.qty)])).toEqual([
      ['transfer_out', 1, -q(30)],
      ['transfer_in', ftMain, q(28)],
    ]);
  });

  it('在途的撤回：原数退回调出仓；撤回以后不能再调入', async () => {
    const r = await send(10);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await centralStock()).toBe(q(60));
    const c = await api(ctx.app, ctx.owner, 'POST', `/api/inventory/transfers/${r.body.id}/cancel`, { expectedVersion: r.body.version, reason: '福田店说先不要' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ status: 'cancelled', cancelReason: '福田店说先不要' });
    expect(await centralStock()).toBe(q(70));
    const again = await api(ctx.app, ctx.owner, 'POST', `/api/inventory/transfers/${r.body.id}/receive`, { expectedVersion: c.body.version, lines: [{ materialId, receivedMilli: q(10) }] });
    expect(again.body.error.code).toBe('TRANSFER_CLOSED');
    // 清单：在途的筛选里没有它
    const inTransit = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/transfers?status=in_transit')).body as { id: number }[];
    expect(inTransit.some((t) => t.id === r.body.id)).toBe(false);
  });

  it('调出仓不够：整单拒绝，什么都不动', async () => {
    const before = await centralStock();
    const r = await send(1000);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await centralStock()).toBe(before);
  });
});
