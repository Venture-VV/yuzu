// 8.0.20 布草洗涤（docs/ERP_V8020.md 第 4 节，JX-E；迁移 138）：品类、送洗 / 收回 / 新增 / 报废、作废、洗涤费对账表。
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { FENCED_OPS } from '../src/server/lib/fences';
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

describe('迁移 140 与别的分支的迁移谁先跑都成立（测试会话在 PR #109 上报的 P1）', () => {
  it('在当时的约束上追加：先跑了客户部的 162 再跑 140，客户部的作废类型还在；库里已经有客户部的作废登记也升得上去', async () => {
    const file = await readFile(new URL('../src/server/migrations/140_linen_ops.sql', import.meta.url), 'utf8');
    const def = async (db: typeof ctx.sql) =>
      (await db<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check'`)[0]!.def;
    // 现在的库是 140、162 都跑过的：再跑一遍 140 = 「162 之后才跑 140」
    await ctx.sql
      .begin(async (tx) => {
        const [owner] = await tx<{ id: number }[]>`SELECT id FROM staff WHERE role = 'owner' ORDER BY id LIMIT 1`;
        await tx`INSERT INTO op_fences (key, op_type, staff_id) VALUES (${randomUUID()}, 'customer_note', ${owner!.id})`;
        await tx.unsafe(file);
        const after = await def(tx as never);
        for (const t of FENCED_OPS) expect(after, t).toContain(`'${t}'`);
        // 只在这个事务里试，不留下
        throw new Error('rollback');
      })
      .catch((e: Error) => {
        if (e.message !== 'rollback') throw e;
      });
    for (const t of ['linen_doc', 'customer_note', 'customer_target']) expect(await def(ctx.sql)).toContain(`'${t}'`);
  });
});

describe('合并前 Codex 审查 b850838', () => {
  let other: number;
  let sheet: number;

  it('几家洗涤厂洗同一个品类：收回按这一家手里的数量核对；这一家已经收回过的送洗单不能直接作废', async () => {
    const s = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'LN02', name: '白云洗涤厂' });
    other = s.body.find((x: { code: string }) => x.code === 'LN02').id;
    sheet = (await api(ctx.app, keeper, 'POST', '/api/erp/linen/items', { name: '床单', washPriceCents: 200 })).body.id;
    expect((await doc({ kind: 'add', lines: [{ itemId: sheet, qty: 40 }] })).status).toBe(201);
    const toA = await doc({ kind: 'send', supplierId: laundry, lines: [{ itemId: sheet, qty: 10 }] });
    const toB = await doc({ kind: 'send', supplierId: other, lines: [{ itemId: sheet, qty: 10 }] });
    expect([toA.status, toB.status]).toEqual([201, 201]);
    // 加起来在洗 20，但 B 手里只有 10：从 B 收回 15 不行
    const tooMany = await doc({ kind: 'return', supplierId: other, lines: [{ itemId: sheet, qty: 12, damagedQty: 2, lostQty: 1 }] });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error).toMatchObject({ code: 'LINEN_NOT_AT_LAUNDRY' });
    expect(tooMany.body.error.message).toContain('白云洗涤厂');
    expect(await counts('床单')).toEqual([40, 20, 20]);
    // 从 B 收回 6：B 手里还有 4、A 手里还有 10，没有负数
    const back = await doc({ kind: 'return', supplierId: other, lines: [{ itemId: sheet, qty: 6 }] });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    const held = (await overview()).outstanding.filter((o: { itemId: number }) => o.itemId === sheet).map((o: { supplierName: string; qty: number }) => [o.supplierName, o.qty]);
    expect(held.sort()).toEqual([['洁净洗涤厂', 10], ['白云洗涤厂', 4]].sort());
    // 作废送给 B 的那张：加起来在洗 14 ≥ 10，但 B 已经收回 6、手里只有 4 → 不让作废；作废了收回单以后可以
    const blocked = await api(ctx.app, keeper, 'POST', `/api/erp/linen/docs/${toB.body.doc.id}/void`, { reason: '送错了' });
    expect(blocked.body.error.code).toBe('LINEN_VOID_BLOCKED');
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/linen/docs/${back.body.doc.id}/void`, { reason: '先撤收回' })).status).toBe(200);
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/linen/docs/${toB.body.doc.id}/void`, { reason: '送错了' })).status).toBe(200);
    expect(await counts('床单')).toEqual([40, 10, 30]);
  });

  it('店总（默认有布草权限、没有「查看库存」）：取得到洗涤厂名单，开得了送洗单', async () => {
    await createStaff(ctx.sql, { username: 'ln-manager', displayName: '店总小周', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
    const manager = await login(ctx.app, 'ln-manager');
    expect((await api(ctx.app, manager, 'GET', '/api/inventory/suppliers')).status).toBe(403);
    const o = await overview(manager);
    expect(o.canManage).toBe(true);
    expect(o.suppliers).toEqual(expect.arrayContaining([{ id: laundry, name: '洁净洗涤厂' }, { id: other, name: '白云洗涤厂' }]));
    expect((await doc({ kind: 'send', supplierId: other, lines: [{ itemId: sheet, qty: 5 }] }, manager)).status).toBe(201);
  });

  it('结果待确认：按编号查得回；确认作废以后原请求再到也不开单；已经开了的作废不了', async () => {
    // 查回：开过的查得到，返回那张单
    const key = randomUUID();
    const made = await doc({ kind: 'add', lines: [{ itemId: sheet, qty: 3 }] }, keeper, key);
    expect(made.status).toBe(201);
    expect((await api(ctx.app, keeper, 'GET', `/api/erp/ops/${key}?type=linen_doc`)).body).toMatchObject({ found: true, refId: made.body.doc.id });
    // 已经开了的：「确认作废」不生效，告诉它已经登记
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'linen_doc' })).body).toMatchObject({ found: true, abandoned: false });
    // 没到的：查不到 → 确认作废 → 原请求晚到也不开单，数量不变
    const lost = randomUUID();
    expect((await api(ctx.app, keeper, 'GET', `/api/erp/ops/${lost}?type=linen_doc`)).body).toMatchObject({ found: false, abandoned: false });
    // 只能看的人不能作废
    expect((await api(ctx.app, coster, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'linen_doc' })).status).toBe(403);
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'linen_doc' })).body).toMatchObject({ found: false, abandoned: true });
    const before = await counts('床单');
    const late = await doc({ kind: 'add', lines: [{ itemId: sheet, qty: 9 }] }, keeper, lost);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OP_ABANDONED');
    expect(await counts('床单')).toEqual(before);
  });
});
