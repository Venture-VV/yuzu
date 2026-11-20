// 8.1.17 BW-11 本店价改价留痕（docs/FRONTDESK_V8117.md 第 6 节）：第二家店改菜品的本店价也写进改价记录——
// 哪家店、改前改后（为空 = 同全公司）、那时的全公司价、谁、几点、原因；改价记录能按门店筛。权限照旧，另要原因。
// 不是菜品的项目照旧只记审计；改成一样的价什么都不做；带了打开时看到的价、别人刚改过的拒绝。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DishPriceChange } from '../src/shared/dishes';
import { storePriceChangeText } from '../src/shared/frontdesk-v8117';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
let ft = 0;
let ftDesk = '';
let dishId = 0;
let towelId = 0;
const put = (body: Record<string, unknown>, cookie = ftDesk) => api(ctx.app, cookie, 'PUT', '/api/admin/catalog/store-prices', body);
const changes = async (q = '') => {
  const r = await api<DishPriceChange[]>(ctx.app, ctx.owner, 'GET', `/api/dining/dishes/price-changes${q}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};

beforeAll(async () => {
  ctx = await setup();
  const entity = await api(ctx.app, ctx.owner, 'POST', '/api/admin/entities', { name: '南山主体' });
  ft = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'NS', name: '南山店', entityId: entity.body.id })).body.id;
  const created = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username: 'nsmgr', displayName: '南山店总', role: 'store_manager' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const temp = created.body.temporaryPassword as string;
  const first = await login(ctx.app, 'nsmgr', temp);
  expect((await api(ctx.app, first, 'POST', '/api/auth/change-password', { currentPassword: temp, newPassword: 'nsmgr-2026x' })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${created.body.staff?.id ?? created.body.id}/stores`, { storeIds: [ft] })).status).toBe(200);
  ftDesk = await login(ctx.app, 'nsmgr', 'nsmgr-2026x');
  // 一道菜（挂在出品档口上）、一样不是菜的
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '热菜' });
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '热菜').id;
  const d = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '本店价牛肉面', category: '面食', price: 3800 });
  dishId = d.body.items.find((i: { name: string }) => i.name === '本店价牛肉面').id;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: dishId, stationId }] })).status).toBe(200);
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '本店价毛巾', category: '零售', price: 1500 });
  towelId = t.body.items.find((i: { name: string }) => i.name === '本店价毛巾').id;
}, 90_000);
afterAll(async () => ctx.close());

describe('BW-11 本店价改价留痕', () => {
  it('要写原因；改了以后改价记录里有：哪家店、同全公司 → 新价、那时的全公司价、谁、原因、来源「本店价」', async () => {
    expect((await put({ itemId: dishId, tier: 'standard', price: 3500 })).status).toBe(400);
    expect((await put({ itemId: dishId, tier: 'standard', price: 3500, reason: '一' })).status).toBe(400);
    const r = await put({ itemId: dishId, tier: 'standard', price: 3500, expected: null, reason: '南山店开业促销' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ ok: true, changed: true });
    const [c] = (await changes(`?store=${ft}`)).filter((x) => x.itemId === dishId);
    expect(c).toMatchObject({
      itemName: '本店价牛肉面',
      tier: 'standard',
      oldPrice: null,
      newPrice: 3500,
      basePrice: 3800,
      reason: '南山店开业促销',
      source: 'store_price',
      staffName: '南山店总',
      storeId: ft,
      storeName: '南山店',
    });
    expect(storePriceChangeText({ ...c!, basePrice: c!.basePrice ?? null })).toBe('标准 同全公司（¥38.00） → ¥35.00');
    // 审计
    const [audit] = await ctx.sql<{ detail: Record<string, unknown> }[]>`SELECT detail FROM audit_logs WHERE action = 'store_price_changed' AND target_id = ${String(dishId)} ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail).toMatchObject({ before: null, after: 3500, basePrice: 3800, reason: '南山店开业促销', dish: true });
  });

  it('改成一样的价什么都不做（回复丢了再点一次不多记）；带了打开时看到的价、别人刚改过的拒绝', async () => {
    const before = (await changes(`?store=${ft}`)).length;
    const same = await put({ itemId: dishId, tier: 'standard', price: 3500, expected: null, reason: '南山店开业促销' });
    expect(same.status).toBe(200);
    expect(same.body).toEqual({ ok: true, changed: false });
    expect((await changes(`?store=${ft}`)).length).toBe(before);
    const stale = await put({ itemId: dishId, tier: 'standard', price: 3600, expected: null, reason: '再降一点' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STORE_PRICE_STALE');
  });

  it('两人同时改同一档：一个接一个，记录前后接得上（第二条的改前就是第一条的改后）', async () => {
    const [a, b] = await Promise.all([put({ itemId: dishId, tier: 'standard', price: 3300, reason: '同时改甲' }), put({ itemId: dishId, tier: 'standard', price: 3200, reason: '同时改乙' })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const mine = (await changes(`?store=${ft}`)).filter((x) => x.itemId === dishId).reverse();
    for (let i = 1; i < mine.length; i++) expect(mine[i]!.oldPrice, `第 ${i} 条`).toBe(mine[i - 1]!.newPrice);
  });

  it('回到全公司的价：记「改前 → 同全公司」；按门店筛：全公司的价目、这家店的本店价各看各的', async () => {
    const cur = (await changes(`?store=${ft}`)).find((x) => x.itemId === dishId)!.newPrice;
    expect((await put({ itemId: dishId, tier: 'standard', price: null, expected: cur, reason: '促销结束' })).status).toBe(200);
    const last = (await changes(`?store=${ft}`)).find((x) => x.itemId === dishId)!;
    expect(last).toMatchObject({ oldPrice: cur, newPrice: null, basePrice: 3800 });
    // 全公司改价（菜品管理）也有一条：按门店筛
    const hqChange = await api(ctx.app, ctx.owner, 'POST', `/api/dining/dishes/${dishId}/price`, {
      clientKey: randomUUID(),
      prices: { standard: 4000 },
      expected: { standard: 3800 },
      reason: '食材涨价',
    });
    expect(hqChange.status, JSON.stringify(hqChange.body)).toBe(200);
    const all = (await changes()).filter((x) => x.itemId === dishId);
    const hq = (await changes('?store=hq')).filter((x) => x.itemId === dishId);
    const ns = (await changes(`?store=${ft}`)).filter((x) => x.itemId === dishId);
    expect(hq.every((x) => x.storeId === null)).toBe(true);
    expect(ns.every((x) => x.storeId === ft)).toBe(true);
    expect(hq.length + ns.length).toBe(all.length);
    expect(hq.some((x) => x.reason === '食材涨价')).toBe(true);
    // 单道菜的记录也带着本店价的
    expect((await changes(`?itemId=${dishId}`)).length).toBe(all.length);
  });

  it('不是菜品的项目：本店价照改、照记审计，不进菜品的改价记录；本店里改本店价照旧拒绝', async () => {
    const r = await put({ itemId: towelId, tier: 'standard', price: 1200, reason: '南山店清仓' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await changes()).some((x) => x.itemId === towelId)).toBe(false);
    const [audit] = await ctx.sql<{ detail: Record<string, unknown> }[]>`SELECT detail FROM audit_logs WHERE action = 'store_price_changed' AND target_id = ${String(towelId)}`;
    expect(audit!.detail).toMatchObject({ after: 1200, dish: false, reason: '南山店清仓' });
    expect((await put({ itemId: dishId, tier: 'standard', price: 3000, reason: '本店改' }, ctx.owner)).status).toBe(400);
    // 记录只追加
    await expect(ctx.sql`UPDATE dish_price_changes SET reason = '改' WHERE store_id IS NOT NULL`).rejects.toThrow();
  });
});
