// 采购台账、12 条账目自检、下单物料与带图片的 Excel、需求单导出（v0.7.9，飞书需求 RQ-005 第三步，见 docs/LEDGER.md）。

import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildXlsx, colName, crc32, imageSize } from '../src/server/lib/xlsx';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

/** 读 zip（只认本项目写出的格式）：文件名 → 内容，顺便核对 CRC */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lnameLen = buf.readUInt16LE(local + 26);
    const body = buf.subarray(local + 30 + lnameLen, local + 30 + lnameLen + size);
    const data = method === 0 ? Buffer.from(body) : inflateRawSync(body);
    expect(crc32(data), name).toBe(crc);
    out.set(name, data);
    p += 46 + nameLen;
  }
  return out;
}

// 最小的 PNG（2×1），文件头与尺寸是真的
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnxEJMAIAJF4C/3FpsJcAAAAASUVORK5CYII=', 'base64');
// 文件头像 JPEG 就行（服务端只核对文件头）；带一个 SOF0 段，读得出 40×30
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
  Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x1e, 0x00, 0x28, 0x01, 0x01, 0x11, 0x00]),
  Buffer.from('yuzu-ledger-image'),
]);

describe('Excel 生成（lib/xlsx）', () => {
  it('文字、数字、图片都写进去；= 开头的文字不会变成公式；列号换算正确', () => {
    expect([0, 25, 26, 27, 701, 702].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
    expect(imageSize(PNG)).toEqual({ width: 2, height: 1 });
    expect(imageSize(JPEG)).toEqual({ width: 40, height: 30 });
    const buf = buildXlsx({
      name: '下单物料',
      columns: [{ header: '图片' }, { header: '物料' }, { header: '数量' }],
      rows: [
        [null, '床单 <白色> & 大号', 2],
        [null, '=SUM(1,2)', 1.5],
      ],
      images: [
        { row: 0, col: 0, image: { data: JPEG, ext: 'jpeg' } },
        { row: 1, col: 0, image: { data: PNG, ext: 'png' } },
      ],
    });
    const files = unzip(buf);
    expect([...files.keys()]).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/drawings/drawing1.xml', 'xl/media/image1.jpeg', 'xl/media/image2.png']),
    );
    expect(files.get('xl/media/image1.jpeg')!.equals(JPEG)).toBe(true);
    const sheet = files.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    expect(sheet).toContain('床单 &lt;白色&gt; &amp; 大号');
    expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">=SUM(1,2)</t>');
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('<v>1.5</v>');
    expect(files.get('xl/drawings/drawing1.xml')!.toString('utf8').match(/<xdr:oneCellAnchor>/g)).toHaveLength(2);
    // 同样的内容生成同样的文件
    expect(buildXlsx({ name: 'a', columns: [{ header: 'x' }], rows: [['1']] }).equals(buildXlsx({ name: 'a', columns: [{ header: 'x' }], rows: [['1']] }))).toBe(true);
  });
});

let ctx: TestContext;
let today: string;
let boss: string; // 演示店主 linlan
let keeper: string; // 物资经办
let buyer: string; // 采购经办 + 对账付款
let coster: string; // 成本核算
let approver: string; // 负责人
let costerId: number;
let deptA: number;
let supplierId: number;
let mat: { id: number; name: string };
const q = (n: number) => Math.round(n * 1000);
const daysAgo = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  costerId = await createStaff(ctx.sql, { username: 'coster', displayName: '成本岗', role: 'backoffice', duties: ['cost'], password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'appr', displayName: '负责人', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
  coster = await login(ctx.app, 'coster');
  approver = await login(ctx.app, 'appr');
  await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name: '采购部' });
  deptA = ((await api(ctx.app, boss, 'GET', '/api/inventory/departments')).body as { id: number; name: string }[]).find((d) => d.name === '采购部')!.id;
  const sups = (await api(ctx.app, boss, 'GET', '/api/inventory/suppliers?all=1')).body as { id: number; code: string; name: string }[];
  const s4 = sups.find((s) => s.code === 'S004')!;
  supplierId = s4.id;
  await api(ctx.app, buyer, 'PUT', `/api/inventory/suppliers/${s4.id}`, { code: s4.code, name: s4.name, settlement: 'cash' });
  mat = ((await api(ctx.app, boss, 'GET', '/api/inventory/materials?all=1')).body as { id: number; code: string; name: string }[]).find((m) => m.code === 'M016')!;
}, 120_000);
afterAll(async () => ctx.close());

const advance = (amountCents: number, date = today) =>
  api(ctx.app, coster, 'POST', '/api/erp/petty/advances', {
    clientKey: randomUUID(),
    departmentId: deptA,
    handlerId: costerId,
    advanceDate: date,
    amountCents,
    method: 'wechat',
    evidence: '转账尾号 0001',
  });

const claim = (body: Record<string, unknown>) =>
  api(ctx.app, coster, 'POST', '/api/erp/expenses', {
    clientKey: randomUUID(),
    expenseDate: today,
    departmentId: deptA,
    handlerId: costerId,
    purpose: '办公',
    paySource: 'company',
    invoiceType: 'receipt',
    taxRateBp: 0,
    lines: [{ name: '打印纸', category: 'office', unit: '包', boughtMilli: q(2), receivedMilli: q(2), amountCents: 6_000 }],
    ...body,
  });

const newPo = async (body: Record<string, unknown> = {}) => {
  const po = (
    await api(ctx.app, buyer, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      supplierId,
      orderDate: today,
      lines: [{ materialId: mat.id, purchaseQtyMilli: q(1), priceCents: 45_000 }],
      ...body,
    })
  ).body.po;
  await api(ctx.app, approver, 'POST', `/api/purchase-orders/${po.id}/approve`, {});
  return po as { id: number; docNo: string; lines: { id: number }[] };
};

describe('采购台账（按日逐笔）', () => {
  it('打款、报销明细、退回按日期逐笔列出，每天小计；合计按全部算；导出 CSV；权限按矩阵', async () => {
    const a = (await advance(50_000)).body.advance;
    const c1 = (await claim({ paySource: 'petty', advanceId: a.id })).body.claim;
    await claim({ lines: [{ name: '扫把', category: 'low_value', unit: '把', boughtMilli: q(3), receivedMilli: q(3), amountCents: 4_500 }] });
    await api(ctx.app, coster, 'POST', '/api/erp/petty/settlements', {
      clientKey: randomUUID(), advanceId: a.id, kind: 'return', settleDate: today, amountCents: 44_000, method: 'cash', evidence: '现金当面点清',
    });

    const ledger = (await api(ctx.app, keeper, 'GET', `/api/erp/ledger?from=${today}&to=${today}`)).body;
    expect(ledger.truncated).toBe(false);
    const day = ledger.days.find((d: { date: string }) => d.date === today);
    expect(day.entries.map((e: { kind: string }) => e.kind)).toEqual(['advance', 'expense', 'expense', 'return']);
    const pettyLine = day.entries.find((e: { docNo: string }) => e.docNo === c1.docNo);
    expect(pettyLine).toMatchObject({ kind: 'expense', paySource: 'petty', advanceNo: a.docNo, description: '打印纸', category: 'office', amountCents: 6_000 });
    expect(day.totals).toMatchObject({ advanceCents: 50_000, pettySpentCents: 6_000, companySpentCents: 4_500, returnedCents: 44_000, toppedUpCents: 0 });
    expect(ledger.totals).toEqual(day.totals);

    // 导出：物资经办只能看不能导出；成本核算可以
    expect((await api(ctx.app, keeper, 'GET', `/api/erp/ledger/export?from=${today}&to=${today}`)).status).toBe(403);
    const csv = await api(ctx.app, coster, 'GET', `/api/erp/ledger/export?from=${today}&to=${today}`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('支出（备用金）');
    expect(String(csv.body)).toContain(c1.docNo);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/erp/ledger?from=${today}&to=${today}`)).status).toBe(403);
    expect((await api(ctx.app, coster, 'GET', `/api/erp/ledger?from=${today}&to=${daysAgo(1)}`)).status).toBe(400);
  });
});

describe('下单物料（库管）', () => {
  it('已确认的采购单每一行：规格、图片、已到、超期；导出带图片的 Excel 与 CSV；店员看不到', async () => {
    const img = (await api(ctx.app, buyer, 'POST', '/api/erp/images', { mime: 'image/jpeg', data: JPEG.toString('base64') })).body;
    const po = await newPo({ orderDate: daysAgo(10), expectedDate: daysAgo(3), lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45_000, spec: '白色 80×180', imageIds: [img.id] }] });
    const list = (await api(ctx.app, keeper, 'GET', `/api/purchase-orders/ordered-lines?from=${daysAgo(30)}&to=${today}`)).body;
    const line = list.lines.find((l: { poId: number }) => l.poId === po.id);
    expect(line).toMatchObject({ docNo: po.docNo, spec: '白色 80×180', state: 'open', dueDate: daysAgo(3), overdue: true, images: [{ id: img.id }] });
    const overdue = (await api(ctx.app, keeper, 'GET', `/api/purchase-orders/ordered-lines?from=${daysAgo(30)}&to=${today}&state=overdue`)).body;
    expect(overdue.lines.map((l: { poId: number }) => l.poId)).toContain(po.id);

    const res = await ctx.app.inject({ method: 'GET', url: `/api/purchase-orders/ordered-lines/export.xlsx?from=${daysAgo(30)}&to=${today}`, headers: { cookie: keeper } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const files = unzip(res.rawPayload);
    expect([...files.values()].some((b) => b.equals(JPEG))).toBe(true);
    expect(files.get('xl/worksheets/sheet1.xml')!.toString('utf8')).toContain(po.docNo);
    const csv = await api(ctx.app, keeper, 'GET', `/api/purchase-orders/ordered-lines/export.csv?from=${daysAgo(30)}&to=${today}`);
    expect(String(csv.body)).toContain('白色 80×180');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/purchase-orders/ordered-lines?from=${today}&to=${today}`)).status).toBe(403);
  });
});

describe('12 条账目自检', () => {
  it('录入时拦截的规则都是 0；每日预警列出没有采购单的备用金报销、未平与超期的打款、超期未到货、同一天重复下单', async () => {
    const old = (await advance(30_000, daysAgo(12))).body.advance;
    await claim({ paySource: 'petty', advanceId: old.id, expenseDate: daysAgo(11) });
    await newPo({ orderDate: daysAgo(2) });
    await newPo({ orderDate: daysAgo(2) });
    // 约定到货天数改成 1 天：没有预计到货日的也算超期
    const rules = (await api(ctx.app, boss, 'GET', '/api/erp/expenses/rules')).body;
    expect(rules.arrivalOverdueDays).toBe(7);
    expect((await api(ctx.app, boss, 'PUT', '/api/erp/expenses/rules', { ...rules, arrivalOverdueDays: 1 })).status).toBe(200);

    const audit = (await api(ctx.app, keeper, 'GET', '/api/erp/audit')).body;
    expect(audit.rules.map((r: { no: number }) => r.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const rule = (no: number) => audit.rules.find((r: { no: number }) => r.no === no);
    for (const no of [1, 5, 6, 7, 8, 11, 12]) expect(rule(no), `第 ${no} 条`).toMatchObject({ kind: 'block', ok: true, count: 0 });
    expect(rule(2)).toMatchObject({ kind: 'warn', ok: false });
    expect(rule(2).items.some((i: { text: string }) => i.text.includes(old.docNo))).toBe(true);
    expect(rule(3).items.some((i: { date: string }) => i.date === daysAgo(12))).toBe(true);
    expect(rule(4).items.some((i: { text: string; link: { id: number } }) => i.link.id === old.id && i.text.includes('未退回'))).toBe(true);
    expect(rule(9).count).toBeGreaterThanOrEqual(2);
    expect(rule(10).items.some((i: { date: string }) => i.date === daysAgo(2))).toBe(true);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/erp/audit')).status).toBe(403);

    // 部门档案拼在一起：第 7 条列出来
    await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name: '前厅/水吧' });
    expect((await api(ctx.app, keeper, 'GET', '/api/erp/audit')).body.rules.find((r: { no: number }) => r.no === 7)).toMatchObject({ ok: false, count: 1 });
  });
});

describe('需求单导出', () => {
  it('每一行需求一行，带进度；导出权限与报销、台账相同', async () => {
    await createStaff(ctx.sql, { username: 'req_a', displayName: '采购部申购', role: 'backoffice', duties: ['request'], departmentId: deptA, password: PASSWORD, mustChangePassword: false });
    const reqA = await login(ctx.app, 'req_a');
    const r = await api(ctx.app, reqA, 'POST', '/api/erp/requests', {
      clientKey: randomUUID(),
      lines: [{ materialId: mat.id, name: mat.name, purpose: '客用消耗', qtyMilli: q(2), unit: '箱', details: '加厚' }],
    });
    expect(r.status).toBe(201);
    expect((await api(ctx.app, reqA, 'GET', `/api/erp/requests/export?from=${today}&to=${today}`)).status).toBe(403);
    const csv = await api(ctx.app, coster, 'GET', `/api/erp/requests/export?from=${today}&to=${today}`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain(r.body.request.docNo);
    expect(String(csv.body)).toContain('未下单');
  });
});
