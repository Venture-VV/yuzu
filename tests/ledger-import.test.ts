// 8.1.20 出入库台账（docs/ERP_V8120.md，PENDING_DECISIONS「8.1.20」LD1–LD10；迁移 200）：模板（门店的两行表头版式）、
// 预览逐行核对（物料、供应商、部门、单价、日期、库存够不够；上期库存量与库存量只提醒）、一键导入（入库生成库管入库、出库生成部门领料，
// 都马上生效；库位写进物料档案）、同一份文件只能导入一次、结果待确认的查回、导出台账（系统导出的不能再导入）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { readXlsx } from '../src/server/lib/xlsx-read';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let keeper: string; // 物资经办 lixiao
let buyer: string; // 采购经办 zhouyi：没有「库存操作」
let sup: { id: number; code: string; name: string };
let mat: { id: number; code: string; name: string; specification: string; refPriceCents: number | null };
let bare: { id: number; name: string };
let dept: { id: number; name: string };
const q = (n: number) => Math.round(n * 1000);
const stock = async (id: number) => Number((await ctx.sql<{ s: number }[]>`SELECT stock_milli AS s FROM materials WHERE id = ${id}`)[0]!.s);
const csvOf = (rows: string[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
const TOP = ['序号', '日期', '供应商', '物料名称', '规格', '库位', '上期库存量', '入库', '', '入库', '', '出库', '', '', '出库', '', '', '库存量', '单价', '备注'];
const SUB = ['', '', '', '', '', '', '', '日期', '数量', '日期', '数量', '日期', '数量', '领料人及部门', '日期', '数量', '领料人及部门', '', '', ''];
const ledger = (title: string, rows: string[][]) => csvOf([[title], TOP, SUB, ...rows]);
const row = (o: {
  seq?: string;
  supplier?: string;
  name: string;
  spec?: string;
  location?: string;
  open?: string;
  in1?: [string, string];
  in2?: [string, string];
  out1?: [string, string, string];
  out2?: [string, string, string];
  close?: string;
  price?: string;
  note?: string;
}) => [
  o.seq ?? '1',
  '',
  o.supplier ?? '',
  o.name,
  o.spec ?? '',
  o.location ?? '',
  o.open ?? '',
  ...(o.in1 ?? ['', '']),
  ...(o.in2 ?? ['', '']),
  ...(o.out1 ?? ['', '', '']),
  ...(o.out2 ?? ['', '', '']),
  o.close ?? '',
  o.price ?? '',
  o.note ?? '',
];

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  sup = (await ctx.sql<{ id: number; code: string; name: string }[]>`SELECT id, code, name FROM suppliers WHERE active ORDER BY id LIMIT 1`)[0]!;
  const mats = await ctx.sql<{ id: number; code: string; name: string; specification: string; refPriceCents: number | null }[]>`
    SELECT id, code, name, specification, ref_price_cents FROM materials m
    WHERE active AND tracked AND NOT counter_use AND NOT expiry_tracked AND NOT weighed AND decimals = 0 AND purchase_factor_milli = 1000
      AND (SELECT count(*) FROM materials o WHERE o.name = m.name) = 1
    ORDER BY id`;
  mat = mats[0]!;
  bare = mats[1]!;
  await ctx.sql`UPDATE materials SET ref_price_cents = NULL WHERE id = ${bare.id}`;
  dept = (
    await ctx.sql<{ id: number; name: string }[]>`
    SELECT d.id, d.name FROM departments d JOIN warehouses w ON w.department_id = d.id WHERE d.active ORDER BY d.id LIMIT 1`
  )[0]!;
}, 120_000);
afterAll(async () => ctx.close());

describe('出入库台账', () => {
  it('模板：门店的版式（标题、两行表头、入库两组、出库三组、库存量、单价、备注），填写说明与选项；没有库存操作的下载不了', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/inventory/ledger/template', headers: { cookie: keeper } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const book = readXlsx(res.rawPayload);
    expect(book.sheets.map((s) => s.name)).toEqual(['出入库台账', '填写说明', '选项']);
    const s = book.sheets[0]!;
    const line = (r: number) => [...(s.rows.get(r)?.values() ?? [])].map((c) => c.value);
    expect(line(1)[0]).toContain('出入库记录');
    expect(line(2)).toEqual(['序号', '日期', '供应商', '物料名称', '规格', '库位', '上期库存量', '入库', '入库', '出库', '出库', '出库', '库存量', '单价', '备注']);
    expect(line(3)).toEqual(['日期', '数量', '日期', '数量', '日期', '数量', '领料人及部门', '日期', '数量', '领料人及部门', '日期', '数量', '领料人及部门']);
    expect((await api(ctx.app, buyer, 'GET', '/api/inventory/ledger/template')).status).toBe(403);
  });

  it('预览逐行核对：有问题的标出来、整份不能导入；上期库存量、库存量对不上只提醒', async () => {
    const before = await stock(mat.id);
    const csv = ledger(`宝安店出入库记录（${today.slice(0, 4)}年）`, [
      // 没问题，但上期写错了：只提醒
      row({ seq: '1', supplier: sup.name, name: mat.name, open: String(before / 1000 + 1), in1: [today, '2'], price: '3' }),
      // 没有这个物料、写了数量没写日期
      row({ seq: '2', supplier: sup.name, name: '没有这个物品', in1: ['', '2'] }),
      // 有入库没写供应商、没写单价档案里也没有参考价
      row({ seq: '3', name: bare.name, in1: [today, '1'] }),
      // 出库：认不出部门、比库存多
      row({ seq: '4', name: mat.name, out1: [today, '1', '张三'], out2: [today, String(before / 1000 + 100), `${dept.name} 李四`] }),
    ]);
    const p = await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import/preview', { fileName: '台账.csv', csv });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const issues = p.body.rows.map((r: { issues: string[] }) => r.issues.join('|'));
    expect(issues[0]).toBe('');
    expect(p.body.rows[0].warnings.join('|')).toContain('上期库存量写的');
    expect(issues[1]).toContain('不在物料档案里');
    expect(issues[1]).toContain('写了数量没写日期');
    expect(issues[2]).toContain('供应商：有入库，要写供应商');
    expect(issues[2]).toContain('档案里也没有参考价');
    expect(issues[3]).toContain('没认出部门');
    expect(p.body.issueCount).toBe(3);
    expect(p.body.docs).toEqual([]);
    const refused = await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import', { fileName: '台账.csv', csv, clientKey: randomUUID(), previewDigest: p.body.digest });
    expect(refused.body.error.code).toBe('IMPORT_INVALID');
    expect(await stock(mat.id)).toBe(before);
  });

  it('导入：入库生成库管入库、出库生成部门领料，都马上生效；库位写进档案；同一份只能导入一次；能查回', async () => {
    const s1 = await stock(mat.id);
    const s2 = await stock(bare.id);
    const md = `${Number(today.slice(5, 7))}月${Number(today.slice(8, 10))}日`;
    const csv = ledger(`宝安店4楼仓库出入库记录（${today.slice(0, 4)}年${Number(today.slice(5, 7))}月）`, [
      row({
        seq: '1',
        supplier: sup.code,
        name: mat.name,
        location: 'J-2',
        open: String(s1 / 1000),
        in1: [today, '10'],
        in2: [md, '5'],
        out1: [today, '4', `${dept.name} 张三`],
        out2: [md, '2', `张三 ${dept.name}`],
        close: String(s1 / 1000 + 9),
        price: '2.5',
      }),
      row({ seq: '2', supplier: sup.name, name: bare.name, in1: [today, '3'], price: '1', out1: [today, '1', `${dept.name}-李四`] }),
    ]);
    const prev = await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import/preview', { fileName: '十一月台账.csv', csv });
    expect(
      prev.body.rows.map((r: { issues: string[] }) => r.issues),
      JSON.stringify(prev.body.rows),
    ).toEqual([[], []]);
    expect(prev.body.rows[0].warnings).toEqual([]);
    // 入库：同一天同一供应商合一张（两样物料，同一种物料两组加在一起）；出库：按部门 + 领料人分两张
    expect(prev.body.docs).toEqual([
      expect.objectContaining({ kind: 'receipt', party: sup.name, lines: 2, amountCents: 15 * 250 + 3 * 100 }),
      expect.objectContaining({ kind: 'issue', party: dept.name, receiver: '张三', lines: 1 }),
      expect.objectContaining({ kind: 'issue', party: dept.name, receiver: '李四', lines: 1 }),
    ]);
    const key = randomUUID();
    const done = await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import', { fileName: '十一月台账.csv', csv, clientKey: key, previewDigest: prev.body.digest });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.import).toMatchObject({ rowCount: 2, receiptCount: 1, issueCount: 2, amountCents: 4050 });
    expect(await stock(mat.id)).toBe(s1 + q(15) - q(6));
    expect(await stock(bare.id)).toBe(s2 + q(3) - q(1));
    for (const d of done.body.docs) {
      const doc = (await api(ctx.app, keeper, 'GET', `/api/inventory/docs/${d.id}`)).body;
      expect(doc.status).toBe('confirmed');
      if (d.docType === 'receipt') expect(doc).toMatchObject({ direct: true, supplier: { id: sup.id } });
      else expect(doc).toMatchObject({ department: { id: dept.id } });
    }
    expect((await ctx.sql<{ location: string }[]>`SELECT location FROM materials WHERE id = ${mat.id}`)[0]!.location).toBe('J-2');
    // 原样重提：返回原来那次；换个编号再导：拒绝
    expect((await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import', { fileName: '十一月台账.csv', csv, clientKey: key, previewDigest: prev.body.digest })).body).toMatchObject({
      replayed: true,
      import: { id: done.body.import.id },
    });
    expect((await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import', { fileName: '另存.csv', csv, clientKey: randomUUID(), previewDigest: prev.body.digest })).body.error.code).toBe(
      'IMPORT_REPEAT',
    );
    expect(await stock(mat.id)).toBe(s1 + q(9));
    expect((await api(ctx.app, keeper, 'GET', `/api/erp/ops/${key}?type=ledger_import`)).body).toMatchObject({ found: true, refId: done.body.import.id });
    expect((await api(ctx.app, keeper, 'GET', `/api/inventory/ledger/imports/${done.body.import.id}`)).body.docs).toHaveLength(3);
  });

  it('同一种物料：第一行只有核对、后面两行入库单价不一样，也拦下来', async () => {
    const csv = ledger('台账', [
      row({ seq: '1', name: mat.name, open: '1' }),
      row({ seq: '2', supplier: sup.name, name: mat.name, in1: [today, '1'], price: '2' }),
      row({ seq: '3', supplier: sup.name, name: mat.name, in1: [today, '1'], price: '3' }),
    ]);
    const p = await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import/preview', { fileName: '单价.csv', csv });
    expect(p.body.rows[1].issues).toEqual([]);
    expect(p.body.rows[2].issues.join('|')).toContain('在第 5 行也有入库，两行的单价不一样');
  });

  it('预览以后参考价改了：导入整份拒绝（IMPORT_STALE），重新预览后能导', async () => {
    await ctx.sql`UPDATE materials SET ref_price_cents = 100 WHERE id = ${bare.id}`;
    const before = await stock(bare.id);
    const csv = ledger('台账', [row({ supplier: sup.name, name: bare.name, in1: [today, '1'], note: `stale ${Date.now()}` })]);
    const p = await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import/preview', { fileName: '改价.csv', csv });
    expect(p.body.rows[0]).toMatchObject({ priceCents: 100, priceFromRef: true });
    await ctx.sql`UPDATE materials SET ref_price_cents = 900 WHERE id = ${bare.id}`;
    const stale = await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import', { fileName: '改价.csv', csv, clientKey: randomUUID(), previewDigest: p.body.digest });
    expect(stale.body.error.code).toBe('IMPORT_STALE');
    expect(await stock(bare.id)).toBe(before);
    const p2 = await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import/preview', { fileName: '改价.csv', csv });
    const ok = await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import', { fileName: '改价.csv', csv, clientKey: randomUUID(), previewDigest: p2.body.digest });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.import.amountCents).toBe(900);
    await ctx.sql`UPDATE materials SET ref_price_cents = NULL WHERE id = ${bare.id}`;
  });

  it('组数封顶：入库超过 62 组整份拒绝（IMPORT_TOO_MANY）', async () => {
    const n = 63;
    const top = ['序号', '物料名称', ...Array.from({ length: n }, () => ['入库', '']).flat()];
    const sub = ['', '', ...Array.from({ length: n }, () => ['日期', '数量']).flat()];
    const csv = csvOf([['台账'], top, sub, ['1', mat.name, today, '1']]);
    const r = await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import/preview', { fileName: '太多.csv', csv });
    expect(r.body.error.code).toBe('IMPORT_TOO_MANY');
  });

  it('作废了编号的导入不再写', async () => {
    const lost = randomUUID();
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'ledger_import' })).body).toMatchObject({ abandoned: true });
    const csv = ledger('台账', [row({ supplier: sup.name, name: mat.name, in1: [today, '1'], price: '2' })]);
    expect((await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import', { fileName: '作废.csv', csv, clientKey: lost, previewDigest: '0'.repeat(64) })).body.error.code).toBe('OP_ABANDONED');
  });

  it('导出台账：这个月总仓的出入库，同一个版式；标题带「系统导出」，原样再导入被拒绝', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/inventory/ledger/export?month=${today.slice(0, 7)}`, headers: { cookie: keeper } });
    expect(res.statusCode).toBe(200);
    const s = readXlsx(res.rawPayload).sheets[0]!;
    const cells = (r: number) => [...(s.rows.get(r)?.values() ?? [])].map((c) => c.value ?? '');
    expect(cells(1)[0]).toContain('系统导出');
    const all = [...s.rows.keys()].filter((r) => r > 3).map(cells);
    const mine = all.find((r) => r.includes(mat.name))!;
    expect(mine).toContain('J-2');
    expect(mine.join('|')).toContain(`${dept.name} 张三`);
    const again = await api(ctx.app, keeper, 'POST', '/api/inventory/ledger/import/preview', { fileName: '导出.xlsx', xlsxBase64: res.rawPayload.toString('base64') });
    expect(again.body.error.code).toBe('IMPORT_EXPORTED');
    expect((await api(ctx.app, keeper, 'GET', '/api/inventory/ledger/export?month=2026-13')).status).toBe(400);
  });
});
