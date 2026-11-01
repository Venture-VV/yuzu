// 8–10 月旧账只读对照（v0.7.10，见 docs/LEGACY_LEDGER.md）：读 Excel、认出四份表、导入只读表、核验结果按固定预期核对。
// 只用合成样例（legacy-samples）；原始文件是真实业务数据，不进 Git。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LegacyAudit } from '../src/shared/legacy';
import expected from '../src/server/demo/legacy-expected.json';
import { DEFAULT_EXPENSE_RULES } from '../src/shared/expenses';
import { legacyBrandLink, legacyInvoiceType, type LegacyBrandLine, type LegacyMaterialLine } from '../src/shared/legacy';
import { parseExact, toSignificant } from '../src/server/lib/exact';
import { evalArithmetic, excelNumber, parseDateText, toCents } from '../src/server/modules/legacy/parse';
import { legacyAudit, legacyInvoiceIssue, type LegacyData } from '../src/server/modules/legacy/audit';
import { applyLegacyImport, fileMeta, legacyChecks, LegacyParseError, parseLegacyWorkbook, voidLegacyImport } from '../src/server/modules/legacy';
import { buildWorkbook, legacySampleFiles, solidPng } from '../src/server/modules/legacy/samples';
import { parseRef, readXlsx, serialToDate } from '../src/server/lib/xlsx-read';
import { buildXlsx } from '../src/server/lib/xlsx';
import { createStaff } from '../src/server/modules/staff';
import { seedLegacyDemo } from '../src/server/seed-legacy';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

describe('读 Excel 与规整', () => {
  it('单元格引用、日期序号、四则运算公式、元换分、文字日期', () => {
    expect(parseRef('J3')).toEqual({ row: 3, col: 9 });
    expect(parseRef('AA10')).toEqual({ row: 10, col: 26 });
    expect(serialToDate(46265)).toBe('2026-08-31');
    expect(serialToDate(46317)).toBe('2026-10-22');
    const cents = (formula: string) => toCents(evalArithmetic(formula)!);
    expect(cents('=-1234.5-678.9-10.6')).toBe(-192400);
    expect(cents('1999+12.34+56.78')).toBe(206812);
    expect(evalArithmetic('(1+2)*3/2')).toEqual({ n: 9n, d: 2n });
    expect(cents('10/3')).toBe(333);
    expect(evalArithmetic('B2+B3')).toBeNull();
    expect(evalArithmetic('1+')).toBeNull();
    expect(evalArithmetic('1/0')).toBeNull();
    expect(toCents(parseExact('-1924.04')!)).toBe(-192404);
    expect(toCents(parseExact('0.5')!)).toBe(50);
    expect(toCents(parseExact('-0.005')!)).toBe(-1);
    expect(parseExact('1.5E-3')).toEqual({ n: 3n, d: 2000n });
    expect(parseExact('.5')).toEqual({ n: 1n, d: 2n });
    expect(parseExact('-')).toBeNull();
    expect(parseExact('1e999')).toBeNull();
    expect(toSignificant(parseExact('12345678901234567890')!, 15)).toEqual({ n: 12345678901234600000n, d: 1n });
  });

  it('公式与金额用精确的十进制算，不经过二进制浮点数（Codex PR #26 P1）', () => {
    const cents = (formula: string) => toCents(evalArithmetic(formula)!);
    // 用浮点数算是 0.99499… → 99 分、0.00499… → 0 分
    expect(cents('1.005-0.01')).toBe(100);
    expect(cents('4.1-4.095')).toBe(1);
    expect(cents('64.005-18.51')).toBe(4550);
    // 文件里存的数按 Excel 的 15 位有效数字读（与在 Excel 里看到的一致）
    expect(toCents(excelNumber('2068.1199999999998')!)).toBe(206812);
    expect(toCents(excelNumber('1.0049999999999999')!)).toBe(101);
    expect(toCents(excelNumber('0.30000000000000004')!)).toBe(30);
    expect(toCents(excelNumber('-3500')!)).toBe(-350000);
    expect(parseDateText('2026/9/4')).toBe('2026-09-04');
    expect(parseDateText('2026年9月4日')).toBe('2026-09-04');
    expect(parseDateText('2026-02-30')).toBeNull();
    expect(parseDateText('9.4')).toBeNull();
  });

  it('读出合成样例的共享字符串、公式、合并格、超链接与 WPS 单元格图', () => {
    const [ledger, , ordered, brand] = legacySampleFiles();
    const wb = readXlsx(ledger!.data);
    expect(wb.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Sheet2']);
    const s1 = wb.sheets[0]!;
    expect(s1.rows.get(4)!.get(4)).toMatchObject({ formula: '-3000-500', value: '-3500' });
    expect(s1.rows.get(15)!.get(4)).toMatchObject({ formula: '-1500-500', value: null });
    expect(s1.merges).toContainEqual({ r1: 8, c1: 4, r2: 9, c2: 4 });
    expect(readXlsx(brand!.data).sheets[0]!.hyperlinks.get('J3')).toBe('https://example.com/sample/1');
    const ow = readXlsx(ordered!.data);
    expect(ow.cellImages.size).toBe(2);
    expect(ow.cellImages.get('ID_SAMPLE_A')!.data.equals(solidPng(0x2f, 0x6f, 0x5e))).toBe(true);
  });

  it('认出四份表；行数、合计行、单元格图与固定预期一致；认不出的文件整份拒绝', () => {
    const parsed = legacySampleFiles().map((f) => parseLegacyWorkbook(f.data));
    expect(parsed.map((p) => p.source)).toEqual(['purchase_ledger', 'material_detail', 'ordered_materials', 'brand_requests']);
    for (const p of parsed) {
      const want = expected.files[p.source as keyof typeof expected.files];
      expect(Object.fromEntries(p.sheets.map((s) => [s.name, s.rows])), p.source).toEqual(want.sheets);
    }
    expect(parsed[0]!.fileTotals).toEqual(expected.files.purchase_ledger.fileTotals);
    expect(parsed[2]!.images.size).toBe(expected.files.ordered_materials.images);
    const ledger = parsed[0]!.ledger;
    expect(ledger.filter((l) => l.preHeader)).toHaveLength(expected.ledger.preHeaderRows);
    expect(ledger.find((l) => l.rowNo === 9)).toMatchObject({ amountCents: null, mergedInto: 8 });
    expect(ledger.find((l) => l.rowNo === 15)).toMatchObject({ amountCents: -200000, amountFormula: '-1500-500' });
    expect(ledger.find((l) => l.rowNo === 18)).toMatchObject({ date: '2026-09-04', dateText: '2026/9/4' });
    // 没存结果的公式按精确的十进制算
    expect(ledger.find((l) => l.rowNo === 7)).toMatchObject({ amountCents: 4550, amountFormula: '64.005-18.51' });
    const ordered = parsed[2]!.ordered;
    expect(ordered.find((o) => o.rowNo === 4)).toMatchObject({ imageKey: 'ID_SAMPLE_B', imageShared: true });
    expect(ordered.find((o) => o.rowNo === 5)).toMatchObject({ imageKey: null });
    const brand = parsed[3]!.brand;
    expect(brand.find((b) => b.rowNo === 3)).toMatchObject({ ordered: true, received: true, returned: false, linkUrl: 'https://example.com/sample/1' });
    // 能点开的链接：超链接、分享文字里的网址；只写了店铺名称的没有链接
    expect(brand.map((b) => [b.rowNo, legacyBrandLink(b)])).toEqual([
      [3, 'https://example.com/sample/1'],
      [4, 'https://example.com/sample/2'],
      [5, 'https://example.com/sample/3'],
      [6, null],
      [7, null],
    ]);

    const other = buildXlsx({ name: '随便一张表', columns: [{ header: '姓名' }, { header: '电话' }], rows: [['张三', '1']] });
    expect(() => parseLegacyWorkbook(other)).toThrow(LegacyParseError);
    expect(() => parseLegacyWorkbook(Buffer.from('not a zip'))).toThrow(LegacyParseError);
  });

  it('认出是哪份表后，其余写了东西的表认不出就整份拒绝（不悄悄少导入一个月）；空白的表跳过（Codex PR #26）', () => {
    const header = ['序号', '购买日期', '物品名', '用途', '金额', '购买数量', '到货数量', '部门', '发票（专票、普票）', '税点', '备注（办公费、固定资产、低值易耗等）'];
    const row = [1, 46265, '样例-水杯', null, 9.9, 2, 2, '餐厅', '普票', 0.01, '固定资产'];
    const month = (name: string, h: string[]) => ({ name, rows: { 1: ['采购物资明细表（合成样例）'], 2: h, 3: row } });
    const renamed = header.map((h) => (h === '物品名' ? '品名' : h));
    const err = (() => {
      try {
        parseLegacyWorkbook(buildWorkbook([month('8月', header), month('9月', renamed), month('10月', header)]));
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(LegacyParseError);
    expect((err as Error).message).toContain('「9月」第 2 行的表头缺「物品名」');
    expect((err as Error).message).toContain('整份没有导入');
    // 完全空白的表（WPS 默认带的 Sheet3）跳过；三张都认得出就照常导入
    const ok = parseLegacyWorkbook(buildWorkbook([month('8月', header), month('9月', header), { name: 'Sheet3', rows: {} }]));
    expect(ok.sheets.map((s) => s.name)).toEqual(['8月', '9月']);
    // 已下单物料同样：11 月的表头改了名
    const ordered = ['下单时间', '产品名称', '图片', '选款', '部门', '下单人', '数量', '金额', '备注'];
    const orderedBad = ordered.map((h) => (h === '下单人' ? '经办人' : h));
    expect(() =>
      parseLegacyWorkbook(buildWorkbook([{ name: '10月', rows: { 1: ordered, 2: [46318, '样例-芝士'] } }, { name: '11月', rows: { 1: orderedBad, 2: [46330, '样例-乳酪'] } }])),
    ).toThrow('「11月」第 1 行的表头缺「下单人」');
    // 品牌清单只导入一张：另一张写了东西又认不出也拒绝
    expect(() => parseLegacyWorkbook(buildWorkbook([{ name: '工作表1', rows: { 1: ['标题'], 2: ['序号', '是否下单', '是否到货', '是否退货', '产品名称', '用途', '采购数量', '备注', '产品详情', '参考链接渠道'], 3: [1] } }, { name: '备忘', rows: { 1: ['随手记'] } }]))).toThrow(
      '「备忘」前 6 行认不出表头',
    );
  });
});

describe('核验规则（纯计算）', () => {
  const types = DEFAULT_EXPENSE_RULES.invoiceTypes;
  const mat = (i: number, extra: Partial<LegacyMaterialLine> = {}): LegacyMaterialLine => ({
    sheet: '8月', rowNo: i + 3, seq: String(i + 1), date: '2026-08-31', dateText: '', item: `样例-${i}`, purpose: '', amountCents: 100, amountFormula: null,
    boughtText: '', boughtMilli: null, receivedText: '', receivedMilli: null, department: '保洁', invoice: '普票', taxText: '0.01', taxRateBp: 100,
    category: '低值易耗', mergedInto: null, raw: {}, ...extra,
  });
  const brandLine = (rowNo: number, extra: Partial<LegacyBrandLine>): LegacyBrandLine => ({
    rowNo, seq: String(rowNo), ordered: false, received: false, returned: false, product: '样例-杯', purpose: '客房', qtyText: '1', qtyMilli: 1000, note: '', details: '', linkText: '', linkUrl: '', raw: {}, ...extra,
  });
  const data = (over: Partial<LegacyData>): LegacyData => ({
    imported: ['material_detail', 'brand_requests'], ledger: [], ledgerSheet: '', payments: [], paymentSheet: '', materials: [], materialSheets: [{ name: '8月', rows: 0 }],
    ordered: [], brand: [], brandSheet: '工作表1', brandTableRows: 0, invoiceTypes: types, ...over,
  });

  it('第 5 条：发票写法换成新账字典的类别，再核对税点（Codex PR #26）', () => {
    expect(legacyInvoiceType('普通', types)?.key).toBe('vat_normal');
    expect(legacyInvoiceType('专 票', types)?.key).toBe('vat_special');
    expect(legacyInvoiceType('增值税普通发票', types)?.key).toBe('vat_normal');
    expect(legacyInvoiceType('电子票', types)).toBeNull();
    const issue = (invoice: string, taxText: string, taxRateBp: number | null) => legacyInvoiceIssue({ invoice, taxText, taxRateBp }, types);
    expect(issue('普票', '0.01', 100)).toBeNull();
    expect(issue('专票', '0.13', 1300)).toBeNull();
    expect(issue('无票', '', null)).toBeNull();
    expect(issue('收据', '0.13', 1300)).toMatchObject({ kind: 'rate' });
    expect(issue('专票', '0', 0)).toMatchObject({ kind: 'rate' });
    expect(issue('专票', '', null)).toMatchObject({ kind: 'missing' });
    expect(issue('', '', null)).toMatchObject({ kind: 'missing', why: '发票与税点都没填' });
    expect(issue('电子票', '0.01', 100)).toMatchObject({ kind: 'unknown' });
    expect(issue('普票', '免税', null)).toMatchObject({ kind: 'unknown' });

    const audit = legacyAudit(data({ materials: [mat(0), mat(1, { invoice: '收据', taxText: '0.13', taxRateBp: 1300 }), mat(2, { invoice: '', taxText: '', taxRateBp: null })] }));
    const r5 = audit.rules.find((r) => r.no === 5)!;
    expect(r5.count).toBe(2);
    expect(r5.result).toContain('2 行对不上（1 行没填、0 行写法认不出、1 行税点不在这类发票的范围里）');
    expect(r5.rows.map((r) => r.rowNo)).toEqual([4, 5]);
    // 店主在模块设置里给收据加上 13% 后就对得上
    const loose = types.map((t) => (t.key === 'receipt' ? { ...t, taxRatesBp: [0, 1300] } : t));
    expect(legacyAudit(data({ materials: [mat(1, { invoice: '收据', taxText: '0.13', taxRateBp: 1300 })], invoiceTypes: loose })).rules.find((r) => r.no === 5)!.count).toBe(0);
  });

  it('第 6 条：问题行超过 300 行时，条数按全部行算，只列前 300 行（Codex PR #26）', () => {
    const audit = legacyAudit(data({ materials: Array.from({ length: 301 }, (_, i) => mat(i, { category: '耗材' })) }));
    const r6 = audit.rules.find((r) => r.no === 6)!;
    expect(r6.count).toBe(301);
    expect(r6.rows).toHaveLength(300);
  });

  it('第 12 条与品牌清单完整度：只写了商品、店铺名称没有网址的算没有链接（Codex PR #26）', () => {
    const brand = [
      brandLine(3, { linkText: '样例店铺 玻璃杯', linkUrl: 'https://example.com/a' }),
      brandLine(4, { linkText: '样例店铺 托盘' }),
      brandLine(5, { linkText: '【样例】托盘 https://example.com/b 点击链接直接打开' }),
      brandLine(6, { linkText: 'javascript:alert(1)' }),
      brandLine(7, { linkUrl: 'ftp://example.com/c' }),
    ];
    const audit = legacyAudit(data({ imported: ['brand_requests'], brand, brandTableRows: 5 }));
    const r12 = audit.rules.find((r) => r.no === 12)!;
    expect(r12.rows.map((r) => r.rowNo)).toEqual([4, 6, 7]);
    expect(r12.rows[0]!.text).toContain('只写了「样例店铺 托盘」，没有能点开的网址');
    expect(audit.overview.find((o) => o.source === 'brand_requests')!.problems).toContain('3 行缺链接 / 用途 / 数量');
  });
});

let ctx: TestContext;
let keeper: string; // 物资经办：能看费用（只读）

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'keeper', displayName: '物资经办', role: 'backoffice', duties: ['stock'], password: PASSWORD, mustChangePassword: false });
  keeper = await login(ctx.app, 'keeper');
}, 120_000);
afterAll(async () => ctx.close());

const get = async (cookie: string, url: string) => (await api(ctx.app, cookie, 'GET', url)).body;

describe('导入只读表与核验', () => {
  it('四份合成样例导入后，核验页的每一个数与固定预期一致；店员看不到', async () => {
    const r = await seedLegacyDemo(ctx.sql, { env: 'test' });
    expect(r.skipped).toBe(false);
    expect((await seedLegacyDemo(ctx.sql, { env: 'test' })).skipped).toBe(true);
    await expect(seedLegacyDemo(ctx.sql, { env: 'trial' })).rejects.toThrow('试用');
    await expect(seedLegacyDemo(ctx.sql, { env: 'production' })).rejects.toThrow('正式');

    const audit = (await get(keeper, '/api/erp/legacy/audit')) as LegacyAudit;
    expect(audit.imported).toEqual(['purchase_ledger', 'material_detail', 'ordered_materials', 'brand_requests']);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/erp/legacy/audit')).status).toBe(403);

    // 一、总览
    const ov = (label: string) => audit.overview.find((o) => o.label === label)!;
    expect(ov('采购台账（费用报销明细）')).toMatchObject({ rows: expected.ledger.rows, amountText: '-¥2,924.51（净）' });
    expect(ov('采购台账（费用报销明细）').problems).toContain(`${expected.ledger.noAmount} 行无金额、${expected.ledger.noDate} 行无日期、${expected.ledger.noCategory} 行无类别`);
    expect(ov('采购台账（付款台账）')).toMatchObject({ rows: expected.payments.days, amountText: '打款 ¥8,800.00 / 应退回 ¥6,170.50 / 实际退回 ¥6,250.00' });
    expect(ov('采购物资明细表')).toMatchObject({ rows: expected.materials.rows, amountText: '¥1,290.40' });
    expect(ov('采购物资明细表').problems).toContain(`用途列 ${expected.materials.noPurpose}/${expected.materials.rows} 未填`);
    expect(ov('已下单物料')).toMatchObject({ rows: expected.ordered.rows, amountText: '¥357.70' });
    expect(ov('品牌新增寻款采购清单')).toMatchObject({ rows: expected.brand.tableRows, amountText: `数量合计 ${expected.brand.qty}` });
    expect(ov('品牌新增寻款采购清单').problems).toContain(`${expected.brand.incomplete} 行缺链接`);

    // 二、三套账之间的差额
    const cross = (key: string) => audit.crossChecks.find((c) => c.key === key)!.detail;
    expect(cross('payout_vs_payment')).toContain(`台账 ${expected.ledger.payoutRows} 行大额负数（推定打款）合计 ¥4,500.00`);
    expect(cross('payout_vs_payment')).toContain('差 ¥4,300.00 未进台账');
    expect(cross('spend_vs_payout')).toContain('净支出 ¥2,575.49');
    expect(cross('spend_vs_payout')).toContain('打款比支出多 ¥6,224.51');
    expect(cross('should_vs_returned')).toContain('多退 ¥79.50');
    expect(cross('should_vs_returned')).toContain(`${expected.crossChecks.shouldNoReturnDays} 天记录了应退回但没记实际退回，涉及 ¥20.50`);
    expect(cross('ledger_vs_material')).toContain('8–9 月台账净支出 ¥2,529.99，明细表 ¥1,290.40，差 ¥1,239.59');
    expect(cross('october')).toContain('已下单 ¥357.70');

    // 三、每日平账
    expect(audit.daily).toMatchObject({ unbalanced: expected.daily.unbalanced, tail: expected.daily.tail, zeroAdvanceWithSpend: expected.daily.zeroAdvanceWithSpend });
    expect(Object.fromEntries(audit.daily!.days.map((d) => [d.date, d.diffCents]))).toEqual(expected.daily.diffs);

    // 四、字段与口径问题
    const field = (key: string) => audit.fieldIssues.find((f) => f.key === key)!;
    expect(field('mixed_negatives').detail).toContain(`${expected.ledger.unclearRows} 行正好 -¥1,000.00 无法判断`);
    expect(field('material_missing').detail).toBe(`${expected.materials.noAmount} 行无金额、${expected.materials.noItem} 行无物品名`);
    expect(field('invoice_tax').detail).toContain(`发票写法 ${expected.materials.invoiceSpellings} 种`);
    expect(field('invoice_tax').detail).toContain(`「（空） （空）」${expected.materials.emptyInvoiceTax} 行（对不上字典）`);
    expect(field('invoice_tax').detail).toContain('「收据 3%」1 行（对不上字典）');
    expect(field('category_synonyms').detail).toContain(`有 ${expected.materials.categoryVariants} 种写法`);
    expect(field('category_synonyms').count).toBe(expected.materials.categorySynonymRows);
    expect(field('department_text').detail).toContain(`${expected.materials.joinedDepartments} 行把几个部门拼在一起`);
    expect(field('department_text').detail).toContain(`${expected.materials.costInDepartment} 行把费用类别写进部门`);
    expect(field('brand_status').count).toBe(expected.brand.orderedNotReceived);

    // 五、12 条规则在旧账上
    expect(Object.fromEntries(audit.rules.map((r) => [String(r.no), r.count]))).toEqual(expected.rules);
    const rule3 = audit.rules.find((r) => r.no === 3)!;
    expect(rule3.rows[0]!.text).toContain('2026-09-02');
    const inv = expected.materials.invoiceIssues;
    expect(audit.rules.find((r) => r.no === 5)!.result).toContain(
      `${expected.rules['5']} 行对不上（${inv.missing} 行没填、${inv.unknown} 行写法认不出、${inv.rate} 行税点不在这类发票的范围里）`,
    );
    expect(audit.rules.find((r) => r.no === 12)!.rows.map((r) => r.text).join('；')).toContain('只写了「样例店铺 香薰」，没有能点开的网址');
  });

  it('逐行接口、原图；只读表不能改不能删；同一个文件再导入返回原来那次；换文件要写原因', async () => {
    const ledger = await get(keeper, '/api/erp/legacy/rows/purchase_ledger');
    expect(ledger.ledger).toHaveLength(expected.files.purchase_ledger.sheets.Sheet1);
    expect(ledger.payments).toHaveLength(expected.files.purchase_ledger.sheets.Sheet2);
    expect(ledger.ledger[0]).toMatchObject({ rowNo: 4, preHeader: true, raw: { 金额: '=-3000-500 → -3500' } });
    const ordered = await get(keeper, '/api/erp/legacy/rows/ordered_materials');
    const withImage = ordered.ordered.find((o: { rowNo: number }) => o.rowNo === 2);
    const img = await ctx.app.inject({ method: 'GET', url: `/api/erp/legacy/images/${withImage.imageId}`, headers: { cookie: keeper } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.equals(solidPng(0x2f, 0x6f, 0x5e))).toBe(true);
    expect((await api(ctx.app, keeper, 'GET', '/api/erp/legacy/rows/nope')).status).toBe(400);

    await expect(ctx.sql`UPDATE legacy_ledger_lines SET amount_cents = 1 WHERE row_no = 5`).rejects.toThrow('只追加');
    await expect(ctx.sql`DELETE FROM legacy_brand_requests`).rejects.toThrow('只追加');
    await expect(ctx.sql`UPDATE legacy_imports SET file_name = 'x'`).rejects.toThrow('只能作废一次');
    await expect(ctx.sql`DELETE FROM legacy_imports`).rejects.toThrow('禁止删除');

    const files = legacySampleFiles();
    const brand = files[3]!;
    const parsed = parseLegacyWorkbook(brand.data);
    const [brandRow] = await ctx.sql<{ id: number }[]>`SELECT id FROM legacy_imports WHERE source = 'brand_requests' AND status = 'active'`;
    const brandImportId = brandRow!.id;
    const again = await applyLegacyImport(ctx.sql, parsed, fileMeta(brand.name, brand.data), { operatorId: ctx.ownerId });
    expect(again).toMatchObject({ replayed: true, importId: Number(brandImportId) });

    // 换一份内容不同的品牌清单：不写原因拒绝；写了原因旧的作废
    const changed = Buffer.concat([brand.data]);
    const otherMeta = { ...fileMeta('品牌清单-新.xlsx', changed), sha256: 'f'.repeat(64) };
    await expect(applyLegacyImport(ctx.sql, parsed, otherMeta, { operatorId: ctx.ownerId })).rejects.toMatchObject({ code: 'LEGACY_IMPORT_EXISTS' });
    const replaced = await applyLegacyImport(ctx.sql, parsed, otherMeta, { operatorId: ctx.ownerId, replaceReason: '店主发来新版' });
    expect(replaced).toMatchObject({ replayed: false, voidedId: Number(brandImportId) });
    const imports = await get(ctx.owner, '/api/erp/legacy/imports');
    expect(imports.find((i: { id: number }) => i.id === Number(brandImportId))).toMatchObject({ status: 'voided', voidReason: '店主发来新版', voidedByName: '测试店主' });
    expect((await legacyChecks(ctx.sql)).ok).toBe(true);

    // 作废：页面上不再显示这份表
    await voidLegacyImport(ctx.sql, replaced.importId, '测试作废', ctx.ownerId);
    await expect(voidLegacyImport(ctx.sql, replaced.importId, '再作废一次', ctx.ownerId)).rejects.toMatchObject({ code: 'LEGACY_IMPORT_VOIDED' });
    const audit = (await get(keeper, '/api/erp/legacy/audit')) as LegacyAudit;
    expect(audit.imported).not.toContain('brand_requests');
    expect(audit.rules.find((r) => r.no === 9)!.result).toContain('还没有导入');
    const [logs] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('legacy_imported', 'legacy_import_voided')`;
    expect(logs!.n).toBeGreaterThanOrEqual(6);
  });

  it('自检：只读表的行数与导入记录一致；被动过时报出来', async () => {
    expect((await legacyChecks(ctx.sql)).ok).toBe(true);
    const [imp] = await ctx.sql<{ id: number }[]>`SELECT id FROM legacy_imports WHERE source = 'material_detail' AND status = 'active'`;
    const id = imp!.id;
    await ctx.sql`ALTER TABLE legacy_material_lines DISABLE TRIGGER legacy_material_lines_append_only`;
    try {
      const [row] = await ctx.sql<{ rowNo: number; sheet: string }[]>`SELECT row_no, sheet FROM legacy_material_lines WHERE import_id = ${id} LIMIT 1`;
      await ctx.sql`DELETE FROM legacy_material_lines WHERE import_id = ${id} AND sheet = ${row!.sheet} AND row_no = ${row!.rowNo}`;
      const bad = await legacyChecks(ctx.sql);
      expect(bad.ok).toBe(false);
      expect(bad.detail).toContain('表里 7 行');
    } finally {
      await ctx.sql`ALTER TABLE legacy_material_lines ENABLE TRIGGER legacy_material_lines_append_only`;
    }
  });
});

describe('同版小改（v0.7.10）', () => {
  it('查询接口缺日期或日期格式不对时给中文提示', async () => {
    const missing = await api(ctx.app, ctx.owner, 'GET', '/api/erp/petty/daily');
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ message: '请填写日期（YYYY-MM-DD）', details: { field: 'from' } });
    const bad = await api(ctx.app, ctx.owner, 'GET', '/api/erp/ledger?from=2026/11/01&to=2026-11-01');
    expect(bad.body.error).toMatchObject({ message: '开始日期格式应为 YYYY-MM-DD', details: { field: 'from' } });
    const report = await api(ctx.app, ctx.owner, 'GET', '/api/reports/executive?from=2026-11-01');
    expect(report.body.error).toMatchObject({ message: '请填写结束日期（YYYY-MM-DD）', details: { field: 'to' } });
    // 测试服回归报告里的例子：已下单物料缺 from 原来返回英文
    const ordered = await api(ctx.app, ctx.owner, 'GET', '/api/purchase-orders/ordered-lines');
    expect(ordered.status).toBe(400);
    expect(ordered.body.error).toMatchObject({ message: '请填写开始日期（YYYY-MM-DD）', details: { field: 'from' } });
  });
});
