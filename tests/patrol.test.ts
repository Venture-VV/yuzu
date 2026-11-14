// 8.0.9 安保巡场（docs/PATROL_V809.md）：场所与场所码、谁能巡场（巡场部门）与谁能看（指定的人）、打卡的幂等与去重、
// 断网补交的时间范围、换码与停用、每天的清单、记录与导出、作废、模块开关。全部是合成数据。
// 8.0.11 巡场轮次（第 11 节）：同一个场所每轮只记一次（XC14）、巡场间隔可调（XC13，从今天起，以前的日子照旧，XC15）、按轮的清单。
// 前面几段把巡场间隔设成 24 小时（一天一轮），按轮的清单在最后一段用过去的某一天、拨好员工端的「此刻」来测，不受跑测试的时刻影响。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCanteenApp } from '../src/server/modules/canteen/portal';
import { patrolLink, parsePatrolToken, patrolRoundMinutesOn, patrolRoundsOf } from '../src/shared/patrol';
import { api, setup, type TestContext } from './helpers';

const SECRET = 'patrol-test-secret-0123456789abcdef-0123456789';

let ctx: TestContext;
let canteen: FastifyInstance;
/** 员工端口的「此刻」：测试里可以往后拨 */
let nowMs = Date.now();

async function c<T = any>(cookie: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await canteen.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.headers['content-type']?.toString().includes('json') ? res.json() : res.body;
  return { status: res.statusCode, body: body as T };
}
const admin = <T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, cookie = ctx.owner) => api<T>(ctx.app, cookie, method, url, payload);

async function hire(empNo: string, name: string, departmentId: number | null) {
  const made = await admin('POST', '/api/erp/canteen/employees', { empNo, name, role: 'staff', departmentId });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const id = made.body.employee.id as number;
  const card = (await admin('GET', `/api/erp/canteen/activation-cards?ids=${id}`)).body[0];
  const res = await canteen.inject({ method: 'POST', url: '/api/canteen/join', payload: { code: card.code, password: 'Xun-chang-2026' } });
  expect(res.statusCode, res.body).toBe(200);
  const sid = res.cookies.find((k) => k.name === 'yuzu_canteen_sid')!.value;
  return { id, name, empNo, cookie: `yuzu_canteen_sid=${sid}` };
}

let security: number;
let guard: Awaited<ReturnType<typeof hire>>;
let guard2: Awaited<ReturnType<typeof hire>>;
let manager: Awaited<ReturnType<typeof hire>>;
let other: Awaited<ReturnType<typeof hire>>;
const points: Record<string, { id: number; token: string; version: number }> = {};

const addPoint = async (name: string, area = '', key = randomUUID()) => admin('POST', '/api/erp/patrol/points', { clientKey: key, name, area });
const scan = (who: { cookie: string; id: number }, code: string, extra: Record<string, unknown> = {}, key = randomUUID()) =>
  c(who.cookie, 'POST', '/api/canteen/patrol/checkins', { clientKey: key, code, employeeId: who.id, ...extra });
const settings = async () =>
  (await admin('GET', '/api/erp/patrol/settings')).body as { rev: number; departmentIds: number[]; viewerIds: number[]; roundMinutes: number; roundChanges: { from: string; minutes: number }[] };
const today = async () => (await admin('GET', '/api/erp/patrol/day')).body.today as string;

beforeAll(async () => {
  ctx = await setup();
  const config = { ...ctx.config, canteen: { port: null, host: '127.0.0.1', codeSecret: SECRET, cookieSecure: false, trustProxy: [] } };
  canteen = await buildCanteenApp(ctx.sql, config, { openCacheMs: 0, clock: () => nowMs });
  expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: true, patrol: true } })).status).toBe(200);
  security = Number((await ctx.sql<{ id: number }[]>`INSERT INTO departments (name) VALUES ('安保部') RETURNING id`)[0]!.id);
  const kitchen = Number((await ctx.sql<{ id: number }[]>`INSERT INTO departments (name) VALUES ('合成后厨') RETURNING id`)[0]!.id);
  guard = await hire('A101', '保安老张', security);
  guard2 = await hire('A102', '保安小李', security);
  manager = await hire('G001', '店总王姐', null);
  other = await hire('K101', '后厨小陈', kitchen);
});

afterAll(async () => {
  await canteen?.close();
  await ctx?.close();
});

describe('模块与权限', () => {
  it('安保巡场依赖员工食堂；店员（没有巡场权限）看不到后台接口', async () => {
    const mods = (await admin('GET', '/api/erp/modules')).body.modules as { key: string; group: string; requires: string[]; enabled: boolean }[];
    const patrol = mods.find((m) => m.key === 'patrol')!;
    // 8.0.18：员工食堂、安保巡场的页面挪到了管理后台「人员与行政」，注册表里记成「后台」（开关与接口拦截照旧）
    expect(patrol).toMatchObject({ group: '后台', requires: ['canteen'], enabled: true });
    expect(mods.find((m) => m.key === 'canteen')!.group).toBe('后台');
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/erp/patrol/day')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/erp/patrol/points')).status).toBe(403);
  });
});

describe('场所与场所码（后台）', () => {
  it('新建带操作编号（原样重提只建一个、换内容拒绝）；启用的不重名；换码以后旧码认不出；改动带版本号', async () => {
    const key = randomUUID();
    const a = await addPoint('北门停车场', '负一层出口旁', key);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.point.token).toMatch(/^[A-Z2-7]{12}$/);
    const again = await addPoint('北门停车场', '负一层出口旁', key);
    expect(again.body).toMatchObject({ replayed: true, point: { id: a.body.point.id } });
    expect((await addPoint('北门停车场', '换了位置', key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await addPoint('北门停车场')).body.error.code).toBe('PATROL_NAME_TAKEN');
    // 确认作废的编号：原请求晚到也不建
    const lost = randomUUID();
    expect((await admin('POST', `/api/erp/ops/${lost}/abandon`, { type: 'patrol_point' })).body).toMatchObject({ found: false, abandoned: true });
    expect((await addPoint('作废了的场所', '', lost)).body.error.code).toBe('OP_ABANDONED');
    for (const [name, area] of [
      ['三楼消防通道', '东侧楼梯口'],
      ['屋顶水箱', ''],
    ] as const) {
      const r = await addPoint(name, area);
      expect(r.status).toBe(200);
      points[name] = { id: r.body.point.id, token: r.body.point.token, version: r.body.point.version };
    }
    points['北门停车场'] = { id: a.body.point.id, token: a.body.point.token, version: a.body.point.version };

    const list = (await admin('GET', '/api/erp/patrol/points')).body as { points: { name: string; token: string }[]; portalUrl: string };
    expect(list.points.map((p) => p.name)).toEqual(['北门停车场', '三楼消防通道', '屋顶水箱']);
    // 改名与版本号
    const water = points['屋顶水箱']!;
    const up = await admin('PUT', `/api/erp/patrol/points/${water.id}`, { name: '屋顶水箱间', area: '7 楼上去', sortOrder: 5, active: true, version: water.version });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect((await admin('PUT', `/api/erp/patrol/points/${water.id}`, { name: '旧的版本', area: '', sortOrder: 0, active: true, version: water.version })).body.error.code).toBe('PATROL_POINT_CHANGED');
    water.version = up.body.point.version;
    // 换码：旧码失效
    const rot = await admin('POST', `/api/erp/patrol/points/${water.id}/token`, { version: water.version });
    expect(rot.status).toBe(200);
    expect(rot.body.point.token).not.toBe(water.token);
    water.token = rot.body.point.token;
    water.version = rot.body.point.version;
  });
});

describe('谁能巡场、谁能看（XC1、XC2）', () => {
  it('没设巡场部门时谁都没有；设了安保部以后安保部的人有「巡场」、指定的人有「巡场记录」，别的部门的人没有、接口也拒绝', async () => {
    expect((await c(guard.cookie, 'GET', '/api/canteen/me')).body.apps).toEqual([]);
    expect((await scan(guard, points['北门停车场']!.token)).status).toBe(403);
    const s = await settings();
    // 没设过巡场间隔：默认 3 小时一轮（XC13）
    expect(s).toMatchObject({ roundMinutes: 180, roundChanges: [] });
    // 这几段先设成 24 小时一轮（一天一轮）：结果不受跑测试的时刻影响
    const saved = await admin('PUT', '/api/erp/patrol/settings', { departmentIds: [security], viewerIds: [manager.id], roundMinutes: 1440, rev: s.rev });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ departmentIds: [security], viewerIds: [manager.id], patrolStaffCount: 2, roundMinutes: 1440, roundChanges: [{ minutes: 1440 }] });
    // 拿旧的版本号再存：拒绝，不盖掉
    expect((await admin('PUT', '/api/erp/patrol/settings', { departmentIds: [], viewerIds: [], rev: s.rev })).body.error.code).toBe('PATROL_SETTINGS_CHANGED');
    expect((await c(guard.cookie, 'GET', '/api/canteen/me')).body.apps).toEqual(['patrol']);
    expect((await c(manager.cookie, 'GET', '/api/canteen/me')).body.apps).toEqual(['patrolLog']);
    expect((await c(other.cookie, 'GET', '/api/canteen/me')).body.apps).toEqual([]);
    expect((await scan(other, points['北门停车场']!.token)).status).toBe(403);
    expect((await c(other.cookie, 'GET', '/api/canteen/patrol/day')).status).toBe(403);
    // 指定能看的人不能打卡
    expect((await scan(manager, points['北门停车场']!.token)).status).toBe(403);
  });
});

describe('巡场打卡（员工端）', () => {
  it('扫整个地址或单独的码都认；同一个编号原样返回；同一个场所这一轮打过以后，谁再扫都只提示「这一轮已打过卡」（XC14）', async () => {
    const north = points['北门停车场']!;
    const link = patrolLink('https://staff.example.com', north.token);
    expect(parsePatrolToken(link)).toBe(north.token);
    const key = randomUUID();
    const first = await scan(guard, link, { via: 'link' }, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      status: 'ok',
      checkin: { pointName: '北门停车场', area: '负一层出口旁', late: false, employeeName: '保安老张', mine: true },
      round: { no: 1 },
      pointCount: 1,
    });
    // 回复丢了原样重提：同一条
    const replay = await scan(guard, link, { via: 'link' }, key);
    expect(replay.body).toMatchObject({ status: 'ok', checkin: { id: first.body.checkin.id } });
    // 别人拿这个编号：拒绝
    expect((await scan(guard2, link, {}, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 1 分钟后同一个人再扫：这一轮已打过卡，不重复记
    nowMs += 60_000;
    const dup = await scan(guard, north.token.toLowerCase());
    expect(dup.body).toMatchObject({ status: 'already', checkin: { id: first.body.checkin.id, mine: true }, pointCount: 1 });
    // 另一位保安扫同一个码：这一轮已经由老张打过，也不另记
    expect((await scan(guard2, north.token)).body).toMatchObject({ status: 'already', checkin: { id: first.body.checkin.id, employeeName: '保安老张', mine: false }, pointCount: 1 });
    // 隔了 3 分钟也一样（8.0.9 是隔 2 分钟以上再记一次）
    nowMs += 3 * 60_000;
    expect((await scan(guard, north.token)).body).toMatchObject({ status: 'already', pointCount: 1 });
    // 别的场所照样能打
    expect((await scan(guard2, points['屋顶水箱']!.token)).body).toMatchObject({ status: 'ok', checkin: { pointName: '屋顶水箱间' }, pointCount: 1 });
  });

  it('不是巡场码、换过码的旧码、停用的场所都拒绝；时间比门店快太多、24 小时以前的拒绝；断网补交的标「离线补登」', async () => {
    expect((await scan(guard, 'YZC1:12:345:ABCDEFGH')).body.error.code).toBe('PATROL_CODE_INVALID');
    expect((await scan(guard, 'https://example.com/whatever')).body.error.code).toBe('PATROL_CODE_INVALID');
    // 换码前的旧码：认不出
    const water = points['屋顶水箱']!;
    const before = (await ctx.sql<{ token: string }[]>`SELECT token FROM patrol_points WHERE id = ${water.id}`)[0]!.token;
    expect(before).toBe(water.token);
    const rot = await admin('POST', `/api/erp/patrol/points/${water.id}/token`, { version: water.version });
    expect((await scan(guard, water.token)).body.error.code).toBe('PATROL_CODE_UNKNOWN');
    water.token = rot.body.point.token;
    water.version = rot.body.point.version;
    // 停用的场所
    const fire = points['三楼消防通道']!;
    const off = await admin('PUT', `/api/erp/patrol/points/${fire.id}`, { name: '三楼消防通道', area: '东侧楼梯口', sortOrder: 0, active: false, version: fire.version });
    expect(off.status).toBe(200);
    expect((await scan(guard, fire.token)).body.error.code).toBe('PATROL_POINT_INACTIVE');
    const on = await admin('PUT', `/api/erp/patrol/points/${fire.id}`, { name: '三楼消防通道', area: '东侧楼梯口', sortOrder: 0, active: true, version: off.body.point.version });
    fire.version = on.body.point.version;
    // 时间
    expect((await scan(guard, fire.token, { scannedAt: new Date(nowMs + 5 * 60_000).toISOString() })).body.error.code).toBe('CLOCK_AHEAD');
    expect((await scan(guard, fire.token, { scannedAt: new Date(nowMs - 25 * 3_600_000).toISOString() })).body.error.code).toBe('SCAN_TOO_OLD');
    // 断网 10 分钟前扫的，现在补交：标离线补登
    const late = await scan(guard, fire.token, { scannedAt: new Date(nowMs - 10 * 60_000).toISOString(), via: 'scan' });
    expect(late.status, JSON.stringify(late.body)).toBe(200);
    expect(late.body.checkin.late).toBe(true);
  });

  it('这台手机换了人登录：上一位断网扫的不记到这一位名下（Codex 审查 ae12728）', async () => {
    const north = points['北门停车场']!;
    const before = (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM patrol_checkins`)[0]!.n;
    // 登录的是老张，交的这一笔记在小李名下：不记，回 409（手机上留着等小李登录再交）
    const other = await scan(guard, north.token, { employeeId: guard2.id });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('PATROL_OTHER_EMPLOYEE');
    // 没带是谁扫的：格式不对
    const { status } = await c(guard.cookie, 'POST', '/api/canteen/patrol/checkins', { clientKey: randomUUID(), code: north.token });
    expect(status).toBe(400);
    expect((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM patrol_checkins`)[0]!.n).toBe(before);
  });

  it('员工停用以后不能再打卡；员工改到别的部门以后马上没有巡场', async () => {
    const extra = await hire('A103', '保安临时', security);
    expect((await c(extra.cookie, 'GET', '/api/canteen/me')).body.apps).toEqual(['patrol']);
    await ctx.sql`UPDATE canteen_employees SET department_id = NULL WHERE id = ${extra.id}`;
    expect((await scan(extra, points['北门停车场']!.token)).status).toBe(403);
    expect((await c(extra.cookie, 'GET', '/api/canteen/me')).body.apps).toEqual([]);
  });
});

describe('每天的清单、记录与导出、作废', () => {
  it('后台「今天」：每个场所每一轮谁几点巡过，这一轮还没巡的个数；手机上保安只看今天，指定的人看以前的', async () => {
    const day = (await admin('GET', '/api/erp/patrol/day')).body as {
      points: { name: string; count: number; byRound: unknown[][] }[];
      total: number;
      date: string;
      roundMinutes: number;
      rounds: { no: number; state: string; expected: number; done: number }[];
      currentRound: number | null;
      currentMissing: number | null;
      missed: number;
    };
    expect(day.date).toBe(await today());
    const byName = Object.fromEntries(day.points.map((p) => [p.name, p.count]));
    expect(byName).toMatchObject({ 北门停车场: 1, 三楼消防通道: 1, 屋顶水箱间: 1 });
    expect(day.total).toBe(3);
    // 一天一轮：正在巡第 1 轮，三个场所都巡了
    expect(day).toMatchObject({ roundMinutes: 1440, currentRound: 1, currentMissing: 0, missed: 0 });
    expect(day.rounds).toMatchObject([{ no: 1, state: 'current', expected: 3, done: 3 }]);
    expect(day.points.every((p) => p.byRound.length === 1 && p.byRound[0]!.length === 1)).toBe(true);
    // 手机上：保安看今天
    const mine = await c(guard.cookie, 'GET', '/api/canteen/patrol/day');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body).toMatchObject({ total: 3, mine: 2, canViewHistory: false, currentRound: 1 });
    const yesterday = new Date(Date.parse(`${day.date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    expect((await c(guard.cookie, 'GET', `/api/canteen/patrol/day?date=${yesterday}`)).status).toBe(403);
    // 指定的人：看以前的
    const past = await c(manager.cookie, 'GET', `/api/canteen/patrol/day?date=${yesterday}`);
    expect(past.status, JSON.stringify(past.body)).toBe(200);
    expect(past.body).toMatchObject({ date: yesterday, total: 0, canViewHistory: true });
    // 码不给员工端
    expect(JSON.stringify(mine.body)).not.toContain(points['北门停车场']!.token);
  });

  it('记录按营业日、场所、人筛选，导出与页面一致；作废要写原因、作废的不算数、不能改不能删', async () => {
    const d = await today();
    const all = (await admin('GET', `/api/erp/patrol/records?from=${d}&to=${d}`)).body as {
      rows: { id: number; name: string; late: boolean; voidedAt: string | null; roundNo: number | null }[];
      total: number;
    };
    expect(all.total).toBe(3);
    expect(all.rows.every((r) => r.roundNo === 1)).toBe(true);
    const north = await admin('GET', `/api/erp/patrol/records?from=${d}&to=${d}&pointId=${points['北门停车场']!.id}`);
    expect(north.body.total).toBe(1);
    const zhang = await admin('GET', `/api/erp/patrol/records?from=${d}&to=${d}&employeeId=${guard.id}`);
    expect(zhang.body.total).toBe(2);
    expect(all.rows.filter((r) => r.late).length).toBe(1);
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/erp/patrol/records/export?from=${d}&to=${d}`, headers: { cookie: ctx.owner } });
    expect(csv.statusCode).toBe(200);
    const lines = csv.body.trim().split(/\r\n/);
    expect(lines.length).toBe(1 + 3 + 1);
    expect(lines[0]).toContain('轮次');
    expect(lines[1]).toContain('第 1 轮');
    expect(lines.at(-1)).toContain('3 次');
    // 作废一条
    const target = all.rows.find((r) => r.name === '保安小李')!;
    expect((await admin('POST', `/api/erp/patrol/checkins/${target.id}/void`, { reason: '' })).status).toBe(400);
    expect((await admin('POST', `/api/erp/patrol/checkins/${target.id}/void`, { reason: '测试扫的' })).status).toBe(200);
    expect((await admin('POST', `/api/erp/patrol/checkins/${target.id}/void`, { reason: '再作废一次' })).status).toBe(200);
    const after = await admin('GET', `/api/erp/patrol/records?from=${d}&to=${d}`);
    expect(after.body).toMatchObject({ total: 2, voided: 1 });
    expect((await admin('GET', '/api/erp/patrol/day')).body).toMatchObject({ total: 2, currentMissing: 1 });
    // 店员没有「场所与设置」权限：不能作废
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/erp/patrol/checkins/${all.rows[0]!.id}/void`, { reason: '越权' })).status).toBe(403);
    // 打卡记录、场所不能删、打卡不能改
    await expect(ctx.sql`DELETE FROM patrol_checkins WHERE id = ${target.id}`).rejects.toThrow(/禁止删除/);
    await expect(ctx.sql`UPDATE patrol_checkins SET employee_name = '改名' WHERE id = ${all.rows.find((r) => r.id !== target.id)!.id}`).rejects.toThrow(/只能作废/);
    await expect(ctx.sql`DELETE FROM patrol_points WHERE id = ${points['北门停车场']!.id}`).rejects.toThrow(/禁止删除/);
    // 查询范围
    expect((await admin('GET', `/api/erp/patrol/records?from=2026-01-01&to=2026-12-31`)).status).toBe(400);
    // 记录筛选用的场所（Codex 审查 41a2fbb）：停用的也在（以前的记录照样能单独筛、单独导出），不带场所码；店员取不到
    const fire = points['三楼消防通道']!;
    const off = await admin('PUT', `/api/erp/patrol/points/${fire.id}`, { name: '三楼消防通道', area: '东侧楼梯口', sortOrder: 0, active: false, version: fire.version });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    fire.version = off.body.point.version;
    const opts = await admin('GET', '/api/erp/patrol/point-options');
    expect(opts.status).toBe(200);
    expect((opts.body.points as { name: string; active: boolean }[]).map((p) => [p.name, p.active])).toEqual([
      ['北门停车场', true],
      ['屋顶水箱间', true],
      ['三楼消防通道', false],
    ]);
    expect(JSON.stringify(opts.body)).not.toMatch(/token/i);
    expect((await admin('GET', `/api/erp/patrol/records?from=${d}&to=${d}&pointId=${fire.id}`)).body.total).toBe(1);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/erp/patrol/point-options')).status).toBe(403);
  });

  it('这一轮已打过卡的那一笔也记下操作编号：原来那条后来被作废，重提照样是「已打过卡」、不再记一条（Codex 审查 94f53d5）', async () => {
    // 小李那条刚被作废：这一轮这个场所又能打了
    const water = points['屋顶水箱']!;
    const first = await scan(guard, water.token);
    expect(first.body).toMatchObject({ status: 'ok' });
    nowMs += 60_000;
    const key = randomUUID();
    const dup = await scan(guard, water.token, {}, key);
    expect(dup.body).toMatchObject({ status: 'already', checkin: { id: first.body.checkin.id } });
    // 「刚打过卡」的回复丢了；重提之前后台把原来那条作废了
    expect((await admin('POST', `/api/erp/patrol/checkins/${first.body.checkin.id}/void`, { reason: '测试扫的' })).status).toBe(200);
    const again = await scan(guard, water.token, {}, key);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ status: 'already', checkin: { id: first.body.checkin.id } });
    const valid = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM patrol_checkins WHERE point_id = ${water.id} AND voided_at IS NULL`;
    expect(valid[0]!.n).toBe(0);
    // 别人拿这个编号：拒绝；这张表只追加
    expect((await scan(guard2, water.token, {}, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    await expect(ctx.sql`DELETE FROM patrol_checkin_repeats WHERE client_key = ${key}`).rejects.toThrow(/只追加/);
  });

  it('安保巡场模块关掉：员工端回「巡场还没开」、工作台里没有巡场，后台接口按模块拦截', async () => {
    expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: true, patrol: false } })).status).toBe(200);
    expect((await scan(guard, points['北门停车场']!.token)).body.error.code).toBe('PATROL_CLOSED');
    expect((await c(guard.cookie, 'GET', '/api/canteen/me')).body.apps).toEqual([]);
    expect((await admin('GET', '/api/erp/patrol/day')).body.error.code).toBe('ERP_MODULE_DISABLED');
    expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: true, patrol: true } })).status).toBe(200);
  });
});

describe('巡场轮次（8.0.11，XC13–XC15）', () => {
  it('分轮：从营业日切换时间起每 N 分钟一轮，除不尽时最后一轮短一些；某一天用不晚于它的最后一次改动', () => {
    const three = patrolRoundsOf('2026-11-11', 'Asia/Shanghai', 6, 180);
    expect(three).toHaveLength(8);
    expect(three[0]).toEqual({ no: 1, start: '2026-11-10T22:00:00.000Z', end: '2026-11-11T01:00:00.000Z' });
    expect(three.at(-1)!.end).toBe('2026-11-11T22:00:00.000Z');
    const five = patrolRoundsOf('2026-11-11', 'Asia/Shanghai', 6, 300);
    expect(five).toHaveLength(5);
    // 第 5 轮从 02:00 到 06:00（4 小时）
    expect(five.at(-1)).toEqual({ no: 5, start: '2026-11-11T18:00:00.000Z', end: '2026-11-11T22:00:00.000Z' });
    expect(patrolRoundsOf('2026-11-11', 'Asia/Shanghai', 6, 1440)).toHaveLength(1);
    const changes = [
      { from: '2026-11-01', minutes: 240 },
      { from: '2026-11-10', minutes: 120 },
    ];
    expect(patrolRoundMinutesOn(changes, '2026-10-31')).toBe(180);
    expect(patrolRoundMinutesOn(changes, '2026-11-05')).toBe(240);
    expect(patrolRoundMinutesOn(changes, '2026-11-10')).toBe(120);
  });

  it('按轮的清单：每一轮哪些场所打了（谁几点）、哪些漏巡；同一轮谁再扫都不另记，作废以后这一轮又能打；数据库唯一索引兜底', async () => {
    const t = await today();
    const day = new Date(Date.parse(`${t}T00:00:00Z`) - 10 * 86_400_000).toISOString().slice(0, 10);
    // 两个专门的场所，建档时间拨到那一天以前（今天建的场所那一天不用巡）
    const p1 = (await addPoint('轮次甲')).body.point as { id: number; token: string };
    const p2 = (await addPoint('轮次乙')).body.point as { id: number; token: string };
    const before = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000);
    await ctx.sql`UPDATE patrol_points SET created_at = ${before} WHERE id IN ${ctx.sql([p1.id, p2.id])}`;
    // 那一天没改过间隔：按默认 3 小时分 8 轮（今天改成 24 小时不影响以前的日子，XC15）
    const plan = (await admin('GET', `/api/erp/patrol/day?date=${day}`)).body as { roundMinutes: number; rounds: { no: number; start: string; end: string }[] };
    expect(plan.roundMinutes).toBe(180);
    expect(plan.rounds).toHaveLength(8);
    const at = (no: number, minutes: number) => new Date(Date.parse(plan.rounds[no - 1]!.start) + minutes * 60_000).toISOString();
    // 员工端的「此刻」拨到那一天第 3 轮里
    const saved = nowMs;
    nowMs = Date.parse(at(3, 30));
    try {
      const a = await scan(guard, p1.token, { scannedAt: at(1, 10) });
      expect(a.body, JSON.stringify(a.body)).toMatchObject({ status: 'ok', round: { no: 1 } });
      // 同一轮小李再扫：已由老张打过
      expect((await scan(guard2, p1.token, { scannedAt: at(1, 50) })).body).toMatchObject({ status: 'already', checkin: { id: a.body.checkin.id, employeeName: '保安老张', mine: false }, round: { no: 1 } });
      // 下一轮：又能打
      expect((await scan(guard, p1.token, { scannedAt: at(2, 5) })).body).toMatchObject({ status: 'ok', round: { no: 2 }, pointCount: 2 });
      expect((await scan(guard2, p2.token, { scannedAt: at(2, 20) })).body).toMatchObject({ status: 'ok', round: { no: 2 } });
      expect((await scan(guard, p2.token, { scannedAt: at(3, 25) })).body).toMatchObject({ status: 'ok', round: { no: 3 } });

      // 手机上能看记录的人：那一天（员工端的「今天」）第 3 轮正在巡；第 1 轮乙漏巡，第 3 轮甲还没巡
      const view = await c(manager.cookie, 'GET', '/api/canteen/patrol/day');
      expect(view.status, JSON.stringify(view.body)).toBe(200);
      const v = view.body as {
        date: string;
        currentRound: number;
        currentMissing: number;
        missed: number;
        total: number;
        rounds: { no: number; state: string; expected: number; done: number }[];
        points: { name: string; byRound: ({ name: string }[] | null)[] }[];
      };
      expect(v).toMatchObject({ date: day, currentRound: 3, currentMissing: 1, missed: 1, total: 4 });
      expect(v.rounds.slice(0, 4)).toMatchObject([
        { no: 1, state: 'past', expected: 2, done: 1 },
        { no: 2, state: 'past', expected: 2, done: 2 },
        { no: 3, state: 'current', expected: 2, done: 1 },
        { no: 4, state: 'future', expected: 2, done: 0 },
      ]);
      const cells = Object.fromEntries(v.points.map((p) => [p.name, p.byRound.map((x) => (x === null ? null : x.map((s) => s.name)))]));
      expect(cells['轮次甲']!.slice(0, 3)).toEqual([['保安老张'], ['保安老张'], []]);
      expect(cells['轮次乙']!.slice(0, 3)).toEqual([[], ['保安小李'], ['保安老张']]);
      // 那一天以后才建的场所，那一天每一轮都不用巡（不算漏巡）
      expect(cells['北门停车场']!.every((x) => x === null)).toBe(true);

      // 数据库兜底：同一个场所同一轮只能有一条没作废的打卡
      const row = (await ctx.sql<{ roundStart: string; roundMinutes: number }[]>`SELECT round_start, round_minutes FROM patrol_checkins WHERE id = ${a.body.checkin.id}`)[0]!;
      expect(new Date(row.roundStart).toISOString()).toBe(plan.rounds[0]!.start);
      expect(row.roundMinutes).toBe(180);
      await expect(
        ctx.sql`
          INSERT INTO patrol_checkins (point_id, point_name, employee_id, emp_no, employee_name, business_date, scanned_at, via, client_key, round_start, round_minutes)
          VALUES (${p1.id}, '轮次甲', ${guard2.id}, 'A102', '保安小李', ${day}, ${at(1, 40)}, 'scan', ${randomUUID()}, ${new Date(row.roundStart)}, 180)`,
      ).rejects.toThrow(/patrol_checkins_round_uq/);
      // 轮次也不能改
      await expect(ctx.sql`UPDATE patrol_checkins SET round_minutes = 240 WHERE id = ${a.body.checkin.id}`).rejects.toThrow(/只能作废/);

      // 作废第 1 轮甲那条：这一轮又能打
      expect((await admin('POST', `/api/erp/patrol/checkins/${a.body.checkin.id}/void`, { reason: '测试扫的' })).status).toBe(200);
      expect((await scan(guard2, p1.token, { scannedAt: at(1, 55) })).body).toMatchObject({ status: 'ok', round: { no: 1 }, checkin: { employeeName: '保安小李' } });
    } finally {
      nowMs = saved;
    }

    // 后台看那一天（已经过去）：第 4–8 轮也都算漏巡；记录里每条带轮次
    const past = (await admin('GET', `/api/erp/patrol/day?date=${day}`)).body as { missed: number; currentRound: number | null; rounds: { state: string }[] };
    expect(past.currentRound).toBeNull();
    expect(past.rounds.every((r) => r.state === 'past')).toBe(true);
    expect(past.missed).toBe(1 + 1 + 5 * 2);
    const recs = (await admin('GET', `/api/erp/patrol/records?from=${day}&to=${day}&voided=exclude`)).body as { rows: { pointName: string; roundNo: number }[] };
    expect(recs.rows.map((r) => `${r.pointName}${r.roundNo}`).sort()).toEqual(['轮次乙2', '轮次乙3', '轮次甲1', '轮次甲2']);
  });

  it('巡场间隔可以调（半小时一档，30 分钟到 24 小时）：从今天起按新的分轮，以前的日子照旧；带版本号', async () => {
    let s = await settings();
    for (const bad of [45, 20, 1500, 90.5]) {
      const r = await admin('PUT', '/api/erp/patrol/settings', { departmentIds: s.departmentIds, viewerIds: s.viewerIds, roundMinutes: bad, rev: s.rev });
      expect(r.status, `${bad}`).toBe(400);
    }
    const t = await today();
    const r = await admin('PUT', '/api/erp/patrol/settings', { departmentIds: s.departmentIds, viewerIds: s.viewerIds, roundMinutes: 240, rev: s.rev });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // 今天改了两次：只留今天最后的那一次
    expect(r.body).toMatchObject({ roundMinutes: 240, roundChanges: [{ from: t, minutes: 240 }] });
    expect((await admin('GET', '/api/erp/patrol/day')).body).toMatchObject({ roundMinutes: 240 });
    expect((await admin('GET', '/api/erp/patrol/day')).body.rounds).toHaveLength(6);
    // 不传巡场间隔：不改
    s = await settings();
    const keep = await admin('PUT', '/api/erp/patrol/settings', { departmentIds: s.departmentIds, viewerIds: s.viewerIds, rev: s.rev });
    expect(keep.body).toMatchObject({ roundMinutes: 240 });
    // 以前的日子照旧按当时的（默认 3 小时）
    const old = new Date(Date.parse(`${t}T00:00:00Z`) - 10 * 86_400_000).toISOString().slice(0, 10);
    expect((await admin('GET', `/api/erp/patrol/day?date=${old}`)).body).toMatchObject({ roundMinutes: 180 });
  });
});
