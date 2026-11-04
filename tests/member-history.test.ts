// v0.7.28 ⑩（docs/SCHEDULE_FINISH.md 第 11 节，N12）：旧 EBC 逐笔流水只读导入。全部是合成数据。
//   · 按旧卡号（期初导入记下的）或手机号认会员；认不出的行不导入、列出来；格式有一行不对整批不导入；
//   · 只读、不进正式账：余额与流水不变；会员详情「旧系统流水」新的在前、分页，含合并进来的档案的；
//   · 同一编号重提返回原结果；同一份文件只能有一批有效导入，作废后可以重新导入；只有店主能导入。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemberHistoryPage, MemberHistoryReport } from '../src/shared/member-history';
import { classifyHistoryType, parseHistoryTime, parseMemberHistoryCsv } from '../src/shared/member-history';
import { api, createMember, setup, type TestContext } from './helpers';

let ctx: TestContext;
let zhang: number;
let li: number;

const CSV = [
  '旧卡号,手机号,姓名,时间,类型,金额,赠金,余额,单号,备注',
  'e0001,,老张,2026/9/1 10:00,充值,"1,000",100,1100,R001,',
  ',199 3333 0002,小李,2026-09-02,消费,-88.5,,911.5,C002,洗浴',
  ',19933339999,没有这个人,2026-09-03,消费,-10,,,X,',
  'E0001,,老张,2026-09-05 20:30:15,退卡,-500,,600,T003,"退卡，现金"',
].join('\n');

const body = (csv = CSV, extra: Record<string, unknown> = {}) => ({ source: 'EBC', fileName: 'ebc-流水.csv', csv, ...extra });
const history = async (memberId: number, q = '') => (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${memberId}/legacy-history${q}`)).body as MemberHistoryPage;

beforeAll(async () => {
  ctx = await setup();
  // 老张有期初（旧卡号 E0001）；小李只有手机号
  const opening = await api(ctx.app, ctx.owner, 'POST', '/api/opening-imports', {
    clientKey: randomUUID(),
    source: 'EBC',
    fileName: 'opening.csv',
    csv: 'name,phone,legacy_no,principal,bonus\n老张,19933330001,E0001,100.00,0\n',
  });
  expect(opening.status, JSON.stringify(opening.body)).toBe(200);
  zhang = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM members WHERE phone = '19933330001'`)[0]!.id);
  li = (await createMember(ctx, '小李', '19933330002')).id;
});
afterAll(async () => ctx?.close());

describe('模板解析', () => {
  it('时间、金额、类型归类；表头缺列、格式不对的行报出来', () => {
    expect(parseHistoryTime('2026/9/1 9:03')).toEqual({ date: '2026-09-01', time: '09:03:00' });
    expect(parseHistoryTime('2026-02-30')).toBeNull();
    expect(['充值', '储值消费', '赠送', '退卡', '手工调整', '积分'].map(classifyHistoryType)).toEqual(['recharge', 'consume', 'bonus', 'refund', 'adjust', 'other']);
    const parsed = parseMemberHistoryCsv(CSV);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => [r.legacyNo, r.phone, r.amount, r.bonus, r.balance, r.kind])).toEqual([
      ['E0001', '', 100000, 10000, 110000, 'recharge'],
      ['', '19933330002', -8850, null, 91150, 'consume'],
      ['', '19933339999', -1000, null, null, 'consume'],
      ['E0001', '', -50000, null, 60000, 'refund'],
    ]);
    expect(parseMemberHistoryCsv('姓名,时间\n老张,2026-01-01').errors[0]!.message).toContain('表头缺少');
    const bad = parseMemberHistoryCsv('手机号,时间,类型,金额\n19933330001,昨天,充值,10\n19933330001,2026-01-01,充值,十元');
    expect(bad.errors.map((e) => e.line)).toEqual([2, 3]);
  });
});

describe('导入与查看', () => {
  it('只有店主能导入；预览按旧卡号、手机号认会员，认不出的列出来', async () => {
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/member-history-imports/preview', body())).status).toBe(403);
    const p = (await api(ctx.app, ctx.owner, 'POST', '/api/member-history-imports/preview', body())).body as MemberHistoryReport;
    expect(p).toMatchObject({ totalRows: 4, matchedRows: 3, memberCount: 2, byLegacyNo: 2, byPhone: 1, duplicateOf: null, errors: [] });
    expect(p.unmatched).toEqual({ count: 1, lines: [{ line: 4, phone: '19933339999', legacyNo: '', name: '没有这个人' }] });
    expect(p.byKind).toEqual([
      { kind: 'recharge', count: 1, amount: 100000 },
      { kind: 'consume', count: 1, amount: -8850 },
      { kind: 'refund', count: 1, amount: -50000 },
    ]);
    // 格式不对整批不导入
    const bad = await api(ctx.app, ctx.owner, 'POST', '/api/member-history-imports', { ...body(`${CSV}\n,19933330002,小李,昨天,消费,1,,,,`), clientKey: randomUUID() });
    expect(bad.body.error.code).toBe('MEMBER_HISTORY_INVALID');
  });

  it('导入只读、不进正式账；会员详情新的在前、分页；重提返回原结果，同一份文件不能再导入', async () => {
    const [before] = await ctx.sql<{ n: number; p: number }[]>`SELECT (SELECT count(*)::int FROM ledger_entries) AS n, (SELECT principal_balance FROM members WHERE id = ${zhang}) AS p`;
    const key = randomUUID();
    const done = await api(ctx.app, ctx.owner, 'POST', '/api/member-history-imports', { ...body(), clientKey: key });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ matchedRows: 3, memberCount: 2, importNo: expect.stringMatching(/^LS\d{8}-\d{4}$/) });
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/member-history-imports', { ...body(), clientKey: key });
    expect(again.body).toMatchObject({ replayed: true, importNo: done.body.importNo });
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/member-history-imports', { ...body(), clientKey: randomUUID() })).body.error.code).toBe('MEMBER_HISTORY_DUPLICATE');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/member-history-imports/preview', body())).body.duplicateOf).toBe(done.body.importNo);
    // 不进正式账
    const [after] = await ctx.sql<{ n: number; p: number }[]>`SELECT (SELECT count(*)::int FROM ledger_entries) AS n, (SELECT principal_balance FROM members WHERE id = ${zhang}) AS p`;
    expect(after).toEqual(before);
    // 只读
    await expect(ctx.sql`UPDATE member_history_rows SET amount = 1`).rejects.toThrow(/只读/);
    await expect(ctx.sql`DELETE FROM member_history_imports`).rejects.toThrow(/禁止删除/);

    const z = await history(zhang);
    expect(z.total).toBe(2);
    expect(z.entries.map((e) => [e.typeLabel, e.amount, e.balance, e.note])).toEqual([
      ['退卡', -50000, 60000, '退卡，现金'],
      ['充值', 100000, 110000, ''],
    ]);
    expect(z.entries[0]!.occurredAt).toBe('2026-09-05T12:30:15.000Z');
    const first = await history(zhang, '?limit=1');
    expect(first.entries.map((e) => e.typeLabel)).toEqual(['退卡']);
    const second = await history(zhang, `?limit=1&before=${first.nextBefore}`);
    expect(second).toMatchObject({ nextBefore: null, entries: [{ typeLabel: '充值' }] });
    expect((await history(li)).entries.map((e) => [e.kind, e.amount, e.note])).toEqual([['consume', -8850, '洗浴']]);
  });

  it('合并进来的档案的旧流水在合并到的会员上也看得到', async () => {
    await ctx.sql`ALTER TABLE members DISABLE TRIGGER USER`;
    try {
      await ctx.sql`UPDATE members SET status = 'frozen', merged_into_id = ${zhang} WHERE id = ${li}`;
    } finally {
      await ctx.sql`ALTER TABLE members ENABLE TRIGGER USER`;
    }
    expect((await history(zhang)).entries.map((e) => e.typeLabel)).toEqual(['退卡', '消费', '充值']);
  });

  it('整批作废后不再显示，同一份文件可以重新导入', async () => {
    const list = (await api(ctx.app, ctx.owner, 'GET', '/api/member-history-imports')).body as { id: number; status: string }[];
    expect(list).toHaveLength(1);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/member-history-imports/${list[0]!.id}/void`, { reason: '导错了' })).status).toBe(403);
    const voided = await api(ctx.app, ctx.owner, 'POST', `/api/member-history-imports/${list[0]!.id}/void`, { reason: '导错了' });
    expect(voided.body).toMatchObject({ status: 'voided', voidReason: '导错了' });
    expect((await history(zhang)).total).toBe(0);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/member-history-imports/${list[0]!.id}/void`, { reason: '再作废' })).body.error.code).toBe('ALREADY_VOIDED');
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/member-history-imports', { ...body(), clientKey: randomUUID() });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((await history(zhang)).total).toBe(3);
  });
});
