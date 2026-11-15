// 多门店的底子（8.0.22，docs/MULTISTORE_V8022.md 第 1–4 节）：门店与主体档案、员工挂门店、登录与换店、
// 按店的设置、事务开头记上当前门店。只有一家店时与以往完全一样（别的用例照旧通过就是证明）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSnapshot } from '../src/server/db';
import { runInStore } from '../src/server/lib/store-context';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
}, 60_000);
afterAll(async () => ctx.close());

async function newStaff(username: string) {
  const created = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, role: 'clerk' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const temp = created.body.temporaryPassword as string;
  const cookie = await login(ctx.app, username, temp);
  expect((await api(ctx.app, cookie, 'POST', '/api/auth/change-password', { currentPassword: temp, newPassword: `${username}-2026x` })).status).toBe(200);
  return { id: Number(created.body.staff?.id ?? created.body.id), cookie: await login(ctx.app, username, `${username}-2026x`) };
}

describe('门店与主体', () => {
  it('迁移建好本店与本公司；只有一家店时会话里就是本店', async () => {
    const me = await api(ctx.app, ctx.owner, 'GET', '/api/auth/me');
    expect(me.body.store).toMatchObject({ id: 1, code: 'HQ' });
    expect(me.body.stores.map((s: { id: number }) => s.id)).toEqual([1]);
    const clerkMe = await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me');
    expect(clerkMe.body.store).toMatchObject({ id: 1 });
    // 本店不能停用
    const list = await api(ctx.app, ctx.owner, 'GET', '/api/admin/stores');
    const hq = list.body.stores.find((s: { id: number }) => s.id === 1);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/stores/1', { ...hq, active: false })).status).toBe(400);
    // 只有店主管门店
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/stores')).status).toBe(403);
  });

  it('建第二个主体与门店；员工只挂第二家店时登录就进那家；店主能换店；按店的设置各自一份', async () => {
    const entity = await api(ctx.app, ctx.owner, 'POST', '/api/admin/entities', { name: '福田汤泉有限公司', taxNo: '91440300MA5XXXXXX1' });
    expect(entity.status, JSON.stringify(entity.body)).toBe(201);
    const store = await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'ft', name: '福田店', entityId: entity.body.id });
    expect(store.status, JSON.stringify(store.body)).toBe(201);
    expect(store.body).toMatchObject({ code: 'FT', entityName: '福田汤泉有限公司' });
    const ft = store.body.id as number;
    // 同样的代码再建一次：拦下
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'FT', name: '福田二店', entityId: entity.body.id })).body.error.code).toBe('STORE_CODE_TAKEN');

    const staff = await newStaff('ftclerk');
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${staff.id}/stores`, { storeIds: [ft] })).status).toBe(200);
    const cookie = await login(ctx.app, 'ftclerk', 'ftclerk-2026x');
    const me = await api(ctx.app, cookie, 'GET', '/api/auth/me');
    expect(me.body.store).toMatchObject({ id: ft, code: 'FT', name: '福田店' });
    expect(me.body.storeName).toBe('福田店');
    expect(me.body.stores.map((s: { id: number }) => s.id)).toEqual([ft]);
    // 不能换到没挂的门店
    expect((await api(ctx.app, cookie, 'POST', '/api/auth/store', { storeId: 1 })).status).toBe(400);

    // 店主换到福田店：营业日切换时间改成 4 点只改福田店的；本店照旧
    const before = (await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body;
    const switched = await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId: ft });
    expect(switched.status, JSON.stringify(switched.body)).toBe(200);
    expect(switched.body.store.code).toBe('FT');
    const inFt = (await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body;
    expect(inFt.storeName).toBe('福田店');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { ...inFt, businessDayStartHour: (before.businessDayStartHour + 2) % 12 })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body.businessDayStartHour).toBe((before.businessDayStartHour + 2) % 12);
    const [own] = await ctx.sql<{ value: number }[]>`SELECT value FROM store_settings WHERE store_id = ${ft} AND key = 'business_day_start_hour'`;
    expect(own?.value).toBe((before.businessDayStartHour + 2) % 12);
    // 全公司的项（钱包扣款规则）在福田店里改，照样存全公司的
    expect((await ctx.sql`SELECT 1 FROM store_settings WHERE store_id = ${ft} AND key = 'deduction_rule'`).length).toBe(0);

    // 换回本店：切换时间照旧
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId: 1 })).status).toBe(200);
    const inHq = (await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body;
    expect(inHq.businessDayStartHour).toBe(before.businessDayStartHour);
    expect(inHq.storeName).toBe(before.storeName);
    // 福田店的员工那边看到的是福田店的切换时间
    expect((await api(ctx.app, cookie, 'GET', '/api/auth/me')).body.rules.businessDayStartHour).toBe((before.businessDayStartHour + 2) % 12);
  });

  it('事务开头记上当前门店：第二家店的上下文里 yuzu_store() 是它；本店与没有上下文的是 1', async () => {
    const outside = await ctx.sql.begin(async (tx) => tx<{ s: number }[]>`SELECT yuzu_store() AS s`);
    expect(outside[0]!.s).toBe(1);
    const inStore = await runInStore(7, () => ctx.sql.begin(async (tx) => tx<{ s: number }[]>`SELECT yuzu_store() AS s`));
    expect(inStore[0]!.s).toBe(7);
    const snap = await runInStore(7, () => readSnapshot(ctx.sql, async (tx) => tx<{ s: number }[]>`SELECT yuzu_store() AS s`));
    expect(snap[0]!.s).toBe(7);
    const hq = await runInStore(1, () => ctx.sql.begin(async (tx) => tx<{ s: string | null }[]>`SELECT current_setting('yuzu.store', true) AS s`));
    expect(hq[0]!.s ?? '').toBe('');
  });
});
