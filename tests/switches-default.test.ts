// 8.0.20：功能开关都默认开（店主 2026-11-14，docs/PENDING_DECISIONS.md KG1–KG4；迁移 126）。
// 别的用例在 setup() 里把这些开关关上、从「都关着」开始；这里不关，核对真正的默认与迁移 126。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERP_MODULE_KEYS } from '../src/shared/erp';
import { loadLocationRules } from '../src/server/modules/locations';
import { loadSettings } from '../src/server/modules/settings';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
const MIGRATION = readFileSync(join(__dirname, '../src/server/migrations/126_switches_on.sql'), 'utf8');

beforeAll(async () => {
  ctx = await setup({ keepDefaultSwitches: true });
});
afterAll(async () => {
  await ctx.close();
});

describe('功能开关都默认开（8.0.20）', () => {
  it('新装的库、没保存过设置：技师、餐饮、客房、平板点餐、ERP 各模块（含员工食堂、安保巡场）、实时位置、企业微信周推都开着', async () => {
    const me = await api(ctx.app, ctx.owner, 'GET', '/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ technicians: true, dining: true, rooms: true, emenu: true });
    expect([...(me.body.erpModules as string[])].sort()).toEqual([...ERP_MODULE_KEYS].sort());
    expect((await loadLocationRules(ctx.sql)).enabled).toBe(true);
    expect((await loadSettings(ctx.sql)).wecomWeeklyPush).toBe(true);
    const dining = await api(ctx.app, ctx.owner, 'GET', '/api/admin/dining');
    expect(dining.body.rules).toMatchObject({ enabled: true, tablesEnabled: true });
  });

  it('没有动的：售次卡仍是停售、点单密码仍是不要、员工自己登记仍关着（KG3）', async () => {
    expect((await loadSettings(ctx.sql)).countCardSales).toBe(false);
    const emenu = await api(ctx.app, ctx.owner, 'GET', '/api/admin/emenu');
    expect(emenu.body.rules).toMatchObject({ enabled: true, requirePin: false });
    const [reg] = await ctx.sql<{ value: { enabled?: boolean } }[]>`SELECT value FROM settings WHERE key = 'canteen_registration'`;
    expect(reg?.value?.enabled ?? false).toBe(false);
  });

  it('迁移 126：已经保存成关的改成开，同一个键里别的数不动；规矩类与小程序线的键不碰；再执行一次什么都不变', async () => {
    const put = (key: string, value: unknown) =>
      ctx.sql`INSERT INTO settings (key, value) VALUES (${key}, ${ctx.sql.json(value as never)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    await put('technician_rules', { enabled: false, requireTechnician: false });
    await put('room_rules', { enabled: false, defaultDeposit: 12300 });
    await put('emenu_rules', { enabled: false, requirePin: false, footerText: '合成页脚' });
    await put('location_rules', { enabled: false, checkinZoneId: null, restZoneId: null });
    await put('dining_rules', { enabled: false, tablesEnabled: false, warnMinutes: 9 });
    await put('erp_modules', { inventory: true, canteen: false, patrol: false, legal: false });
    await put('wecom_weekly_push', false);
    await put('count_card_sales', false);
    await put('canteen_registration', { enabled: false, rev: 3 });
    await put('mp_rules', { enabled: false, version: 2 });
    await put('purchase_rules', { cutoffEnabled: false });
    await ctx.sql.unsafe(MIGRATION);
    const read = async () =>
      Object.fromEntries((await ctx.sql<{ key: string; value: unknown }[]>`SELECT key, value FROM settings ORDER BY key`).map((r) => [r.key, r.value]));
    const after = await read();
    expect(after.technician_rules).toEqual({ enabled: true, requireTechnician: false });
    expect(after.room_rules).toEqual({ enabled: true, defaultDeposit: 12300 });
    expect(after.emenu_rules).toEqual({ enabled: true, requirePin: false, footerText: '合成页脚' });
    expect(after.location_rules).toEqual({ enabled: true, checkinZoneId: null, restZoneId: null });
    expect(after.dining_rules).toEqual({ enabled: true, tablesEnabled: true, warnMinutes: 9 });
    expect(after.erp_modules).toEqual({ inventory: true, canteen: true, patrol: true, legal: true });
    expect(after.wecom_weekly_push).toBe(true);
    // 没有动的
    expect(after.count_card_sales).toBe(false);
    expect(after.canteen_registration).toEqual({ enabled: false, rev: 3 });
    expect(after.mp_rules).toEqual({ enabled: false, version: 2 });
    expect(after.purchase_rules).toEqual({ cutoffEnabled: false });
    // 再执行一次：一行都不改（updated_at 也不动）
    const stamps = async () => (await ctx.sql<{ key: string; at: string }[]>`SELECT key, updated_at::text AS at FROM settings ORDER BY key`).map((r) => `${r.key}@${r.at}`);
    const before2 = await stamps();
    await ctx.sql.unsafe(MIGRATION);
    expect(await stamps()).toEqual(before2);
    expect(await read()).toEqual(after);
    // 之后在设置页关掉：关得上，不会被默认顶回来
    const off = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body).toMatchObject({ dining: false, emenu: false, rooms: true });
  });
});
