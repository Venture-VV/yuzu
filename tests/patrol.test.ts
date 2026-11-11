// 8.0.9 安保巡场（docs/PATROL_V809.md）：场所与场所码、谁能巡场（巡场部门）与谁能看（指定的人）、打卡的幂等与去重、
// 断网补交的时间范围、换码与停用、每天的清单、记录与导出、作废、模块开关。全部是合成数据。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCanteenApp } from '../src/server/modules/canteen/portal';
import { patrolLink, parsePatrolToken } from '../src/shared/patrol';
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
const settings = async () => (await admin('GET', '/api/erp/patrol/settings')).body as { rev: number; departmentIds: number[]; viewerIds: number[] };
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
    expect(patrol).toMatchObject({ group: '员工工作台', requires: ['canteen'], enabled: true });
    expect(mods.find((m) => m.key === 'canteen')!.group).toBe('员工工作台');
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
    const saved = await admin('PUT', '/api/erp/patrol/settings', { departmentIds: [security], viewerIds: [manager.id], rev: s.rev });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ departmentIds: [security], viewerIds: [manager.id], patrolStaffCount: 2 });
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
  it('扫整个地址或单独的码都认；同一个编号原样返回；2 分钟内重复扫同一个码只记一次；不同的人各记各的', async () => {
    const north = points['北门停车场']!;
    const link = patrolLink('https://staff.example.com', north.token);
    expect(parsePatrolToken(link)).toBe(north.token);
    const key = randomUUID();
    const first = await scan(guard, link, { via: 'link' }, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ status: 'ok', checkin: { pointName: '北门停车场', area: '负一层出口旁', late: false }, pointCount: 1 });
    // 回复丢了原样重提：同一条
    const replay = await scan(guard, link, { via: 'link' }, key);
    expect(replay.body).toMatchObject({ status: 'ok', checkin: { id: first.body.checkin.id } });
    // 别人拿这个编号：拒绝
    expect((await scan(guard2, link, {}, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 1 分钟后同一个人再扫：刚打过卡，不重复记
    nowMs += 60_000;
    const dup = await scan(guard, north.token.toLowerCase());
    expect(dup.body).toMatchObject({ status: 'already', checkin: { id: first.body.checkin.id }, pointCount: 1 });
    // 另一位保安扫同一个码：各记各的
    expect((await scan(guard2, north.token)).body).toMatchObject({ status: 'ok', pointCount: 2 });
    // 3 分钟后同一个人再扫：记第二次
    nowMs += 3 * 60_000;
    expect((await scan(guard, north.token)).body).toMatchObject({ status: 'ok', pointCount: 3 });
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
  it('后台「今天」：每个场所谁几点巡过，还没人巡的个数；手机上保安只看今天，指定的人看以前的', async () => {
    const day = (await admin('GET', '/api/erp/patrol/day')).body as { points: { name: string; count: number }[]; missing: number; total: number; date: string };
    expect(day.date).toBe(await today());
    const byName = Object.fromEntries(day.points.map((p) => [p.name, p.count]));
    expect(byName).toMatchObject({ 北门停车场: 3, 三楼消防通道: 1, 屋顶水箱间: 0 });
    expect(day.missing).toBe(1);
    expect(day.total).toBe(4);
    // 手机上：保安看今天
    const mine = await c(guard.cookie, 'GET', '/api/canteen/patrol/day');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body).toMatchObject({ total: 4, mine: 3, canViewHistory: false });
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
    const all = (await admin('GET', `/api/erp/patrol/records?from=${d}&to=${d}`)).body as { rows: { id: number; name: string; late: boolean; voidedAt: string | null }[]; total: number };
    expect(all.total).toBe(4);
    const north = await admin('GET', `/api/erp/patrol/records?from=${d}&to=${d}&pointId=${points['北门停车场']!.id}`);
    expect(north.body.total).toBe(3);
    const zhang = await admin('GET', `/api/erp/patrol/records?from=${d}&to=${d}&employeeId=${guard.id}`);
    expect(zhang.body.total).toBe(3);
    expect(all.rows.filter((r) => r.late).length).toBe(1);
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/erp/patrol/records/export?from=${d}&to=${d}`, headers: { cookie: ctx.owner } });
    expect(csv.statusCode).toBe(200);
    const lines = csv.body.trim().split(/\r\n/);
    expect(lines.length).toBe(1 + 4 + 1);
    expect(lines.at(-1)).toContain('4 次');
    // 作废一条
    const target = all.rows.find((r) => r.name === '保安小李')!;
    expect((await admin('POST', `/api/erp/patrol/checkins/${target.id}/void`, { reason: '' })).status).toBe(400);
    expect((await admin('POST', `/api/erp/patrol/checkins/${target.id}/void`, { reason: '测试扫的' })).status).toBe(200);
    expect((await admin('POST', `/api/erp/patrol/checkins/${target.id}/void`, { reason: '再作废一次' })).status).toBe(200);
    const after = await admin('GET', `/api/erp/patrol/records?from=${d}&to=${d}`);
    expect(after.body).toMatchObject({ total: 3, voided: 1 });
    expect((await admin('GET', '/api/erp/patrol/day')).body.total).toBe(3);
    // 店员没有「场所与设置」权限：不能作废
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/erp/patrol/checkins/${all.rows[0]!.id}/void`, { reason: '越权' })).status).toBe(403);
    // 打卡记录、场所不能删、打卡不能改
    await expect(ctx.sql`DELETE FROM patrol_checkins WHERE id = ${target.id}`).rejects.toThrow(/禁止删除/);
    await expect(ctx.sql`UPDATE patrol_checkins SET employee_name = '改名' WHERE id = ${all.rows[0]!.id}`).rejects.toThrow(/只能作废/);
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

  it('2 分钟内重复的那一笔也记下操作编号：原来那条后来被作废，重提照样是「刚打过卡」、不再记一条（Codex 审查 94f53d5）', async () => {
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
