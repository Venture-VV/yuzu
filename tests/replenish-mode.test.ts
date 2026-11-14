// 补货方式（店主 2026-11-14，迁移 161，docs/ERP_PURCHASING.md 第 5.1 节，E9–E12）：
// 手机这类不是消耗品的东西，部门领走以后总仓不该一直出补货建议。
//   · 自动识别：只领过一次的看作一次性采购、不提；领用天数够「常用天数」的照常提；设了提醒的算常备；建过资产卡片的不提；
//   · 物料档案的补货方式：常备一直提，按需采购不提、也不做低库存提醒；
//   · 没提的列在 skipped 里（带原因），不进 groups、不算进 count；
//   · 只改补货方式的接口：权限、取值、审计；整份保存不带这一项时保持原样。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shiftDate } from '../src/shared/labels';
import { DEFAULT_PURCHASE_RULES, REPLENISH_LOOKBACK_DAYS, replenishSkipWhy } from '../src/shared/purchasing';
import { coverFor, todayIn } from '../src/server/modules/inventory/common';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let keeper: string; // 物资经办 lixiao
let buyer: string; // 采购经办 zhouyi（能维护档案）
let deptId: number;
let supplierId: number;
const q = (n: number) => Math.round(n * 1000);

async function ok<T = any>(res: Promise<{ status: number; body: any }>, status = 201): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

interface Line {
  materialId: number;
  reason: string;
  suggestedPurchaseMilli: number;
  [k: string]: unknown;
}
interface Skipped {
  materialId: number;
  why: string;
  mode: string;
  useDays: number;
  lastUsedOn: string | null;
  assetNo: string | null;
  assetCount: number;
  [k: string]: unknown;
}
interface Suggestions {
  count: number;
  regularUseDays: number;
  lookbackDays: number;
  groups: { lines: Line[] }[];
  skipped: Skipped[];
}
const suggest = async () => (await ok<Suggestions>(api(ctx.app, keeper, 'GET', '/api/purchase-suggestions'), 200));
const lineOf = (d: Suggestions, id: number) => d.groups.flatMap((g) => g.lines).find((l) => l.materialId === id) ?? null;
const skipOf = (d: Suggestions, id: number) => d.skipped.find((s) => s.materialId === id) ?? null;

const mkMaterial = (body: Record<string, unknown>) =>
  ok<{ id: number; replenishMode: string; isLow: boolean }>(
    api(ctx.app, buyer, 'POST', '/api/inventory/materials', { category: '测试', inventoryUnit: '台', purchaseUnit: '台', purchaseFactorMilli: q(1), refPriceCents: 300_00, ...body }),
  );
const getMaterial = (id: number) => ok<{ id: number; replenishMode: string; isLow: boolean; coverDays: number | null }>(api(ctx.app, keeper, 'GET', `/api/inventory/materials/${id}`), 200);
const putMode = (cookie: string, id: number, body: Record<string, unknown>) => api(ctx.app, cookie, 'PUT', `/api/inventory/materials/${id}/replenish-mode`, body);
/** 改补货方式：像页面一样带上现在看到的值 */
const setMode = async (cookie: string, id: number, mode: unknown) => {
  const [cur] = await ctx.sql<{ replenishMode: string }[]>`SELECT replenish_mode FROM materials WHERE id = ${id}`;
  return putMode(cookie, id, { mode, expected: cur?.replenishMode ?? 'auto' });
};

/** 采购入库 n 个（店主建单即确认，仓库收货），返回收货单 */
async function stockIn(materialId: number, n: number, date = today) {
  const po = await ok(
    api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      supplierId,
      orderDate: date,
      approveNow: true,
      lines: [{ materialId, purchaseQtyMilli: q(n), priceCents: 300_00 }],
    }),
  );
  return ok(
    api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docDate: date,
      docType: 'receipt',
      supplierId,
      purchaseOrderId: po.po.id,
      lines: [{ materialId, poLineId: po.po.lines[0].id, deliveredMilli: q(n), acceptedMilli: q(n) }],
    }),
  );
}
/** 部门领走 n 个 */
const issue = (materialId: number, n: number, date = today) =>
  ok(
    api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'issue',
      docDate: date,
      departmentId: deptId,
      handler: '行政部',
      lines: [{ materialId, qtyMilli: q(n) }],
    }),
  );

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  // 这里不测询价门槛：设成不要求，入库的采购单不用先询价
  await ok(api(ctx.app, ctx.owner, 'PUT', '/api/inventory/purchase-rules', { quoteThresholdCents: 0 }), 200);
  await api(ctx.app, ctx.owner, 'POST', '/api/inventory/departments', { name: '行政部' });
  deptId = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/departments?all=1')).body.find((d: { name: string }) => d.name === '行政部').id;
  supplierId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM suppliers WHERE active ORDER BY id LIMIT 1`)[0]!.id);
}, 120_000);
afterAll(async () => ctx.close());

describe('补货方式：识别规则（纯函数）', () => {
  const base = { replenishMode: 'auto' as const, coverDays: null, lowStockMilli: null, consumable: false, hasAsset: false, useDays: 1 };
  it('按需采购不提、常备一直提；自动识别依次看提醒、资产卡片、领用天数', () => {
    expect(DEFAULT_PURCHASE_RULES.regularUseDays).toBe(2);
    expect(REPLENISH_LOOKBACK_DAYS).toBe(90);
    // 档案里定了的：不看别的
    expect(replenishSkipWhy({ ...base, replenishMode: 'on_demand', coverDays: 7, useDays: 30 }, 2)).toBe('on_demand');
    expect(replenishSkipWhy({ ...base, replenishMode: 'stock', hasAsset: true, useDays: 0 }, 2)).toBeNull();
    // 自动识别：只领过一次 = 一次性采购；够常用天数的照常提
    expect(replenishSkipWhy(base, 2)).toBe('sporadic');
    expect(replenishSkipWhy({ ...base, useDays: 2 }, 2)).toBeNull();
    expect(replenishSkipWhy({ ...base, useDays: 2 }, 3)).toBe('sporadic');
    // 常用天数设 1 = 领过一次就算（同原来）
    expect(replenishSkipWhy(base, 1)).toBeNull();
    // 设了提醒天数或提醒数量 = 人说了要备货：只领过一次、建过资产卡片也照常提；提醒数量填 0 等于没设
    expect(replenishSkipWhy({ ...base, coverDays: 7 }, 2)).toBeNull();
    expect(replenishSkipWhy({ ...base, lowStockMilli: 5000, hasAsset: true }, 2)).toBeNull();
    expect(replenishSkipWhy({ ...base, lowStockMilli: 0 }, 2)).toBe('sporadic');
    // 档案里标明是消耗品的（台面日耗品、管效期、称重；8.0.20 起挂了用料的）算常备：头一次领用就提，建过资产卡片也照常
    expect(replenishSkipWhy({ ...base, consumable: true }, 2)).toBeNull();
    expect(replenishSkipWhy({ ...base, consumable: true, hasAsset: true }, 2)).toBeNull();
    expect(replenishSkipWhy({ ...base, consumable: true, replenishMode: 'on_demand' }, 2)).toBe('on_demand');
    // 建过资产卡片的不提，领得再勤也一样
    expect(replenishSkipWhy({ ...base, hasAsset: true, useDays: 30 }, 2)).toBe('asset');
  });

  it('低库存提醒：按需采购的不提醒，别的照旧', () => {
    expect(coverFor(0, 2800, 28, { coverDays: 5, lowStockMilli: null }).isLow).toBe(true);
    expect(coverFor(0, 2800, 28, { coverDays: 5, lowStockMilli: null, replenishMode: 'stock' }).isLow).toBe(true);
    expect(coverFor(0, 2800, 28, { coverDays: 5, lowStockMilli: null, replenishMode: 'on_demand' }).isLow).toBe(false);
    expect(coverFor(1000, 0, 28, { coverDays: null, lowStockMilli: 5000, replenishMode: 'on_demand' }).isLow).toBe(false);
    expect(coverFor(1000, 0, 28, { coverDays: null, lowStockMilli: 5000, replenishMode: 'auto' }).isLow).toBe(true);
  });
});

describe('补货建议按补货方式过滤', () => {
  it('手机：买 2 台、部门一次领走——自动识别成一次性采购，不提补货、列在「没提补货的」里；改成常备就提，定为按需采购不提', async () => {
    const phone = await mkMaterial({ code: 'BH-P1', name: '工作手机' });
    expect(phone.replenishMode).toBe('auto');
    await stockIn(phone.id, 2);
    await issue(phone.id, 2);

    // 原来：近 28 天有用量、结存 0 → 够用 0 天 → 建议再买。现在不提，原因写清楚
    let d = await suggest();
    expect(d).toMatchObject({ regularUseDays: 2, lookbackDays: 90 });
    expect(lineOf(d, phone.id)).toBeNull();
    expect(skipOf(d, phone.id)).toMatchObject({ why: 'sporadic', mode: 'auto', useDays: 1, lastUsedOn: today, stockMilli: 0, assetNo: null, assetCount: 0 });
    // 页签上的数量、按 groups 建草稿的（页面、自动补货）都只算真正建议的
    expect(d.count).toBe(d.groups.reduce((t, g) => t + g.lines.length, 0));
    expect(d.groups.flatMap((g) => g.lines).some((l) => l.materialId === phone.id)).toBe(false);

    // 设为常备：照原来的算法提（日均 2/28 台，补到 14 天 = 1 台）
    expect((await ok<{ replenishMode: string }>(setMode(buyer, phone.id, 'stock'), 200)).replenishMode).toBe('stock');
    d = await suggest();
    expect(lineOf(d, phone.id)).toMatchObject({ reason: 'cover', suggestedPurchaseMilli: q(1) });
    expect(skipOf(d, phone.id)).toBeNull();

    // 定为按需采购：不提，原因是档案里定的
    await ok(setMode(buyer, phone.id, 'on_demand'), 200);
    d = await suggest();
    expect(lineOf(d, phone.id)).toBeNull();
    expect(skipOf(d, phone.id)).toMatchObject({ why: 'on_demand', mode: 'on_demand' });

    // 改回自动识别：又是一次性采购
    await ok(setMode(buyer, phone.id, 'auto'), 200);
    expect(skipOf(await suggest(), phone.id)).toMatchObject({ why: 'sporadic', mode: 'auto' });

    // 常用天数设 1 = 领过一次就算（同原来）；改回 2
    await ok(api(ctx.app, ctx.owner, 'PUT', '/api/inventory/purchase-rules', { regularUseDays: 1 }), 200);
    d = await suggest();
    expect(d.regularUseDays).toBe(1);
    expect(lineOf(d, phone.id)).toMatchObject({ reason: 'cover' });
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/inventory/purchase-rules', { regularUseDays: 0 })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/inventory/purchase-rules', { regularUseDays: 11 })).status).toBe(400);
    await ok(api(ctx.app, ctx.owner, 'PUT', '/api/inventory/purchase-rules', { regularUseDays: 2 }), 200);
    expect(lineOf(await suggest(), phone.id)).toBeNull();
  });

  it('经常领用的耗材照常提：两天都有领用就算常用；90 天以前的那次不算', async () => {
    const soap = await mkMaterial({ code: 'BH-S1', name: '洗手液（补货方式）', inventoryUnit: '瓶', purchaseUnit: '瓶', refPriceCents: 1_500 });
    await stockIn(soap.id, 30, shiftDate(today, -100));
    // 100 天前领过一次、今天领一次：识别窗口（90 天）里只有 1 天 → 还看不出是不是常备（结存只剩 1 瓶，本来会提）
    await issue(soap.id, 5, shiftDate(today, -100));
    await issue(soap.id, 24);
    let d = await suggest();
    expect(lineOf(d, soap.id)).toBeNull();
    expect(skipOf(d, soap.id)).toMatchObject({ why: 'sporadic', useDays: 1, lastUsedOn: today, stockMilli: q(1) });
    // 上周又领过（同一天两张领料单只算一天）：窗口里 2 天有领用 → 常用，按用量提
    await stockIn(soap.id, 4, shiftDate(today, -7));
    await issue(soap.id, 2, shiftDate(today, -7));
    await issue(soap.id, 2, shiftDate(today, -7));
    d = await suggest();
    expect(skipOf(d, soap.id)).toBeNull();
    // 近 28 天用了 28 瓶（日均 1 瓶）、结存 1 瓶：够用 1 天 < 7 天 → 补到 14 天：14 − 1 = 13 瓶
    expect(lineOf(d, soap.id)).toMatchObject({ reason: 'cover', stockMilli: q(1), dailyUsageMilli: q(1), daysOfCover: 1, suggestedPurchaseMilli: q(13) });
  });

  it('设了提醒天数或提醒数量的算常备：只领过一次也照常提（人已经说了要备货）', async () => {
    const tissue = await mkMaterial({ code: 'BH-T1', name: '抽纸（补货方式）', inventoryUnit: '包', purchaseUnit: '包', refPriceCents: 500, coverDays: 5 });
    await stockIn(tissue.id, 30);
    await issue(tissue.id, 28);
    let d = await suggest();
    expect(lineOf(d, tissue.id)).toMatchObject({ reason: 'cover', triggerDays: 5 });
    expect(skipOf(d, tissue.id)).toBeNull();
    // 没有用量、设了提醒数量、结存不够：照常按提醒数量补；定为按需采购以后不提、也不再标低库存
    const cup = await mkMaterial({ code: 'BH-C1', name: '纸杯（补货方式）', inventoryUnit: '个', purchaseUnit: '个', refPriceCents: 10, lowStockMilli: q(50) });
    d = await suggest();
    expect(lineOf(d, cup.id)).toMatchObject({ reason: 'low_stock', suggestedPurchaseMilli: q(50) });
    expect((await getMaterial(cup.id)).isLow).toBe(true);
    const lowBefore = (await ok<{ lowCount: number }>(api(ctx.app, keeper, 'GET', '/api/inventory/overview'), 200)).lowCount;
    await ok(setMode(buyer, cup.id, 'on_demand'), 200);
    d = await suggest();
    expect(lineOf(d, cup.id)).toBeNull();
    expect(skipOf(d, cup.id)).toMatchObject({ why: 'on_demand' });
    expect((await getMaterial(cup.id)).isLow).toBe(false);
    expect((await ok<{ lowCount: number }>(api(ctx.app, keeper, 'GET', '/api/inventory/overview'), 200)).lowCount).toBe(lowBefore - 1);
    // 物料列表（不带时区的口径）也一样
    const listed = (await api(ctx.app, keeper, 'GET', '/api/inventory/materials')).body.find((m: { id: number }) => m.id === cup.id);
    expect(listed).toMatchObject({ replenishMode: 'on_demand', isLow: false });
  });

  it('档案里标明是消耗品的算常备：台面日耗品、管效期的、称重的头一次领用就提；什么都没标的同样情形不提', async () => {
    const mk = (code: string, name: string, extra: Record<string, unknown>) => mkMaterial({ code, name, inventoryUnit: '个', purchaseUnit: '个', refPriceCents: 100, ...extra });
    const plain = await mk('BH-X0', '挂钩（补货方式）', {});
    const counter = await mk('BH-X1', '一次性牙刷（补货方式）', { counterUse: true });
    const expiry = await mk('BH-X2', '消毒液（补货方式）', { expiryTracked: true, shelfLifeDays: 365 });
    const weighed = await mk('BH-X3', '柠檬（补货方式）', { weighed: true, decimals: 2, inventoryUnit: '斤', purchaseUnit: '斤' });
    for (const m of [plain, counter, weighed]) await stockIn(m.id, 10);
    // 管效期的收货要填到期日
    const po = await ok(api(ctx.app, ctx.owner, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId, orderDate: today, approveNow: true, lines: [{ materialId: expiry.id, purchaseQtyMilli: q(10), priceCents: 100 }] }));
    await ok(
      api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
        clientKey: randomUUID(), docDate: today, docType: 'receipt', supplierId, purchaseOrderId: po.po.id,
        lines: [{ materialId: expiry.id, poLineId: po.po.lines[0].id, deliveredMilli: q(10), acceptedMilli: q(10), expiresOn: shiftDate(today, 300) }],
      }),
    );
    for (const m of [plain, counter, expiry, weighed]) await issue(m.id, 10);
    const d = await suggest();
    // 都只领过这一次、结存 0：标了消耗品的三样照常提，什么都没标的看作一次性采购
    for (const m of [counter, expiry, weighed]) {
      expect(lineOf(d, m.id), String(m.id)).toMatchObject({ reason: 'cover' });
      expect(skipOf(d, m.id)).toBeNull();
    }
    expect(lineOf(d, plain.id)).toBeNull();
    expect(skipOf(d, plain.id)).toMatchObject({ why: 'sporadic', useDays: 1 });
    // 标了消耗品的也可以定为按需采购：档案里定的优先
    await ok(setMode(buyer, counter.id, 'on_demand'), 200);
    expect(skipOf(await suggest(), counter.id)).toMatchObject({ why: 'on_demand' });
  });

  it('建过资产卡片的不提补货（领得再勤也一样）；设为常备以后照常提', async () => {
    const dryer = await mkMaterial({ code: 'BH-D1', name: '吹风机（补货方式）' });
    const rc = await stockIn(dryer.id, 6, shiftDate(today, -3));
    await issue(dryer.id, 3, shiftDate(today, -3));
    await issue(dryer.id, 3);
    // 两天都有领用：按领用次数是常用的，会提
    expect(lineOf(await suggest(), dryer.id)).toMatchObject({ reason: 'cover' });
    // 从收货单转资产建卡 2 张
    const lines = (await api(ctx.app, keeper, 'GET', `/api/erp/assets/receipt-lines?docNo=${rc.doc.docNo}`)).body;
    const made = await ok(
      api(ctx.app, keeper, 'POST', '/api/erp/assets', { clientKey: randomUUID(), name: '吹风机', category: 'consumable', originalCents: 300_00, acquiredOn: today, receiptLineId: lines[0].lineId, quantity: 2 }),
    );
    let d = await suggest();
    expect(lineOf(d, dryer.id)).toBeNull();
    const s = skipOf(d, dryer.id)!;
    expect(s).toMatchObject({ why: 'asset', mode: 'auto', assetCount: 2, useDays: 2 });
    expect(made.cards.map((c: { assetNo: string }) => c.assetNo)).toContain(s.assetNo);
    // 仓库要常备几台：设为常备
    await ok(setMode(buyer, dryer.id, 'stock'), 200);
    d = await suggest();
    expect(lineOf(d, dryer.id)).toMatchObject({ reason: 'cover' });
    expect(skipOf(d, dryer.id)).toBeNull();
  });
});

describe('物料档案的补货方式', () => {
  it('新建默认自动识别、可以直接定；整份保存不带这一项时保持原样；取值不对的拒绝', async () => {
    const body = { code: 'BH-M1', name: '对讲机', category: '测试', inventoryUnit: '台', purchaseUnit: '台', purchaseFactorMilli: q(1) };
    const m = await ok<{ id: number; replenishMode: string }>(api(ctx.app, buyer, 'POST', '/api/inventory/materials', { ...body, replenishMode: 'on_demand' }));
    expect(m.replenishMode).toBe('on_demand');
    // 旧页面、导入不带这一项：不动
    expect((await ok<{ replenishMode: string }>(api(ctx.app, buyer, 'PUT', `/api/inventory/materials/${m.id}`, { ...body, note: '行政部用' }), 200)).replenishMode).toBe('on_demand');
    // 带了就按带的
    expect((await ok<{ replenishMode: string }>(api(ctx.app, buyer, 'PUT', `/api/inventory/materials/${m.id}`, { ...body, replenishMode: 'stock' }), 200)).replenishMode).toBe('stock');
    expect((await api(ctx.app, buyer, 'PUT', `/api/inventory/materials/${m.id}`, { ...body, replenishMode: 'never' })).status).toBe(400);
    await expect(ctx.sql`UPDATE materials SET replenish_mode = 'never' WHERE id = ${m.id}`).rejects.toThrow(/replenish_mode/);
  });

  it('只改补货方式的接口：要「维护档案」权限；取值不对 400、物料不存在 404；改了记审计，设成同一个值不重复记', async () => {
    const m = await mkMaterial({ code: 'BH-M2', name: '打印机' });
    expect((await setMode(ctx.clerk, m.id, 'on_demand')).status).toBe(403);
    // 物资经办没有维护档案的权限
    expect((await setMode(keeper, m.id, 'on_demand')).status).toBe(403);
    expect((await setMode(buyer, m.id, 'never')).status).toBe(400);
    expect((await setMode(buyer, m.id, undefined)).status).toBe(400);
    // 要带上页面看到的值
    expect((await putMode(buyer, m.id, { mode: 'on_demand' })).status).toBe(400);
    expect((await putMode(buyer, 99_999_999, { mode: 'on_demand', expected: 'auto' })).status).toBe(404);
    const audits = async () =>
      (await ctx.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit_logs WHERE action = 'inventory_master_saved' AND target_type = 'material' AND target_id = ${String(m.id)} AND detail ? 'before' ORDER BY id`).map((r) => r.detail);
    expect((await ok<{ replenishMode: string }>(setMode(buyer, m.id, 'on_demand'), 200)).replenishMode).toBe('on_demand');
    expect((await ok<{ replenishMode: string }>(setMode(buyer, m.id, 'on_demand'), 200)).replenishMode).toBe('on_demand');
    expect(await audits()).toEqual([{ replenishMode: 'on_demand', before: 'auto' }]);
    await ok(setMode(buyer, m.id, 'auto'), 200);
    expect(await audits()).toEqual([{ replenishMode: 'on_demand', before: 'auto' }, { replenishMode: 'auto', before: 'on_demand' }]);
  });

  it('带上页面看到的值，对不上拒绝：晚到的旧请求不会盖掉后来的修改；已经是要改成的值照常返回（原样重提）；等锁有时限', async () => {
    const m = await mkMaterial({ code: 'BH-M3', name: '投影仪' });
    // 页面甲看到「自动识别」，要定为按需采购——这次请求没等到回音（当它还在路上）
    const late = { mode: 'on_demand', expected: 'auto' };
    // 这期间页面刷新过，又改成了常备
    await ok(putMode(buyer, m.id, { mode: 'stock', expected: 'auto' }), 200);
    // 旧请求这时才到：看到的是自动识别、现在是常备，对不上 → 拒绝，常备没被盖掉
    const res = await putMode(buyer, m.id, late);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'REPLENISH_MODE_CHANGED', details: { current: 'stock' } });
    expect((await getMaterial(m.id)).replenishMode).toBe('stock');
    // 原样重提：已经是要改成的值，照常返回、不报错（哪怕带的是旧的「看到的值」）
    expect((await ok<{ replenishMode: string }>(putMode(buyer, m.id, { mode: 'stock', expected: 'auto' }), 200)).replenishMode).toBe('stock');
    // 物料行被别的事务锁着（收发货在记账）：等不到锁就失败、明确没有生效，不会拖到页面超时以后才生效
    const holder = await ctx.sql.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM materials WHERE id = ${m.id} FOR UPDATE`;
      const started = Date.now();
      const busy = await putMode(buyer, m.id, { mode: 'auto', expected: 'stock' });
      expect(busy.status).toBe(409);
      expect(busy.body.error.code).toBe('BUSY');
      expect(Date.now() - started).toBeLessThan(9_000);
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect((await getMaterial(m.id)).replenishMode).toBe('stock');
  }, 30_000);
});
