// R1.5 只读对账命令：每日对账包（部门参考表合计 = 应收，后面单列优惠与净营业额；异常清单含反结账、优惠 / 免单、撤销误开的牌、
// 免票入场与当场授权的人和原因；交班长短款与反结账退现金）
// 与余额变动清单（起点余额、现在余额、期初默认不算变动）。建在 seed-frontdesk-demo + seed-billing-demo 上。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { minuteOfDay } from '../src/shared/business-date';
import expected from '../src/server/demo/billing-expected.json';
import { applyOpeningImport } from '../src/server/modules/opening';
import { balanceChanges, parseLocalTime } from '../src/server/ops/balance-changes';
import { buildDailyRecon, type DailyRecon } from '../src/server/ops/recon';
import { seedBillingDemo } from '../src/server/seed-billing';
import { seedFrontdeskDemo } from '../src/server/seed-frontdesk';
import { setup, type TestContext } from './helpers';

let ctx: TestContext;
let date: string;
let recon: DailyRecon;
let seededAt: Date;

/** 解析带 BOM 的 CSV（对账包里的单元格没有换行） */
const rowsOf = (csv: string) =>
  csv
    .replace(/^﻿/, '')
    .trim()
    .split('\r\n')
    .map((line) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].map((m) => m[1]!.replace(/^"|"$/g, '').replace(/""/g, '"')).slice(0, -1));
const file = (name: string) => recon.files.find((f) => f.name === name)!.content;

beforeAll(async () => {
  ctx = await setup();
  // 与 billing-seed.test 相同：避开营业日切换（06:00）附近
  let now = new Date();
  const m = minuteOfDay(now, 'Asia/Shanghai');
  if (m >= 360 && m < 450) now = new Date(now.getTime() - 2 * 3_600_000);
  seededAt = now;
  await seedFrontdeskDemo(ctx.sql, ctx.config, { now });
  await seedBillingDemo(ctx.sql, ctx.config, { now });
  const [row] = await ctx.sql<{ date: string }[]>`SELECT DISTINCT business_date::text AS date FROM checkouts WHERE note = '结账演示'`;
  date = row!.date;
  recon = await buildDailyRecon(ctx.sql, ctx.config, date, now);
});
afterAll(async () => ctx.close());

describe('每日对账包', () => {
  it('六个文件；自检全部一致，部门参考表合计 = 应收，再单列优惠 / 免单与净营业额', () => {
    expect(recon.files.map((f) => f.name)).toEqual(['00-说明.txt', '01-日结汇总.csv', '02-结账单.csv', '03-部门参考表.csv', '04-异常清单.csv', '05-交班.csv']);
    expect(recon.ok).toBe(true);
    const dept = rowsOf(file('03-部门参考表.csv'));
    const total = dept.find((r) => r[0] === '合计')!;
    expect(total[3]).toBe((expected.business.net / 100).toFixed(2));
    expect(dept.find((r) => r[0] === '核对')![1]).toBe('一致');
    // 门票单独一类：与营业口径的门票合计一致
    const ticket = dept.find((r) => r[0] === '门票' && r[1] === '小计')!;
    expect(ticket[3]).toBe((expected.business.ticket / 100).toFixed(2));
    expect(dept.find((r) => r[0] === '应收（结账 − 反结账）')![3]).toBe((expected.business.net / 100).toFixed(2));
    const discount = expected.business.byMethod.discount;
    expect(dept.find((r) => r[0] === '优惠 / 免单（不是收款）')![3]).toBe((-discount / 100).toFixed(2));
    expect(dept.find((r) => r[0] === '净营业额（应收 − 优惠）')![3]).toBe(((expected.business.net - discount) / 100).toFixed(2));
    const readme = file('00-说明.txt');
    expect(readme).toContain('✓ 与应收一致');
    // 与日结同一口径：应收、优惠 / 免单、净营业额、实收（现金类）
    expect(readme).toContain(`应收 ¥${(expected.business.net / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    expect(readme).toMatch(/优惠 \/ 免单 ¥21\.00；净营业额 ¥[\d,]+\.\d{2}；实收（现金类）¥[\d,]+\.\d{2}/);
    expect(readme).toMatch(/异常：反结账 1、优惠 \/ 免单 1、/);
  });

  it('结账单：「计入本日」两列分别合计 = 结账合计、反结账合计；储值与团购单列', () => {
    const [header, ...rows] = rowsOf(file('02-结账单.csv'));
    const col = (name: string) => header!.indexOf(name);
    const sum = (name: string) => rows.reduce((t, r) => t + Math.round(Number(r[col(name)]) * 100), 0);
    expect(rows).toHaveLength(expected.checkouts.length);
    expect(sum('计入本日结账')).toBe(expected.business.checkouts.total);
    expect(sum('计入本日反结账')).toBe(-expected.business.voids.total);
    expect(sum('会员储值')).toBe(expected.business.byMethod.wallet);
    const coupon = rows.find((r) => Number(r[col('团购券')]) > 0)!;
    expect(coupon[col('团购券码')]).toBe('美团 MT2026102900001');
    // 优惠 / 免单：收款备注写原因与授权人
    const discounted = rows.find((r) => Number(r[col('优惠 / 免单')]) > 0)!;
    expect(discounted[col('收款备注')]).toBe('优惠 / 免单 抹零（张经理授权）');
  });

  it('异常清单：反结账、撤销误开的牌、免票入场；反结账时作废的门票不重复列为作废明细', () => {
    const rows = rowsOf(file('04-异常清单.csv')).slice(1);
    const kinds = rows.map((r) => r[0]);
    const voidRow = rows.find((r) => r[0] === '反结账')!;
    expect(voidRow[3]).toBe('A8071');
    expect(voidRow[6]).toBe('-557.00');
    expect(voidRow[7]).toContain('收款方式记错');
    // 撤销误开的牌：每一次都列，写明是否超过更正时限（演示里 A8095 开牌 1 分钟后撤销，在时限内，日结异常清单不列）
    const cancel = rows.find((r) => r[0] === '撤销误开的牌')!;
    expect(cancel[3]).toBe('A8095');
    expect(cancel[7]).toContain('在更正时限 15 分钟内');
    // 接待时直接选免票：写明当场授权的人与原因（R1.2）
    const free = rows.find((r) => r[0] === '免票入场' && r[3] === 'A8069')!;
    expect(free[7]).toContain('儿童免票');
    expect(free[7]).toContain('1 米以下儿童，与爸爸同行，张经理当场授权');
    // 优惠 / 免单：补上手牌与收银，金额记负数（少收的营业额）
    const discount = rows.find((r) => r[0] === '优惠 / 免单')!;
    expect(discount[3]).toBe('A8072');
    expect(discount[5]).toBe('陈茵');
    expect(discount[6]).toBe('-21.00');
    expect(discount[7]).toContain('抹零');
    expect(discount[7]).toContain('张经理当场授权');
    expect(rows.filter((r) => r[0] === '作废明细' && r[7]!.startsWith('门票'))).toEqual([]);
    expect(kinds).not.toContain('余额不一致');
  });

  it('交班：陈茵已交班，短款 10 元', () => {
    const [header, ...rows] = rowsOf(file('05-交班.csv'));
    const chen = rows.find((r) => r[1] === '陈茵')!;
    expect(chen[header!.indexOf('状态')]).toBe('已交班');
    expect(chen[header!.indexOf('长短款')]).toBe('-10.00');
    expect(chen[header!.indexOf('备用金')]).toBe('500.00');
    expect(chen[header!.indexOf('反结账退现金')]).toBe('0.00');
  });
});

describe('余额变动清单', () => {
  it('按门店时间解析起点', () => {
    expect(parseLocalTime('2026-11-05 06:00', 'Asia/Shanghai')?.toISOString()).toBe('2026-11-04T22:00:00.000Z');
    expect(parseLocalTime('2026-11-05T06:00:00+08:00', 'Asia/Shanghai')?.toISOString()).toBe('2026-11-04T22:00:00.000Z');
    expect(parseLocalTime('2026-11-05 25:00', 'Asia/Shanghai')).toBeNull();
    expect(parseLocalTime('昨天', 'Asia/Shanghai')).toBeNull();
  });

  it('起点之后有变动的会员：起点余额、现在余额与笔数；起点在最后一笔之后时为空', async () => {
    const all = await balanceChanges(ctx.sql, new Date(seededAt.getTime() - 3 * 86_400_000));
    const shen = all.find((r) => r.phone === expected.member.phone)!;
    expect(shen).toMatchObject({ principalBefore: 0, bonusBefore: 0, principalAfter: expected.member.principalBalance, bonusAfter: expected.member.bonusBalance, openingAfterSince: false });
    expect(shen.entries).toBeGreaterThanOrEqual(2);
    expect(await balanceChanges(ctx.sql, new Date(Date.now() + 60_000))).toEqual([]);
  });

  it('期初导入、期初作废默认不算变动；--include-opening 时列出并注明', async () => {
    const since = new Date();
    const actor = { id: ctx.ownerId, username: 'owner', displayName: '测试店主', role: 'owner' as const, duties: [], mustChangePassword: false };
    await applyOpeningImport(
      { sql: ctx.sql, config: ctx.config },
      { source: 'EBC', fileName: 'ebc.csv', csv: '姓名,手机号,本金,赠金\n变动甲,13900009999,88,0', clientKey: randomUUID() },
      { actor },
    );
    expect((await balanceChanges(ctx.sql, since)).find((r) => r.phone === '13900009999')).toBeUndefined();
    expect((await balanceChanges(ctx.sql, since, true)).find((r) => r.phone === '13900009999')).toMatchObject({
      principalBefore: 0,
      principalAfter: 8800,
      openingAfterSince: true,
    });
  });
});
