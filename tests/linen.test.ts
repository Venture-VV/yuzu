// 8.0.20 布草洗涤（docs/ERP_V8020.md 第 4 节，JX-E；迁移 138）：品类、送洗 / 收回 / 新增 / 报废、作废、洗涤费对账表。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let keeper: string;
let coster: string;
let laundry: number;
const item: Record<string, number> = {};
const doc = (body: Record<string, unknown>, cookie = keeper, clientKey = randomUUID()) => api(ctx.app, cookie, 'POST', '/api/erp/linen/docs', { clientKey, docDate: today, ...body });
const overview = async (cookie = keeper) => (await api(ctx.app, cookie, 'GET', '/api/erp/linen')).body;
const counts = async (name: string) => {
  const it = (await overview()).items.find((x: { name: string }) => x.name === name);
  return [it.totalQty, it.atLaundryQty, it.inHouseQty];
};

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  await createStaff(ctx.sql, { username: 'ln-keeper', displayName: '布草小林', role: 'backoffice', duties: ['stock'] as never, password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'ln-cost', displayName: '成本小吴', role: 'backoffice', duties: ['cost'] as never, password: PASSWORD, mustChangePassword: false });
  keeper = await login(ctx.app, 'ln-keeper');
  coster = await login(ctx.app, 'ln-cost');
  const s = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'LN01', name: '洁净洗涤厂' });
  laundry = s.body.find((x: { code: string }) => x.code === 'LN01').id;
}, 60_000);
afterAll(async () => ctx.close());

describe('布草洗涤', () => {
  it('品类：物资经办维护，成本岗只能看；在用的不重名；改要带版本号', async () => {
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/erp/linen')).status).toBe(403);
    expect((await api(ctx.app, coster, 'POST', '/api/erp/linen/items', { name: '浴巾' })).status).toBe(403);
    for (const [name, price] of [
      ['浴巾', 150],
      ['浴衣', 300],
    ] as const) {
      const r = await api(ctx.app, keeper, 'POST', '/api/erp/linen/items', { name, washPriceCents: price });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      item[name] = r.body.id;
    }
    expect((await api(ctx.app, keeper, 'POST', '/api/erp/linen/items', { name: '浴巾' })).body.error.code).toBe('LINEN_NAME_TAKEN');
    const stale = await api(ctx.app, keeper, 'PUT', `/api/erp/linen/items/${item['浴巾']}`, { name: '大浴巾', washPriceCents: 180, active: true, expectedVersion: 9 });
    expect(stale.body.error.code).toBe('LINEN_ITEM_CHANGED');
    const ok = await api(ctx.app, keeper, 'PUT', `/api/erp/linen/items/${item['浴巾']}`, { name: '浴巾', washPriceCents: 180, active: true, expectedVersion: 1 });
    expect(ok.body).toMatchObject({ washPriceCents: 180, version: 2 });
    expect((await overview(coster)).canManage).toBe(false);
  });

  it('新增 → 送洗 → 收回（破损、丢失）→ 报废：总数、在洗、在店跟着变；洗涤费只算洗过的；洗涤厂手里还有几件看得到', async () => {
    expect((await doc({ kind: 'add', lines: [{ itemId: item['浴巾'], qty: 100 }, { itemId: item['浴衣'], qty: 40 }] })).status).toBe(201);
    expect(await counts('浴巾')).toEqual([100, 0, 100]);
    // 送洗要选洗涤厂；在店不够送不了
    expect((await doc({ kind: 'send', lines: [{ itemId: item['浴巾'], qty: 10 }] })).status).toBe(400);
    expect((await doc({ kind: 'send', supplierId: laundry, lines: [{ itemId: item['浴巾'], qty: 101 }] })).body.error.code).toBe('LINEN_NOT_ENOUGH');
    const sent = await doc({ kind: 'send', supplierId: laundry, lines: [{ itemId: item['浴巾'], qty: 60 }, { itemId: item['浴衣'], qty: 20 }] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.doc).toMatchObject({ kind: 'send', amountCents: 0, supplier: { name: '洁净洗涤厂' } });
    expect(sent.body.doc.docNo).toMatch(/^BS/);
    expect(await counts('浴巾')).toEqual([100, 60, 40]);
    // 收回：完好 50、破损 3、丢失 2（还有 5 件在洗涤厂）；收不回比在洗更多的
    expect((await doc({ kind: 'return', supplierId: laundry, lines: [{ itemId: item['浴巾'], qty: 61 }] })).body.error.code).toBe('LINEN_NOT_AT_LAUNDRY');
    const back = await doc({ kind: 'return', supplierId: laundry, lines: [{ itemId: item['浴巾'], qty: 50, damagedQty: 3, lostQty: 2 }] });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    // 洗涤费 =（50 + 3）× 1.80
    expect(back.body.doc).toMatchObject({ amountCents: 53 * 180, lines: [{ qty: 50, damagedQty: 3, lostQty: 2, priceCents: 180 }] });
    expect(await counts('浴巾')).toEqual([95, 5, 90]);
    const o = await overview();
    expect(o.outstanding).toEqual([
      { supplierId: laundry, supplierName: '洁净洗涤厂', itemId: item['浴巾'], itemName: '浴巾', qty: 5 },
      { supplierId: laundry, supplierName: '洁净洗涤厂', itemId: item['浴衣'], itemName: '浴衣', qty: 20 },
    ]);
    // 报废 4 件
    expect((await doc({ kind: 'scrap', note: '用旧了', lines: [{ itemId: item['浴巾'], qty: 4 }] })).status).toBe(201);
    expect(await counts('浴巾')).toEqual([91, 5, 86]);
    // 只有收回单才填破损、丢失
    expect((await doc({ kind: 'add', lines: [{ itemId: item['浴巾'], qty: 1, damagedQty: 1 }] })).status).toBe(400);
    // 在洗着的品类不能停用
    const cur = (await overview()).items.find((x: { name: string }) => x.name === '浴巾');
    expect((await api(ctx.app, keeper, 'PUT', `/api/erp/linen/items/${cur.id}`, { name: '浴巾', washPriceCents: 180, active: false, expectedVersion: cur.version })).body.error.code).toBe('LINEN_AT_LAUNDRY');
  });

  it('同一个操作编号原样重提只记一次，内容不同拒绝；作废把数量冲回，之后的单挡着时不能作废', async () => {
    const key = randomUUID();
    const body = { kind: 'add', lines: [{ itemId: item['浴衣'], qty: 5 }] };
    const first = await doc(body, keeper, key);
    expect(first.status).toBe(201);
    const again = await doc(body, keeper, key);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, doc: { id: first.body.doc.id } });
    expect((await doc({ kind: 'add', lines: [{ itemId: item['浴衣'], qty: 6 }] }, keeper, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await counts('浴衣')).toEqual([45, 20, 25]);
    // 作废新增的 5 件
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/linen/docs/${first.body.doc.id}/void`, { reason: '' })).status).toBe(400);
    const voided = await api(ctx.app, keeper, 'POST', `/api/erp/linen/docs/${first.body.doc.id}/void`, { reason: '录错了' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body).toMatchObject({ status: 'voided', voidReason: '录错了' });
    expect(await counts('浴衣')).toEqual([40, 20, 20]);
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/linen/docs/${first.body.doc.id}/void`, { reason: '再作废' })).body.error.code).toBe('LINEN_DOC_VOIDED');
    // 最早那张新增单（浴巾 100、浴衣 40）：浴衣已经送洗 20，作废后在洗 20 > 总数 0，不让作废
    const addDoc = (await overview()).docs.find((d: { kind: string; status: string; lines: { qty: number }[] }) => d.kind === 'add' && d.status === 'confirmed' && d.lines.length === 2);
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/linen/docs/${addDoc.id}/void`, { reason: '想作废' })).body.error.code).toBe('LINEN_VOID_BLOCKED');
    // 单据内容不能改、不能删
    await expect(ctx.sql`UPDATE linen_docs SET note = '改' WHERE id = ${addDoc.id}`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM linen_doc_lines WHERE doc_id = ${addDoc.id}`).rejects.toThrow();
  });

  it('洗涤费对账表：按洗涤厂、按月，只算有效的收回单；能导出；模块关着时接口拒绝', async () => {
    const s = (await api(ctx.app, coster, 'GET', `/api/erp/linen/statement?month=${today.slice(0, 7)}`)).body;
    expect(s).toEqual({ month: today.slice(0, 7), rows: [{ supplierId: laundry, supplierName: '洁净洗涤厂', docs: 1, washedQty: 50, damagedQty: 3, lostQty: 2, amountCents: 53 * 180 }], totalCents: 53 * 180 });
    expect((await api(ctx.app, coster, 'GET', '/api/erp/linen/statement?month=2026-13')).status).toBe(400);
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/erp/linen/statement/export?month=${today.slice(0, 7)}`, headers: { cookie: coster } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('洁净洗涤厂');
    expect(csv.body).toContain('95.40');
    // 模块开关：默认开；关掉以后接口拒绝
    const me = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body;
    expect(me.erpModules).toContain('linen');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/erp/modules', { modules: { linen: false } })).status).toBe(200);
    expect((await api(ctx.app, keeper, 'GET', '/api/erp/linen')).body.error.code).toBe('ERP_MODULE_DISABLED');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/erp/modules', { modules: { linen: true } })).status).toBe(200);
  });
});
