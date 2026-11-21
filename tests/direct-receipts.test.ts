// 8.1.9 库管入库（docs/ERP_V819.md 第 3 节，KR1–KR6；迁移 183）：不选采购单的收货、确认入库、应付与成本、补采购单、开关、自检；
// 台账模板与一键导入：预览逐行核对、合单与拆单、整份不写、同一份文件只能导入一次、结果待确认。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let boss: string;
let keeper: string; // 物资经办 lixiao：库管入库
let buyer: string; // 采购经办 zhouyi：补采购单
let credit: { id: number; code: string; name: string };
let cash: { id: number; code: string; name: string };
let mat: { id: number; code: string; name: string; inventoryUnit: string; purchaseUnit: string; purchaseFactorMilli: number };
let mat2: { id: number; code: string; name: string; inventoryUnit: string };
const q = (n: number) => Math.round(n * 1000);
const stock = async (id: number) => Number((await ctx.sql<{ s: number }[]>`SELECT stock_milli AS s FROM materials WHERE id = ${id}`)[0]!.s);
const direct = (body: Record<string, unknown> = {}, cookie = keeper) =>
  api(ctx.app, cookie, 'POST', '/api/inventory/docs', {
    clientKey: randomUUID(),
    docType: 'receipt',
    docDate: today,
    supplierId: cash.id,
    direct: true,
    lines: [{ materialId: mat.id, deliveredMilli: q(5), acceptedMilli: q(5), priceCents: 2000 }],
    ...body,
  });
const csvOf = (rows: string[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
const HEAD = ['序号', '入库日期', '供应商', '物品名称', '物料编号', '送达数量', '合格实收', '单位', '单价', '金额', '拒收原因', '收货人', '单据分组', '备注'];

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  const sups = await ctx.sql<{ id: number; code: string; name: string; settlement: string }[]>`SELECT id, code, name, settlement FROM suppliers WHERE active ORDER BY id`;
  credit = sups.find((s) => s.settlement === 'credit')!;
  // 现付供应商：没有就把一家改成现付（网购零采走现付，货款走报销）
  cash = sups.find((s) => s.settlement === 'cash') ?? sups.find((s) => s.id !== credit.id)!;
  await ctx.sql`UPDATE suppliers SET settlement = 'cash' WHERE id = ${cash.id}`;
  const mats = await ctx.sql<
    { id: number; code: string; name: string; inventoryUnit: string; purchaseUnit: string; purchaseFactorMilli: number; decimals: number; expiryTracked: boolean; weighed: boolean }[]
  >`SELECT id, code, name, inventory_unit, purchase_unit, purchase_factor_milli, decimals, expiry_tracked, weighed FROM materials WHERE active AND tracked AND NOT counter_use ORDER BY id`;
  const plain = mats.filter((m) => !m.expiryTracked && !m.weighed);
  mat = { ...plain.find((m) => Number(m.purchaseFactorMilli) > 1000 && m.purchaseUnit !== m.inventoryUnit)!, purchaseFactorMilli: 0 };
  mat.purchaseFactorMilli = Number(plain.find((m) => m.id === mat.id)!.purchaseFactorMilli);
  // 第二样：采购单位与库存单位一样（单价就是每个库存单位的价）
  mat2 = plain.find((m) => m.id !== mat.id && m.decimals === 0 && Number(m.purchaseFactorMilli) === 1000)!;
}, 120_000);
afterAll(async () => ctx.close());

describe('库管入库', () => {
  it('不选采购单也能收货：确认入库、进总仓、算成本；现付供应商不记应付、挂账的记应付', async () => {
    const before = await stock(mat.id);
    const r = await direct();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.doc).toMatchObject({ docType: 'receipt', status: 'confirmed', direct: true, noPo: true, purchaseOrder: null, urgent: false, importId: null });
    expect(await stock(mat.id)).toBe(before + q(5));
    const ap = async (docId: number) => Number((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ap_entries WHERE inv_doc_id = ${docId}`)[0]!.n);
    expect(await ap(r.body.doc.id)).toBe(0);
    const c = await direct({ supplierId: credit.id });
    expect(c.body.doc.status).toBe('confirmed');
    expect(await ap(c.body.doc.id)).toBe(1);
    // 列表里看得出是库管入库
    const list = (await api(ctx.app, keeper, 'GET', '/api/inventory/docs?type=receipt')).body;
    expect(list.find((d: { id: number }) => d.id === r.body.doc.id)).toMatchObject({ direct: true });
  });

  it('其余与收货一样：要单价、不能选采购单、不是急采；不标库管入库照旧要采购单', async () => {
    expect((await direct({ lines: [{ materialId: mat.id, deliveredMilli: q(1), acceptedMilli: q(1) }] })).status).toBe(400);
    expect((await direct({ purchaseOrderId: 1 })).status).toBe(400);
    // 急采只有采购能登记（物资经办直接 403）；店主带上急采也拒绝
    expect((await direct({ urgent: true, departmentId: 1 })).status).toBe(403);
    expect((await direct({ urgent: true, departmentId: 1 }, boss)).status).toBe(400);
    expect((await direct({ direct: false })).body.error.code).toBe('PO_REQUIRED');
    // 拒收要写原因
    expect((await direct({ lines: [{ materialId: mat.id, deliveredMilli: q(5), acceptedMilli: q(4), priceCents: 2000 }] })).status).toBe(400);
    // 采购经办（没有收货权限）登记不了
    expect((await direct({}, buyer)).status).toBe(403);
  });

  it('草稿能改，但库管入库与按采购单收货不能互相改', async () => {
    const draft = await direct({ action: 'save' });
    expect(draft.body.doc).toMatchObject({ status: 'draft', direct: true });
    const put = (body: Record<string, unknown>) =>
      api(ctx.app, keeper, 'PUT', `/api/inventory/docs/${draft.body.doc.id}`, {
        docType: 'receipt',
        docDate: today,
        supplierId: cash.id,
        lines: [{ materialId: mat.id, deliveredMilli: q(2), acceptedMilli: q(2), priceCents: 2000 }],
        ...body,
      });
    expect((await put({ direct: false })).status).toBe(400);
    expect((await put({ direct: true, action: 'submit' })).body).toMatchObject({ status: 'confirmed', direct: true, amountCents: 4000 / (mat.purchaseFactorMilli / 1000) });
  });

  it('补采购单：补单只挂上采购单，不再入库', async () => {
    const r = await direct({ lines: [{ materialId: mat.id, deliveredMilli: mat.purchaseFactorMilli * 2, acceptedMilli: mat.purchaseFactorMilli * 2, priceCents: 3000 }] });
    const before = await stock(mat.id);
    const bf = await api(ctx.app, buyer, 'POST', '/api/purchase-orders/backfill', { receiptDocId: r.body.doc.id, clientKey: randomUUID() });
    expect(bf.status, JSON.stringify(bf.body)).toBe(201);
    const po = bf.body.po ?? bf.body;
    if (po.status !== 'approved') await api(ctx.app, boss, 'POST', `/api/purchase-orders/${po.id}/approve`, {});
    const doc = (await api(ctx.app, keeper, 'GET', `/api/inventory/docs/${r.body.doc.id}`)).body;
    expect(doc).toMatchObject({ direct: true, noPo: true, purchaseOrder: { id: po.id } });
    expect(await stock(mat.id)).toBe(before);
  });

  it('库存设置里关掉以后不能用；自检「收货都有采购单」放过库管入库', async () => {
    const settings = (await api(ctx.app, boss, 'GET', '/api/inventory/settings')).body;
    expect(settings.directReceipt).toBe(true);
    const off = await api(ctx.app, boss, 'PUT', '/api/inventory/settings', { ...settings, directReceipt: false });
    expect(off.body.directReceipt).toBe(false);
    expect((await direct()).body.error.code).toBe('DIRECT_RECEIPT_OFF');
    expect((await api(ctx.app, boss, 'PUT', '/api/inventory/settings', { ...settings, directReceipt: true })).body.directReceipt).toBe(true);
    // 不传这一项的旧页面保存不会把它冲掉
    const { directReceipt: _d, ...old } = settings;
    expect((await api(ctx.app, boss, 'PUT', '/api/inventory/settings', old)).body.directReceipt).toBe(true);
    const checks = (await api(ctx.app, boss, 'GET', '/api/inventory/checks')).body as { key: string; ok: boolean; detail: string }[];
    expect(checks.find((c) => c.key === 'receipt_po')).toMatchObject({ ok: true });
  });
});

describe('库管入库台账：模板与一键导入', () => {
  it('8.1.20 起旧模板停用：下载返回 410，指向新的出入库台账模板（LD9）', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/inventory/direct-receipts/template', headers: { cookie: keeper } });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('TEMPLATE_RETIRED');
    expect((await api(ctx.app, buyer, 'GET', '/api/inventory/direct-receipts/template')).status).toBe(403);
  });

  it('预览逐行核对：有问题的标出来、不能导入；改好以后按日期 + 供应商 + 分组合单，一次确认入库', async () => {
    const bad = csvOf([
      HEAD,
      ['1', today, cash.name, mat.name, '', '2', '', mat.purchaseUnit, '30', '', '', '李晓', '', ''],
      ['2', '2999-01-01', '没有这家', '没有这个物品', '', '0', '', '', 'x', '', '', '', '', ''],
      ['3', today, cash.code, mat2.name, '', '3', '2', '', '5', '99', '', '', '', ''],
    ]);
    const p = await api(ctx.app, keeper, 'POST', '/api/inventory/direct-receipts/import/preview', { fileName: '入库台账.csv', csv: bad });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.issueCount).toBe(2);
    expect(p.body.groups).toEqual([]);
    const issues = p.body.rows.map((r: { issues: string[] }) => r.issues.join('|'));
    expect(issues[0]).toBe('');
    expect(issues[1]).toContain('入库日期：不能晚于今天');
    expect(issues[1]).toContain('供应商：「没有这家」不在供应商档案里');
    expect(issues[2]).toContain('拒收原因');
    expect(issues[2]).toContain('金额');
    // 第一行：按采购单位换算成库存单位
    expect(p.body.rows[0]).toMatchObject({ deliveredMilli: mat.purchaseFactorMilli * 2, acceptedMilli: mat.purchaseFactorMilli * 2, priceCents: 3000, amountCents: 6000 });
    const refused = await api(ctx.app, keeper, 'POST', '/api/inventory/direct-receipts/import', { fileName: '入库台账.csv', csv: bad, clientKey: randomUUID() });
    expect(refused.body.error.code).toBe('IMPORT_INVALID');

    const good = csvOf([
      HEAD,
      ['1', today, cash.name, mat.name, '', '2', '', mat.purchaseUnit, '30', '60', '', '李晓', '', ''],
      ['2', today, cash.code, mat2.name, '', '3', '2', '', '5', '10', '破了一个', '', '', ''],
      ['3', today, credit.name, mat2.name, mat2.code, '1', '', '', '8', '', '', '', '', ''],
      ['4', today, cash.name, mat2.name, '', '4', '', '', '5', '', '', '', '早班', '单独一张'],
    ]);
    const prev = await api(ctx.app, keeper, 'POST', '/api/inventory/direct-receipts/import/preview', { fileName: '入库台账.csv', csv: good });
    expect(prev.body).toMatchObject({ issueCount: 0, previous: null });
    expect(prev.body.groups).toEqual([
      expect.objectContaining({ supplierName: cash.name, group: '', lines: 2, amountCents: 6000 + 1000 }),
      expect.objectContaining({ supplierName: credit.name, group: '', lines: 1, amountCents: 800 }),
      expect.objectContaining({ supplierName: cash.name, group: '早班', lines: 1, amountCents: 2000 }),
    ]);
    const s1 = await stock(mat.id);
    const s2 = await stock(mat2.id);
    const key = randomUUID();
    const done = await api(ctx.app, keeper, 'POST', '/api/inventory/direct-receipts/import', { fileName: '入库台账.csv', csv: good, clientKey: key });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.import).toMatchObject({ rowCount: 4, docCount: 3, amountCents: 9800 });
    expect(done.body.docs).toHaveLength(3);
    expect(await stock(mat.id)).toBe(s1 + mat.purchaseFactorMilli * 2);
    expect(await stock(mat2.id)).toBe(s2 + q(2) + q(1) + q(4));
    for (const d of done.body.docs) {
      const doc = (await api(ctx.app, keeper, 'GET', `/api/inventory/docs/${d.id}`)).body;
      expect(doc).toMatchObject({ status: 'confirmed', direct: true, importId: done.body.import.id });
    }
    // 同一编号原样重提：返回原来的那次；同一份文件换个编号再导：拒绝（重复入库会多出库存）
    expect((await api(ctx.app, keeper, 'POST', '/api/inventory/direct-receipts/import', { fileName: '入库台账.csv', csv: good, clientKey: key })).body).toMatchObject({
      replayed: true,
      import: { id: done.body.import.id },
    });
    expect((await api(ctx.app, keeper, 'POST', '/api/inventory/direct-receipts/import', { fileName: '另存.csv', csv: good, clientKey: randomUUID() })).body.error.code).toBe('IMPORT_REPEAT');
    expect((await api(ctx.app, keeper, 'POST', '/api/inventory/direct-receipts/import/preview', { fileName: '另存.csv', csv: good })).body.previous).toMatchObject({ docCount: 3 });
    expect(await stock(mat2.id)).toBe(s2 + q(7));
    // 查回
    expect((await api(ctx.app, keeper, 'GET', `/api/erp/ops/${key}?type=receipt_import`)).body).toMatchObject({ found: true, refId: done.body.import.id });
    expect((await api(ctx.app, keeper, 'GET', `/api/inventory/direct-receipts/imports/${done.body.import.id}`)).body.docs).toHaveLength(3);
  });

  it('一组超过 100 行拆成两张；作废了编号的导入不再写', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => [String(i + 1), today, cash.name, mat2.name, '', '1', '', '', '1', '', '', '', '大单', '']);
    const csv = csvOf([HEAD, ...rows]);
    const lost = randomUUID();
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'receipt_import' })).body).toMatchObject({ abandoned: true });
    expect((await api(ctx.app, keeper, 'POST', '/api/inventory/direct-receipts/import', { fileName: '大单.csv', csv, clientKey: lost })).body.error.code).toBe('OP_ABANDONED');
    const done = await api(ctx.app, keeper, 'POST', '/api/inventory/direct-receipts/import', { fileName: '大单.csv', csv, clientKey: randomUUID() });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.docs.map((d: { lineCount: number }) => d.lineCount)).toEqual([100, 1]);
  });

  it('导入的这一刻物料的换算被改了：锁住物料以后再算一遍，与之前算的不一样整份不导（Codex 审查 785ca18）', async () => {
    const [orig] = await ctx.sql<{ f: number }[]>`SELECT purchase_factor_milli AS f FROM materials WHERE id = ${mat.id}`;
    const before = await stock(mat.id);
    const fileName = `换算-${Date.now()}.csv`;
    const csv = csvOf([HEAD, ['1', today, cash.name, mat.name, '', '2', '', mat.purchaseUnit, '30', '60', '', '李晓', '', fileName]]);
    // 另一个连接先锁住这个物料：导入读完物料、停在物料锁上时，把换算改了再提交
    const other = await ctx.sql.reserve();
    try {
      await other`BEGIN`;
      await other`SELECT id FROM materials WHERE id = ${mat.id} FOR UPDATE`;
      const pending = api(ctx.app, keeper, 'POST', '/api/inventory/direct-receipts/import', { fileName, csv, clientKey: randomUUID() });
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) {
        const [w] = await ctx.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM materials%FOR UPDATE%'`;
        waiting = w!.n > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting, '导入应停在物料锁上').toBe(true);
      await other`UPDATE materials SET purchase_factor_milli = purchase_factor_milli * 2 WHERE id = ${mat.id}`;
      await other`COMMIT`;
      const r = await pending;
      expect(r.body.error?.code, JSON.stringify(r.body)).toBe('IMPORT_STALE');
      // 整份没写：库存不变、没有导入记录
      expect(await stock(mat.id)).toBe(before);
      expect((await ctx.sql`SELECT 1 FROM receipt_imports WHERE file_name = ${fileName}`).length).toBe(0);
      // 重新预览按新的换算算；导入照常
      const prev = await api(ctx.app, keeper, 'POST', '/api/inventory/direct-receipts/import/preview', { fileName, csv });
      expect(prev.body.issueCount).toBe(0);
      const ok = await api(ctx.app, keeper, 'POST', '/api/inventory/direct-receipts/import', { fileName, csv, clientKey: randomUUID() });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(await stock(mat.id)).toBe(before + orig!.f * 2 * 2);
    } finally {
      await ctx.sql`UPDATE materials SET purchase_factor_milli = ${orig!.f} WHERE id = ${mat.id}`;
      other.release();
    }
  });
});
