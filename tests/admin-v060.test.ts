// v0.6.0：管理后台（后台首页、规则总表、岗位权限可配置）、客户经理岗位、会员渠道来源与等级、按岗位的数据看板。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { api, consumeBody, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let boss: string;
let today: string;

const perms = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/auth/me')).body.permissions as string[];
const matrix = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/permissions')).body;
const setRole = (role: string, list: string[], cookie = ctx.owner) => api(ctx.app, cookie, 'PUT', '/api/admin/permissions', { roles: { [role]: list } });
const authorize = (cookie: string, approver: string, purpose: string, scope: unknown) =>
  api(ctx.app, cookie, 'POST', '/api/auth/authorize', { username: approver, password: PASSWORD, purpose, scope });

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  boss = await login(ctx.app, 'boss');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
});
afterAll(async () => ctx.close());

describe('岗位权限可在后台调整', () => {
  it('去掉值班经理的「查看历史营业日」立即生效（会话与接口），恢复默认后照常', async () => {
    expect((await api(ctx.app, duty, 'GET', '/api/ledger?date=2020-01-01')).status).toBe(200);
    const m = await matrix();
    const without = m.effective.duty_manager.filter((p: string) => p !== 'ledger.readHistory');
    const r = await setRole('duty_manager', without);
    expect(r.status).toBe(200);
    // 只存相对默认的增减
    expect(r.body.overrides).toEqual({ duty_manager: { add: [], remove: ['ledger.readHistory'] } });
    expect(r.body.updatedBy).toBe('测试店主');
    expect(await perms(duty)).not.toContain('ledger.readHistory');
    expect((await api(ctx.app, duty, 'GET', '/api/ledger?date=2020-01-01')).status).toBe(403);
    // 其他岗位不受影响
    expect(await perms(boss)).toContain('ledger.readHistory');

    expect((await setRole('duty_manager', m.defaults.duty_manager)).body.overrides).toEqual({});
    expect((await api(ctx.app, duty, 'GET', '/api/ledger?date=2020-01-01')).status).toBe(200);
    const audit = await ctx.sql<{ detail: { key: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'settings_updated' AND detail->>'key' = 'role_permissions'`;
    expect(audit.length).toBe(2);
  });

  it('店主专属的权限不能授出；只有店主能改，店总只能看', async () => {
    const r = await setRole('store_manager', [...(await matrix()).effective.store_manager, 'staff.manage']);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('只属于店主');
    expect((await setRole('duty_manager', [], duty)).status).toBe(403);
    expect((await setRole('duty_manager', [], boss)).status).toBe(403);
    expect((await api(ctx.app, boss, 'GET', '/api/admin/permissions')).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/permissions')).status).toBe(403);
    // 库里被手工写进店主专属权限时也不生效
    await ctx.sql`INSERT INTO settings (key, value) VALUES ('role_permissions', ${ctx.sql.json({ clerk: { add: ['settings.manage', 'audit.read'], remove: [] } })})
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    const clerkPerms = await perms(ctx.clerk);
    expect(clerkPerms).toContain('audit.read');
    expect(clerkPerms).not.toContain('settings.manage');
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/settings', { storeName: '越权' })).status).toBe(403);
    await ctx.sql`DELETE FROM settings WHERE key = 'role_permissions'`;
    expect(await perms(ctx.clerk)).not.toContain('audit.read');
  });

  it('当场授权按调整后的权限核对授权人：给值班经理加上「授权超限」后可以签发，签发后又去掉则核销时拒绝', async () => {
    await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { maxRechargeCents: 100_000 });
    const m = await createMember(ctx, '超限会员', '19900060001');
    const scope = { kind: 'recharge', memberId: m.id, amount: 200_000 };
    const denied = await authorize(ctx.clerk, 'duty', 'over_limit', scope);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('AUTH_NOT_ALLOWED');

    const base = (await matrix()).effective.duty_manager as string[];
    expect((await setRole('duty_manager', [...base, 'auth.overLimit'])).status).toBe(200);
    const g = await authorize(ctx.clerk, 'duty', 'over_limit', scope);
    expect(g.status).toBe(200);
    // 签发后店主又收回：这次授权在核销时作废
    expect((await setRole('duty_manager', base)).status).toBe(200);
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 200_000, 0, { overLimitGrantId: g.body.grantId }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('GRANT_INVALID');
    await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { maxRechargeCents: 50_000_000 });
  });
});

describe('客户经理岗位', () => {
  it('能建档、充值、看会员总览；不能前台收银、看经营总览、改规则', async () => {
    await createStaff(ctx.sql, { username: 'kehu', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
    const am = await login(ctx.app, 'kehu');
    const p = await perms(am);
    expect(p).toEqual(expect.arrayContaining(['member.read', 'member.write', 'recharge.create', 'ledger.readToday', 'report.members']));
    for (const x of ['frontdesk.read', 'consume.create', 'report.executive', 'settings.manage', 'staff.manage']) expect(p).not.toContain(x);

    const m = await api(ctx.app, am, 'POST', '/api/members', { name: '客户经理开发', phone: '19900060002', channel: 'c5' });
    expect(m.status).toBe(201);
    expect((await api(ctx.app, am, 'POST', '/api/recharges', rechargeBody(m.body.id, 100_000))).status).toBe(200);
    // 收款前必须先开班（新库默认开）：客户经理自己开班后充值，记到自己的班次
    await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { requireOpenShift: true });
    expect((await api(ctx.app, am, 'POST', '/api/recharges', rechargeBody(m.body.id, 10_000))).body.error.code).toBe('SHIFT_REQUIRED');
    const shift = await api(ctx.app, am, 'POST', '/api/shifts', { openingCash: 0 });
    expect(shift.status).toBeLessThan(300);
    expect((await api(ctx.app, am, 'POST', '/api/recharges', rechargeBody(m.body.id, 10_000))).status).toBe(200);
    await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { requireOpenShift: false });
    expect((await api(ctx.app, am, 'GET', `/api/reports/members?from=${today}&to=${today}`)).status).toBe(200);
    expect((await api(ctx.app, am, 'GET', `/api/reports/executive?from=${today}&to=${today}`)).status).toBe(403);
    expect((await api(ctx.app, am, 'GET', '/api/frontdesk/board')).status).toBe(403);
    expect((await api(ctx.app, am, 'GET', '/api/admin/overview')).status).toBe(403);
  });
});

describe('会员渠道来源', () => {
  it('后台新增渠道按顺序编号、不能删除只能停用、名称不重复；建档选启用中的渠道，停用的旧渠道保留', async () => {
    const before = (await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body.memberChannels as { key: string; label: string; active: boolean }[];
    expect(before.map((c) => c.key)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
    const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { memberChannels: [...before, { label: '小红书', active: true }] });
    expect(saved.status).toBe(200);
    expect(saved.body.memberChannels.at(-1)).toEqual({ key: 'c8', label: '小红书', active: true });
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { memberChannels: before.slice(1) })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { memberChannels: [...before, { label: '美团', active: true }] })).status).toBe(400);

    const m = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name: '小红书来的', phone: '19900060003', channel: 'c8' });
    expect(m.status).toBe(201);
    expect(m.body.channel).toBe('c8');
    // 停用「小红书」：新建不能再选，已登记的会员编辑其他资料时照常保留
    const list = (await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body.memberChannels as { key: string; label: string; active: boolean }[];
    await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { memberChannels: list.map((c) => (c.key === 'c8' ? { ...c, active: false } : c)) });
    const blocked = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name: '停用渠道', phone: '19900060004', channel: 'c8' });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.details).toEqual({ field: 'channel' });
    const kept = await api(ctx.app, ctx.clerk, 'PUT', `/api/members/${m.body.id}`, { name: '小红书来的（改名）', phone: '19900060003', channel: 'c8' });
    expect(kept.status).toBe(200);
    expect(kept.body.channel).toBe('c8');
    const noChannel = await api(ctx.app, ctx.clerk, 'PUT', `/api/members/${m.body.id}`, { name: '小红书来的', phone: '19900060003' });
    expect(noChannel.body.channel).toBe('c8');
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/members/${m.body.id}`, { name: '小红书来的', phone: '19900060003', channel: 'c99' })).status).toBe(400);
    const cleared = await api(ctx.app, ctx.clerk, 'PUT', `/api/members/${m.body.id}`, { name: '小红书来的', phone: '19900060003', channel: null });
    expect(cleared.body.channel).toBeNull();
  });
});

describe('会员等级与赠金明细', () => {
  it('按累计充值：达到门槛的时间、到下一级还差多少、升级记录；改为余额口径时消费会降级', async () => {
    const rules = await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', {
      vipLevelBasis: 'recharge',
      vipLevelThresholds: [0, 100_000, 300_000],
      vipLevelNames: ['普通', '银卡', '金卡'],
    });
    expect(rules.status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { vipLevelNames: ['普通', '普通'] })).status).toBe(400);

    const m = await createMember(ctx, '升级会员', '19900060005');
    let d = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}`)).body;
    expect(d.level).toMatchObject({ level: 1, name: '普通', amountCents: 0, next: { level: 2, name: '银卡', thresholdCents: 100_000, gapCents: 100_000 }, history: [] });
    expect(d.level.since).toBe(new Date(d.createdAt).toISOString());

    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 50_000));
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 60_000));
    d = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}`)).body;
    expect(d.level).toMatchObject({ level: 2, name: '银卡', amountCents: 110_000, next: { level: 3, name: '金卡', gapCents: 190_000 } });
    expect(d.level.history).toHaveLength(1);
    expect(d.level.history[0]).toMatchObject({ from: 1, to: 2, fromName: '普通', toName: '银卡' });
    expect(d.level.validity).toContain('不降级');

    // 余额口径：消费 ¥700 后余额 ¥400，降回普通
    await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { vipLevelBasis: 'balance' });
    await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, 70_000));
    d = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}`)).body;
    expect(d.level).toMatchObject({ basis: 'balance', level: 1, amountCents: 40_000 });
    expect(d.level.history.map((h: { from: number; to: number }) => `${h.from}→${h.to}`)).toEqual(['2→1', '1→2']);
    await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { vipLevelBasis: 'recharge' });
  });

  it('赠金明细列出每笔赠送：可用（含已用部分）、已用完', async () => {
    const m = await createMember(ctx, '赠金会员', '19900060006');
    await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, 100_000, 10_000));
    await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, 100_000, 5_000));
    // 先赠金后本金：扣 ¥120 赠金（先到期的批次先用；都长期有效时按先后）
    await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { deductionRule: 'bonus_first' });
    const c = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, 12_000, { expectedSplit: { principal: 0, bonus: 12_000 } }));
    expect(c.status).toBe(200);
    await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { deductionRule: 'principal_first' });
    const lots = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}`)).body.bonusLotHistory as { amount: number; remaining: number; used: number; status: string }[];
    expect(lots).toHaveLength(2);
    const byAmount = Object.fromEntries(lots.map((l) => [l.amount, l]));
    expect(byAmount[10_000]).toMatchObject({ remaining: 0, used: 10_000, status: 'used' });
    expect(byAmount[5_000]).toMatchObject({ remaining: 3_000, used: 2_000, status: 'active' });
  });
});

describe('数据看板', () => {
  it('经营总览与今日看板、日结同一口径；时段校验', async () => {
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'V', from: 1, to: 10, width: 3, zone: 'male' })).status).toBe(200);
    const enter = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'V001', zone: 'male' }] });
    expect(enter.status).toBe(201);
    const visitId = enter.body.visits[0].id as number;
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
    const paid = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [visitId],
      expectedTotal: preview.totalAmount,
      payments: [{ method: 'cash', amount: preview.totalAmount }],
    });
    expect(paid.status).toBe(200);

    const dash = (await api(ctx.app, ctx.owner, 'GET', '/api/dashboard')).body;
    const exec = await api(ctx.app, ctx.owner, 'GET', `/api/reports/executive?from=${today}&to=${today}`);
    expect(exec.status).toBe(200);
    expect(exec.body.kpis).toMatchObject({ net: dash.todayStats.net - dash.todayStats.discount, guests: dash.todayStats.guests, checkouts: dash.todayStats.checkouts });
    expect(exec.body.kpis.perGuest).toBe(Math.round(exec.body.kpis.net / exec.body.kpis.guests));
    expect(exec.body.departments.reduce((t: number, x: { amount: number }) => t + x.amount, 0)).toBe(exec.body.kpis.receivable);
    expect(exec.body.trend).toHaveLength(1);
    expect(exec.body.arrivals.reduce((t: number, a: { count: number }) => t + a.count, 0)).toBeGreaterThanOrEqual(1);
    // 应收 = 日结的营业额（净额，结账 − 反结账）；储值消费 = 日结的会员消费
    const settlement = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
    expect(exec.body.kpis.receivable).toBe(settlement.business.net);
    expect(exec.body.kpis.rechargePaid).toBe(settlement.recharge.paid);

    const extras = (await api(ctx.app, ctx.clerk, 'GET', '/api/reports/duty')).body;
    expect(extras.hourly).toHaveLength(24);
    expect(extras.departments.reduce((t: number, x: { amount: number }) => t + x.amount, 0)).toBe(exec.body.kpis.receivable);

    // 时段：起止颠倒、晚于今天、超过 366 天都拒绝；值班经理、店员看不到经营总览
    const bad = async (q: string) => (await api(ctx.app, ctx.owner, 'GET', `/api/reports/executive?${q}`)).status;
    expect(await bad(`from=${today}&to=2020-01-01`)).toBe(400);
    expect(await bad(`from=${today}&to=2099-01-01`)).toBe(400);
    expect(await bad(`from=2020-01-01&to=${today}`)).toBe(400);
    expect(await bad('from=2026-02-31&to=2026-03-01')).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/reports/executive?from=${today}&to=${today}`)).status).toBe(403);
    expect((await api(ctx.app, duty, 'GET', `/api/reports/executive?from=${today}&to=${today}`)).status).toBe(403);
    expect((await api(ctx.app, boss, 'GET', `/api/reports/executive?from=${today}&to=${today}`)).status).toBe(200);
  });

  it('会员总览：人数与余额合计、渠道、等级分布与库里一致', async () => {
    const r = await api(ctx.app, boss, 'GET', `/api/reports/members?from=${today}&to=${today}`);
    expect(r.status).toBe(200);
    const [db] = await ctx.sql<{ n: number; principal: number; bonus: number }[]>`
      SELECT count(*)::int AS n, coalesce(sum(principal_balance), 0) AS principal, coalesce(sum(bonus_balance), 0) AS bonus FROM members`;
    expect(r.body.totals).toMatchObject({ members: db!.n, principal: db!.principal, bonus: db!.bonus });
    expect(r.body.levels.reduce((t: number, l: { count: number }) => t + l.count, 0)).toBe(db!.n);
    expect(r.body.allByChannel.reduce((t: number, c: { count: number }) => t + c.count, 0)).toBe(db!.n);
    expect(r.body.newByChannel.find((c: { channel: string }) => c.channel === 'c5')).toMatchObject({ label: '老带新', count: 1 });
    expect(r.body.period.newMembers).toBe(db!.n);
    expect((await api(ctx.app, duty, 'GET', `/api/reports/members?from=${today}&to=${today}`)).status).toBe(403);
  });
});

describe('后台首页与规则总表', () => {
  it('规则总表列出各项设置：改过的标出修改人；首页汇总与最近变动；按岗位开放', async () => {
    let rules = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/rules')).body as { key: string; isDefault: boolean; updatedBy: string | null; value: string }[];
    expect(rules.length).toBeGreaterThanOrEqual(20);
    expect(rules.find((r) => r.key === 'store_name')).toMatchObject({ isDefault: true, updatedBy: null });
    await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { storeName: '浴族 · 测试店' });
    rules = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/rules')).body;
    expect(rules.find((r) => r.key === 'store_name')).toMatchObject({ isDefault: false, updatedBy: '测试店主', value: '浴族 · 测试店' });
    expect(rules.find((r) => r.key === 'frontdesk_rules.vipLevelNames')).toBeTruthy();
    expect(rules.find((r) => r.key === 'role_permissions')).toMatchObject({ value: '按默认' });

    const o = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/overview')).body;
    expect(o.counts.members).toBeGreaterThan(0);
    expect(o.counts.staffByRole).toMatchObject({ owner: 1, clerk: 1, duty_manager: 1, store_manager: 1, account_manager: 1 });
    expect(o.rules.changed).toBeGreaterThanOrEqual(1);
    expect(o.recentChanges[0]).toMatchObject({ staffName: '测试店主', summary: '修改了门店名称' });

    // 店总能看首页与规则总表；值班经理（维护手牌池）能进后台首页，但看不到变动记录与规则总表；店员进不了后台
    expect((await api(ctx.app, boss, 'GET', '/api/admin/rules')).status).toBe(200);
    const dutyHome = await api(ctx.app, duty, 'GET', '/api/admin/overview');
    expect(dutyHome.status).toBe(200);
    expect(dutyHome.body.recentChanges).toBeNull();
    expect((await api(ctx.app, duty, 'GET', '/api/admin/rules')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/overview')).status).toBe(403);
  });
});
