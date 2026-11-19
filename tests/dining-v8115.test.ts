// 8.1.15《浴族系统需求汇总》块 B1 · 桌台动作（docs/DINING_V8115.md 第 2 节）：结账后待清台、清台、维修 / 恢复、并台 / 拆台与结账、
// 桌台历史、操作编号重提、并发。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TableActionResult, TableHistory } from '../src/shared/dining-v8115';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let cook: string;
const item: Record<string, number> = {};
const table: Record<string, number> = {};

type Board = {
  tables: {
    id: number;
    name: string;
    state: string;
    maintenanceReason: string | null;
    maintenanceUntil: string | null;
    stateSince: string | null;
    session: { id: number; mergedInto: number | null; amount: number } | null;
  }[];
};
const board = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/tables')).body as Board;
const tile = async (name: string) => (await board()).tables.find((t) => t.name === name)!;
const open = (name: string, clientKey = randomUUID()) => api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey, tableId: table[name], guests: 2 });
const opened = async (name: string) => {
  const r = await open(name);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id as number;
};
const order = (sessionId: number, itemId = item['宫保鸡丁']!, price = 4800) =>
  api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${sessionId}/orders`, { clientKey: randomUUID(), lines: [{ itemId, quantity: 1 }], expectedTotal: price });
const pay = (sessionIds: number[], total: number, clientKey = randomUUID()) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/checkout', { clientKey, sessionIds, expectedTotal: total, payments: total ? [{ method: 'cash', amount: total }] : [] });
const act = (name: string, action: 'clear' | 'maintenance' | 'restore', body: Record<string, unknown> = {}, cookie = ctx.clerk, clientKey = randomUUID()) =>
  api<TableActionResult & { error: { code: string } }>(ctx.app, cookie, 'POST', `/api/dining/tables/${table[name]}/${action}`, { clientKey, ...body });
const merge = (mainId: number, subSessionIds: number[], clientKey = randomUUID()) =>
  api<TableActionResult & { error: { code: string } }>(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${mainId}/merge`, { clientKey, subSessionIds });
const split = (subId: number, clientKey = randomUUID()) =>
  api<TableActionResult & { error: { code: string } }>(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${subId}/split`, { clientKey });
const history = async (name: string) => (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/${table[name]}/history`)).body as TableHistory;
const rules = (body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', body);
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'bduty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'bcook', displayName: '厨房', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'bduty');
  cook = await login(ctx.app, 'bcook');
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '热菜' });
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '热菜').id;
  for (const [name, category, price] of [
    ['宫保鸡丁', '热菜', 4800],
    ['米饭', '主食', 300],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: Object.values(item).map((id) => ({ id, stationId })) })).status).toBe(200);
  // 用例基线里关着（老用例照结账后直接可用编写），这组用例测的就是它，打开
  expect((await rules({ enabled: true, tablesEnabled: true, clearAfterCheckout: true })).status).toBe(200);
  for (const name of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'C1', 'C2', 'C3', 'C4']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name, area: '散桌', seats: 4 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    table[name] = r.body.tables.find((t: { name: string }) => t.name === name).id;
  }
});
afterAll(async () => ctx.close());

describe('结账后待清台、清台', () => {
  it('结账以后待清台；待清台不能开台、不能换过去；清台回到可用；同一编号重提返回同一条；关掉规则后结账直接可用', async () => {
    expect((await tile('A1')).state).toBe('available');
    const s1 = await opened('A1');
    expect((await order(s1)).status).toBe(200);
    expect((await pay([s1], 4800)).status).toBe(200);
    const dirty = await tile('A1');
    expect(dirty).toMatchObject({ state: 'dirty', session: null });
    expect(dirty.stateSince).not.toBeNull();

    // 待清台：不能开台、不能换过去
    expect((await open('A1')).body.error.code).toBe('TABLE_DIRTY');
    const s2 = await opened('A2');
    const moved = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${s2}/move`, { toTableId: table['A1'], reason: '客人要靠窗' });
    expect(moved.body.error.code).toBe('TABLE_DIRTY');

    // 清台：同一编号重提返回第一次的那条；换个编号再清提示不用清台；同一编号拿去做别的动作拒绝
    const key = randomUUID();
    const c1 = await act('A1', 'clear', {}, ctx.clerk, key);
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    expect(c1.body).toMatchObject({ kind: 'clear', tableId: table['A1'], replayed: false });
    const c2 = await act('A1', 'clear', {}, ctx.clerk, key);
    expect(c2.body).toMatchObject({ eventId: c1.body.eventId, replayed: true });
    expect((await act('A1', 'clear')).body.error.code).toBe('TABLE_NOT_DIRTY');
    expect((await act('A1', 'restore', {}, ctx.clerk, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM table_events WHERE op_key = ${key}`)[0]!.n).toBe(1);
    expect(await tile('A1')).toMatchObject({ state: 'available' });
    expect((await open('A1')).status).toBe(200);

    // 关掉「结账后先待清台」：结账以后直接可用（与原来一样）
    expect((await rules({ clearAfterCheckout: false })).status).toBe(200);
    expect((await pay([s2], 0)).status).toBe(200);
    expect(await tile('A2')).toMatchObject({ state: 'available', session: null });
    expect((await rules({ clearAfterCheckout: true })).status).toBe(200);
    // 后勤（没有点单、前台挂账）不能清台
    expect((await act('A1', 'clear', {}, cook)).status).toBe(403);
  });
});

describe('维修、恢复', () => {
  it('要原因与预计恢复时间；维修中不能开台、不能换过去；用餐中的桌不能维修；恢复回到可用', async () => {
    expect((await act('A3', 'maintenance', { reason: '', expectedBackAt: inHours(2) })).status).toBe(400);
    expect((await act('A3', 'maintenance', { reason: '桌腿松了' })).status).toBe(400);
    expect((await act('A3', 'maintenance', { reason: '桌腿松了', expectedBackAt: inHours(-1) })).body.error.code).toBe('MAINTENANCE_UNTIL');
    expect((await act('A3', 'maintenance', { reason: '桌腿松了', expectedBackAt: inHours(24 * 91) })).body.error.code).toBe('MAINTENANCE_UNTIL');
    const until = inHours(3);
    const m = await act('A3', 'maintenance', { reason: '桌腿松了', expectedBackAt: until });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(await tile('A3')).toMatchObject({ state: 'maintenance', maintenanceReason: '桌腿松了', maintenanceUntil: new Date(until).toISOString() });
    expect((await open('A3')).body.error.code).toBe('TABLE_MAINTENANCE');
    const s = await opened('A4');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${s}/move`, { toTableId: table['A3'], reason: '换个大桌' })).body.error.code).toBe('TABLE_MAINTENANCE');
    expect((await act('A3', 'maintenance', { reason: '又坏了', expectedBackAt: until })).body.error.code).toBe('TABLE_MAINTENANCE');
    expect((await act('A3', 'clear')).body.error.code).toBe('TABLE_NOT_DIRTY');
    // 用餐中的桌不能维修
    expect((await act('A4', 'maintenance', { reason: '桌腿松了', expectedBackAt: until })).body.error.code).toBe('TABLE_IN_USE');
    expect((await act('A3', 'maintenance', { reason: '桌腿松了', expectedBackAt: until }, cook)).status).toBe(403);
    // 恢复
    const r = await act('A3', 'restore');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await tile('A3')).toMatchObject({ state: 'available', maintenanceReason: null, maintenanceUntil: null });
    expect((await act('A3', 'restore')).body.error.code).toBe('TABLE_NOT_MAINTENANCE');
    expect((await pay([s], 0)).status).toBe(200);
    expect((await act('A4', 'clear')).status).toBe(200);
  });
});

describe('并台、拆台', () => {
  it('附台不能单独结；主台结账带着附台一起结；预览自动带上一组；拆台后各结各的；撤台先拆台；不能串成几层', async () => {
    const main = await opened('A4');
    const sub = await opened('A5');
    const empty = await opened('A6');
    expect((await order(main)).status).toBe(200);
    expect((await order(sub, item['米饭'], 300)).status).toBe(200);

    const key = randomUUID();
    const m1 = await merge(main, [sub], key);
    expect(m1.status, JSON.stringify(m1.body)).toBe(200);
    expect(m1.body).toMatchObject({ kind: 'merge', tableId: table['A4'], replayed: false });
    expect((await merge(main, [sub], key)).body).toMatchObject({ eventId: m1.body.eventId, replayed: true });
    expect((await merge(main, [sub])).body.error.code).toBe('TABLE_MERGED');
    // 不能串成几层：附台不能当主台，并着别的桌的不能再并进来
    expect((await merge(sub, [empty])).body.error.code).toBe('TABLE_MERGED');
    expect((await merge(empty, [main])).body.error.code).toBe('TABLE_MERGED');
    expect((await merge(main, [main])).status).toBe(400);

    expect((await tile('A5')).session).toMatchObject({ mergedInto: main });
    const d = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/sessions/${main}`)).body;
    expect(d.merged).toEqual([{ sessionId: sub, tableName: 'A5', amount: 300 }]);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/sessions/${sub}`)).body.mergedInto).toEqual({ sessionId: main, tableName: 'A4' });

    // 附台不能单独结；主台也不能撇下附台单独结
    expect((await pay([sub], 300)).body.error.code).toBe('TABLE_MERGED');
    expect((await pay([main], 4800)).body.error.code).toBe('TABLE_MERGED');
    // 预览：选附台也把主台带上
    const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/checkout-preview?ids=${sub}`)).body;
    expect(pre.sessions.map((s: { sessionId: number }) => s.sessionId).sort()).toEqual([main, sub].sort());
    expect(pre.sessions.find((s: { sessionId: number }) => s.sessionId === sub).mergedInto).toBe(main);
    expect(pre.totalAmount).toBe(5100);

    // 撤台要先拆台；拆台同一编号重提返回同一条
    expect((await merge(main, [empty])).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${empty}/cancel`, { reason: '开错台了' })).body.error.code).toBe('TABLE_MERGED');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${main}/cancel`, { reason: '开错台了' })).body.error.code).toBe('TABLE_MERGED');
    const sk = randomUUID();
    const s1 = await split(empty, sk);
    expect(s1.status, JSON.stringify(s1.body)).toBe(200);
    expect((await split(empty, sk)).body).toMatchObject({ eventId: s1.body.eventId, replayed: true });
    expect((await split(empty)).body.error.code).toBe('TABLE_NOT_MERGED');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${empty}/cancel`, { reason: '开错台了' })).status).toBe(200);

    // 主台带着附台一起结：两桌都结清、都待清台
    const done = await pay([main, sub], 5100);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    for (const n of ['A4', 'A5']) expect(await tile(n)).toMatchObject({ state: 'dirty', session: null });
    // 撤台的桌没用过，照旧可用
    expect(await tile('A6')).toMatchObject({ state: 'available' });
    const audits = await ctx.sql<{ action: string }[]>`SELECT action FROM audit_logs WHERE action IN ('table_merge', 'table_split', 'table_clear', 'table_maintenance', 'table_restore') ORDER BY id`;
    expect(new Set(audits.map((a) => a.action))).toEqual(new Set(['table_merge', 'table_split', 'table_clear', 'table_maintenance', 'table_restore']));
  });

  it('拆台以后各结各的', async () => {
    const a = await opened('C1');
    const b = await opened('C2');
    expect((await order(a)).status).toBe(200);
    expect((await order(b, item['米饭'], 300)).status).toBe(200);
    expect((await merge(a, [b])).status).toBe(200);
    expect((await split(b)).status).toBe(200);
    expect((await pay([b], 300)).status).toBe(200);
    expect((await pay([a], 4800)).status).toBe(200);
  });
});

describe('桌台历史', () => {
  it('开台、换台（转出 / 转入）、结账、反结账、清台、维修、恢复排在一起，最近的在前；待清台时反结账也能恢复开台，重新结账照样待清台', async () => {
    const s = await opened('B1');
    expect((await order(s)).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${s}/move`, { toTableId: table['B2'], reason: '客人要安静' })).status).toBe(200);
    const paid = await pay([s], 4800);
    expect(paid.status).toBe(200);
    expect((await tile('B2')).state).toBe('dirty');
    // 反结账：桌台待清台也照样恢复这次开台（客人已经走了，只是更正账）
    const voided = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${paid.body.id}/void`, { reason: '收错了' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect((await tile('B2')).session?.id).toBe(s);
    expect((await pay([s], 4800)).status).toBe(200);
    expect((await tile('B2')).state).toBe('dirty');
    expect((await act('B2', 'clear')).status).toBe(200);
    expect((await act('B1', 'maintenance', { reason: '换桌布', expectedBackAt: inHours(1) })).status).toBe(200);
    expect((await act('B1', 'restore')).status).toBe(200);

    const b1 = await history('B1');
    expect(b1.entries.map((e) => e.kind)).toEqual(['restore', 'maintenance', 'move_out', 'open']);
    expect(b1.entries.find((e) => e.kind === 'move_out')!.text).toBe('换到桌 B2：客人要安静');
    expect(b1.entries.find((e) => e.kind === 'maintenance')!.text).toContain('换桌布 · 预计');
    expect(b1.entries.every((e) => e.operatorName.length > 0)).toBe(true);
    const b2 = await history('B2');
    expect(b2.entries.map((e) => e.kind)).toEqual(['clear', 'checkout', 'checkout_void', 'checkout', 'move_in']);
    expect(b2.entries.find((e) => e.kind === 'checkout_void')!.text).toContain('收错了');
    expect(b2).toMatchObject({ tableName: 'B2', truncated: false });

    const a4 = await history('A4');
    expect(a4.entries.map((e) => e.kind)).toEqual(expect.arrayContaining(['merge', 'split', 'checkout', 'open']));
    expect(a4.entries.find((e) => e.kind === 'merge')!.text).toContain('并入这桌');
    expect((await history('A5')).entries.find((e) => e.kind === 'merge')!.text).toContain('并入桌 A4');
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/tables/999999/history')).status).toBe(404);
  });
});

describe('并发', () => {
  it('两台终端同时清台只成一笔；同一编号同时提交两次只记一条；并台与结账同时提交不死锁、结果说得通', async () => {
    expect((await act('A4', 'clear')).status).toBe(200);
    expect((await act('A5', 'clear')).status).toBe(200);
    const s = await opened('A4');
    expect((await pay([s], 0)).status).toBe(200);
    const [x, y] = await Promise.all([act('A4', 'clear'), act('A4', 'clear')]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const s2 = await opened('A4');
    expect((await pay([s2], 0)).status).toBe(200);
    const key = randomUUID();
    const [p, q] = await Promise.all([act('A4', 'clear', {}, ctx.clerk, key), act('A4', 'clear', {}, ctx.clerk, key)]);
    expect([p.status, q.status]).toEqual([200, 200]);
    expect(p.body.eventId).toBe(q.body.eventId);
    expect((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM table_events WHERE op_key = ${key}`)[0]!.n).toBe(1);

    const main = await opened('C3');
    const sub = await opened('C4');
    expect((await order(main)).status).toBe(200);
    const [mg, co] = await Promise.all([merge(main, [sub]), pay([main], 4800)]);
    if (mg.status === 200) {
      // 并台先成：主台撇下附台单独结被拒，或者在并台之前已经结了（这时并台要被拒）
      expect(co.body.error?.code).toBe('TABLE_MERGED');
      expect((await pay([main, sub], 4800)).status).toBe(200);
    } else {
      expect(co.status, JSON.stringify(co.body)).toBe(200);
      expect(mg.body.error.code).toBe('TABLE_CLOSED');
      expect((await pay([sub], 0)).status).toBe(200);
    }
  });
});
