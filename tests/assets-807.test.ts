// 8.0.7 ERP P2 3.2 资产与易耗台账（docs/ERP_V807.md）：
//   · 手工建卡（一次几张）、同一编号重复提交只建一次；从收货单转资产建卡，不超过收货数量；
//   · 调拨、改状态、报废带版本号、留变动记录；报废后不能再改；卡片不能删；
//   · 扫码盘点：范围内没扫到的是盘亏，扫到不在范围里的、编号对不上的单列；结果只记录，不改卡片；
//   · 权限：仓库能维护，部门账号进不来。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let keeper: string; // 仓库
let deptId: number;

const q = (n: number) => Math.round(n * 1000);
async function ok<T = any>(res: Promise<{ status: number; body: any }>, status = 201): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const create = (body: Record<string, unknown>, key = randomUUID()) =>
  api(ctx.app, keeper, 'POST', '/api/erp/assets', { clientKey: key, name: '前台电脑', category: 'fixed', originalCents: 450_000, acquiredOn: today, ...body });

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  deptId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM departments WHERE active ORDER BY id LIMIT 1`)[0]!.id);
}, 60_000);
afterAll(async () => ctx.close());

describe('资产卡片', () => {
  it('手工建几张；同一编号只建一次；调拨、改状态、报废留记录；报废后不能改；不能删', async () => {
    const key = randomUUID();
    const r = await ok(create({ quantity: 2, departmentId: deptId, location: '前台', keeper: '小王' }, key));
    expect(r.cards).toHaveLength(2);
    expect(r.card.assetNo).toMatch(/^ZC\d{8}-\d{4}$/);
    // 打标签按编号直接取这几张（不从列表里筛：列表最多 1,000 张；Codex 审查 9ad0f56）
    const picked = (await api(ctx.app, keeper, 'GET', `/api/erp/assets?ids=${r.cards[1].id},${r.cards[0].id}`)).body as { id: number }[];
    expect(picked.map((c) => c.id).sort()).toEqual([r.cards[0].id, r.cards[1].id].sort());
    expect((await api(ctx.app, keeper, 'GET', '/api/erp/assets?ids=abc')).status).toBe(400);
    const again = await ok(create({ quantity: 2, departmentId: deptId, location: '前台', keeper: '小王' }, key), 200);
    expect(again.replayed).toBe(true);
    expect(again.cards.map((c: { id: number }) => c.id)).toEqual(r.cards.map((c: { id: number }) => c.id));
    expect((await create({ quantity: 1 }, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    const id = r.card.id as number;
    let a = (await api(ctx.app, keeper, 'GET', `/api/erp/assets/${id}`)).body;
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/assets/${id}/change`, { kind: 'status', status: 'repair', expectedVersion: a.version + 5 })).body.error.code).toBe('VERSION_CONFLICT');
    a = await ok(api(ctx.app, keeper, 'POST', `/api/erp/assets/${id}/change`, { kind: 'transfer', departmentId: null, location: '仓库', keeper: '', expectedVersion: a.version }), 200);
    expect(a).toMatchObject({ departmentId: null, location: '仓库' });
    a = await ok(api(ctx.app, keeper, 'POST', `/api/erp/assets/${id}/change`, { kind: 'status', status: 'idle', expectedVersion: a.version }), 200);
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/assets/${id}/change`, { kind: 'scrap', reason: '', expectedVersion: a.version })).status).toBe(400);
    a = await ok(api(ctx.app, keeper, 'POST', `/api/erp/assets/${id}/change`, { kind: 'scrap', reason: '主板坏了', expectedVersion: a.version }), 200);
    expect(a.status).toBe('scrapped');
    expect(a.changes.map((c: { kind: string }) => c.kind)).toEqual(['scrap', 'status', 'transfer', 'create']);
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/assets/${id}/change`, { kind: 'status', status: 'in_use', expectedVersion: a.version })).body.error.code).toBe('INVALID_STATE');
    await expect(ctx.sql`DELETE FROM asset_cards WHERE id = ${id}`).rejects.toThrow(/不能删除/);
    await expect(ctx.sql`UPDATE asset_cards SET original_cents = 1 WHERE id = ${r.cards[1].id}`).rejects.toThrow(/不能改/);
    // 没有资产权限的账号（店员）进不来
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/erp/assets')).status).toBe(403);
  });

  it('从收货单转资产建卡：一件一张，不超过收货数量', async () => {
    const m = await ok(api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', { code: 'AS-M1', name: '吸尘器', inventoryUnit: '台', purchaseUnit: '台', purchaseFactorMilli: q(1) }));
    const sup = (await ctx.sql<{ id: number }[]>`SELECT id FROM suppliers WHERE active ORDER BY id LIMIT 1`)[0]!.id;
    const po = await ok(api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId: sup, orderDate: today, approveNow: true, lines: [{ materialId: m.id, purchaseQtyMilli: q(3), priceCents: 899_00 }] }));
    const rc = await ok(
      api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
        clientKey: randomUUID(),
        docDate: today,
        docType: 'receipt',
        supplierId: sup,
        purchaseOrderId: po.po.id,
        lines: [{ materialId: m.id, poLineId: po.po.lines[0].id, deliveredMilli: q(3), acceptedMilli: q(3) }],
      }),
    );
    const lines = (await api(ctx.app, keeper, 'GET', `/api/erp/assets/receipt-lines?docNo=${rc.doc.docNo}`)).body;
    expect(lines).toEqual([expect.objectContaining({ materialName: '吸尘器', quantity: 3, carded: 0, unitCents: 899_00 })]);
    const lineId = lines[0].lineId as number;
    expect((await create({ name: '吸尘器', receiptLineId: lineId, quantity: 4 })).body.error.code).toBe('ASSET_OVER_RECEIPT');
    const made = await ok(create({ name: '吸尘器', receiptLineId: lineId, quantity: 2, category: 'consumable', originalCents: 899_00 }));
    expect(made.card.receipt).toMatchObject({ docNo: rc.doc.docNo, lineId });
    expect((await create({ name: '吸尘器', receiptLineId: lineId, quantity: 2 })).body.error.code).toBe('ASSET_OVER_RECEIPT');
    await ok(create({ name: '吸尘器', receiptLineId: lineId, quantity: 1 }));
    expect((await api(ctx.app, keeper, 'GET', `/api/erp/assets/receipt-lines?docNo=${rc.doc.docNo}`)).body[0].carded).toBe(3);
  });
});

describe('扫码盘点', () => {
  it('范围内没扫到的是盘亏；不在范围里的、对不上的单列；结束后不能再扫；结果不改卡片', async () => {
    const inScope = await ok(create({ name: '盘点用电脑', quantity: 2, departmentId: deptId }));
    const other = await ok(create({ name: '别的部门的', quantity: 1, departmentId: null }));
    const st = await ok(api(ctx.app, keeper, 'POST', '/api/erp/assets/stocktakes', { departmentId: deptId }));
    expect(st.expected).toBeGreaterThanOrEqual(2);
    const scan = (code: string) => ok(api(ctx.app, keeper, 'POST', `/api/erp/assets/stocktakes/${st.id}/scan`, { code }), 200);
    await scan(inScope.cards[0].assetNo);
    await scan(inScope.cards[0].assetNo.toLowerCase()); // 同一个码只记一次（不分大小写）
    await scan(other.card.assetNo);
    const s = await scan('ZC-NOT-EXIST');
    expect(s.scans).toHaveLength(3);
    expect(s.missing).toEqual([]); // 结束前不算盘亏
    const closed = await ok(api(ctx.app, keeper, 'POST', `/api/erp/assets/stocktakes/${st.id}/close`, {}), 200);
    expect(closed.status).toBe('closed');
    expect(closed.missing.map((x: { assetNo: string }) => x.assetNo)).toContain(inScope.cards[1].assetNo);
    expect(closed.missing.map((x: { assetNo: string }) => x.assetNo)).not.toContain(inScope.cards[0].assetNo);
    expect(closed.extra.map((x: { code: string }) => x.code).sort()).toEqual([other.card.assetNo, 'ZC-NOT-EXIST'].sort());
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/assets/stocktakes/${st.id}/scan`, { code: 'X' })).body.error.code).toBe('INVALID_STATE');
    // 卡片没被改
    expect((await api(ctx.app, keeper, 'GET', `/api/erp/assets/${inScope.cards[1].id}`)).body.status).toBe('in_use');

    // 结束时记下了结果：之后在这个部门建卡、把盘亏的那张报废，都不改写这次盘点（Codex 审查 d8b314b）
    await ok(create({ name: '盘点后新买的', quantity: 1, departmentId: deptId }));
    const lost = (await api(ctx.app, keeper, 'GET', `/api/erp/assets/${inScope.cards[1].id}`)).body;
    await ok(api(ctx.app, keeper, 'POST', `/api/erp/assets/${lost.id}/change`, { kind: 'scrap', reason: '盘点没找到，报损', expectedVersion: lost.version }), 200);
    const later = (await api(ctx.app, keeper, 'GET', `/api/erp/assets/stocktakes/${st.id}`)).body;
    expect(later).toMatchObject({ expected: closed.expected, found: closed.found });
    expect(later.missing.map((x: { assetNo: string }) => x.assetNo)).toEqual(closed.missing.map((x: { assetNo: string }) => x.assetNo));
    expect(later.extra).toEqual(closed.extra);
    // 结束了的盘点不能再改、盘点记录不能删
    await expect(ctx.sql`UPDATE asset_stocktakes SET note = '改一下' WHERE id = ${st.id}`).rejects.toThrow(/已经结束的盘点不能再改/);
    await expect(ctx.sql`DELETE FROM asset_stocktakes WHERE id = ${st.id}`).rejects.toThrow(/不能删除/);
  });
});
