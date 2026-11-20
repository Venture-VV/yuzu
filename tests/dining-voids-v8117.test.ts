// 8.1.17 餐饮按出品口（docs/FRONTDESK_V8117.md 第 2、3 节）：
//   · BW-4 退菜按出品口：新权限「退菜：餐厅 / 水吧 / 果吧」，默认原来能退菜（有「前台挂账」）的岗位三项都有，康美部有水吧、果吧；
//     手牌、桌台两个退菜接口与退菜的当场授权申请都按这道菜所在的出品口逐行核对，别的明细照旧要「前台挂账」；原因、时限、授权照旧；
//   · BW-3 发卡台「加项目」：进厨房的菜按出品口的下单权限逐行核对（与点单页同一个函数），不进厨房的项目不受影响，原样重提照原样返回。
// 全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsOf } from '../src/shared/permissions';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let km: string; // 康美部（后勤 + 康美部职责）
let tagNo = 0;
let tableId = 0;
const item: Record<string, number> = {};
const price: Record<string, number> = { 宫保鸡丁: 4800, 柠檬茶: 1800, 果盘: 3800, 大果盘: 8800, 搓澡: 6800 };

const enter = async () => {
  tagNo += 1;
  const tagCode = `V${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', memberId: null }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0].id as number;
};
const lines = (names: string[]) => names.map((n) => ({ itemId: item[n]!, quantity: 1 }));
const total = (names: string[]) => names.reduce((s, n) => s + price[n]!, 0);
/** 点单页下单（手牌客人） */
const order = (visitId: number, names: string[], cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines: lines(names), expectedTotal: total(names) });
/** 发卡台「加项目」 */
const charge = (visitId: number, names: string[], cookie = ctx.clerk, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey, lines: lines(names), expectedTotal: total(names) });
const lineOf = async (visitId: number, name: string) =>
  ((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${visitId}`)).body.lines as { id: number; name: string; status: string }[]).find((l) => l.name === name && l.status === 'active')!;
const voidLine = (lineId: number, cookie: string, extra: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', `/api/frontdesk/lines/${lineId}/void`, { reason: '客人不要了', blame: 'guest', ...extra });
const setClerkPermissions = (drop: string[]) =>
  api(ctx.app, ctx.owner, 'PUT', '/api/admin/permissions', { roles: { clerk: permissionsOf({ position: null, role: 'clerk' }).filter((p) => !drop.includes(p)) } });
const auditOf = async (lineId: number) =>
  (await ctx.sql<{ detail: Record<string, unknown> }[]>`SELECT detail FROM audit_logs WHERE action IN ('frontdesk_void', 'table_void') AND detail ->> 'lineId' = ${String(lineId)}`)[0]?.detail;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'vduty', displayName: '值班丙', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'vkm', displayName: '康美小周', role: 'backoffice', duties: ['kangmei'], password: PASSWORD, mustChangePassword: false });
  km = await login(ctx.app, 'vkm');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'V', from: 1, to: 60, width: 3, zone: 'male' })).status).toBe(200);
  const station: Record<string, number> = {};
  for (const name of ['热菜', '水吧', '果吧']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name });
    station[name] = r.body.stations.find((s: { name: string }) => s.name === name).id;
  }
  for (const [name, category, st] of [
    ['宫保鸡丁', '热菜', '热菜'],
    ['柠檬茶', '饮品', '水吧'],
    ['果盘', '水果', '果吧'],
    ['大果盘', '水果', '果吧'],
    ['搓澡', '洗浴', null],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price: price[name] });
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
    if (st) expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: item[name], stationId: station[st] }] })).status).toBe(200);
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true, tablesEnabled: true })).status).toBe(200);
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name: '退1', area: '散桌', seats: 2 });
  tableId = t.body.tables.find((x: { name: string }) => x.name === '退1').id;
});
afterAll(async () => ctx.close());

describe('BW-4 退菜按出品口', () => {
  it('默认：原来能退菜的岗位三项都有，康美部有水吧、果吧（没有餐厅、没有「前台挂账」）', async () => {
    for (const role of ['owner', 'store_manager', 'duty_manager', 'clerk'] as const) {
      expect(permissionsOf({ position: null, role })).toEqual(expect.arrayContaining(['frontdesk.operate', 'dining.voidRestaurant', 'dining.voidWater', 'dining.voidFruit']));
    }
    expect(permissionsOf({ position: null, role: 'backoffice' }).filter((p) => p.startsWith('dining.void'))).toEqual([]);
    const me = (await api(ctx.app, km, 'GET', '/api/auth/me')).body as { permissions: string[] };
    expect(me.permissions).toEqual(expect.arrayContaining(['dining.voidWater', 'dining.voidFruit']));
    expect(me.permissions).not.toContain('dining.voidRestaurant');
    expect(me.permissions).not.toContain('frontdesk.operate');
  });

  it('康美部自己退水吧、果吧的菜（小额直接退，照旧写原因与责任岗位）；餐厅的菜、不是餐饮的明细都退不了', async () => {
    const v = await enter();
    expect((await order(v, ['柠檬茶', '果盘'], km)).status).toBe(200);
    expect((await order(v, ['宫保鸡丁'])).status).toBe(200);
    expect((await charge(v, ['搓澡'])).status).toBe(200);
    const tea = await lineOf(v, '柠檬茶');
    const ok = await voidLine(tea.id, km);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await auditOf(tea.id)).toMatchObject({ approval: 'small', blame: 'guest', reason: '客人不要了' });
    expect((await voidLine((await lineOf(v, '果盘')).id, km)).status).toBe(200);
    const chicken = await lineOf(v, '宫保鸡丁');
    const denied = await voidLine(chicken.id, km);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: 'OUTLET_VOID_FORBIDDEN', details: { outlet: 'restaurant' } });
    expect(denied.body.error.message).toContain('餐厅');
    const rub = await lineOf(v, '搓澡');
    expect((await voidLine(rub.id, km)).status).toBe(403);
    // 被拒的两条没动
    expect((await lineOf(v, '宫保鸡丁')).status).toBe('active');
    expect((await lineOf(v, '搓澡')).status).toBe('active');
    // 店员照旧都能退
    expect((await voidLine(chicken.id, ctx.clerk)).status).toBe(200);
    expect((await voidLine(rub.id, ctx.clerk)).status).toBe(200);
  });

  it('超过小额的：康美部本人 15 分钟内直接退；别人点的要当场授权——康美部也能申请，授权照旧绑定这一条', async () => {
    const v = await enter();
    expect((await order(v, ['大果盘'], km)).status).toBe(200);
    const own = await lineOf(v, '大果盘');
    const self = await voidLine(own.id, km);
    expect(self.status, JSON.stringify(self.body)).toBe(200);
    expect(await auditOf(own.id)).toMatchObject({ approval: 'self' });

    expect((await order(v, ['大果盘'])).status).toBe(200);
    const other = await lineOf(v, '大果盘');
    const need = await voidLine(other.id, km);
    expect(need.status).toBe(403);
    expect(need.body.error.code).toBe('VOID_NEEDS_GRANT');
    const grant = await api(ctx.app, km, 'POST', '/api/auth/authorize', {
      purpose: 'line_void',
      username: 'vduty',
      password: PASSWORD,
      scope: { lineId: other.id, reason: '客人不要了' },
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    const done = await voidLine(other.id, km, { grantId: grant.body.grantId });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await auditOf(other.id)).toMatchObject({ approval: 'grant', approverName: '值班丙' });
    // 餐厅的菜，康美部连授权都申请不了
    expect((await order(v, ['宫保鸡丁'])).status).toBe(200);
    const chicken = await lineOf(v, '宫保鸡丁');
    const r = await api(ctx.app, km, 'POST', '/api/auth/authorize', { purpose: 'line_void', username: 'vduty', password: PASSWORD, scope: { lineId: chicken.id, reason: '客人不要了' } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('OUTLET_VOID_FORBIDDEN');
  });

  it('后台去掉店员的「退菜：水吧」：手牌、桌台都退不了水吧的菜，别的出品口照旧；改回去又能退', async () => {
    expect((await setClerkPermissions(['dining.voidWater'])).status).toBe(200);
    const clerk = await login(ctx.app, 'clerk');
    const v = await enter();
    expect((await order(v, ['柠檬茶', '果盘'], clerk)).status).toBe(200);
    const tea = await lineOf(v, '柠檬茶');
    expect((await voidLine(tea.id, clerk)).body.error?.code).toBe('OUTLET_VOID_FORBIDDEN');
    expect((await voidLine((await lineOf(v, '果盘')).id, clerk)).status).toBe(200);
    // 桌台
    const open = await api(ctx.app, clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 1 });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    const sessionId = open.body.id as number;
    const posted = await api(ctx.app, clerk, 'POST', `/api/dining/tables/sessions/${sessionId}/orders`, { clientKey: randomUUID(), lines: lines(['柠檬茶']), expectedTotal: total(['柠檬茶']) });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const tableLine = (posted.body.lines as { id: number; name: string; status: string }[]).find((l) => l.name === '柠檬茶' && l.status === 'active')!;
    const tv = await api(ctx.app, clerk, 'POST', `/api/dining/tables/lines/${tableLine.id}/void`, { reason: '上错了', blame: 'waiter' });
    expect(tv.status).toBe(403);
    expect(tv.body.error.code).toBe('OUTLET_VOID_FORBIDDEN');
    expect((await setClerkPermissions([])).status).toBe(200);
    const again = await login(ctx.app, 'clerk');
    expect((await api(ctx.app, again, 'POST', `/api/dining/tables/lines/${tableLine.id}/void`, { reason: '上错了', blame: 'waiter' })).status).toBe(200);
    expect((await voidLine(tea.id, again)).status).toBe(200);
    expect((await api(ctx.app, again, 'POST', `/api/dining/tables/sessions/${sessionId}/cancel`, { reason: '用例收尾' })).status).toBe(200);
  });

  it('前台自检照旧全部通过', async () => {
    const r = await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks');
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean; name: string }[]).filter((c) => !c.ok)).toEqual([]);
  });
});

describe('BW-3 发卡台「加项目」按出品口核对', () => {
  it('去掉店员的「在水吧下单」：加项目里有水吧的菜整单拒绝（写明哪一道）；餐厅的菜、不进厨房的项目照常挂；原样重提照原样返回第一次的结果', async () => {
    const v = await enter();
    const key = randomUUID();
    expect((await charge(v, ['柠檬茶'], ctx.clerk, key)).status).toBe(200);
    expect((await setClerkPermissions(['dining.orderWater'])).status).toBe(200);
    const clerk = await login(ctx.app, 'clerk');
    try {
      const denied = await charge(v, ['宫保鸡丁', '柠檬茶', '搓澡'], clerk);
      expect(denied.status).toBe(403);
      expect(denied.body.error).toMatchObject({ code: 'OUTLET_FORBIDDEN', details: { items: ['柠檬茶'] } });
      expect(denied.body.error.message).toContain('水吧');
      expect((await charge(v, ['宫保鸡丁', '搓澡'], clerk)).status).toBe(200);
      expect((await charge(v, ['搓澡'], clerk)).status).toBe(200);
      // 同一个编号原样重提：照原样返回第一次的结果，不再按此刻的权限核对，也不多挂
      const again = await charge(v, ['柠檬茶'], clerk, key);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      const teas = ((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body.lines as { name: string; status: string }[]).filter((l) => l.name === '柠檬茶');
      expect(teas).toHaveLength(1);
      // 康美部没有「前台挂账」，发卡台的加项目本来就进不来
      expect((await charge(v, ['柠檬茶'], km)).status).toBe(403);
    } finally {
      expect((await setClerkPermissions([])).status).toBe(200);
    }
  });

  it('前台自检照旧全部通过', async () => {
    const r = await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks');
    expect((r.body as { ok: boolean }[]).filter((c) => !c.ok)).toEqual([]);
  });
});
