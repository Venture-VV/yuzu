// v0.7.1 带上的复核修正：
//   · 测试服补充报告（PR #16 评论）：店员只看自己的班次；会员搜索只有纯数字才按手机号找；
//   · 测试会话 main 测试（PR #15 / #16 评论）问题 1：没有「查看在店手牌」的岗位（客户经理）看不到在店客人；
//     问题 2：有跨营业日反结账时，经营总览、今日看板的收款构成、门票、结账单、客人、储值消费与日结同一营业口径；
//     其他观察：试用 / 正式环境灌演示数据先报红线。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDayStart } from '../src/shared/business-date';
import { shiftDate } from '../src/shared/labels';
import type { Actor } from '../src/server/lib/context';
import { checkout } from '../src/server/modules/frontdesk/checkout';
import { checkin } from '../src/server/modules/frontdesk/visits';
import { loadSettings } from '../src/server/modules/settings';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

const H = 3_600_000;
let ctx: TestContext;
let duty: string;
let am: string;
let today: string;
let clerk: Actor;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'am', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  am = await login(ctx.app, 'am');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  clerk = { id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk', duties: [], mustChangePassword: false };
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'R', from: 1, to: 20, width: 3, zone: 'male' })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('测试服补充报告', () => {
  it('交班页「今天的班次」：店员、客户经理只看到自己的班次，值班经理看全部（与单个班次的规则一致）', async () => {
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/shifts', { openingCash: 50000 })).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 20000 })).status).toBe(200);
    const mine = (await api(ctx.app, ctx.clerk, 'GET', `/api/shifts?date=${today}`)).body as { staffName: string }[];
    expect(mine.map((s) => s.staffName)).toEqual(['测试店员']);
    expect((await api(ctx.app, am, 'GET', `/api/shifts?date=${today}`)).body).toEqual([]);
    const all = (await api(ctx.app, duty, 'GET', `/api/shifts?date=${today}`)).body as { staffName: string }[];
    expect(all.map((s) => s.staffName).sort()).toEqual(['测试店主', '测试店员']);
  });

  it('会员搜索：文字里的数字不当作手机号片段；纯数字（可带空格、横线）照常按手机号找', async () => {
    await createMember(ctx, '搜索甲', '19900099901');
    const search = async (q: string) => ((await api(ctx.app, ctx.clerk, 'GET', `/api/members?q=${encodeURIComponent(q)}`)).body as { name: string }[]).map((m) => m.name);
    expect(await search('zzz-绝不存在-999')).toEqual([]);
    expect(await search('99901')).toEqual(['搜索甲']);
    expect(await search('199 0009 9901')).toEqual(['搜索甲']);
    expect(await search('199-0009-9901')).toEqual(['搜索甲']);
    expect(await search('搜索甲')).toEqual(['搜索甲']);
  });
});

describe('测试会话问题 1：在店客人只给能看前台的岗位', () => {
  it('客户经理的今日看板没有在店人数与在店最久；店员照常有', async () => {
    await checkin({ sql: ctx.sql, config: ctx.config }, { clientKey: randomUUID(), guests: [{ tagCode: 'R001', zone: 'male' }] }, { actor: clerk, at: new Date(Date.now() - H) });
    const asAm = (await api(ctx.app, am, 'GET', '/api/dashboard')).body;
    expect(asAm.inStore).toBeNull();
    expect((await api(ctx.app, am, 'GET', '/api/reports/duty')).body.longStays).toBeNull();
    const asClerk = (await api(ctx.app, ctx.clerk, 'GET', '/api/dashboard')).body;
    expect(asClerk.inStore.count).toBe(1);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/reports/duty')).body.longStays).toHaveLength(1);
  });
});

describe('测试会话问题 2：跨营业日反结账时看板与日结同一营业口径', () => {
  it('昨天结的单今天反结账：昨天的收款、门票、结账单、客人、储值消费不变，今天冲回；两天都与日结一致', async () => {
    const deps = { sql: ctx.sql, config: ctx.config };
    const yesterday = shiftDate(today, -1);
    // 昨天营业日开始后 3 小时结账（在店 1 小时）：不论现在几点都落在昨天。原来用「现在 − 26 小时」，
    // 在营业日切换后的两小时里（北京时间 06:00–08:00）会落到前天（测试会话复测 v0.7.3 的观察）
    const startHour = (await loadSettings(ctx.sql)).businessDayStartHour;
    const at = new Date(businessDayStart(yesterday, ctx.config.timezone, startHour).getTime() + 3 * H);
    const m = await createMember(ctx, '跨日会员', '19900099902');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, 100000))).status).toBe(200);
    const v = await checkin(deps, { clientKey: randomUUID(), guests: [{ tagCode: 'R002', zone: 'male', memberId: m.id }, { tagCode: 'R003', zone: 'male' }] }, { actor: clerk, at: new Date(at.getTime() - H) });
    const ids = v.visits.map((x) => x.id);
    // 按实际时间核对要有补录权限（店主）
    const preview = (await api(ctx.app, ctx.owner, 'GET', `/api/frontdesk/checkout-preview?ids=${ids.join(',')}&at=${encodeURIComponent(at.toISOString())}`)).body;
    const total = preview.totalAmount as number;
    expect(total).toBe(99800);
    const done = await checkout(
      deps,
      {
        clientKey: randomUUID(),
        visitIds: ids,
        expectedTotal: total,
        payments: [
          { method: 'wallet', memberId: m.id, amount: 30000, expectedSplit: { principal: 30000, bonus: 0 } },
          { method: 'wechat', amount: total - 30000, ref: '尾号 0001' },
        ],
      },
      { actor: clerk, at },
    );
    expect(done.businessDate).toBe(yesterday);
    // 今天反结账（店主），客人再用现金重结
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${done.id}/void`, { reason: '收款方式记错' })).status).toBe(200);
    const pre2 = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${ids.join(',')}`)).body;
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: ids, expectedTotal: pre2.totalAmount, payments: [{ method: 'cash', amount: pre2.totalAmount }] })).status).toBe(200);

    for (const date of [yesterday, today]) {
      const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${date}`)).body;
      const ex = (await api(ctx.app, ctx.owner, 'GET', `/api/reports/executive?from=${date}&to=${date}`)).body;
      const biz = st.business as { net: number; ticket: number; checkouts: { count: number }; voids: { count: number }; byMethod: { method: string; amount: number }[] };
      const methods = (list: { method: string; amount: number }[]) => Object.fromEntries(list.filter((x) => x.amount !== 0).map((x) => [x.method, x.amount]));
      expect(methods(ex.byMethod), date).toEqual(methods(biz.byMethod));
      expect(ex.kpis.receivable, date).toBe(biz.net);
      expect(ex.kpis.checkouts, date).toBe(biz.checkouts.count - biz.voids.count);
      expect(ex.tickets.reduce((t: number, x: { amount: number }) => t + x.amount, 0), date).toBe(biz.ticket);
      expect(ex.kpis.walletConsumed, date).toBe(st.consume.total - (st.reversal.principal + st.reversal.bonus));
    }
    // 昨天：两位客人、一张单、储值 300；今天：反结账冲回两位客人与一张单，重结又加回
    const y = (await api(ctx.app, ctx.owner, 'GET', `/api/reports/executive?from=${yesterday}&to=${yesterday}`)).body;
    expect(y.kpis).toMatchObject({ guests: 2, checkouts: 1, walletConsumed: 30000 });
    const t = (await api(ctx.app, ctx.owner, 'GET', `/api/reports/executive?from=${today}&to=${today}`)).body;
    expect(t.kpis).toMatchObject({ guests: 0, checkouts: 0, walletConsumed: -30000 });
    // 今日看板与日结同口径
    const dash = (await api(ctx.app, ctx.owner, 'GET', '/api/dashboard')).body;
    const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
    expect(Object.fromEntries(dash.todayStats.byMethod.map((x: { method: string; amount: number }) => [x.method, x.amount]))).toEqual(
      Object.fromEntries((st.business.byMethod as { method: string; amount: number }[]).filter((x) => x.amount !== 0).map((x) => [x.method, x.amount])),
    );
    expect(dash.todayStats.ticket).toBe(st.business.ticket);
    expect(dash.todayStats.checkouts).toBe(st.business.checkouts.count - st.business.voids.count);
  });
});

describe('其他观察：演示数据的红线提示放在最前', () => {
  it('试用环境执行 seed-billing-demo --previous-day 先报「禁止写入」', async () => {
    const { execFileSync } = await import('node:child_process');
    let out = '';
    try {
      execFileSync('npx', ['tsx', 'src/server/cli.ts', 'seed-billing-demo', '--previous-day'], {
        env: { ...process.env, APP_ENV: 'trial', DATABASE_URL: ctx.config.databaseUrl, YUZU_INSTANCE: 'shadow' },
        stdio: 'pipe',
      });
    } catch (e) {
      out = String((e as { stderr?: Buffer }).stderr ?? '');
    }
    expect(out).toContain('当前是试用环境，禁止写入结账演示数据');
  }, 60_000);
});
