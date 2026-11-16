// 8.0.21 银行账户与网银流水（docs/FINANCE_V8021.md 第 4 节，CW-C / CW3 / CW16 / CW17；迁移 144）
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectColumns, parseStatementRows } from '../src/shared/bank';
import { FENCED_OPS } from '../src/server/lib/fences';
import { createStaff } from '../src/server/modules/staff';
import { buildWorkbook } from '../src/server/lib/xlsx';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let payer: string;
let viewer: string;
let today: string;
let accountId: number;
let supplierId: number;

const shift = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
/** 一笔已确认的银行转账付款（直接写进库：这里只测勾对，不测付款流程） */
const payment = async (amountCents: number, payDate: string, method = 'bank_transfer') => {
  const [r] = await ctx.sql<{ id: number }[]>`
    INSERT INTO payments (doc_no, supplier_id, pay_date, amount_cents, method, status, created_by, confirmed_by, confirmed_at)
    VALUES (${`FK-T-${randomUUID().slice(0, 8)}`}, ${supplierId}, ${payDate}, ${amountCents}, ${method}, 'confirmed', ${ctx.ownerId}, ${ctx.ownerId}, now())
    RETURNING id`;
  return Number(r!.id);
};
const csv = (rows: string[][]) => ['交易日期,摘要,借方发生额,贷方发生额,余额,对方户名,对方账号,交易流水号', ...rows.map((r) => r.join(','))].join('\n');
const doImport = (content: string, fileName = 'icbc.csv', key = randomUUID(), cookie = payer) =>
  api(ctx.app, cookie, 'POST', '/api/erp/bank/import', { clientKey: key, accountId, fileName, csv: content });
const lines = async (status = 'all') => (await api(ctx.app, payer, 'GET', `/api/erp/bank?status=${status}`)).body;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'bk-payer', displayName: '对账小钱', role: 'backoffice', duties: ['payable'] as never, password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'bk-cost', displayName: '成本小吴', role: 'backoffice', duties: ['cost'] as never, password: PASSWORD, mustChangePassword: false });
  payer = await login(ctx.app, 'bk-payer');
  viewer = await login(ctx.app, 'bk-cost');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  const s = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'BK01', name: '城东蔬菜有限公司' });
  supplierId = s.body.find((x: { code: string }) => x.code === 'BK01').id;
}, 60_000);
afterAll(async () => ctx.close());

describe('对账单解析', () => {
  it('按同义词认列：借方 / 贷方发生额；交易金额 + 借贷标志；认不出日期列给提示', () => {
    expect(detectColumns(['交易日期', '摘要', '借方发生额', '贷方发生额', '余额', '对方户名', '对方账号', '交易流水号'])).toEqual({
      date: '交易日期',
      summary: '摘要',
      out: '借方发生额',
      in: '贷方发生额',
      balance: '余额',
      counterparty: '对方户名',
      counterpartyAccount: '对方账号',
      ref: '交易流水号',
    });
    const header = ['记账日期', '交易金额', '借贷标志', '对方单位名称', '用途'];
    const map = detectColumns(header);
    expect(map).toMatchObject({ date: '记账日期', amount: '交易金额', dc: '借贷标志', counterparty: '对方单位名称', summary: '用途' });
    const { lines: ls, problems } = parseStatementRows(
      header,
      [
        { row: 2, cells: ['2026/11/02 10:20:30', '1,200.50', '借', '城东蔬菜', '货款'] },
        { row: 3, cells: ['20261103', '-80', '', '某某', '手续费'] },
        { row: 4, cells: ['2026-11-04', '300', '贷', '协议单位甲', '回款'] },
        { row: 5, cells: ['合计', '', '', '', ''] },
        { row: 6, cells: ['2026-13-01', '1', '贷', '', ''] },
      ],
      map,
    );
    expect(ls.map((l) => [l.txnDate, l.direction, l.amountCents])).toEqual([
      ['2026-11-02', 'out', 120050],
      ['2026-11-03', 'out', 8000],
      ['2026-11-04', 'in', 30000],
    ]);
    expect(problems).toEqual([{ row: 6, message: '日期「2026-13-01」认不出' }]);
  });
  it('合计行只认日期那一格不是日期的：摘要里写「合计支付」的有日期的一笔照常认', () => {
    const header = ['交易日期', '交易金额', '对方户名', '摘要'];
    const map = detectColumns(header);
    const { lines: ls, problems } = parseStatementRows(
      header,
      [
        { row: 2, cells: ['2026-11-14', '-123.45', '城东蔬菜', '合计支付11月货款'] },
        { row: 3, cells: ['本页合计', '-123.45', '', ''] },
        { row: 4, cells: ['总计：', '-123.45', '', ''] },
      ],
      map,
    );
    expect(ls.map((l) => [l.txnDate, l.direction, l.amountCents, l.summary])).toEqual([['2026-11-14', 'out', 12_345, '合计支付11月货款']]);
    expect(problems).toEqual([]);
  });
  it('借贷标志：借方 / 贷方、Dr / Cr、转出 / 转入都认；认不出的非空标志记成问题、不按金额正负猜成收入', () => {
    const header = ['交易日期', '交易金额', '借贷标志', '对方户名'];
    const map = detectColumns(header);
    const { lines: ls, problems } = parseStatementRows(
      header,
      [
        { row: 2, cells: ['2026-11-14', '100.00', '借方', '城东蔬菜'] },
        { row: 3, cells: ['2026-11-14', '200.00', '贷方', '协议单位甲'] },
        { row: 4, cells: ['2026-11-14', '300.00', 'Dr', '城西肉类'] },
        { row: 5, cells: ['2026-11-14', '400.00', ' 转入 ', '协议单位乙'] },
        { row: 6, cells: ['2026-11-14', '500.00', '冲正', '某某'] },
        { row: 7, cells: ['2026-11-14', '-60.00', '', '手续费'] },
      ],
      map,
    );
    expect(ls.map((l) => [l.amountCents, l.direction])).toEqual([
      [10_000, 'out'],
      [20_000, 'in'],
      [30_000, 'out'],
      [40_000, 'in'],
      [6_000, 'out'],
    ]);
    expect(problems).toEqual([{ row: 6, message: '借贷标志「冲正」认不出（认得借 / 贷、借方 / 贷方、支出 / 收入、D / C）' }]);
  });

  it('没有流水号、没有余额：打给不同账号的是两笔；内容完全一样的几笔按先后编号，各记各的', () => {
    const header = ['交易日期', '交易金额', '对方户名', '对方账号', '摘要'];
    const map = detectColumns(header);
    const parse = (rows: string[][]) =>
      parseStatementRows(
        header,
        rows.map((cells, i) => ({ row: i + 2, cells })),
        map,
      ).lines.map((l) => l.dedupeKey);
    const a = ['2026-11-14', '-100', '城东蔬菜', '6222 0000 0000 0001', '货款'];
    const b = ['2026-11-14', '-100', '城东蔬菜', '6222 0000 0000 0002', '货款'];
    const keys = parse([a, b, a]);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toContain('6222000000000001');
    expect(keys[2]).toBe(`${keys[0]}#2`);
    // 另一份覆盖同一天的对账单里同样的几笔：编号相同，认得出重复
    expect(parse([b, a, a])).toEqual([keys[1], keys[0], keys[2]]);
  });
});

describe('银行流水', () => {
  it('账户只记后四位；对账付款能维护，成本岗只能看', async () => {
    expect((await api(ctx.app, payer, 'POST', '/api/erp/bank/accounts', { name: '基本户', bankName: '工商银行城东支行', accountTail: '6222020000001234' })).status).toBe(400);
    expect((await api(ctx.app, viewer, 'POST', '/api/erp/bank/accounts', { name: '基本户', bankName: '工商银行', accountTail: '1234' })).status).toBe(403);
    const a = await api(ctx.app, payer, 'POST', '/api/erp/bank/accounts', { name: '基本户', bankName: '工商银行城东支行', accountTail: '1234', template: 'icbc' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    accountId = a.body.id;
    expect((await api(ctx.app, viewer, 'GET', '/api/erp/bank')).status).toBe(200);
  });

  it('导入：认列、去重、同一份文件只导一次；自动勾对只认金额、日期前后 3 天、户名都对上且只有一个候选的', async () => {
    const pay1 = await payment(58_000, shift(today, -1));
    // 两笔同金额同户名：不自动对（有两个候选）
    await payment(12_000, today);
    await payment(12_000, today);
    // 现金付款不参与
    await payment(9_900, today, 'cash');
    const content = csv([
      [shift(today, 0), '货款', '580.00', '', '10000.00', '城东蔬菜', '6222000011112222', 'ICBC001'],
      [today, '货款', '120.00', '', '9880.00', '城东蔬菜有限公司', '6222000011112222', 'ICBC002'],
      [today, '现金货款', '99.00', '', '9781.00', '城东蔬菜有限公司', '', 'ICBC003'],
      [today, '结息', '', '3.21', '9784.21', '', '', 'ICBC004'],
    ]);
    const preview = await api(ctx.app, payer, 'POST', '/api/erp/bank/import/preview', { accountId, fileName: 'icbc.csv', csv: content });
    expect(preview.body).toMatchObject({ problem: null, duplicates: 0, alreadyImported: false });
    expect(preview.body.lines).toHaveLength(4);
    const key = randomUUID();
    const r = await doImport(content, 'icbc.csv', key);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.import).toMatchObject({ lineCount: 4, newCount: 4, dupCount: 0, autoMatched: 1 });
    // 重提同一个编号：返回原来那次；同一份文件换编号：拒绝
    const replay = await doImport(content, 'icbc.csv', key);
    expect(replay.body.replayed, JSON.stringify(replay.body)).toBe(true);
    expect((await doImport(content)).body.error.code).toBe('BANK_FILE_IMPORTED');
    // 另一份文件里有重叠的流水：只记新的
    const more = csv([
      [today, '结息', '', '3.21', '9784.21', '', '', 'ICBC004'],
      [today, '回款', '', '880.00', '10664.21', '大众点评', '', 'ICBC005'],
    ]);
    expect((await doImport(more, 'icbc-2.csv')).body.import).toMatchObject({ newCount: 1, dupCount: 1 });
    const all = await lines();
    const matched = all.lines.find((l: { bankRef: string }) => l.bankRef === 'ICBC001');
    expect(matched).toMatchObject({ status: 'matched', matchedCents: 58_000 });
    expect(matched.matches[0]).toMatchObject({ auto: true, target: { type: 'payment', id: pay1 } });
    expect(all.lines.find((l: { bankRef: string }) => l.bankRef === 'ICBC002').status).toBe('open');
    // 账户记住了列怎么对
    expect(all.accounts[0].columnMap).toMatchObject({ date: '交易日期', out: '借方发生额', in: '贷方发生额' });
    expect(FENCED_OPS).toContain('bank_import');
  });

  it('Excel 对账单：日期存成序号的，按对上的那一列换（手动对的英文表头、带说明的中文表头都认）', async () => {
    // 2026-11-15 的 Excel 序号是 46341
    const serial = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);
    expect(serial('2026-11-15')).toBe(46_341);
    const book = (header: string[], rows: (string | number)[][]) =>
      buildWorkbook([{ name: '流水', widths: header.map(() => 14), rows: [{ cells: header }, ...rows.map((cells) => ({ cells }))] }]).toString('base64');
    // 手动对的英文表头
    const en = await api(ctx.app, payer, 'POST', '/api/erp/bank/import/preview', {
      accountId,
      fileName: 'en.xlsx',
      xlsxBase64: book(['Txn Date', 'Debit', 'Credit', 'Counterparty', 'Ref'], [[serial(today), 123.45, '', '某供应商', 'EN-0001']]),
      columnMap: { date: 'Txn Date', out: 'Debit', in: 'Credit', counterparty: 'Counterparty', ref: 'Ref' },
    });
    expect(en.status, JSON.stringify(en.body)).toBe(200);
    expect(en.body.problems ?? []).toEqual([]);
    expect(en.body.lines[0]).toMatchObject({ txnDate: today, direction: 'out', amountCents: 12_345 });
    // 带说明的中文表头（按同义词认得出来，但不在固定的日期列名单里）
    const zh = await api(ctx.app, payer, 'POST', '/api/erp/bank/import/preview', {
      accountId,
      fileName: 'zh.xlsx',
      xlsxBase64: book(['交易日期（年/月/日）', '借方发生额', '贷方发生额', '对方户名'], [[serial(today), '', 88, '某客户']]),
    });
    expect(zh.status, JSON.stringify(zh.body)).toBe(200);
    expect(zh.body.lines[0]).toMatchObject({ txnDate: today, direction: 'in', amountCents: 8_800 });
  });

  it('没有流水号、没有余额的两笔：同一天同金额同户名同摘要、打给不同账号，导入时两笔都记（原来按重复只记一笔）', async () => {
    const content = csv([
      ['2026-11-12', '代付', '100.00', '', '', '同名供应商', '6222000000000101', ''],
      ['2026-11-12', '代付', '100.00', '', '', '同名供应商', '6222000000000202', ''],
    ]);
    const r = await doImport(content, 'no-ref.csv');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.import).toMatchObject({ newCount: 2, dupCount: 0 });
  });

  it('人工勾对：候选里有同金额的；合计超过流水拒绝；同一笔不能对两条；撤销写原因；不用对的（利息）要写原因', async () => {
    const all = await lines();
    const line = all.lines.find((l: { bankRef: string }) => l.bankRef === 'ICBC002');
    const cand = (await api(ctx.app, payer, 'GET', `/api/erp/bank/lines/${line.id}/candidates`)).body;
    expect(cand.suggested.length).toBe(2);
    const [a, b] = cand.suggested;
    expect(
      (await api(ctx.app, payer, 'POST', `/api/erp/bank/lines/${line.id}/match`, { version: line.version, targets: [a, b].map((t: { type: string; id: number }) => ({ type: t.type, id: t.id })) }))
        .body.error.code,
    ).toBe('MATCH_OVER');
    const ok = await api(ctx.app, payer, 'POST', `/api/erp/bank/lines/${line.id}/match`, { version: line.version, targets: [{ type: a.type, id: a.id }] });
    expect(ok.body).toMatchObject({ status: 'matched', matchedCents: 12_000 });
    // 旧版本号拒绝
    expect((await api(ctx.app, payer, 'POST', `/api/erp/bank/lines/${line.id}/match`, { version: line.version, targets: [{ type: b.type, id: b.id }] })).body.error.code).toBe('BANK_LINE_CHANGED');
    // 同一笔付款不能再对到别的流水
    const cash = all.lines.find((l: { bankRef: string }) => l.bankRef === 'ICBC003');
    expect((await api(ctx.app, payer, 'POST', `/api/erp/bank/lines/${cash.id}/match`, { version: cash.version, targets: [{ type: a.type, id: a.id }] })).body.error.code).toBe('MATCH_TARGET_TAKEN');
    // 收入的流水不能对付款
    const interest = all.lines.find((l: { bankRef: string }) => l.bankRef === 'ICBC004');
    expect((await api(ctx.app, payer, 'POST', `/api/erp/bank/lines/${interest.id}/match`, { version: interest.version, targets: [{ type: b.type, id: b.id }] })).status).toBe(400);
    expect((await api(ctx.app, payer, 'POST', `/api/erp/bank/lines/${interest.id}/ignore`, { version: interest.version })).status).toBe(400);
    expect((await api(ctx.app, payer, 'POST', `/api/erp/bank/lines/${interest.id}/ignore`, { version: interest.version, reason: '存款利息' })).body).toMatchObject({
      status: 'ignored',
      ignoreReason: '存款利息',
    });
    // 撤销勾对
    const v = await api(ctx.app, payer, 'POST', `/api/erp/bank/matches/${ok.body.matches[0].id}/void`, { reason: '对错了' });
    expect(v.body).toMatchObject({ status: 'open', matchedCents: 0 });
    // 流水内容、勾对记录数据库兜底不能改
    await expect(ctx.sql`UPDATE bank_statement_lines SET amount_cents = 1 WHERE id = ${line.id}`).rejects.toThrow(/不能改/);
    await expect(ctx.sql`DELETE FROM bank_matches WHERE id = ${ok.body.matches[0].id}`).rejects.toThrow(/不能删除/);
  });

  it('待办：超过 7 天没对上的流水；有流水以后、超过 7 天没对上流水的付款', async () => {
    const old = shift(today, -10);
    await payment(33_300, old);
    const content = csv([[old, '房租', '5000.00', '', '1.00', '某物业', '', 'ICBC-OLD-1']]);
    expect((await doImport(content, 'old.csv')).status).toBe(201);
    const todo = (await api(ctx.app, payer, 'GET', '/api/erp/bank/todo')).body;
    expect(todo.stale).toBeGreaterThanOrEqual(1);
    expect(todo.unmatched).toBeGreaterThanOrEqual(1);
  });
});
