// 供应链二次整改（docs/ERP_ROUND2.md）：02 部门提需求的表格导入、01 集采模板按采购组的最终版。
// 02：模板三个工作表（需求表、填写说明、选项）带下拉与提示；逐行核对、写明哪一列为什么；有一行有问题整份不导入；
//     50 行一次导入成功；超过 50 行拆单；部门申购只能导自己部门的；同一份文件再导入要确认；操作编号重提只算一次、能查回、能作废。
// 01：模板就是最终版「品牌新增寻款采购清单」（标题行、表头、是否下单等的下拉）；按最终版填的表原样导入：表头自动找、
//     超链接取地址、数量里拆单位、用途原样记、线下已下单的默认不导入、部门在页面上选；8.0.1 旧模板照旧能导（见 purchasing-v801.test.ts）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shiftDate } from '@shared/labels';
import { DEPT_SHEET_COLUMNS, REQUEST_IMPORT_COLUMNS, REQUEST_IMPORT_TITLE, type DeptSheetPreview, type RequestImportPreview } from '@shared/requests';
import { todayIn } from '../src/server/lib/dates';
import { buildWorkbook } from '../src/server/lib/xlsx';
import { readXlsx, unzip } from '../src/server/lib/xlsx-read';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
let buyer: string; // 采购经办（审核需求单、集采导入）
let reqA: string; // 部门申购（客房部）
let deptA: number;
let deptB: number;
let today: string;
let mats: { id: number; code: string; name: string; purchaseUnit: string }[];
const q = (n: number) => Math.round(n * 1000);

const csvOf = (header: readonly string[], rows: (string | number)[][]) => [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
/** 部门需求表的一行（按 DEPT_SHEET_COLUMNS 的顺序） */
const deptRow = (o: Partial<Record<(typeof DEPT_SHEET_COLUMNS)[number], string | number>>) => DEPT_SHEET_COLUMNS.map((c) => o[c] ?? '');
const sheetPreview = (cookie: string, csv: string, name = '客房部补货.csv') => api(ctx.app, cookie, 'POST', '/api/erp/requests/sheet/preview', { fileName: name, csv });
const sheetImport = (cookie: string, csv: string, extra: Record<string, unknown> = {}, name = '客房部补货.csv') =>
  api(ctx.app, cookie, 'POST', '/api/erp/requests/sheet/import', { fileName: name, csv, clientKey: randomUUID(), ...extra });

beforeAll(async () => {
  ctx = await setup();
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  today = todayIn(ctx.config.timezone);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  const mk = async (name: string) => {
    await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name });
    return ((await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[]).find((d) => d.name === name)!.id;
  };
  deptA = await mk('客房部');
  deptB = await mk('水吧');
  await createStaff(ctx.sql, { username: 'sheet_a', displayName: '客房申购', role: 'backoffice', duties: ['request'], departmentId: deptA, password: PASSWORD, mustChangePassword: false });
  reqA = await login(ctx.app, 'sheet_a');
  mats = (await api(ctx.app, reqA, 'GET', '/api/erp/requests/meta')).body.materials;
  expect(mats.length).toBeGreaterThan(10);
}, 120_000);
afterAll(async () => ctx.close());

describe('部门表格导入（02）', () => {
  it('下载模板：需求表（表头一行，部门、物品、用途、优先级是下拉，点到单元格有提示）、填写说明、选项（部门、用途、物料档案）', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/erp/requests/sheet/template', headers: { cookie: reqA } });
    expect(res.statusCode).toBe(200);
    const book = readXlsx(res.rawPayload);
    expect(book.sheets.map((s) => s.name)).toEqual(['需求表', '填写说明', '选项']);
    const head = book.sheets[0]!.rows.get(1)!;
    expect(DEPT_SHEET_COLUMNS.map((_, c) => head.get(c)?.value)).toEqual([...DEPT_SHEET_COLUMNS]);
    expect(book.sheets[0]!.merges).toEqual([]);
    // 选项表：部门、用途、物料（名称与编号同一行）
    const opts = book.sheets[2]!.rows;
    const column = (c: number) => [...opts.keys()].filter((r) => r > 1).map((r) => opts.get(r)?.get(c)?.value).filter(Boolean);
    expect(column(0)).toEqual(expect.arrayContaining(['客房部', '水吧']));
    expect(column(1)).toContain('客用消耗');
    expect(column(3)).toContain(mats[0]!.code);
    // 下拉与提示写在需求表的数据验证里，部门、物品、用途引用选项表
    const files = unzip(res.rawPayload);
    const sheet1 = files.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    expect(sheet1).toContain('<formula1>opt_dept</formula1>');
    expect(sheet1).toContain('<formula1>opt_material</formula1>');
    expect(sheet1).toContain('<formula1>opt_purpose</formula1>');
    expect(sheet1).toContain('<formula1>"紧急,普通"</formula1>');
    expect(sheet1).toContain('promptTitle="物品名称（必填）"');
    const wb = files.get('xl/workbook.xml')!.toString('utf8');
    expect(wb).toMatch(/<definedName name="opt_material">'选项'!\$C\$2:\$C\$\d+<\/definedName>/);
    // 谁能提需求单谁就能下载、导入（GY07）；只管采购、不提需求单的账号不行
    expect((await ctx.app.inject({ method: 'GET', url: '/api/erp/requests/sheet/template', headers: { cookie: buyer } })).statusCode).toBe(403);
    expect((await api(ctx.app, buyer, 'POST', '/api/erp/requests/sheet/preview', { fileName: 'x.csv', csv: '物品名称,用途,数量\n纸巾,客用消耗,1' })).status).toBe(403);
  });

  it('逐行核对：有问题的行写明哪一列、为什么；有一行有问题整份不导入', async () => {
    const [m1, m2] = mats;
    const later = shiftDate(today, 5);
    const csv = csvOf(DEPT_SHEET_COLUMNS, [
      deptRow({ 序号: 1, 物品名称: m1!.name, 用途: '客用消耗', 数量: 20, 期望到货日期: later, 参考单价: '35.5', 参考链接: 'https://example.com/a' }),
      deptRow({ 序号: 2, 申请部门: '水吧', 物品名称: m2!.name, 用途: '客用消耗', 数量: 1 }),
      deptRow({ 序号: 3, 物品名称: '没有这种东西', 用途: '客用消耗', 数量: 1 }),
      deptRow({ 序号: 4, 物品名称: m1!.name, 用途: '买着玩', 数量: 1 }),
      deptRow({ 序号: 5, 物品名称: m1!.name, 用途: '客用消耗', 数量: 'abc' }),
      deptRow({ 序号: 6, 物品名称: m1!.name, 用途: '客用消耗', 数量: 1, 期望到货日期: shiftDate(today, -1) }),
      deptRow({ 序号: 7, 物品名称: m1!.name, 用途: '客用消耗', 数量: 1, 参考单价: '1.234' }),
      deptRow({ 序号: 8, 物品名称: m1!.name, 用途: '客用消耗', 数量: 1, 参考链接: 'www.example.com' }),
      deptRow({ 序号: 9, 物品名称: m1!.name, 用途: '客用消耗', 数量: 1, 采购优先级: '很急' }),
      deptRow({ 序号: 10, 物品名称: m1!.name, 物料编号: m2!.code, 用途: '客用消耗', 数量: 1 }),
      deptRow({ 序号: 11, 用途: '客用消耗', 数量: 1 }),
    ]);
    const p = (await sheetPreview(reqA, csv)).body as DeptSheetPreview;
    expect(p.rows).toHaveLength(11);
    expect(p.issueCount).toBe(10);
    expect(p.groups).toEqual([]);
    const issue = (row: number) => p.rows.find((r) => r.row === row)!.issues.join('；');
    // 第 1 行没问题：部门按自己的，物料按名称认，单位按档案的采购单位
    expect(p.rows[0]).toMatchObject({ issues: [], department: { id: deptA }, material: { id: m1!.id }, unit: m1!.purchaseUnit, needBy: later, refPriceCents: 3550, link: 'https://example.com/a', qtyMilli: q(20) });
    expect(issue(3)).toMatch(/^申请部门：只能给自己的部门（客房部）导入/);
    expect(issue(4)).toMatch(/^物品名称：「没有这种东西」不在物料档案里/);
    expect(issue(5)).toMatch(/^用途：「买着玩」不是固定选项/);
    expect(issue(6)).toMatch(/^数量：「abc」不对/);
    expect(issue(7)).toBe('期望到货日期：不能早于今天');
    expect(issue(8)).toMatch(/^参考单价：「1.234」不对/);
    expect(issue(9)).toBe('参考链接：要以 http 或 https 开头');
    expect(issue(10)).toMatch(/^采购优先级：只能写「紧急」或「普通」/);
    expect(issue(11)).toMatch(new RegExp(`^物料编号：「${m2!.code}」是「${m2!.name}」，与物品名称「${m1!.name}」对不上`));
    expect(issue(12)).toBe('物品名称：没填');

    const refused = await sheetImport(reqA, csv);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('IMPORT_INVALID');
    expect(refused.body.error.details.rows).toHaveLength(10);
    // 表头不对
    const wrong = await sheetPreview(reqA, '名称,数量\n纸巾,1');
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('IMPORT_COLUMNS');
  });

  it('50 行一次导入成功：一张待审核的需求单（来源「表格导入」），与手填的一样审核；超过 50 行按顺序拆单', async () => {
    const rows50 = Array.from({ length: 50 }, (_, i) => deptRow({ 序号: i + 1, 物品名称: mats[i % mats.length]!.name, 物料编号: mats[i % mats.length]!.code, 用途: '客用消耗', 数量: i + 1, 备注: `第 ${i + 1} 行` }));
    const csv = csvOf(DEPT_SHEET_COLUMNS, rows50);
    const p = (await sheetPreview(reqA, csv, '五十行.csv')).body as DeptSheetPreview;
    expect(p).toMatchObject({ issueCount: 0, previous: null, groups: [{ department: '客房部', priority: 'normal', needBy: null, lines: 50 }] });
    const done = await sheetImport(reqA, csv, {}, '五十行.csv');
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.import).toMatchObject({ rowCount: 50, requestCount: 1 });
    expect(done.body.request.id).toBe(done.body.requests[0].id);
    const r = (await api(ctx.app, reqA, 'GET', `/api/erp/requests/${done.body.request.id}`)).body;
    expect(r).toMatchObject({ status: 'submitted', source: 'sheet', department: { id: deptA }, note: '表格导入：五十行.csv' });
    expect(r.lines).toHaveLength(50);
    expect(r.lines[49]).toMatchObject({ materialId: mats[49 % mats.length]!.id, qtyMilli: q(50), note: '序号 50 · 第 50 行', purpose: '客用消耗' });
    // 采购照常审核
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/approve`, {})).status).toBe(200);

    // 60 行（50 普通 + 7 紧急 + 3 普通带日期）：普通的拆成 50 一张，紧急的、带日期的各一张
    const later = shiftDate(today, 3);
    const rows60 = [
      ...Array.from({ length: 53 }, (_, i) => deptRow({ 物品名称: mats[0]!.name, 物料编号: mats[0]!.code, 用途: '客用消耗', 数量: 1, 备注: `普通 ${i + 1}` })),
      ...Array.from({ length: 5 }, () => deptRow({ 物品名称: mats[1]!.name, 物料编号: mats[1]!.code, 用途: '客用消耗', 数量: 2, 采购优先级: '紧急' })),
      ...Array.from({ length: 2 }, () => deptRow({ 物品名称: mats[2]!.name, 物料编号: mats[2]!.code, 用途: '客用消耗', 数量: 3, 期望到货日期: later })),
    ];
    const csv60 = csvOf(DEPT_SHEET_COLUMNS, rows60);
    const p60 = (await sheetPreview(reqA, csv60, '六十行.csv')).body as DeptSheetPreview;
    expect(p60.groups.map((g) => [g.priority, g.needBy, g.lines])).toEqual([
      ['normal', null, 50],
      ['normal', null, 3],
      ['urgent', null, 5],
      ['normal', later, 2],
    ]);
    const d60 = await sheetImport(reqA, csv60, {}, '六十行.csv');
    expect(d60.status).toBe(201);
    expect(d60.body.requests.map((x: { lineCount: number; priority: string }) => [x.priority, x.lineCount])).toEqual([
      ['normal', 50],
      ['normal', 3],
      ['urgent', 5],
      ['normal', 2],
    ]);
    // 一份最多 500 行
    const tooMany = await sheetPreview(reqA, csvOf(DEPT_SHEET_COLUMNS, Array.from({ length: 501 }, () => deptRow({ 物品名称: mats[0]!.name, 用途: '客用消耗', 数量: 1 }))));
    expect(tooMany.body.error.code).toBe('IMPORT_TOO_MANY');
  });

  it('同一份文件再导入：提醒上次谁导入过，要确认；操作编号重提只算一次、能查回；确认作废后原请求不再登记', async () => {
    const csv = csvOf(DEPT_SHEET_COLUMNS, [deptRow({ 物品名称: mats[3]!.name, 物料编号: mats[3]!.code, 用途: '客用消耗', 数量: 4 })]);
    const key = randomUUID();
    const first = await api(ctx.app, reqA, 'POST', '/api/erp/requests/sheet/import', { fileName: '每周补货.csv', csv, clientKey: key });
    expect(first.status).toBe(201);
    // 同一个操作编号原样重提：原来那次的结果
    const again = await api(ctx.app, reqA, 'POST', '/api/erp/requests/sheet/import', { fileName: '每周补货.csv', csv, clientKey: key });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, import: { id: first.body.import.id }, request: { id: first.body.request.id } });
    // 「结果待确认」按部门需求单查回：找得到第一张需求单
    const look = await api(ctx.app, reqA, 'GET', `/api/erp/ops/${key}?type=purchase_request`);
    expect(look.body).toMatchObject({ found: true, refId: first.body.request.id });

    const p = (await sheetPreview(reqA, csv, '每周补货-副本.csv')).body as DeptSheetPreview;
    expect(p.previous).toMatchObject({ id: first.body.import.id, createdByName: '客房申购', requestCount: 1 });
    const unconfirmed = await sheetImport(reqA, csv, {}, '每周补货-副本.csv');
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.error.code).toBe('IMPORT_REPEAT');
    const confirmed = await sheetImport(reqA, csv, { confirmRepeat: true }, '每周补货-副本.csv');
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.import.id).not.toBe(first.body.import.id);

    // 确认作废以后，同一个编号的原请求晚到也不登记
    const lost = randomUUID();
    expect((await api(ctx.app, reqA, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'purchase_request', summary: '表格导入' })).status).toBe(200);
    const late = await api(ctx.app, reqA, 'POST', '/api/erp/requests/sheet/import', { fileName: '每周补货.csv', csv, clientKey: lost, confirmRepeat: true });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OP_ABANDONED');
    // 手填需求单用过的编号不能拿来导入
    const formKey = randomUUID();
    const form = await api(ctx.app, reqA, 'POST', '/api/erp/requests', { clientKey: formKey, lines: [{ materialId: mats[0]!.id, name: mats[0]!.name, purpose: '客用消耗', qtyMilli: q(1), unit: '个' }] });
    expect(form.status, JSON.stringify(form.body)).toBe(201);
    const reuse = await api(ctx.app, reqA, 'POST', '/api/erp/requests/sheet/import', { fileName: '每周补货.csv', csv, clientKey: formKey, confirmRepeat: true });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('店主、采购可以替别的部门导入；Excel 的日期序号与超链接都认', async () => {
    const book = buildWorkbook([
      {
        name: '需求表',
        widths: [],
        rows: [
          { cells: [...DEPT_SHEET_COLUMNS] },
          { cells: DEPT_SHEET_COLUMNS.map((c) => (c === '申请部门' ? '水吧' : c === '物品名称' ? mats[4]!.name : c === '物料编号' ? mats[4]!.code : c === '用途' ? '客用消耗' : c === '数量' ? 2.5 : c === '期望到货日期' ? excelSerial(shiftDate(today, 10)) : c === '参考链接' ? { v: '某宝商品页', link: 'https://item.example.com/x?id=1' } : null)) },
        ],
      },
    ]);
    const p = await api(ctx.app, boss, 'POST', '/api/erp/requests/sheet/preview', { fileName: '水吧.xlsx', xlsxBase64: book.toString('base64') });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.rows[0]).toMatchObject({ issues: [], department: { id: deptB, name: '水吧' }, qtyMilli: q(2.5), needBy: shiftDate(today, 10), link: 'https://item.example.com/x?id=1' });
    const done = await api(ctx.app, boss, 'POST', '/api/erp/requests/sheet/import', { fileName: '水吧.xlsx', xlsxBase64: book.toString('base64'), clientKey: randomUUID() });
    expect(done.status).toBe(201);
    expect(done.body.requests[0]).toMatchObject({ department: '水吧', lineCount: 1 });
    // 部门申购看不到别的部门的需求单：自己导入的这张也照样只在本部门
    expect((await api(ctx.app, reqA, 'GET', `/api/erp/requests/${done.body.request.id}`)).status).toBe(404);
  });
});

/** YYYY-MM-DD → Excel 日期序号（1900 日期系统） */
function excelSerial(iso: string) {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

describe('集采模板最终版（01）', () => {
  it('下载模板就是「品牌新增寻款采购清单」：标题行合并、表头一行、是否下单 / 到货 / 退货是下拉、冻结标题与表头，另有填写说明', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/erp/requests/import/template', headers: { cookie: buyer } });
    expect(res.statusCode).toBe(200);
    const book = readXlsx(res.rawPayload);
    expect(book.sheets.map((s) => s.name)).toEqual(['工作表1', '填写说明']);
    const s = book.sheets[0]!;
    expect(s.rows.get(1)!.get(0)!.value).toBe(REQUEST_IMPORT_TITLE);
    expect(s.merges).toEqual([{ r1: 1, c1: 0, r2: 1, c2: 9 }]);
    expect(REQUEST_IMPORT_COLUMNS.map((_, c) => s.rows.get(2)!.get(c)?.value)).toEqual([...REQUEST_IMPORT_COLUMNS]);
    const xml = unzip(res.rawPayload).get('xl/worksheets/sheet1.xml')!.toString('utf8');
    expect(xml).toContain('<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/>');
    for (const c of ['B', 'C', 'D']) expect(xml).toMatch(new RegExp(`type="list"[^>]*sqref="${c}3:${c}502"><formula1>"是,否"</formula1>`));
    expect(xml).toContain('promptTitle="采购数量（必填）"');
  });

  it('按最终版填的表原样导入：表头自动找、超链接取地址、数量里拆单位、用途原样记；线下已下单的默认不导入；部门在页面上选', async () => {
    const link1 = 'https://item.taobao.com/item.htm?id=929520192795';
    const link2 = 'https://detail.tmall.com/item.htm?id=807785650103';
    const link3 = 'https://detail.tmall.com/item.htm?id=1086143632280';
    const header = [...REQUEST_IMPORT_COLUMNS];
    const row = (o: Partial<Record<(typeof REQUEST_IMPORT_COLUMNS)[number], string | number | { v: string; link: string }>>) => REQUEST_IMPORT_COLUMNS.map((c) => o[c] ?? null);
    const rows = [
      row({ 序号: 1, 是否下单: '是', 是否到货: '是', 产品名称: '玻璃杯', 用途: '客房漱口', 采购数量: 19, 备注: '大货，样品有1', 产品详情: '水波杯【300ml】', 参考链接渠道: { v: 'dirty咖啡杯-淘宝网', link: link1 } }),
      row({ 序号: 2, 是否下单: '是', 是否到货: '是', 产品名称: '实木托盘', 用途: '客房桌面放置', 采购数量: 9, 备注: '大货，样品有1', 产品详情: '方舟托盘-炭烧黑30*24', 参考链接渠道: { v: '草木祠 实木托盘-tmall.com天猫', link: link2 } }),
      row({ 序号: 3, 产品名称: '垃圾桶（待定）', 用途: '淋浴间', 采购数量: 1, 备注: '样品采购', 产品详情: '植物基·米白（ESG减塑）', 参考链接渠道: { v: link3, link: link3 } }),
      row({ 序号: 4, 是否下单: '否', 产品名称: mats[5]!.name, 采购数量: '2箱', 参考链接渠道: '自采' }),
      row({ 序号: 5, 产品名称: '浴帽', 用途: '客房', 采购数量: '200 个', 参考链接渠道: '朋友推荐的厂家' }),
      row({ 序号: 6 }),
    ];
    const file = (extra: unknown[][] = []) =>
      buildWorkbook([{ name: '工作表1', widths: [], merges: ['A1:J1'], rows: [{ cells: [REQUEST_IMPORT_TITLE] }, { cells: header }, ...[...rows, ...extra].map((cells) => ({ cells: cells as never[] }))] }]).toString('base64');
    const preview = (b64: string, extra: Record<string, unknown> = {}) =>
      api(ctx.app, buyer, 'POST', '/api/erp/requests/import/preview', { fileName: '品牌新增寻款采购清单.xlsx', xlsxBase64: b64, departmentId: deptA, ...extra });

    // 有一行「是否下单」写错了：只能是、否或空着
    const bad = (await preview(file([row({ 序号: 7, 是否下单: '已下', 产品名称: '毛巾', 采购数量: 3 })]))).body as RequestImportPreview;
    expect(bad.issueCount).toBe(1);
    expect(bad.rows.find((r) => r.row === 9)!.issues).toEqual(['「是否下单」只能填是、否或空着（写的是「已下」）']);

    const b64 = file();
    const p = (await preview(b64)).body as RequestImportPreview;
    // 标题行不算；只填了序号的空行跳过
    expect(p.rows.map((r) => r.row)).toEqual([3, 4, 5, 6, 7]);
    expect(p).toMatchObject({ issueCount: 0, skippedCount: 2, duplicate: null });
    const [r1, , r3, r4, r5] = p.rows;
    expect(r1).toMatchObject({ skipped: true, offline: ['是否下单', '是否到货'], link: link1, unit: '个', qtyMilli: q(19), purpose: '客房漱口', department: { id: deptA } });
    expect(r3).toMatchObject({ skipped: false, offline: [], link: link3, details: '植物基·米白（ESG减塑）', purpose: '淋浴间', note: '样品采购' });
    expect(r4).toMatchObject({ skipped: false, offline: [], material: { id: mats[5]!.id }, qtyMilli: q(2), unit: '箱', channel: 'self', purpose: '其他', link: '' });
    expect(r5).toMatchObject({ qtyMilli: q(200), unit: '个', channel: null, details: '渠道：朋友推荐的厂家' });
    expect(p.groups).toEqual([{ department: '客房部', priority: 'normal', needBy: null, lines: 3 }]);
    // 勾「线下已下单的也导入」：都进来
    expect(((await preview(b64, { includeOffline: true })).body as RequestImportPreview).groups[0]!.lines).toBe(5);
    // 没选部门、表里也没有「申请部门」：每一行都要先选
    const noDept = (await preview(b64, { departmentId: null })).body as RequestImportPreview;
    expect(noDept.issueCount).toBe(3);
    expect(noDept.rows[2]!.issues).toEqual(['没选部门：在页面上选这份清单记在哪个部门']);

    const done = await api(ctx.app, buyer, 'POST', '/api/erp/requests/import', { fileName: '品牌新增寻款采购清单.xlsx', xlsxBase64: b64, departmentId: deptA, clientKey: randomUUID() });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.import).toMatchObject({ rowCount: 3, requestCount: 1, skippedCount: 2 });
    const req = (await api(ctx.app, buyer, 'GET', `/api/erp/requests/${done.body.requests[0].id}`)).body;
    expect(req).toMatchObject({ status: 'approved', source: 'import', department: { id: deptA } });
    expect(req.lines.map((l: { name: string; purpose: string; unit: string; link: string; details: string; note: string; channel: string | null }) => [l.name, l.purpose, l.unit, l.link, l.details, l.note, l.channel])).toEqual([
      ['垃圾桶（待定）', '淋浴间', '个', link3, '植物基·米白（ESG减塑）', '序号 3 · 样品采购', null],
      [mats[5]!.name, '其他', '箱', '', '', '序号 4', 'self'],
      ['浴帽', '客房', '个', '', '渠道：朋友推荐的厂家', '序号 5', null],
    ]);
    // 导入的新产品不要求链接和图片：需求单自检照常 ✓
    expect(((await api(ctx.app, buyer, 'GET', '/api/erp/requests/checks')).body as { ok: boolean }[]).every((c) => c.ok)).toBe(true);
    // 同一份文件只能导入一次（与部门表格导入不同）
    const dup = await api(ctx.app, buyer, 'POST', '/api/erp/requests/import', { fileName: '副本.xlsx', xlsxBase64: b64, departmentId: deptA, clientKey: randomUUID() });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('IMPORT_DUPLICATE');
    // 都标了线下已下单的：没有要导入的行
    const allOffline = buildWorkbook([{ name: '工作表1', widths: [], rows: [{ cells: [REQUEST_IMPORT_TITLE] }, { cells: header }, { cells: rows[0] as never[] }] }]).toString('base64');
    const none = await api(ctx.app, buyer, 'POST', '/api/erp/requests/import', { fileName: '只有已下单.xlsx', xlsxBase64: allOffline, departmentId: deptA, clientKey: randomUUID() });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('IMPORT_EMPTY');
  });
});
