// 8.0.20 自动补货（docs/ERP_V8020.md 第 3 节，JX-D / JX5 / JX10）：每天过了设定的时间，把补货建议按供应商各建一张采购单草稿。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAutoReplenish } from '../src/server/modules/inventory/auto-replenish';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
const q = (n: number) => Math.round(n * 1000);
const supplier: Record<string, number> = {};
const mat: Record<string, number> = {};
/** 门店时区（Asia/Shanghai）今天的某个钟点 */
const at = (hhmm: string) => new Date(`${today}T${hhmm}:00+08:00`);
const drafts = () =>
  ctx.sql<{ id: number; status: string; supplierId: number; note: string; lines: number; operator: string }[]>`
    SELECT p.id, p.status, p.supplier_id, p.note, (SELECT count(*)::int FROM purchase_order_lines l WHERE l.po_id = p.id) AS lines, st.username AS operator
    FROM purchase_orders p JOIN staff st ON st.id = p.created_by ORDER BY p.id`;
const rules = (body: Record<string, unknown>, cookie = ctx.owner) => api(ctx.app, cookie, 'PUT', '/api/purchase-suggestions/auto/rules', body);

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  for (const [code, name] of [
    ['AR-S1', '自动补货供应商甲'],
    ['AR-S2', '自动补货供应商乙'],
  ] as const) {
    const s = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code, name });
    supplier[code] = s.body.find((x: { code: string }) => x.code === code).id;
  }
  // 三样低于提醒数量的物料：两样有默认供应商（一家各一样），一样没有供应商；一样库存够的
  for (const [code, sup, low, stock] of [
    ['AR-M1', 'AR-S1', 10, 2],
    ['AR-M2', 'AR-S2', 10, 0],
    ['AR-M3', null, 10, 1],
    ['AR-M4', 'AR-S1', 10, 50],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', {
      code, name: `自动补货物料${code}`, inventoryUnit: '个', purchaseUnit: '箱', purchaseFactorMilli: q(10), refPriceCents: 3000,
      lowStockMilli: q(low), defaultSupplierId: sup ? supplier[sup] : null,
    });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    mat[code] = r.body.id;
    if (stock > 0) {
      const o = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docDate: today, docType: 'opening', approveNow: true, lines: [{ materialId: r.body.id, qtyMilli: q(stock) }] });
      expect(o.status, JSON.stringify(o.body)).toBe(201);
    }
  }
}, 60_000);
afterAll(async () => ctx.close());

describe('自动补货', () => {
  it('关着不跑；开着、没到时间不跑；到了时间按供应商各建一张草稿（系统经办、不提交），没有供应商的只记个数；当天再跑什么都不做', async () => {
    // 用例的基线里关着
    expect(await runAutoReplenish(ctx, at('09:00'))).toBeNull();
    expect((await rules({ enabled: true }, ctx.clerk)).status).toBe(403);
    expect((await rules({ time: '5点半' })).status).toBe(400);
    expect((await rules({ enabled: true, time: '05:30' })).status).toBe(200);
    expect(await runAutoReplenish(ctx, at('05:29'))).toBeNull();
    expect(await drafts()).toEqual([]);
    const run = await runAutoReplenish(ctx, at('05:30'));
    expect(run).toMatchObject({ date: today, status: 'done', lineCount: 2, skippedNoSupplier: 1, error: null });
    expect(run!.poIds).toHaveLength(2);
    const made = await drafts();
    expect(made.map((d) => [d.status, Number(d.supplierId), d.lines, d.operator]).sort()).toEqual(
      [
        ['draft', supplier['AR-S1'], 1, 'system.stock'],
        ['draft', supplier['AR-S2'], 1, 'system.stock'],
      ].sort(),
    );
    expect(made.every((d) => d.note.startsWith('自动补货'))).toBe(true);
    // 当天再到点：不再跑
    expect(await runAutoReplenish(ctx, at('05:31'))).toBeNull();
    expect(await runAutoReplenish(ctx, at('23:00'))).toBeNull();
    expect(await drafts()).toHaveLength(2);
    // 草稿算在途：建议里只剩没有供应商的那一样
    const left = (await api(ctx.app, ctx.owner, 'GET', '/api/purchase-suggestions')).body as { count: number; groups: { supplier: unknown; lines: { materialId: number }[] }[] };
    expect(left.groups.flatMap((g) => g.lines.map((l) => l.materialId))).toEqual([mat['AR-M3']]);
    // 页面读得到今天的结果
    const info = (await api(ctx.app, ctx.owner, 'GET', '/api/purchase-suggestions/auto')).body;
    expect(info.rules).toEqual({ enabled: true, time: '05:30' });
    expect(info.runs[0]).toMatchObject({ date: today, status: 'done', poNos: [expect.any(String), expect.any(String)] });
  });

  it('「现在跑一次」：今天跑过也再跑，已经建过的草稿不重复建，只补新出现的建议', async () => {
    // 给没有供应商的那一样补上供应商
    const m = (await api(ctx.app, ctx.owner, 'GET', `/api/inventory/materials/${mat['AR-M3']}`)).body;
    await ctx.sql`UPDATE materials SET default_supplier_id = ${supplier['AR-S2']!} WHERE id = ${m.id}`;
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/purchase-suggestions/auto/run')).status).toBe(403);
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/purchase-suggestions/auto/run');
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    // 原来两张草稿还在（算在途，不重复建）；新出现的那一样另开一张给供应商乙的草稿
    expect(again.body).toMatchObject({ status: 'done', lineCount: 3, skippedNoSupplier: 0 });
    const made = await drafts();
    expect(made).toHaveLength(3);
    expect(made.filter((d) => Number(d.supplierId) === supplier['AR-S2']).map((d) => d.lines)).toEqual([1, 1]);
    // 再点一次：没有新的建议了，不再建
    const third = await api(ctx.app, ctx.owner, 'POST', '/api/purchase-suggestions/auto/run');
    expect(third.body).toMatchObject({ status: 'done', lineCount: 3 });
    expect(await drafts()).toHaveLength(3);
  });

  it('自动建的草稿：能编制采购单的采购可以撤掉；别人编的照旧只能本人或负责人撤（合并前 Codex 审查 35d8b16）', async () => {
    await createStaff(ctx.sql, { username: 'ar-buyer', displayName: '采购小孙', role: 'backoffice', duties: ['purchase'] as never, password: PASSWORD, mustChangePassword: false });
    const buyer = await login(ctx.app, 'ar-buyer');
    const auto = (await drafts()).find((d) => d.operator === 'system.stock' && d.status === 'draft')!;
    const seen = await api(ctx.app, buyer, 'GET', `/api/purchase-orders/${auto.id}`);
    expect(seen.body).toMatchObject({ status: 'draft', createdBySystem: true, withdrawable: true });
    const gone = await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${auto.id}/cancel`, { reason: '这次不买' });
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(gone.body.status).toBe('cancelled');
    // 店主自己编的草稿：采购撤不了
    const own = await api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(), supplierId: supplier['AR-S1'], orderDate: today, action: 'save', lines: [{ materialId: mat['AR-M4'], purchaseQtyMilli: q(1), priceCents: 3000 }],
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.po).toMatchObject({ status: 'draft', createdBySystem: false });
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${own.body.po.id}/cancel`, { reason: '想撤别人的' })).status).toBe(403);
  });
});
