// Batch 2.4d：旧系统（EBC）会员余额期初导入（店主 2026-10-27 #6）。
//   · 本金、赠金分开迁入，记「期初导入」流水，不计入充值实收；每位会员保留来源行与旧卡号；
//   · 按手机号匹配已有会员，姓名不一致、已有期初、赠金到期日已过的行报错，任一行有问题整批不导入；
//   · 同一操作编号重提返回第一次的结果；作废记「期初作废」流水，期初之后已有余额变动的不能作废；
//   · 日结：单据合计与流水一致、期初 + 本日变动 = 期末、赠金批次一致。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lastUsableDate } from '../src/shared/business-date';
import { shiftDate } from '../src/shared/labels';
import { parseOpeningCsv } from '../src/shared/opening-import';
import { sweepExpiredBonus } from '../src/server/modules/bonus';
import { api, balanceOf, consumeBody, createMember, setup, type TestContext } from './helpers';

const TZ = 'Asia/Shanghai';
let ctx: TestContext;
let today: string;

const csvOf = (...lines: string[]) => ['姓名,手机号,旧卡号,本金,赠金,赠金到期日,累计充值,性别,生日,备注', ...lines].join('\n');
const preview = (csv: string, source = 'EBC') => api(ctx.app, ctx.owner, 'POST', '/api/opening-imports/preview', { source, fileName: 'ebc.csv', csv });
const apply = (csv: string, clientKey: string = randomUUID(), source = 'EBC') =>
  api(ctx.app, ctx.owner, 'POST', '/api/opening-imports', { source, fileName: 'ebc.csv', note: '测试导入', csv, clientKey });
const memberByPhone = async (phone: string) => {
  const [m] = await ctx.sql<{ id: number; name: string; principalBalance: number; bonusBalance: number }[]>`
    SELECT id, name, principal_balance, bonus_balance FROM members WHERE phone = ${phone}`;
  return m;
};
const checksOk = async (date: string) => {
  const s = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${date}`)).body;
  for (const c of s.checks as { ok: boolean; label: string; detail: string }[]) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  return s;
};

beforeAll(async () => {
  ctx = await setup();
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
});
afterAll(async () => ctx.close());

describe('CSV 解析', () => {
  it('中文表头、金额带符号与千分位、日期多种写法', () => {
    const r = parseOpeningCsv(csvOf('张三,138 0000 0001,EBC001,"¥1,200.50",100,2027/1/5,3000,男,1990-02-03,老客', '李四,13800000002,,0,,,,,,'));
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ line: 2, name: '张三', phone: '13800000001', legacyNo: 'EBC001', principal: 120050, bonus: 10000, bonusExpiresOn: '2027-01-05', totalRecharged: 300000, gender: 'male', birthday: '1990-02-03' });
    expect(r.rows[0]!.raw['旧卡号']).toBe('EBC001');
    expect(r.rows[1]).toMatchObject({ principal: 0, bonus: 0, bonusExpiresOn: null, totalRecharged: null, gender: null });
  });

  it('逐行报出问题：手机号、重复、负数、多于两位小数、表头缺列', () => {
    const r = parseOpeningCsv(csvOf('王五,1380000,,10,,,,,,', '赵六,13800000003,,-1,,,,,,', '孙七,13800000003,,1.234,,,,,,', '周八,13800000004,,10,5,2027-02-30,,,,'));
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
    expect(r.errors[0]!.message).toContain('手机号');
    expect(parseOpeningCsv('姓名,手机号\n张三,13800000001').errors[0]!.message).toContain('本金');
  });

  it('备注里带换行（Excel 导出的多行备注）不拆成两行：后半截像一位会员也不会多导一笔；行号按记录开始的行（v0.7.22）', () => {
    // 原来先按换行切再拆单元格，引号里的「陈九,13800000009,,500」会被当成第三位会员、多导 ¥500
    const r = parseOpeningCsv(csvOf('张三,13800000001,,100,,,,,,"老客\n陈九,13800000009,,500,,,,,,"', '李四,13800000002,,0,,,,,,'));
    expect(r.errors).toEqual([]);
    expect(r.rows.map((row) => [row.line, row.name, row.principal])).toEqual([
      [2, '张三', 10000],
      [4, '李四', 0],
    ]);
    expect(r.rows[0]!.raw['备注']).toBe('老客\n陈九,13800000009,,500,,,,,,');
    // 引号没有配对：整份报错，不导入
    expect(parseOpeningCsv(csvOf('张三,13800000001,,100,,,,,,"老客')).errors[0]!.message).toContain('引号没有配对');
    // 只有逗号的行当空行跳过
    expect(parseOpeningCsv(csvOf('张三,13800000001,,100,,,,,,', ',,,,,,,,,')).rows).toHaveLength(1);
  });
});

describe('预览与导入', () => {
  it('预览不写数据；姓名不一致、赠金到期日已过的行报错', async () => {
    const existing = await createMember(ctx, '老会员甲', '13900000001');
    const before = await ctx.sql`SELECT count(*)::int AS n FROM members`;
    const r = await preview(
      csvOf(
        '老会员甲,13900000001,E1,100,20,,,,,',
        '新会员乙,13900000002,E2,50,0,,,,,',
        '冒名丙,13900000001,E3,1,0,,,,,',
        `过期丁,13900000003,E4,1,5,${shiftDate(today, -1)},,,,`,
      ),
    );
    expect(r.status).toBe(200);
    // 第 4 行与第 2 行手机号重复（解析阶段报错），第 5 行赠金已过期
    expect(r.body.errors.map((e: { line: number }) => e.line)).toEqual([4, 5]);
    expect(r.body).toMatchObject({ dryRun: true, total: 3, createCount: 1, matchCount: 1 });
    const after = await ctx.sql`SELECT count(*)::int AS n FROM members`;
    expect(after[0]!.n).toBe(before[0]!.n);
    expect((await balanceOf(ctx, existing.id)).principal).toBe(0);

    const mismatch = await preview(csvOf('改名了,13900000001,E1,100,0,,,,,'));
    expect(mismatch.body.errors[0].message).toContain('姓名');
    // 有问题时导入整批拒绝
    const rejected = await apply(csvOf('改名了,13900000001,E1,100,0,,,,,', '新会员乙,13900000002,E2,50,0,,,,,'));
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('OPENING_INVALID');
    expect(await memberByPhone('13900000002')).toBeUndefined();
  });

  it('店员不能导入期初', async () => {
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/opening-imports/preview', { source: 'EBC', csv: csvOf('某某,13900000009,,1,,,,,,') });
    expect(r.status).toBe(403);
  });

  it('导入：本金、赠金分开记期初流水，不计入充值实收；赠金进批次（含到期日）；日结全部一致', async () => {
    const expiresOn = shiftDate(today, 30);
    const csv = csvOf(
      '老会员甲,13900000001,E1,100,20,,5000,,,',
      `新会员乙,13900000002,E2,"1,000",88.8,${expiresOn},,女,1992-03-04,旧会员`,
      '只建档丙,13900000004,E5,0,0,,800,,,',
    );
    const key = randomUUID();
    const r = await apply(csv, key);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: false, replayed: false, total: 3, createCount: 2, matchCount: 1, zeroCount: 1, principalTotal: 110000, bonusTotal: 10880, legacyRechargedTotal: 580000 });
    expect(r.body.importNo).toMatch(/^QC\d{8}-\d{4}$/);

    const jia = (await memberByPhone('13900000001'))!;
    const yi = (await memberByPhone('13900000002'))!;
    expect([jia.principalBalance, jia.bonusBalance]).toEqual([10000, 2000]);
    expect([yi.principalBalance, yi.bonusBalance]).toEqual([100000, 8880]);
    expect((await memberByPhone('13900000004'))!.principalBalance).toBe(0);

    const entries = await ctx.sql<{ entryType: string; principalDelta: number; bonusDelta: number; docNo: string }[]>`
      SELECT entry_type, principal_delta, bonus_delta, doc_no FROM ledger_entries WHERE member_id = ${yi.id}`;
    expect(entries).toEqual([{ entryType: 'opening', principalDelta: 100000, bonusDelta: 8880, docNo: `${r.body.importNo}-0002` }]);
    const [lot] = await ctx.sql<{ source: string; remaining: number; expiresAt: string }[]>`
      SELECT source, remaining, expires_at FROM bonus_lots WHERE member_id = ${yi.id}`;
    expect(lot!.source).toBe('opening');
    expect(lot!.remaining).toBe(8880);
    expect(lastUsableDate(lot!.expiresAt, TZ, 6)).toBe(expiresOn);

    // 来源记录：原始行、旧卡号、是否新建
    const [ob] = await ctx.sql<{ sourceRow: Record<string, string>; legacyNo: string; memberCreated: boolean }[]>`
      SELECT source_row, legacy_no, member_created FROM opening_balances WHERE member_id = ${yi.id}`;
    expect(ob).toMatchObject({ legacyNo: 'E2', memberCreated: true });
    expect(ob!.sourceRow['本金']).toBe('1,000');

    const detail = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${yi.id}`)).body;
    expect(detail.opening).toMatchObject({ source: 'EBC', legacyNo: 'E2', principal: 100000, bonus: 8880 });
    expect(detail.gender).toBe('female');

    const s = await checksOk(today);
    expect(s.recharge.paid).toBe(0);
    expect(s.opening).toEqual({ count: 2, voidCount: 0, principal: 110000, bonus: 10880 });

    const ledger = (await api(ctx.app, ctx.owner, 'GET', `/api/ledger?date=${today}&type=opening`)).body;
    expect(ledger).toHaveLength(2);
    expect(ledger[0].summary).toContain('EBC 期初余额');

    // 同一编号重提：返回第一次的结果，不重复记账
    const again = await apply(csv, key);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, importNo: r.body.importNo, total: 3 });
    expect((await memberByPhone('13900000002'))!.principalBalance).toBe(100000);
    // 同一编号换了文件：拒绝
    expect((await apply(csvOf('别的,13900000077,,1,,,,,,'), key)).status).toBe(409);
    // 编号丢了、换新编号重复导入同一个文件：每位会员都已有期初，整批拒绝
    const dup = await apply(csv);
    expect(dup.status).toBe(422);
    expect(dup.body.error.details.errors).toHaveLength(3);
    // 查回
    const found = (await api(ctx.app, ctx.owner, 'GET', `/api/opening-imports/by-key/${key}`)).body;
    expect(found).toMatchObject({ found: true, report: { importNo: r.body.importNo } });
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/opening-imports/by-key/${randomUUID()}`)).body.found).toBe(false);
  });

  it('会员体系 v2：期初导入按累计充值（含旧系统累计）定档、进初阶，周期从导入日起，记一条「期初导入定档」', async () => {
    const jia = (await memberByPhone('13900000001'))!;
    const detail = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${jia.id}`)).body;
    // 旧系统累计充值 5,000 元 → L1 云涧（VIP 柜按会员规则的对应表）
    expect(detail).toMatchObject({ grade: 1, tier: 0 });
    expect(detail.gradeInfo).toMatchObject({ label: 'L1 云涧 · 初', lockerLevel: 1, state: { cycleStart: detail.gradeInfo.today } });
    expect(detail.gradeInfo.events.map((e: { kind: string; rollingRecharge: number; staffName: string }) => [e.kind, e.rollingRecharge, e.staffName])).toEqual([
      ['import', 500000, '测试店主'],
    ]);
  });
});

describe('作废', () => {
  it('逐位作废：扣回期初余额、批次清零，原记录保留；重复作废被拒绝', async () => {
    const yi = (await memberByPhone('13900000002'))!;
    const [ob] = await ctx.sql<{ id: number }[]>`SELECT id FROM opening_balances WHERE member_id = ${yi.id}`;
    const r = await api(ctx.app, ctx.owner, 'POST', `/api/opening-balances/${ob!.id}/void`, { reason: '金额有误' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'voided', voidReason: '金额有误' });
    expect(await balanceOf(ctx, yi.id)).toEqual({ principal: 0, bonus: 0 });
    const [lot] = await ctx.sql<{ remaining: number }[]>`SELECT remaining FROM bonus_lots WHERE opening_id = ${ob!.id}`;
    expect(lot!.remaining).toBe(0);
    const types = await ctx.sql<{ entryType: string }[]>`SELECT entry_type FROM ledger_entries WHERE member_id = ${yi.id} ORDER BY id`;
    expect(types.map((t) => t.entryType)).toEqual(['opening', 'opening_void']);
    const again = await api(ctx.app, ctx.owner, 'POST', `/api/opening-balances/${ob!.id}/void`, { reason: '金额有误' });
    expect(again.status).toBe(409);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/members/${yi.id}`)).body.opening).toBeNull();

    const s = await checksOk(today);
    expect(s.opening).toEqual({ count: 2, voidCount: 1, principal: 10000, bonus: 2000 });

    // 作废后可以重新导入更正后的余额
    const fixed = await apply(csvOf('新会员乙,13900000002,E2,900,0,,,,,'));
    expect(fixed.status).toBe(200);
    expect(fixed.body).toMatchObject({ createCount: 0, matchCount: 1 });
    expect(await balanceOf(ctx, yi.id)).toEqual({ principal: 90000, bonus: 0 });
    await checksOk(today);
  });

  it('期初之后已有余额变动的不能作废；整批作废要求批内每位都没有后续变动', async () => {
    const jia = (await memberByPhone('13900000001'))!;
    const [ob] = await ctx.sql<{ id: number; importId: number }[]>`SELECT id, import_id FROM opening_balances WHERE member_id = ${jia.id}`;
    const spent = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(jia.id, 3000));
    expect(spent.status).toBe(200);
    const blocked = await api(ctx.app, ctx.owner, 'POST', `/api/opening-balances/${ob!.id}/void`, { reason: '测试' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('OPENING_IN_USE');
    const batch = await api(ctx.app, ctx.owner, 'POST', `/api/opening-imports/${ob!.importId}/void`, { reason: '测试' });
    expect(batch.status).toBe(409);
    const detail = (await api(ctx.app, ctx.owner, 'GET', `/api/opening-imports/${ob!.importId}`)).body;
    expect(detail.rows.find((r: { memberId: number }) => r.memberId === jia.id).laterActivity).toBe(true);
    await checksOk(today);
  });

  it('整批作废：批内仍有效的期初逐位作废（只建档的行只改状态）', async () => {
    const r = await apply(csvOf('批量甲,13900000011,,10,1,,,,,', '批量乙,13900000012,,0,0,,,,,'));
    expect(r.status).toBe(200);
    const [imp] = await ctx.sql<{ id: number }[]>`SELECT id FROM opening_imports WHERE import_no = ${r.body.importNo}`;
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/opening-imports/${imp!.id}/void`, { reason: '整批重导' });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ activeCount: 0, voidedCount: 2 });
    const a = (await memberByPhone('13900000011'))!;
    expect([a.principalBalance, a.bonusBalance]).toEqual([0, 0]);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/opening-imports/${imp!.id}/void`, { reason: '再来' })).status).toBe(409);
    await checksOk(today);
  });

  it('期初明细不能删改（只能作废）', async () => {
    const [ob] = await ctx.sql<{ id: number }[]>`SELECT id FROM opening_balances WHERE status = 'active' LIMIT 1`;
    await expect(ctx.sql`UPDATE opening_balances SET principal = principal + 1 WHERE id = ${ob!.id}`).rejects.toThrow(/只能作废/);
    await expect(ctx.sql`DELETE FROM opening_balances WHERE id = ${ob!.id}`).rejects.toThrow(/禁止删除/);
    await expect(ctx.sql`UPDATE opening_imports SET note = 'x'`).rejects.toThrow();
  });
});

describe('导入期间会员资料变动（G3 复测）', () => {
  /** 等到有 n 个会话在等锁，证明导入确实卡在给已有会员加锁的一步 */
  async function waitForLockWaiters(n: number) {
    for (let i = 0; i < 100; i++) {
      const [row] = await ctx.sql<{ n: number }[]>`
        SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row!.n >= n) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`等待 ${n} 个锁等待者超时`);
  }
  /** 另一个终端：先锁住会员行（导入核对完、加锁时等在这里），再改资料并提交 */
  async function editWhileImporting(memberId: number, csv: string, edit: (tx: typeof ctx.sql) => Promise<unknown>) {
    const conn = await ctx.sql.reserve();
    const tx = conn as unknown as typeof ctx.sql;
    await conn.unsafe('BEGIN');
    await tx`SELECT id FROM members WHERE id = ${memberId} FOR UPDATE`;
    const importing = apply(csv);
    await waitForLockWaiters(1);
    await edit(tx);
    await conn.unsafe('COMMIT');
    conn.release();
    return importing;
  }
  const counts = async () =>
    (await ctx.sql<{ imports: number; balances: number; ledger: number; members: number }[]>`
      SELECT (SELECT count(*)::int FROM opening_imports) AS imports, (SELECT count(*)::int FROM opening_balances) AS balances,
             (SELECT count(*)::int FROM ledger_entries) AS ledger, (SELECT count(*)::int FROM members) AS members`)[0]!;

  it('核对后、加锁前会员改了姓名和手机号：整批拒绝，期初不会记到身份已变的会员上', async () => {
    const m = await createMember(ctx, '并发期初原身份', '19900009701');
    const before = await counts();
    const csv = csvOf('并发期初原身份,19900009701,E91,100,0,,,,,', '并发期初新客,19900009703,E92,50,0,,,,,');
    const r = await editWhileImporting(m.id, csv, (tx) => tx`UPDATE members SET name = '并发期初新身份', phone = '19900009702' WHERE id = ${m.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'OPENING_STALE', message: '导入期间会员资料有变动，整批未导入；请重新预览后再导入' });
    expect(r.body.error.details.errors.map((e: { line: number }) => e.line)).toEqual([2]);
    // 整批没有写入：没有批次、期初、流水，新客也没有建档；改了资料的会员余额仍为 0
    expect(await counts()).toEqual(before);
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 0, bonus: 0 });
    expect(await memberByPhone('19900009703')).toBeUndefined();
    await checksOk(today);
  });

  it('核对后、加锁前手机号换到另一位同名会员名下：整批拒绝，不会记到原来那位会员上', async () => {
    const a = await createMember(ctx, '同名期初', '19900009711');
    const b = await createMember(ctx, '同名期初', '19900009712');
    const before = await counts();
    const r = await editWhileImporting(a.id, csvOf('同名期初,19900009711,E93,100,0,,,,,'), async (tx) => {
      await tx`UPDATE members SET phone = '19900009713' WHERE id = ${a.id}`;
      await tx`UPDATE members SET phone = '19900009711' WHERE id = ${b.id}`;
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('OPENING_STALE');
    expect(r.body.error.details.errors).toEqual([{ line: 2, message: '手机号 19900009711 对应的会员刚刚有变动' }]);
    expect(await counts()).toEqual(before);
    expect([await balanceOf(ctx, a.id), await balanceOf(ctx, b.id)]).toEqual([{ principal: 0, bonus: 0 }, { principal: 0, bonus: 0 }]);
  });

  it('期间只改了不影响身份的资料（备注）：照常导入', async () => {
    const m = await createMember(ctx, '改备注期初', '19900009721');
    const r = await editWhileImporting(m.id, csvOf('改备注期初,19900009721,E94,100,0,,,,,'), (tx) => tx`UPDATE members SET note = '导入时改了备注' WHERE id = ${m.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 1, matchCount: 1 });
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 10000, bonus: 0 });
    await checksOk(today);
  });
});

describe('期初赠金到期', () => {
  it('带到期日的期初赠金到期后作废，日结一致', async () => {
    const lastDay = today;
    const r = await apply(csvOf(`到期戊,13900000021,,0,30,${lastDay},,,,`));
    expect(r.status).toBe(200);
    const m = (await memberByPhone('13900000021'))!;
    expect(m.bonusBalance).toBe(3000);
    // 第二天营业日开始后扫描
    const done = await sweepExpiredBonus({ sql: ctx.sql, config: ctx.config }, new Date(Date.now() + 2 * 86_400_000));
    expect(done).toBeGreaterThanOrEqual(1);
    expect((await balanceOf(ctx, m.id)).bonus).toBe(0);
    const types = await ctx.sql<{ entryType: string; businessDate: string }[]>`
      SELECT entry_type, business_date FROM ledger_entries WHERE member_id = ${m.id} ORDER BY id`;
    expect(types.map((t) => t.entryType)).toEqual(['opening', 'expire']);
    await checksOk(today);
    await checksOk(types[1]!.businessDate);
  });
});
