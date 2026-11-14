// 8.0.20 用料与配方、销售与出品扣库存（docs/ERP_V8020.md 第 2 节，JX-A / JX-B；迁移 128）。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usageMilli } from '../src/shared/stock-usage';
import { todayIn } from '../src/server/modules/inventory/common';
import { processStockUsage } from '../src/server/modules/stock-usage';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let keeper: string;
let cook: string;
let tagNo = 0;
const item: Record<string, number> = {};
const mat: Record<string, number> = {};
const q = (n: number) => Math.round(n * 1000);

const enter = async () => {
  tagNo += 1;
  const code = `U${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.visits[0].id as number, code };
};
const charge = (visitId: number, itemId: number, quantity: number, price: number) =>
  api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines: [{ itemId, quantity }], expectedTotal: price * quantity });
const order = (visitId: number, itemId: number, quantity: number, price: number) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines: [{ itemId, quantity }], expectedTotal: price * quantity });
async function pay(visitId: number) {
  const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const paid = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: preview.totalAmount,
    payments: [{ method: 'cash', amount: preview.totalAmount }],
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  const [c] = await ctx.sql<{ id: number }[]>`SELECT checkout_id AS id FROM checkout_bills WHERE visit_id = ${visitId} ORDER BY checkout_id DESC LIMIT 1`;
  return Number(c!.id);
}
const doc = (cookie: string, body: Record<string, unknown>) => api(ctx.app, cookie, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docDate: today, ...body });
async function opening(materialId: number, qtyMilli: number) {
  const r = await doc(ctx.owner, { docType: 'opening', approveNow: true, lines: [{ materialId, qtyMilli }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
const stock = async (materialId: number) => Number((await ctx.sql<{ s: number }[]>`SELECT stock_milli AS s FROM materials WHERE id = ${materialId}`)[0]!.s);
const events = (where: 'sale' | 'recipe') =>
  ctx.sql<{ sign: number; material: number; qty: number; state: string; blocked: boolean }[]>`
    SELECT sign, material_id AS material, qty_milli AS qty, state, blocked_at IS NOT NULL AS blocked FROM stock_usage_events WHERE kind = ${where} ORDER BY id`;
const run = () => processStockUsage({ sql: ctx.sql, config: ctx.config });
const recipe = (itemId: number, body: Record<string, unknown>, cookie = ctx.owner) => api(ctx.app, cookie, 'PUT', `/api/inventory/recipes/${itemId}`, body);
const kitchenIds = async (visitId: number) => (await ctx.sql<{ id: number }[]>`SELECT id FROM kitchen_items WHERE visit_id = ${visitId} ORDER BY id`).map((r) => Number(r.id));
const act = (id: number, action: string) => api(ctx.app, cook, 'POST', `/api/kitchen/items/${id}/${action}`);

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  await createStaff(ctx.sql, { username: 'u-keeper', displayName: '仓库小林', role: 'backoffice', duties: ['stock'] as never, password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'u-cook', displayName: '厨房', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  keeper = await login(ctx.app, 'u-keeper');
  cook = await login(ctx.app, 'u-cook');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'U', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  for (const [name, category, price] of [
    ['矿泉水', '零售', 500],
    ['宫保鸡丁', '热菜', 4800],
    ['没设用料的', '零售', 300],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    expect(r.status).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '热菜' });
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '热菜').id;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: item['宫保鸡丁'], stationId }] })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
  for (const [code, name, unit, decimals, ref] of [
    ['U-WATER', '瓶装水', '瓶', 0, 2400],
    ['U-CHICK', '鸡腿肉', '千克', 3, 30000],
    ['U-NUT', '花生米', '千克', 3, 12000],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', { code, name, inventoryUnit: unit, decimals, purchaseUnit: '箱', purchaseFactorMilli: q(24), refPriceCents: ref });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    mat[name] = r.body.id;
  }
  await opening(mat['瓶装水']!, q(10));
  await opening(mat['鸡腿肉']!, q(2));
}, 60_000);
afterAll(async () => ctx.close());

describe('用料', () => {
  it('算法：一份用量 × 份数 ×（1 + 损耗率），按物料的小数位向上取整', () => {
    expect(usageMilli(q(1), 3, 0, 0)).toBe(q(3));
    expect(usageMilli(q(0.2), 2, 500, 3)).toBe(q(0.42));
    expect(usageMilli(q(0.2), 1, 333, 3)).toBe(207); // 0.2 × 1.0333 = 0.20666 → 0.207
    expect(usageMilli(q(1), 1, 1000, 0)).toBe(q(2)); // 1.1 瓶 → 整瓶算 2
  });

  it('设用料：带版本，改 = 旧的停用、写一份新的；别人改过拒绝；同一样物料只能一次、小数位要对；清空 = 不再扣', async () => {
    const r1 = await recipe(item['矿泉水']!, { expectedVersion: 0, lines: [{ materialId: mat['瓶装水'], qtyMilli: q(1) }] });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.version).toBe(1);
    expect((await recipe(item['矿泉水']!, { expectedVersion: 0, lines: [{ materialId: mat['瓶装水'], qtyMilli: q(2) }] })).body.error.code).toBe('RECIPE_CHANGED');
    expect((await recipe(item['宫保鸡丁']!, { expectedVersion: 0, lines: [{ materialId: mat['鸡腿肉'], qtyMilli: q(0.2) }, { materialId: mat['鸡腿肉'], qtyMilli: q(0.1) }] })).status).toBe(400);
    expect((await recipe(item['宫保鸡丁']!, { expectedVersion: 0, lines: [{ materialId: mat['瓶装水'], qtyMilli: 500 }] })).status).toBe(400);
    expect((await recipe(item['宫保鸡丁']!, { expectedVersion: 0, lines: [] })).status).toBe(400);
    // 物资经办能看、不能改
    expect((await recipe(item['宫保鸡丁']!, { expectedVersion: 0, lines: [{ materialId: mat['鸡腿肉'], qtyMilli: q(0.2) }] }, keeper)).status).toBe(403);
    const r2 = await recipe(item['宫保鸡丁']!, {
      expectedVersion: 0,
      note: '标准份',
      lines: [
        { materialId: mat['鸡腿肉'], qtyMilli: q(0.2), lossBp: 500 },
        { materialId: mat['花生米'], qtyMilli: q(0.05) },
      ],
    });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    const list = (await api(ctx.app, keeper, 'GET', '/api/inventory/recipes')).body as { itemName: string; version: number; kitchen: boolean; unitCostCents: number | null; lines: { materialName: string; avgCostE4: number | null }[] }[];
    const water = list.find((x) => x.itemName === '矿泉水')!;
    const dish = list.find((x) => x.itemName === '宫保鸡丁')!;
    expect(water).toMatchObject({ version: 1, kitchen: false });
    expect(dish).toMatchObject({ version: 1, kitchen: true });
    expect(dish.lines.map((l) => l.materialName)).toEqual(['鸡腿肉', '花生米']);
    expect(list.find((x) => x.itemName === '没设用料的')).toMatchObject({ version: 0, lines: [] });
    // 物资经办没有「看成本」：不给成本
    expect(dish.unitCostCents).toBeNull();
    expect(dish.lines.every((l) => l.avgCostE4 === null)).toBe(true);
    // 店主看得到：瓶装水 24.00 元 / 24 瓶 = 1.00 元；鸡丁 = 0.21 kg × 12.50 + 0.05 kg × 5.00
    const asOwner = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/recipes')).body as typeof list;
    expect(asOwner.find((x) => x.itemName === '矿泉水')!.unitCostCents).toBe(100);
    expect(asOwner.find((x) => x.itemName === '宫保鸡丁')!.unitCostCents).toBe(263 + 25);
    // 改：版本 2；历史版本留着
    const r3 = await recipe(item['矿泉水']!, { expectedVersion: 1, lines: [{ materialId: mat['瓶装水'], qtyMilli: q(1) }], note: '改过一次' });
    expect(r3.body.version).toBe(2);
    expect((await ctx.sql`SELECT version, status FROM item_recipes WHERE item_id = ${item['矿泉水']!} ORDER BY version`).map((r) => [r.version, r.status])).toEqual([
      [1, 'retired'],
      [2, 'active'],
    ]);
  });
});

describe('零售：结账时记、每分钟的任务开耗用单', () => {
  it('结账：只对设了用料、不进厨房的明细记；任务开一张「销售出库」的耗用单、扣总仓；反结账冲回、重新结账与冲回轧平，不再出库', async () => {
    const v = await enter();
    expect((await charge(v.id, item['矿泉水']!, 3, 500)).status).toBe(200);
    expect((await charge(v.id, item['没设用料的']!, 1, 300)).status).toBe(200);
    expect(await events('sale')).toEqual([]);
    const checkoutId = await pay(v.id);
    expect((await events('sale')).map((e) => [e.sign, Number(e.material), Number(e.qty), e.state])).toEqual([[1, mat['瓶装水'], q(3), 'pending']]);
    expect(await stock(mat['瓶装水']!)).toBe(q(10));
    const r = await run();
    expect(r).toMatchObject({ docs: 1, lines: 1, blocked: 0 });
    expect(await stock(mat['瓶装水']!)).toBe(q(7));
    const [d] = await ctx.sql<{ docType: string; note: string; status: string; operator: string }[]>`
      SELECT d.doc_type, d.note, d.status, st.username AS operator FROM stock_usage_batches b JOIN inv_docs d ON d.id = b.inv_doc_id JOIN staff st ON st.id = d.created_by ORDER BY b.id DESC LIMIT 1`;
    expect(d).toMatchObject({ docType: 'direct_use', status: 'confirmed', operator: 'system.stock' });
    expect(d!.note).toMatch(/^销售出库（自动扣料第 \d+ 批）$/);
    expect((await events('sale')).map((e) => e.state)).toEqual(['batched']);
    // 再跑一次：什么都不做
    expect(await run()).toMatchObject({ docs: 0, lines: 0 });
    // 反结账：一条冲回，净数 −3，留着
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${checkoutId}/void`, { reason: '收款方式记错' })).status).toBe(200);
    expect((await events('sale')).map((e) => [e.sign, e.state])).toEqual([
      [1, 'batched'],
      [-1, 'pending'],
    ]);
    expect(await run()).toMatchObject({ docs: 0 });
    const overview = (await api(ctx.app, keeper, 'GET', '/api/inventory/usage')).body;
    expect(overview.pending).toEqual([expect.objectContaining({ kind: 'sale', materialName: '瓶装水', netMilli: -q(3), blocked: false })]);
    // 重新结账：与冲回轧平，不再出库
    await pay(v.id);
    expect(await run()).toMatchObject({ docs: 0, lines: 0 });
    expect((await events('sale')).map((e) => [e.sign, e.state])).toEqual([
      [1, 'batched'],
      [-1, 'netted'],
      [1, 'netted'],
    ]);
    expect(await stock(mat['瓶装水']!)).toBe(q(7));
    expect((await api(ctx.app, keeper, 'GET', '/api/inventory/usage')).body.pending).toEqual([]);
  });

  it('库存不够：不拦结账；缺的那样留在待扣料里，补了库存以后自动扣', async () => {
    const v = await enter();
    expect((await charge(v.id, item['矿泉水']!, 9, 500)).status).toBe(200);
    await pay(v.id);
    expect(await run()).toMatchObject({ docs: 0, blocked: 1 });
    expect(await stock(mat['瓶装水']!)).toBe(q(7));
    const blocked = (await api(ctx.app, keeper, 'GET', '/api/inventory/usage')).body.pending;
    expect(blocked).toEqual([expect.objectContaining({ materialName: '瓶装水', netMilli: q(9), stockMilli: q(7), blocked: true })]);
    // 到一箱货（24 瓶）
    const sup = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'US01', name: '扣料测试供应商' });
    const supplierId = sup.body.find((x: { code: string }) => x.code === 'US01').id;
    const po = await api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId, orderDate: today, approveNow: true, lines: [{ materialId: mat['瓶装水'], purchaseQtyMilli: q(1), priceCents: 2400 }] });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    const received = await doc(keeper, { docType: 'receipt', supplierId, purchaseOrderId: po.body.po.id, coAcceptorId: null, lines: [{ materialId: mat['瓶装水'], poLineId: po.body.po.lines[0].id, deliveredMilli: q(24), acceptedMilli: q(24) }] });
    expect(received.status, JSON.stringify(received.body)).toBe(201);
    const manual = await api(ctx.app, keeper, 'POST', '/api/inventory/usage/run');
    expect(manual.body).toMatchObject({ docs: 1, lines: 1, blocked: 0 });
    expect(await stock(mat['瓶装水']!)).toBe(q(22));
  });
});

describe('配方：出品完成时记', () => {
  it('下单不记；出品完成按配方（含损耗）记；撤回冲回；退菜已出品的不退料；缺的物料留着、别的照扣', async () => {
    const v = await enter();
    expect((await order(v.id, item['宫保鸡丁']!, 2, 4800)).status).toBe(200);
    expect(await events('recipe')).toEqual([]);
    const [k] = await kitchenIds(v.id);
    expect((await act(k!, 'done')).status).toBe(200);
    expect((await events('recipe')).map((e) => [e.sign, Number(e.material), Number(e.qty)])).toEqual([
      [1, mat['鸡腿肉'], q(0.42)],
      [1, mat['花生米'], q(0.1)],
    ]);
    // 撤回出品完成 → 冲回；再完成 → 再记
    expect((await act(k!, 'undo')).status).toBe(200);
    expect((await events('recipe')).map((e) => e.sign)).toEqual([1, 1, -1, -1]);
    expect((await act(k!, 'done')).status).toBe(200);
    expect((await events('recipe')).map((e) => e.sign)).toEqual([1, 1, -1, -1, 1, 1]);
    // 鸡腿肉有货、花生米没货：一张「配方耗用」只扣鸡腿肉，花生米留着
    const r = await run();
    expect(r).toMatchObject({ docs: 1, lines: 1, blocked: 1 });
    expect(await stock(mat['鸡腿肉']!)).toBe(q(2) - q(0.42));
    const pending = (await api(ctx.app, keeper, 'GET', '/api/inventory/usage')).body.pending;
    expect(pending).toEqual([expect.objectContaining({ kind: 'recipe', materialName: '花生米', netMilli: q(0.1), blocked: true })]);
    // 退菜（已出品）：不退料
    const [line] = await ctx.sql<{ id: number }[]>`SELECT bill_line_id AS id FROM kitchen_items WHERE id = ${k!}`;
    const voided = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${line!.id}/void`, { reason: '客人不要了' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect((await events('recipe')).filter((e) => e.sign === -1).length).toBe(2);
    // 花生米到货：自动扣
    await opening(mat['花生米']!, q(1));
    expect(await run()).toMatchObject({ docs: 1, lines: 1, blocked: 0 });
    expect(await stock(mat['花生米']!)).toBe(q(0.9));
    // 结账：进厨房的明细不再按「销售」记一遍
    const before = (await events('sale')).length;
    await pay(v.id);
    expect((await events('sale')).length).toBe(before);
  });

  it('规则关着：不记；批次开了单没记下结果，下一轮按操作编号对账；没开出来的放回去重来', async () => {
    const off = await api(ctx.app, ctx.owner, 'PUT', '/api/inventory/usage/rules', { enabled: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const v = await enter();
    await charge(v.id, item['矿泉水']!, 1, 500);
    const n = (await events('sale')).length;
    await pay(v.id);
    expect((await events('sale')).length).toBe(n);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/inventory/usage/rules', { enabled: true })).status).toBe(200);
    // 两位客人各买 1 瓶
    const a = await enter();
    await charge(a.id, item['矿泉水']!, 1, 500);
    await pay(a.id);
    const [ea] = await ctx.sql<{ id: number }[]>`SELECT id FROM stock_usage_events WHERE state = 'pending' ORDER BY id DESC LIMIT 1`;
    // 模拟「单已经开出来、批次没记下结果」：批次停在 posting，耗用单用批次的操作编号开好了
    const [stuck] = await ctx.sql<{ id: number; clientKey: string }[]>`
      INSERT INTO stock_usage_batches (kind, warehouse_id, doc_date, line_count) VALUES ('sale', 1, ${today}, 1) RETURNING id, client_key`;
    await ctx.sql`UPDATE stock_usage_events SET batch_id = ${stuck!.id} WHERE id = ${ea!.id}`;
    const made = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', { clientKey: stuck!.clientKey, docDate: today, docType: 'direct_use', note: '销售出库（模拟）', lines: [{ materialId: mat['瓶装水'], qtyMilli: q(1) }] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(await stock(mat['瓶装水']!)).toBe(q(21));
    // 另一批：停在 posting，单没有开出来
    const b = await enter();
    await charge(b.id, item['矿泉水']!, 1, 500);
    await pay(b.id);
    const [eb] = await ctx.sql<{ id: number }[]>`SELECT id FROM stock_usage_events WHERE state = 'pending' AND batch_id IS NULL ORDER BY id DESC LIMIT 1`;
    const [lost] = await ctx.sql<{ id: number }[]>`INSERT INTO stock_usage_batches (kind, warehouse_id, doc_date, line_count) VALUES ('sale', 1, ${today}, 1) RETURNING id`;
    await ctx.sql`UPDATE stock_usage_events SET batch_id = ${lost!.id} WHERE id = ${eb!.id}`;
    const r = await run();
    // 第一批认下（不重复扣）、第二批放回去后在这一轮重新开出来
    expect(r).toMatchObject({ reconciled: 1, released: 1, docs: 1 });
    expect(await stock(mat['瓶装水']!)).toBe(q(20));
    expect((await ctx.sql`SELECT status FROM stock_usage_batches WHERE id IN ${ctx.sql([stuck!.id, lost!.id])} ORDER BY id`).map((x) => x.status)).toEqual(['done', 'released']);
    expect((await ctx.sql`SELECT state FROM stock_usage_events WHERE id IN ${ctx.sql([ea!.id, eb!.id])} ORDER BY id`).map((x) => x.state)).toEqual(['batched', 'batched']);
    // 事件内容不能改、不能删
    await expect(ctx.sql`UPDATE stock_usage_events SET qty_milli = 1 WHERE id = ${ea!.id}`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM stock_usage_events WHERE id = ${ea!.id}`).rejects.toThrow();
  });
});
