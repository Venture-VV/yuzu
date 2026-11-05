// v0.7.30：询价接上需求单与补货建议（v0.7.29 的已知问题，docs/HANDOFF_V0729.md 第 6 节）。
//   · 需求单下成的采购单合计到询价门槛提交被拒（原来的问题），改为询价：询价单带上需求行，定标转采购单时一起带到采购单行上；
//   · 需求行在没撤销的询价单里时显示「询价中」、不在待转采购单里，不能直接转采购单、也不能再进第二张询价单；
//   · 采购单撤回后回到询价中、可以再转；询价单撤销后回到待转采购单；
//   · 补货建议：询价中的数量算在途；自检报出一行需求同时在两张没撤销的询价单里。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { sourcingChecks } from '../src/server/modules/inventory/sourcing';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let boss: string; // 演示店主
let keeper: string; // 物资经办（没有审核需求单的权限）
let buyer: string; // 采购经办（审核需求单、转采购单、询价）
let reqA: string; // 客房部申购
let reqB: string; // 水吧申购
let s1: { id: number };
let s2: { id: number };
let mat: { id: number; name: string };
let other: { id: number; name: string };
const q = (n: number) => Math.round(n * 1000);

const supplier = async (code: string) => (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/suppliers?all=1')).body.find((s: { code: string }) => s.code === code);
const material = async (code: string) => (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/materials?all=1')).body.find((m: { code: string }) => m.code === code);
const sourcing = (body: Record<string, unknown>, cookie = buyer) => api(ctx.app, cookie, 'POST', '/api/purchase-sourcing', { clientKey: randomUUID(), ...body });
const quote = (eventId: number, body: Record<string, unknown>) =>
  api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${eventId}/quotes`, { clientKey: randomUUID(), payTerms: '月结 30 天', ...body });
const requestLine = (over: Record<string, unknown>) => ({ purpose: '客用消耗', unit: '箱', link: '', details: '', imageIds: [], ...over });
// 新产品要带图片：最小的「JPEG」（服务端只核对文件头与大小）
const jpeg = (seed: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`yuzu-${seed}`)]).toString('base64');
const upload = async (cookie: string, seed: string) => (await api(ctx.app, cookie, 'POST', '/api/erp/images', { mime: 'image/jpeg', data: jpeg(seed) })).body as { id: number };
/** 提一张需求单并由采购审核通过，返回需求单 */
async function approvedRequest(cookie: string, lines: Record<string, unknown>[]) {
  const created = await api(ctx.app, cookie, 'POST', '/api/erp/requests', { clientKey: randomUUID(), lines: lines.map(requestLine) });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const approved = await api(ctx.app, buyer, 'POST', `/api/erp/requests/${created.body.request.id}/approve`, {});
  expect(approved.body.status).toBe('approved');
  return approved.body as { id: number; docNo: string; lines: { id: number }[] };
}
const progressOf = async (requestId: number, cookie = buyer) =>
  ((await api(ctx.app, cookie, 'GET', `/api/erp/requests/${requestId}`)).body.lines as { progress: { state: string; sourcing: { docNo: string } | null; po: { docNo: string } | null } }[]).map((l) => l.progress);
const openIds = async () => ((await api(ctx.app, buyer, 'GET', '/api/erp/requests/open-lines')).body as { id: number }[]).map((l) => l.id);

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  const dept = async (name: string) => {
    await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name });
    return ((await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[]).find((d) => d.name === name)!.id;
  };
  const rooms = await dept('客房部');
  const bar = await dept('水吧');
  await createStaff(ctx.sql, { username: 'req_rooms', displayName: '客房申购', role: 'backoffice', duties: ['request'], departmentId: rooms, password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'req_bar', displayName: '水吧申购', role: 'backoffice', duties: ['request'], departmentId: bar, password: PASSWORD, mustChangePassword: false });
  reqA = await login(ctx.app, 'req_rooms');
  reqB = await login(ctx.app, 'req_bar');
  s1 = await supplier('S001');
  s2 = await supplier('S002');
  mat = await material('M016');
  other = await material('M001');
  expect(mat && other).toBeTruthy();
}, 120_000);
afterAll(async () => ctx.close());

describe('询价接上需求单（v0.7.29 的已知问题）', () => {
  it('需求单 → 改为询价（带需求行）→ 定标 → 转采购单带上需求行 → 过门槛提交；需求单显示询价中、已下单；采购单撤回后可以再转', async () => {
    // 两个部门都要护理床单：合计 20 箱（每箱 ¥450，¥9,000 到了询价门槛 ¥5,000）
    const ra = await approvedRequest(reqA, [{ materialId: mat.id, name: mat.name, qtyMilli: q(12) }]);
    const rb = await approvedRequest(reqB, [{ materialId: mat.id, name: mat.name, qtyMilli: q(8) }]);
    const [la, lb] = [ra.lines[0]!.id, rb.lines[0]!.id];

    // 原来的问题：从需求单直接转采购单，提交被询价门槛拦下（整笔回滚，什么都不留）
    const direct = await api(ctx.app, buyer, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      supplierId: s1.id,
      orderDate: today,
      action: 'submit',
      lines: [{ materialId: mat.id, purchaseQtyMilli: q(20), priceCents: 45_000, requestLineIds: [la, lb] }],
    });
    expect(direct.body.error.code).toBe('QUOTES_REQUIRED');
    expect(await openIds()).toEqual(expect.arrayContaining([la, lb]));

    // 改为询价：询价单的一行并了两行需求
    const made = await sourcing({ title: '护理床单 20 箱', needBy: today, lines: [{ materialId: mat.id, purchaseQtyMilli: q(20), requestLineIds: [la, lb] }] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const ev = made.body.event;
    expect(ev.lines[0].requests.map((r: { lineId: number; requestNo: string; departmentName: string }) => [r.lineId, r.requestNo, r.departmentName]).sort()).toEqual(
      [
        [la, ra.docNo, '客房部'],
        [lb, rb.docNo, '水吧'],
      ].sort(),
    );
    // 需求单：询价中（带询价单号）；部门申购自己也看得到；不在待转采购单里
    expect(await progressOf(ra.id, reqA)).toEqual([expect.objectContaining({ state: 'sourcing', sourcing: { id: ev.id, docNo: ev.docNo }, po: null })]);
    expect(await openIds()).not.toEqual(expect.arrayContaining([la]));
    expect((await openIds()).includes(lb)).toBe(false);
    // 在询价单里的需求行：不能直接转采购单，也不能再进第二张询价单
    const sneak = await api(ctx.app, buyer, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      supplierId: s1.id,
      orderDate: today,
      action: 'save',
      lines: [{ materialId: mat.id, purchaseQtyMilli: q(12), priceCents: 45_000, requestLineIds: [la] }],
    });
    expect(sneak.body.error).toMatchObject({ code: 'REQUEST_LINE_IN_SOURCING', details: { docNo: ev.docNo } });
    expect((await sourcing({ title: '再询一次', lines: [{ materialId: mat.id, purchaseQtyMilli: q(12), requestLineIds: [la] }] })).body.error.code).toBe('REQUEST_LINE_IN_SOURCING');

    // 两家报价、定标、转采购单：采购单行带着两行需求
    const lineId = ev.lines[0].id;
    expect((await quote(ev.id, { supplierId: s1.id, prices: [{ lineId, priceCents: 45_000 }] })).status).toBe(200);
    expect((await quote(ev.id, { supplierId: s2.id, prices: [{ lineId, priceCents: 46_000 }] })).status).toBe(200);
    const awarded = (await api(ctx.app, buyer, 'GET', `/api/purchase-sourcing/${ev.id}`)).body;
    const winner = awarded.quotes.find((x: { supplier: { id: number } }) => x.supplier.id === s1.id);
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ev.id}/award`, { quoteId: winner.id, reason: '单价最低' })).body.status).toBe('awarded');
    const ordered = await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ev.id}/order`, { clientKey: randomUUID() });
    expect(ordered.status, JSON.stringify(ordered.body)).toBe(201);
    const po = ordered.body.po;
    expect(po.lines[0].requests.map((r: { lineId: number }) => r.lineId).sort()).toEqual([la, lb].sort());
    // 过门槛提交（超过免确认门槛，等负责人确认）
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/submit`, {})).body.status).toBe('submitted');
    // 需求单：已下单，采购单号看得到
    expect(await progressOf(ra.id)).toEqual([expect.objectContaining({ state: 'ordered', po: expect.objectContaining({ docNo: po.docNo }), sourcing: { id: ev.id, docNo: ev.docNo } })]);
    expect(await progressOf(rb.id)).toEqual([expect.objectContaining({ state: 'ordered', po: expect.objectContaining({ docNo: po.docNo }) })]);

    // 采购单撤回：需求行回到询价中（询价单还是已定标），可以从询价单再转一次
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/cancel`, { reason: '数量改一下' })).body.status).toBe('cancelled');
    expect(await progressOf(ra.id)).toEqual([expect.objectContaining({ state: 'sourcing', po: null })]);
    const again = await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ev.id}/order`, { clientKey: randomUUID() });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.po.lines[0].requests).toHaveLength(2);
    expect((await sourcingChecks(ctx.sql))[0]).toMatchObject({ key: 'sourcing_links', ok: true });
  });

  it('拒绝：没有审核需求单权限、需求单没通过、物料不一致、同一行需求重复；撤销询价单后需求行回到待转采购单', async () => {
    const img = await upload(reqA, 'slipper');
    const r = await approvedRequest(reqA, [
      { materialId: mat.id, name: mat.name, qtyMilli: q(2) },
      { materialId: null, name: '新款拖鞋', qtyMilli: q(30), unit: '双', link: 'https://example.com/slipper', details: '一次性', imageIds: [img.id] },
    ]);
    const [lm, ln] = [r.lines[0]!.id, r.lines[1]!.id];
    // 物资经办能建询价单（采购权限）但不能带需求单
    const keeperTry = await sourcing({ title: '床单', lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), requestLineIds: [lm] }] }, keeper);
    expect([403]).toContain(keeperTry.status);
    // 物料不一致；同一行需求重复
    expect((await sourcing({ title: '床单', lines: [{ materialId: other.id, purchaseQtyMilli: q(2), requestLineIds: [lm] }] })).body.error.code).toBe('REQUEST_MATERIAL_MISMATCH');
    expect(
      (await sourcing({ title: '床单', lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), requestLineIds: [lm] }, { materialId: other.id, purchaseQtyMilli: q(1), requestLineIds: [lm] }] })).status,
    ).toBe(400);
    // 没通过的需求单
    const pending = await api(ctx.app, reqA, 'POST', '/api/erp/requests', { clientKey: randomUUID(), lines: [requestLine({ materialId: mat.id, name: mat.name, qtyMilli: q(1) })] });
    const pendingLine = pending.body.request.lines[0].id;
    expect((await sourcing({ title: '床单', lines: [{ materialId: mat.id, purchaseQtyMilli: q(1), requestLineIds: [pendingLine] }] })).body.error.code).toBe('REQUEST_NOT_APPROVED');

    // 新产品选了物料就能带（需求行没选物料的不核对物料）
    const ok = await sourcing({ title: '床单与拖鞋', lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), requestLineIds: [lm] }, { materialId: other.id, purchaseQtyMilli: q(1), requestLineIds: [ln] }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await progressOf(r.id)).toEqual([expect.objectContaining({ state: 'sourcing' }), expect.objectContaining({ state: 'sourcing' })]);
    // 撤销询价单：需求行回到未下单、重新出现在待转采购单里
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ok.body.event.id}/cancel`, { reason: '先不买了' })).body.status).toBe('cancelled');
    expect(await progressOf(r.id)).toEqual([expect.objectContaining({ state: 'none', sourcing: null }), expect.objectContaining({ state: 'none', sourcing: null })]);
    expect(await openIds()).toEqual(expect.arrayContaining([lm, ln]));
    // 同一编号重提：返回原询价单（不会因为需求行已经被它占着而拒绝）
    const key = randomUUID();
    const body = { clientKey: key, title: '床单', lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), requestLineIds: [lm] }] };
    const first = await api(ctx.app, buyer, 'POST', '/api/purchase-sourcing', body);
    expect(first.status).toBe(201);
    const replay = await api(ctx.app, buyer, 'POST', '/api/purchase-sourcing', body);
    expect(replay.status).toBe(200);
    expect(replay.body.event.id).toBe(first.body.event.id);
  });

  it('补货建议：询价中、已定标没转出的询价单算在途；转出采购单以后按采购单算；自检报出一行需求在两张询价单里', async () => {
    const res = await api(ctx.app, buyer, 'POST', '/api/inventory/materials', {
      code: 'SQ01', name: '洗衣液（询价）', category: '测试', inventoryUnit: '桶', purchaseUnit: '箱', purchaseFactorMilli: q(4), refPriceCents: 20_000, defaultSupplierId: s1.id, lowStockMilli: q(8),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const x = await material('SQ01');
    const lineOf = async () => {
      const d = (await api(ctx.app, keeper, 'GET', '/api/purchase-suggestions')).body as { groups: { lines: { materialId: number; inTransitMilli: number; openPos: string[]; suggestedPurchaseMilli: number }[] }[] };
      return d.groups.flatMap((g) => g.lines).find((l) => l.materialId === x.id) ?? null;
    };
    expect(await lineOf()).toMatchObject({ inTransitMilli: 0, suggestedPurchaseMilli: q(2) });
    // 从补货建议发起询价 1 箱：算在途，只差 1 箱
    const ev = (await sourcing({ title: '补货：洗衣液', lines: [{ materialId: x.id, purchaseQtyMilli: q(1) }] })).body.event;
    expect(await lineOf()).toMatchObject({ inTransitMilli: q(4), openPos: [ev.docNo], suggestedPurchaseMilli: q(1) });
    // 定标转出采购单：按采购单算（不重复算）
    expect((await quote(ev.id, { supplierId: s1.id, prices: [{ lineId: ev.lines[0].id, priceCents: 20_000 }] })).status).toBe(200);
    expect((await quote(ev.id, { supplierId: s2.id, prices: [{ lineId: ev.lines[0].id, priceCents: 21_000 }] })).status).toBe(200);
    const winner = (await api(ctx.app, buyer, 'GET', `/api/purchase-sourcing/${ev.id}`)).body.quotes.find((x: { supplier: { id: number } }) => x.supplier.id === s1.id);
    await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ev.id}/award`, { quoteId: winner.id, reason: '单价最低' });
    const po = (await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${ev.id}/order`, { clientKey: randomUUID() })).body.po;
    expect(await lineOf()).toMatchObject({ inTransitMilli: q(4), openPos: [po.docNo] });

    // 自检：一行需求同时在两张没撤销的询价单里（绕过接口直接写）报出来；撤销其中一张后恢复
    const r = await approvedRequest(reqB, [{ materialId: mat.id, name: mat.name, qtyMilli: q(1) }]);
    const e1 = (await sourcing({ title: '床单 A', lines: [{ materialId: mat.id, purchaseQtyMilli: q(1), requestLineIds: [r.lines[0]!.id] }] })).body.event;
    const e2 = (await sourcing({ title: '床单 B', lines: [{ materialId: mat.id, purchaseQtyMilli: q(1) }] })).body.event;
    await ctx.sql`INSERT INTO sourcing_line_requests (sourcing_line_id, request_line_id) VALUES (${e2.lines[0].id}, ${r.lines[0]!.id})`;
    const [broken] = await sourcingChecks(ctx.sql);
    expect(broken!.ok).toBe(false);
    expect(broken!.detail).toContain(`需求行 #${r.lines[0]!.id}`);
    // 关联只追加：改、删都拒绝
    await expect(ctx.sql`DELETE FROM sourcing_line_requests WHERE sourcing_line_id = ${e2.lines[0].id}`).rejects.toThrow();
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${e2.id}/cancel`, { reason: '重复了' })).body.status).toBe('cancelled');
    expect((await sourcingChecks(ctx.sql))[0]).toMatchObject({ ok: true });
    expect(e1.lines[0].requests).toHaveLength(1);
  });
});
