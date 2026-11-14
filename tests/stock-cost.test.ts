// 8.0.20 成本核算（docs/ERP_V8020.md 第 1 节，JX-C / JX4）：移动加权平均——带金额的进出重算平均成本，其余按当时的平均成本记金额。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moveCostCents, movingAverageE4, refCostE4, todayIn } from '../src/server/modules/inventory/common';
import { ERP_MODULES } from '../src/shared/erp';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let keeper: string;
let supplierId: number;
const q = (n: number) => Math.round(n * 1000);

const doc = (cookie: string, body: Record<string, unknown>) => api(ctx.app, cookie, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docDate: today, ...body });
async function ok(res: ReturnType<typeof doc>) {
  const r = await res;
  if (r.status !== 201) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body.doc as { id: number; status: string; lines: { id: number }[] };
}
async function material(code: string, over: Record<string, unknown> = {}) {
  const res = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', { code, name: `成本物料${code}`, inventoryUnit: '个', purchaseUnit: '箱', purchaseFactorMilli: q(10), ...over });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as { id: number };
}
const cost = async (id: number) => (await ctx.sql<{ avg: number; estimated: boolean; stock: number }[]>`SELECT avg_cost_e4 AS avg, cost_estimated AS estimated, stock_milli AS stock FROM materials WHERE id = ${id}`)[0]!;
const moves = (id: number) =>
  ctx.sql<{ type: string; delta: number; unit: number | null; cents: number | null }[]>`
    SELECT move_type AS type, qty_delta_milli AS delta, unit_cost_e4 AS unit, cost_cents AS cents FROM stock_moves WHERE material_id = ${id} ORDER BY id`;
async function receive(materialId: number, boxes: number, priceCents: number) {
  const po = await api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId, orderDate: today, approveNow: true, lines: [{ materialId, purchaseQtyMilli: q(boxes), priceCents }] });
  expect(po.status, JSON.stringify(po.body)).toBe(201);
  const p = po.body.po as { id: number; lines: { id: number }[] };
  return ok(doc(keeper, { docType: 'receipt', supplierId, purchaseOrderId: p.id, coAcceptorId: null, lines: [{ materialId, poLineId: p.lines[0]!.id, deliveredMilli: q(boxes * 10), acceptedMilli: q(boxes * 10) }] }));
}

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  await createStaff(ctx.sql, { username: 'cost-keeper', displayName: '仓库小林', role: 'backoffice', duties: ['stock'] as never, password: PASSWORD, mustChangePassword: false });
  keeper = await login(ctx.app, 'cost-keeper');
  const s = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'CS01', name: '成本测试供应商' });
  supplierId = s.body.find((x: { code: string }) => x.code === 'CS01').id;
}, 60_000);
afterAll(async () => {
  await ctx.close();
});

describe('算法（纯函数）', () => {
  it('移动加权平均：按金额进出重算；结存到 0 保持原成本；金额四舍五入到分', () => {
    // 20 个 @1.00 元，再进 10 个共 15.00 元 → (2000 + 1500) / 30 = 116.6667 分
    expect(movingAverageE4(q(20), 1_000_000, q(10), 1500)).toBe(1_166_667);
    // 作废那次收货：(24 × 116.6667 − 1500) / 14
    expect(movingAverageE4(q(24), 1_166_667, -q(10), 1500)).toBe(928_572);
    // 退完：保持原成本
    expect(movingAverageE4(q(10), 1_500_000, -q(10), 1500)).toBe(1_500_000);
    // 没有结存时进货：就是这次的进价；赠品（金额 0）拉低平均
    expect(movingAverageE4(0, 0, q(4), 1000)).toBe(2_500_000);
    expect(movingAverageE4(q(10), 2_000_000, q(10), 0)).toBe(1_000_000);
    // 大数不丢精度：100 万个 @ 9,999.99 元
    expect(movingAverageE4(q(1_000_000), 9_999_990_000, q(1), 999_999)).toBe(9_999_990_000);
    expect(moveCostCents(-q(6), 1_166_667)).toBe(-700);
    expect(moveCostCents(q(0.333), 1_000_000)).toBe(33);
    expect(moveCostCents(q(3), 0)).toBe(0);
    expect(refCostE4({ refPriceCents: 1000, purchaseFactorMilli: q(10) })).toBe(1_000_000);
    expect(refCostE4({ refPriceCents: null, purchaseFactorMilli: q(10) })).toBe(0);
  });
});

describe('随单据走', () => {
  it('期初按参考价起算（估的）→ 收货重算（不再是估的）→ 耗用按当时的平均成本、不改成本 → 作废收货按原金额冲回', async () => {
    const m = await material('C001', { refPriceCents: 1000 });
    expect(await cost(m.id)).toMatchObject({ avg: 0, estimated: true });
    await ok(doc(ctx.owner, { docType: 'opening', approveNow: true, lines: [{ materialId: m.id, qtyMilli: q(20) }] }));
    expect(await cost(m.id)).toMatchObject({ avg: 1_000_000, estimated: true, stock: q(20) });
    const receipt = await receive(m.id, 1, 1500);
    expect(receipt.status).toBe('confirmed');
    expect(await cost(m.id)).toMatchObject({ avg: 1_166_667, estimated: false, stock: q(30) });
    const used = await ok(doc(keeper, { docType: 'direct_use', note: '成本用例耗用', lines: [{ materialId: m.id, qtyMilli: q(6) }] }));
    expect(used.status).toBe('confirmed');
    expect(await cost(m.id)).toMatchObject({ avg: 1_166_667, stock: q(24) });
    expect((await moves(m.id)).map((x) => [x.type, Number(x.delta), Number(x.unit), Number(x.cents)])).toEqual([
      ['opening', q(20), 1_000_000, 2000],
      ['receipt', q(10), 1_500_000, 1500],
      ['direct_use', -q(6), 1_166_667, -700],
    ]);
    // 作废耗用：按现在的平均成本回来，成本不变
    const v1 = await api(ctx.app, ctx.owner, 'POST', `/api/inventory/docs/${used.id}/void`, { reason: '成本用例：作废耗用' });
    expect(v1.status, JSON.stringify(v1.body)).toBe(200);
    expect(await cost(m.id)).toMatchObject({ avg: 1_166_667, stock: q(30) });
    // 作废收货：按原来那 15.00 元冲回 → (30 × 116.6667 − 1500) / 20 = 100.00 分
    const v2 = await api(ctx.app, ctx.owner, 'POST', `/api/inventory/docs/${receipt.id}/void`, { reason: '成本用例：作废收货' });
    expect(v2.status, JSON.stringify(v2.body)).toBe(200);
    // 平均成本存的是取整后的数，冲回来可能差一个最小单位（万分之一分）
    const back = await cost(m.id);
    expect(Number(back.stock)).toBe(q(20));
    expect(Math.abs(Number(back.avg) - 1_000_000)).toBeLessThanOrEqual(1);
    const last = (await moves(m.id)).slice(-2).map((x) => [x.type, Number(x.delta), Number(x.cents)]);
    expect(last).toEqual([
      ['void', q(6), 700],
      ['void', -q(10), -1500],
    ]);
  });

  it('没有参考价、没收过货：成本是 0，流水金额记 0；第一次收货起算', async () => {
    const m = await material('C002');
    await ok(doc(ctx.owner, { docType: 'opening', approveNow: true, lines: [{ materialId: m.id, qtyMilli: q(5) }] }));
    expect(await cost(m.id)).toMatchObject({ avg: 0, estimated: true });
    await receive(m.id, 1, 2000);
    // 原来 5 个没有成本（按 0 算）+ 10 个 20.00 元 → 2000 / 15
    expect(await cost(m.id)).toMatchObject({ avg: 1_333_333, estimated: false });
  });

  it('仓与仓之间挪动（领料到部门小仓）不改成本；两边流水金额一正一负', async () => {
    const m = await material('C003', { refPriceCents: 3000 });
    await ok(doc(ctx.owner, { docType: 'opening', approveNow: true, lines: [{ materialId: m.id, qtyMilli: q(10) }] }));
    const [dept] = await ctx.sql<{ id: number }[]>`SELECT id FROM departments ORDER BY id LIMIT 1`;
    const issued = await ok(doc(keeper, { docType: 'issue', departmentId: dept!.id, handler: '部门同事', lines: [{ materialId: m.id, qtyMilli: q(4) }] }));
    expect(['confirmed', 'submitted']).toContain(issued.status);
    expect(await cost(m.id)).toMatchObject({ avg: 3_000_000 });
    const issue = (await moves(m.id)).filter((x) => x.type === 'issue').map((x) => [Number(x.delta), Number(x.cents)]);
    expect(issue).toEqual([
      [-q(4), -1200],
      [q(4), 1200],
    ]);
  });

  it('零元进货（赠送）以后成本真的是 0：不拿参考价顶；再进货从 0 起算（合并前 Codex 审查 b850838）', async () => {
    // 参考价 ¥10 / 箱 = ¥1 / 个
    const m = await material('C004', { refPriceCents: 1000 });
    await receive(m.id, 1, 0);
    expect(await cost(m.id)).toMatchObject({ avg: 0, estimated: false, stock: q(10) });
    // 耗用 2 个：按 0 记，不按参考价记成 ¥2
    await ok(doc(keeper, { docType: 'direct_use', note: '零成本用例耗用', lines: [{ materialId: m.id, qtyMilli: q(2) }] }));
    expect((await moves(m.id)).filter((x) => x.type === 'direct_use').map((x) => [Number(x.unit), Number(x.cents)])).toEqual([[0, 0]]);
    // 再进 10 个共 ¥10：8 个 @0 + 10 个 ¥10 → 1000 / 18（不是把那 8 个按参考价算成 ¥8）
    await receive(m.id, 1, 1000);
    expect((await cost(m.id)).avg).toBe(555_556);
    const report = await api(ctx.app, ctx.owner, 'GET', '/api/inventory/cost');
    expect(report.body.stock.rows.find((r: { materialId: number }) => r.materialId === m.id)).toMatchObject({ avgCostE4: 555_556, estimated: false });
  });

  it('台面日耗品领到部门：领料单下面那笔「耗用」流水算进耗用成本；作废领料冲回（合并前 Codex 审查 b850838）', async () => {
    const m = await material('C005', { refPriceCents: 2000, counterUse: true });
    await ok(doc(ctx.owner, { docType: 'opening', approveNow: true, lines: [{ materialId: m.id, qtyMilli: q(10) }] }));
    const [dept] = await ctx.sql<{ id: number; name: string }[]>`SELECT id, name FROM departments ORDER BY id DESC LIMIT 1`;
    const usageOf = async () => {
      const r = await api(ctx.app, ctx.owner, 'GET', '/api/inventory/cost');
      return (r.body.usage.rows as { warehouseName: string; label: string; costCents: number }[]).find((u) => u.warehouseName === dept!.name && u.label === '耗用')?.costCents ?? 0;
    };
    const before = await usageOf();
    const issued = await ok(doc(ctx.owner, { docType: 'issue', departmentId: dept!.id, handler: '部门同事', approveNow: true, lines: [{ materialId: m.id, qtyMilli: q(3) }] }));
    expect(issued.status).toBe('confirmed');
    expect((await moves(m.id)).map((x) => x.type)).toEqual(['opening', 'issue', 'issue', 'direct_use']);
    // 3 个 × ¥2
    expect((await usageOf()) - before).toBe(600);
    const voided = await api(ctx.app, ctx.owner, 'POST', `/api/inventory/docs/${issued.id}/void`, { reason: '领错了' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect((await usageOf()) - before).toBe(0);
  });

  it('盘点里记成「耗用」的盘亏算进耗用成本，别的盘点差异不算；店总（有「看成本」、没有「查看库存」）看得到报表（合并前 Codex 审查 35d8b16）', async () => {
    const m = await material('C006', { refPriceCents: 5000 });
    const other = await material('C007', { refPriceCents: 5000 });
    for (const x of [m, other]) await ok(doc(ctx.owner, { docType: 'opening', approveNow: true, lines: [{ materialId: x.id, qtyMilli: q(10) }] }));
    const row = async () => {
      const r = await api(ctx.app, ctx.owner, 'GET', '/api/inventory/cost');
      return (r.body.usage.rows as { warehouseName: string; label: string; costCents: number }[]).find((u) => u.warehouseName === '总仓' && u.label === '盘点记成耗用')?.costCents ?? 0;
    };
    const before = await row();
    const counted = await ok(
      doc(ctx.owner, {
        docType: 'count',
        approveNow: true,
        lines: [
          { materialId: m.id, countedMilli: q(8), expectedBookMilli: q(10), diffReason: 'consumed', diffNote: '日常用掉没登记' },
          { materialId: other.id, countedMilli: q(9), expectedBookMilli: q(10), diffReason: 'damaged', diffNote: '摔坏了一个没登记' },
        ],
      }),
    );
    expect(counted.status).toBe('confirmed');
    // 只算记成耗用的那 2 个 × ¥5
    expect((await row()) - before).toBe(1000);
    // 店总：没有「查看库存」，有「看成本」——接口给看，ERP「库存」模块对他可见（页面只有「成本」一个页签）
    await createStaff(ctx.sql, { username: 'cost-manager', displayName: '店总小郑', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
    const manager = await login(ctx.app, 'cost-manager');
    expect((await api(ctx.app, manager, 'GET', '/api/inventory/materials')).status).toBe(403);
    expect((await api(ctx.app, manager, 'GET', '/api/inventory/cost')).status).toBe(200);
    const me = (await api(ctx.app, manager, 'GET', '/api/auth/me')).body;
    expect(ERP_MODULES.inventory.perms.some((p) => me.permissions.includes(p))).toBe(true);
  });
});
