// 8.0.7 A1 可调的数值（店主 2026-11-10：有争议的规则不要写死；@shared/tunables）：
//   · 默认与原来写死的一样，会话里带到各页面；只改提交的项、不合格的整次拒绝、记修改记录；
//   · 读设置的地方按设置算：代理人天数（A7）、平台核销补录天数（N6）、收货附件份数（CG11）、批量发券人数（HY07）；
//   · 打印方式（店主 2026-11-10）：默认「本机打印」，服务器不发、不探测网口小票机，改成「服务器直连」照旧；
//   · 财务账号看营销成本（HY14）：默认看不到，关掉以后按岗位权限给；
//   · 规则总表列出这些项。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TUNABLES, TUNABLE_LIMITS } from '../src/shared/tunables';
import { checkDevicesOnce } from '../src/server/modules/devices';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;

const settings = (body: Record<string, unknown>, cookie = ctx.owner) => api(ctx.app, cookie, 'PUT', '/api/settings', body);
const shiftDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
}, 60_000);
afterAll(async () => ctx.close());

describe('可调的数值（8.0.7 A1）', () => {
  it('默认与原来写死的一样，会话里带着；只改提交的项，不合格的拒绝，改动进规则总表', async () => {
    const s = (await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body;
    expect(s).toMatchObject(DEFAULT_TUNABLES);
    expect(s).toMatchObject({ approvalBatchMaxCents: 500_000, approvalBatchMax: 50, approvalOverdueHours: 24, delegationMaxDays: 31, urgentEscalateDays: 3, contractRemindDays: 60, pdfMaxMb: 10, receiptAttachmentsMax: 9, mpFoodMaxQuantity: 20, mpFoodMaxTotalCents: 50_000, platformBackfillDays: 31, printMode: 'local', printWaitMinutes: 30, campaignMaxMembers: 2000, campaignNoticeDays: 30, smsMaxAttempts: 3, financeHidesMarketingCost: true });
    // 会话（各页面读它）
    expect((await api(ctx.app, duty, 'GET', '/api/auth/me')).body.rules).toMatchObject({ approvalOverdueHours: 24, printMode: 'local' });
    // 只有店主能改
    expect((await settings({ approvalOverdueHours: 12 }, duty)).status).toBe(403);
    const saved = await settings({ approvalOverdueHours: 12, contractRemindDays: 90 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ approvalOverdueHours: 12, contractRemindDays: 90, delegationMaxDays: 31, storeName: s.storeName });
    expect((await api(ctx.app, duty, 'GET', '/api/auth/me')).body.rules).toMatchObject({ approvalOverdueHours: 12, contractRemindDays: 90 });
    // 每一项的范围
    for (const [key, l] of Object.entries(TUNABLE_LIMITS)) {
      expect((await settings({ [key]: l.max + 1 })).status, key).toBe(400);
      expect((await settings({ [key]: l.min - 1 })).status, key).toBe(400);
    }
    expect((await settings({ printMode: 'lan' })).status).toBe(400);
    expect((await settings({ pdfMaxMb: 1.5 })).status).toBe(400);
    // 不合格的没写进去
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body).toMatchObject({ approvalOverdueHours: 12, pdfMaxMb: 10 });
    const rules = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/rules')).body as { key: string; value: string; isDefault: boolean }[];
    expect(rules.find((r) => r.key === 'approval_overdue_hours')).toMatchObject({ value: '当前这一级等了超过 12 小时', isDefault: false });
    expect(rules.find((r) => r.key === 'print_mode')).toMatchObject({ isDefault: true });
    for (const key of ['approval_batch_max_cents', 'delegation_max_days', 'urgent_escalate_days', 'contract_remind_days', 'pdf_max_mb', 'receipt_attachments_max', 'mp_food_max_quantity', 'platform_backfill_days', 'campaign_max_members', 'sms_max_attempts', 'count_card_sales', 'finance_hides_marketing_cost']) {
      expect(rules.some((r) => r.key === key), key).toBe(true);
    }
    expect((await settings({ approvalOverdueHours: 24, contractRemindDays: 60 })).status).toBe(200);
  });

  it('代理人最多几天（A7）按设置', async () => {
    const me = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body;
    const today = me.calendarToday as string;
    // 代理人要有审批中心的权限：负责人职责
    const delegateId = await createStaff(ctx.sql, { username: 'appr', displayName: '负责人甲', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
    const body = (days: number) => ({ clientKey: randomUUID(), staffId: me.staff.id, delegateId, startsOn: today, endsOn: shiftDays(today, days - 1) });
    await settings({ delegationMaxDays: 5 });
    const over = await api(ctx.app, ctx.owner, 'POST', '/api/approvals/delegations', body(6));
    expect(over.status).toBe(400);
    expect(over.body.error.message).toContain('最多 5 天');
    const okRes = await api(ctx.app, ctx.owner, 'POST', '/api/approvals/delegations', body(5));
    expect(okRes.status, JSON.stringify(okRes.body)).toBeLessThan(300);
    // 设到 31 天以上也能登记：库里原来卡在 31 天，迁移 105 放宽到 366 天（Codex 审查 d8b314b）
    await settings({ delegationMaxDays: 366 });
    const long = await api(ctx.app, ctx.owner, 'POST', '/api/approvals/delegations', body(366));
    expect(long.status, JSON.stringify(long.body)).toBeLessThan(300);
    await settings({ delegationMaxDays: DEFAULT_TUNABLES.delegationMaxDays });
  });

  it('库里的约束跟得上可调的上限：批量发券最多 20,000 位、代理最长 366 天（迁移 105，Codex 审查 d8b314b）', async () => {
    const defs = await ctx.sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid IN ('coupon_campaigns'::regclass, 'approval_delegations'::regclass) AND contype = 'c'`;
    const targeted = defs.filter((d) => d.def.includes('targeted'));
    expect(targeted).toHaveLength(1);
    expect(targeted[0]!.def).toContain(`<= ${TUNABLE_LIMITS.campaignMaxMembers.max}`);
    const span = defs.filter((d) => d.def.includes('ends_on - starts_on'));
    expect(span).toHaveLength(1);
    expect(span[0]!.def).toContain(`<= ${TUNABLE_LIMITS.delegationMaxDays.max - 1}`);
  });

  it('平台核销补录最早补到几天前（N6）按设置', async () => {
    await settings({ platformBackfillDays: 2 });
    const redeemedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/platform/redemptions', { clientKey: randomUUID(), platform: 'meituan', code: '1234567890', faceValue: 9_900, redeemedAt });
    expect(r.body.error.code).toBe('PLATFORM_TIME');
    expect(r.body.error.message).toContain('2 天以内');
    await settings({ platformBackfillDays: 31 });
    const ok = await api(ctx.app, ctx.owner, 'POST', '/api/platform/redemptions', { clientKey: randomUUID(), platform: 'meituan', code: '1234567890', faceValue: 9_900, redeemedAt });
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
  });

  it('打印方式：默认本机打印，服务器不发、不探测网口小票机；改成服务器直连以后照旧', async () => {
    // 一台连不上的网口小票机（端口没人听）
    const created = await api(ctx.app, ctx.owner, 'POST', '/api/devices', { clientKey: randomUUID(), code: 'PRN-TUN-1', name: '测试小票机', kind: 'printer', area: '收银', connection: 'network', host: '127.0.0.1', port: 9 });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const id = Number(created.body.id);
    const status = async () => (await ctx.sql<{ status: string }[]>`SELECT status FROM devices WHERE id = ${id}`)[0]!.status;
    await checkDevicesOnce(ctx);
    expect(await status()).toBe('unknown'); // 本机打印：不探测
    const job = await api(ctx.app, ctx.owner, 'POST', `/api/devices/${id}/jobs`, { clientKey: randomUUID(), kind: 'test_page' });
    expect(job.body.error.code).toBe('PRINT_MODE_LOCAL');
    const doc = await api(ctx.app, ctx.owner, 'POST', '/api/print/jobs', { clientKey: randomUUID(), deviceId: id, doc: { type: 'settlement', date: (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today } });
    expect(doc.body.error.code).toBe('PRINT_MODE_LOCAL');
    await settings({ printMode: 'network' });
    await checkDevicesOnce(ctx);
    expect(await status()).toBe('offline'); // 服务器直连：照旧探测，连不上记离线
    await settings({ printMode: 'local' });
    await api(ctx.app, ctx.owner, 'POST', `/api/devices/${id}/enabled`, { enabled: false, expectedVersion: (await ctx.sql<{ version: number }[]>`SELECT version FROM devices WHERE id = ${id}`)[0]!.version });
  });

  it('财务账号看营销成本（HY14）：默认看不到，关掉以后按岗位权限给', async () => {
    await createStaff(ctx.sql, { username: 'sm_cost', displayName: '店总兼成本', role: 'store_manager', duties: ['cost'], password: PASSWORD, mustChangePassword: false });
    const sm = await login(ctx.app, 'sm_cost');
    const perms = async () => (await api(ctx.app, sm, 'GET', '/api/auth/me')).body.permissions as string[];
    expect(await perms()).not.toContain('marketing.cost');
    await settings({ financeHidesMarketingCost: false });
    expect(await perms()).toContain('marketing.cost');
    await settings({ financeHidesMarketingCost: true });
    expect(await perms()).not.toContain('marketing.cost');
  });

  it('次卡售卖（HY05）在设置里开关', async () => {
    expect((await api(ctx.app, duty, 'GET', '/api/auth/me')).body.rules.countCardSales).toBe(false);
    await settings({ countCardSales: true });
    expect((await api(ctx.app, duty, 'GET', '/api/auth/me')).body.rules.countCardSales).toBe(true);
    await settings({ countCardSales: false });
  });
});
