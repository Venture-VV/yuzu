// 8.1.17 BW-2 桌台提醒（docs/FRONTDESK_V8117.md 第 5 节）：
//   · 维修中的桌过了预计恢复时间、待清台超过 N 分钟（餐饮规则，默认 15）——按看板上的状态与时刻算，进餐饮的待办数；
//   · 餐饮规则「到点自动恢复」（默认关）：每分钟的任务走手动恢复的同一个函数，记一条桌台记录、经办人「系统」；
//     几个进程同时跑每一桌只恢复一次；挑候选到锁住之间有人恢复后又报修、还没到点的不动。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TablesBoard } from '../src/shared/dining';
import type { TableHistory } from '../src/shared/dining-v8115';
import { tableReminderOf, tableTodos } from '../src/shared/frontdesk-v8117';
import { systemAutoActor } from '../src/server/modules/system-staff';
import { restoreTable } from '../src/server/modules/tables-v8115';
import { autoRestoreKey, sweepTableRestores } from '../src/server/modules/tables-v8117';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
const table: Record<string, number> = {};
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const board = async () => (await api<TablesBoard>(ctx.app, ctx.clerk, 'GET', '/api/dining/tables')).body;
const tile = async (name: string) => (await board()).tables.find((t) => t.name === name)!;
const rules = (patch: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', patch);
const maintain = (name: string, minutes: number) =>
  api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/${table[name]!}/maintenance`, { clientKey: randomUUID(), reason: '桌腿松了', expectedBackAt: later(minutes).toISOString() });
const sweep = (minutes: number) => sweepTableRestores({ sql: ctx.sql, config: ctx.config }, later(minutes));

beforeAll(async () => {
  ctx = await setup();
  expect((await rules({ enabled: true, tablesEnabled: true, clearAfterCheckout: true })).status).toBe(200);
  for (const name of ['R1', 'R2', 'R3', 'R4']) {
    const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name, area: '散桌', seats: 4 });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    table[name] = t.body.tables.find((x: { name: string }) => x.name === name).id;
  }
});
afterAll(async () => ctx.close());

describe('BW-2 餐饮规则：到点自动恢复、待清台多久算久了', () => {
  it('默认不自动恢复、待清台 15 分钟；只有店主能改，分钟数 1–240', async () => {
    const admin = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/dining')).body;
    expect(admin.rules).toMatchObject({ autoRestore: false, dirtyAlertMinutes: 15 });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/menu')).body.rules).toMatchObject({ autoRestore: false, dirtyAlertMinutes: 15 });
    expect((await rules({ dirtyAlertMinutes: 0 })).status).toBe(400);
    expect((await rules({ dirtyAlertMinutes: 241 })).status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/dining/rules', { autoRestore: true })).status).toBe(403);
  });
});

describe('BW-2 维修过了预计恢复时间', () => {
  it('看板上算得出「已过预计恢复时间」、进待办数；没开自动恢复时任务不动它', async () => {
    expect((await maintain('R1', 60)).status).toBe(200);
    const t = await tile('R1');
    expect(t.state).toBe('maintenance');
    expect(tableReminderOf(t, later(30).getTime(), 15)).toBeNull();
    expect(tableReminderOf(t, later(75).getTime(), 15)).toEqual({ kind: 'overdue', minutes: expect.any(Number) });
    expect(tableTodos((await board()).tables, later(75).getTime(), 15)).toMatchObject({ overdue: 1, total: 1 });
    expect(await sweep(75)).toBe(0);
    expect((await tile('R1')).state).toBe('maintenance');
  });

  it('开了「到点自动恢复」：到点的桌恢复（走手动恢复的同一条路），桌台记录的经办人写「系统」；没到点的不动', async () => {
    expect((await rules({ autoRestore: true })).status).toBe(200);
    expect((await maintain('R2', 180)).status).toBe(200);
    expect(await sweep(30)).toBe(0);
    expect(await sweep(75)).toBe(1);
    expect((await tile('R1')).state).toBe('available');
    expect((await tile('R2')).state).toBe('maintenance');
    const h = (await api<TableHistory>(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/${table.R1!}/history`)).body;
    expect(h.entries[0]).toMatchObject({ kind: 'restore', operatorName: '系统' });
    const [audit] = await ctx.sql<{ name: string }[]>`
      SELECT s.display_name AS name FROM audit_logs a JOIN staff s ON s.id = a.staff_id WHERE a.action = 'table_restore' AND a.target_id = ${String(table.R1)}`;
    expect(audit!.name).toBe('系统');
    // 再跑一次：已经恢复了，不再记
    expect(await sweep(80)).toBe(0);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM table_events WHERE table_id = ${table.R1!} AND kind = 'restore'`;
    expect(n!.n).toBe(1);
  });

  it('几个进程同时跑：每一桌只恢复一次（同一个操作编号，后到的原样返回）', async () => {
    expect((await maintain('R3', 60)).status).toBe(200);
    expect((await maintain('R4', 60)).status).toBe(200);
    const runs = await Promise.all([sweep(240), sweep(240), sweep(240)]);
    // R2（180 分钟）、R3、R4 三桌都到点了，三个任务加起来正好恢复三桌
    expect(runs.reduce((a, b) => a + b, 0)).toBe(3);
    for (const name of ['R2', 'R3', 'R4']) {
      expect((await tile(name)).state).toBe('available');
      const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM table_events WHERE table_id = ${table[name]!} AND kind = 'restore'`;
      expect(n!.n, name).toBe(1);
    }
  });

  it('锁住以后再核对：恢复后又重新报修、还没到点的，自动恢复拒绝（MAINTENANCE_NOT_DUE），手动恢复照常', async () => {
    expect((await maintain('R3', 120)).status).toBe(200);
    const t = await tile('R3');
    const actor = await systemAutoActor(ctx.sql);
    await expect(
      restoreTable({ sql: ctx.sql, config: ctx.config }, table.R3!, { clientKey: autoRestoreKey(table.R3!, t.stateSince) }, { actor, at: later(30) }, { dueAt: later(30) }),
    ).rejects.toMatchObject({
      code: 'MAINTENANCE_NOT_DUE',
    });
    expect((await tile('R3')).state).toBe('maintenance');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/${table.R3!}/restore`, { clientKey: randomUUID() })).status).toBe(200);
    expect((await rules({ autoRestore: false })).status).toBe(200);
  });
});

describe('BW-2 待清台太久', () => {
  it('结账后待清台：超过规则里的分钟数才提醒（改了分钟数跟着变）；清台以后不再提醒', async () => {
    await ctx.sql`UPDATE dining_tables SET state = 'dirty', state_since = now() WHERE id = ${table.R4!}`;
    const t = await tile('R4');
    expect(t.state).toBe('dirty');
    expect(tableReminderOf(t, later(10).getTime(), 15)).toBeNull();
    expect(tableReminderOf(t, later(16).getTime(), 15)).toEqual({ kind: 'dirty_long', minutes: 16 });
    expect(tableReminderOf(t, later(10).getTime(), 5)).toEqual({ kind: 'dirty_long', minutes: 10 });
    expect(tableTodos((await board()).tables, later(16).getTime(), 15)).toMatchObject({ dirtyLong: 1 });
    // 升级前就待清台、没有时刻的不提醒
    expect(tableReminderOf({ ...t, stateSince: null }, later(600).getTime(), 15)).toBeNull();
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/${table.R4!}/clear`, { clientKey: randomUUID() })).status).toBe(200);
    expect(tableReminderOf(await tile('R4'), later(600).getTime(), 15)).toBeNull();
  });
});
