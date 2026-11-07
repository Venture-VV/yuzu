// 员工食堂 · 柚子饭堂（docs/CANTEEN.md）：模块开关、员工端口的边界、名单与开通、登录与锁定、饭卡码与打卡（每餐一次、
// 同一编号重提与并发、断网补登、停用与重新开通后作废）、撤销、菜单的版本与发布、点赞、管理后台的记录与导出。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf } from '../src/shared/business-date';
import { signCanteenCode } from '../src/shared/canteen';
import { makeCanteenCode } from '../src/server/modules/canteen/code';
import { buildCanteenApp } from '../src/server/modules/canteen/portal';
import { api, setup, type TestContext } from './helpers';

const SECRET = 'canteen-test-secret-0123456789abcdef-0123456789';
const TZ = 'Asia/Shanghai';
const today = businessDateOf(new Date(), TZ, 0);
const at = (hhmm: string, date = today) => Date.parse(`${date}T${hhmm}:00+08:00`);
const yesterday = (() => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();

let ctx: TestContext;
let canteen: FastifyInstance;
let clock = at('12:00');

async function c<T = any>(cookie: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await canteen.inject({
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  const body = res.headers['content-type']?.toString().includes('json') ? res.json() : res.body;
  const set = res.cookies.find((k) => k.name === 'yuzu_canteen_sid');
  return { status: res.statusCode, body: body as T, cookie: set ? `yuzu_canteen_sid=${set.value}` : null };
}

const admin = <T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => api<T>(ctx.app, ctx.owner, method, url, payload);

/** 加一位员工并用开通码开通，返回会话 Cookie、编号与码钥匙版本 */
async function hire(empNo: string, name: string, role: 'staff' | 'cook' | 'manager', departmentId: number | null, password = 'Fan-tang-2026') {
  const made = await admin('POST', '/api/erp/canteen/employees', { empNo, name, role, departmentId });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const id = made.body.employee.id as number;
  const card = (await admin('GET', `/api/erp/canteen/activation-cards?ids=${id}`)).body[0];
  const joined = await c(null, 'POST', '/api/canteen/join', { code: card.code, password });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  return { id, cookie: joined.cookie!, epoch: joined.body.codeEpoch as number, me: joined.body };
}

const scan = (cookie: string, body: Record<string, unknown>) => c(cookie, 'POST', '/api/canteen/checkins', { clientKey: randomUUID(), ...body });

let deptId: number;
let otherDeptId: number;
let emp: Awaited<ReturnType<typeof hire>>;
let cook: Awaited<ReturnType<typeof hire>>;
let boss: Awaited<ReturnType<typeof hire>>;

beforeAll(async () => {
  ctx = await setup();
  const config = { ...ctx.config, canteen: { port: null, host: '127.0.0.1', codeSecret: SECRET, cookieSecure: false, trustProxy: [] } };
  canteen = await buildCanteenApp(ctx.sql, config, { clock: () => clock, openCacheMs: 0 });
  otherDeptId = (await ctx.sql<{ id: number }[]>`INSERT INTO departments (name) VALUES ('前厅') RETURNING id`)[0]!.id;
});

afterAll(async () => {
  await canteen?.close();
  await ctx?.close();
});

describe('模块开关与两个端口的边界', () => {
  it('默认关：后台接口按 ERP 规则拦截，员工端口回「饭堂还没开张」', async () => {
    const r = await admin('GET', '/api/erp/canteen/overview');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ERP_MODULE_DISABLED');
    expect((await c(null, 'GET', '/api/canteen/ping')).body.open).toBe(false);
    const me = await c(null, 'GET', '/api/canteen/me');
    expect([me.status, me.body.error.code]).toEqual([503, 'CANTEEN_CLOSED']);
  });

  it('打开模块后两边都能用；店员没有管理权限', async () => {
    expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: true } })).status).toBe(200);
    expect((await admin('GET', '/api/erp/canteen/overview')).status).toBe(200);
    expect((await c(null, 'GET', '/api/canteen/ping')).body.open).toBe(true);
    expect((await c(null, 'GET', '/api/canteen/me')).status).toBe(401);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/erp/canteen/employees')).status).toBe(403);
  });

  it('主端口没有 /api/canteen/*，员工端口没有管理后台和系统账号的登录', async () => {
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/canteen/ping')).status).toBe(404);
    expect((await c(null, 'GET', '/api/erp/canteen/overview')).status).toBe(404);
    expect((await c(null, 'POST', '/api/auth/login', { username: 'owner', password: 'x' })).status).toBe(404);
    // 系统账号的 Cookie 在员工端口上不认
    expect((await c(ctx.owner, 'GET', '/api/canteen/me')).status).toBe(401);
  });

  it('员工端口的页面安全头、JSON 不缓存', async () => {
    const r = await canteen.inject({ method: 'GET', url: '/api/canteen/ping' });
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(String(r.headers['permissions-policy'])).toContain('camera=(self)');
  });
});

describe('设置与名单', () => {
  it('一键新建食堂部门；开饭时间不能重叠；员工入口要 https（店里局域网的地址可以用 http，K18）', async () => {
    const d = await admin('POST', '/api/erp/canteen/department', {});
    expect(d.status).toBe(200);
    deptId = d.body.departmentId;
    expect((await ctx.sql`SELECT name FROM departments WHERE id = ${deptId}`)[0]!.name).toBe('员工食堂');
    const s = (await admin('GET', '/api/erp/canteen/settings')).body;
    const overlap = { ...s, meals: s.meals.map((m: any) => (m.meal === 'dinner' ? { ...m, start: '14:00' } : m)) };
    expect((await admin('PUT', '/api/erp/canteen/settings', overlap)).status).toBe(400);
    expect((await admin('PUT', '/api/erp/canteen/settings', { ...s, portalUrl: 'http://staff.example.com' })).status).toBe(400);
    expect((await admin('PUT', '/api/erp/canteen/settings', { ...s, portalUrl: 'http://8.8.8.8:8090' })).status).toBe(400);
    const lan = await admin('PUT', '/api/erp/canteen/settings', { ...s, portalUrl: 'http://192.168.1.20:8090/' });
    expect([lan.status, lan.body.portalUrl]).toEqual([200, 'http://192.168.1.20:8090']);
    const ok = await admin('PUT', '/api/erp/canteen/settings', { ...s, portalUrl: 'https://staff.example.com/' });
    expect([ok.status, ok.body.portalUrl, ok.body.departmentId]).toEqual([200, 'https://staff.example.com', deptId]);
  });

  it('厨师、负责人必须在食堂部门；工号转大写；同一工号原样重提不重复', async () => {
    const wrong = await admin('POST', '/api/erp/canteen/employees', { empNo: 'c01', name: '王厨', role: 'cook', departmentId: otherDeptId });
    expect(wrong.body.error.code).toBe('CANTEEN_ROLE_DEPARTMENT');
    const body = { empNo: 'e001', name: '小林', role: 'staff', departmentId: otherDeptId };
    const first = await admin('POST', '/api/erp/canteen/employees', body);
    expect([first.status, first.body.created, first.body.employee.empNo, first.body.employee.activationPending]).toEqual([200, true, 'E001', true]);
    const again = await admin('POST', '/api/erp/canteen/employees', body);
    expect([again.body.created, again.body.employee.id]).toEqual([false, first.body.employee.id]);
    const clash = await admin('POST', '/api/erp/canteen/employees', { ...body, name: '别人' });
    expect([clash.status, clash.body.error.code]).toEqual([409, 'EMP_NO_TAKEN']);
  });

  it('粘贴一批：先预览，有问题的一行都不加；改好后整批加，已经有的跳过', async () => {
    const text = ['E001 小林 前厅', 'E002 小周 前厅', 'E003 小陈 不存在的部门', 'E002 重复 前厅', 'bad! 坏工号'].join('\n');
    const preview = await admin('POST', '/api/erp/canteen/employees/batch', { text });
    expect(preview.body.rows.map((r: any) => r.status)).toEqual(['same', 'new', 'error', 'error', 'error']);
    expect((await admin('POST', '/api/erp/canteen/employees/batch', { text, apply: true })).body.error.code).toBe('BATCH_HAS_ERRORS');
    const ok = await admin('POST', '/api/erp/canteen/employees/batch', { text: 'E001 小林 前厅\nE002 小周 前厅\ne003, 小陈', apply: true });
    expect([ok.status, ok.body.created]).toEqual([200, 2]);
    const list = (await admin('GET', '/api/erp/canteen/employees')).body.map((e: any) => `${e.empNo}:${e.name}:${e.department}`);
    expect(list).toEqual(expect.arrayContaining(['E001:小林:前厅', 'E002:小周:前厅', 'E003:小陈:']));
  });

  it('开通：开通码打招呼、太好猜的密码不行、用过的码不能再用', async () => {
    const card = (await admin('GET', '/api/erp/canteen/activation-cards')).body.find((x: any) => x.empNo === 'E002');
    expect(card.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    const hello = await c(null, 'GET', `/api/canteen/join/${card.code.slice(0, 4)}-${card.code.slice(4).toLowerCase()}`);
    expect([hello.status, hello.body.name]).toEqual([200, '小周']);
    expect((await c(null, 'POST', '/api/canteen/join', { code: card.code, password: '123456' })).status).toBe(400);
    const joined = await c(null, 'POST', '/api/canteen/join', { code: card.code, password: 'zhou-2026' });
    expect([joined.status, joined.body.employee.empNo, typeof joined.body.codeKey]).toEqual([200, 'E002', 'string']);
    expect(joined.cookie).toBeTruthy();
    const reuse = await c(null, 'POST', '/api/canteen/join', { code: card.code, password: 'zhou-2026' });
    expect(reuse.body.error.code).toBe('ACTIVATION_INVALID');
    // 员工端的 Cookie 在主端口上不认
    expect((await api(ctx.app, joined.cookie, 'GET', '/api/auth/me')).status).toBe(401);
  });

  it('登录：没开通的提示用开通码；输错 5 次锁 15 分钟', async () => {
    const pending = await c(null, 'POST', '/api/canteen/login', { empNo: 'e003', password: 'whatever-1' });
    expect(pending.body.error.code).toBe('NOT_ACTIVATED');
    for (let i = 0; i < 4; i++) expect((await c(null, 'POST', '/api/canteen/login', { empNo: 'E002', password: `nope-${i}x` })).status).toBe(401);
    const locked = await c(null, 'POST', '/api/canteen/login', { empNo: 'E002', password: 'nope-5x' });
    expect([locked.status, locked.body.error.code]).toEqual([429, 'ACCOUNT_LOCKED']);
    expect((await c(null, 'POST', '/api/canteen/login', { empNo: 'E002', password: 'zhou-2026' })).body.error.code).toBe('ACCOUNT_LOCKED');
    await ctx.sql`UPDATE canteen_employees SET locked_until = NULL WHERE emp_no = 'E002'`;
    const ok = await c(null, 'POST', '/api/canteen/login', { empNo: ' e002 ', password: 'zhou-2026' });
    expect([ok.status, ok.body.employee.name]).toEqual([200, '小周']);
  });

  it('写请求核对来源', async () => {
    const r = await c(null, 'POST', '/api/canteen/login', { empNo: 'E002', password: 'zhou-2026' }, { origin: 'https://evil.example.com' });
    expect([r.status, r.body.error.code]).toEqual([403, 'BAD_ORIGIN']);
  });
});

describe('饭卡码与打卡', () => {
  beforeAll(async () => {
    emp = await hire('E100', '阿美', 'staff', otherDeptId);
    cook = await hire('C001', '王师傅', 'cook', deptId);
    boss = await hire('M001', '陈姐', 'manager', deptId);
  });

  it('换食堂部门前要先把厨师、负责人调过去', async () => {
    const s = (await admin('GET', '/api/erp/canteen/settings')).body;
    const r = await admin('PUT', '/api/erp/canteen/settings', { ...s, departmentId: otherDeptId });
    expect(r.body.error.code).toBe('CANTEEN_STAFF_ELSEWHERE');
  });

  it('负责人扫码：午餐记一次；同一餐再扫提示已经打过卡；同一编号重提返回原来那条', async () => {
    clock = at('12:00');
    const code = makeCanteenCode(SECRET, emp.id, emp.epoch, clock);
    const key = randomUUID();
    const first = await c(boss.cookie, 'POST', '/api/canteen/checkins', { clientKey: key, code });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect([first.body.status, first.body.checkin.meal, first.body.checkin.date, first.body.checkin.name, first.body.mealCount]).toEqual(['ok', 'lunch', today, '阿美', 1]);
    const again = await scan(boss.cookie, { code });
    expect([again.body.status, again.body.checkin.id, again.body.mealCount]).toEqual(['already', first.body.checkin.id, 1]);
    const replay = await c(boss.cookie, 'POST', '/api/canteen/checkins', { clientKey: key, code });
    expect([replay.body.status, replay.body.checkin.id]).toEqual(['ok', first.body.checkin.id]);
    expect((await ctx.sql`SELECT count(*)::int AS n FROM canteen_checkins WHERE employee_id = ${emp.id}`)[0]!.n).toBe(1);
  });

  it('同一个编号同时提交两次只记一条', async () => {
    clock = at('18:00');
    const body = { clientKey: randomUUID(), code: makeCanteenCode(SECRET, emp.id, emp.epoch, clock) };
    const [a, b] = await Promise.all([c(boss.cookie, 'POST', '/api/canteen/checkins', body), c(boss.cookie, 'POST', '/api/canteen/checkins', body)]);
    expect([a.status, b.status, a.body.checkin.id === b.body.checkin.id, a.body.checkin.meal]).toEqual([200, 200, true, 'dinner']);
    expect((await ctx.sql`SELECT count(*)::int AS n FROM canteen_checkins WHERE client_key = ${body.clientKey}`)[0]!.n).toBe(1);
  });

  it('过期、被改过、不是饭卡码的都拒绝；不在开饭时间拒绝', async () => {
    clock = at('12:30');
    const old = makeCanteenCode(SECRET, emp.id, emp.epoch, clock - 5 * 60_000);
    expect((await scan(boss.cookie, { code: old })).body.error.code).toBe('CODE_EXPIRED');
    const good = makeCanteenCode(SECRET, cook.id, cook.epoch, clock);
    const forged = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
    expect((await scan(boss.cookie, { code: forged })).body.error.code).toBe('CODE_INVALID');
    expect((await scan(boss.cookie, { code: 'https://example.com/hello' })).body.error.code).toBe('CODE_INVALID');
    // 码里的员工编号换成别人：签名对不上
    const other = good.replace(/^YZC1:[0-9A-Z]+:/, `YZC1:${emp.id.toString(36).toUpperCase()}:`);
    expect((await scan(boss.cookie, { code: other })).body.error.code).toBe('CODE_INVALID');
    clock = at('15:00');
    const idle = await scan(boss.cookie, { code: makeCanteenCode(SECRET, cook.id, cook.epoch, clock) });
    expect(idle.body.error.code).toBe('NOT_MEAL_TIME');
    expect(idle.body.error.message).toContain('午餐 10:30–14:30');
  });

  it('只有负责人能扫码；员工、厨师都不行', async () => {
    clock = at('12:40');
    const code = makeCanteenCode(SECRET, cook.id, cook.epoch, clock);
    expect((await scan(emp.cookie, { code })).status).toBe(403);
    expect((await scan(cook.cookie, { code })).status).toBe(403);
    expect((await c(cook.cookie, 'GET', '/api/canteen/today')).status).toBe(403);
  });

  it('断网补登：按扫到的时间核对码、定餐次；只收 24 小时内；手机时间太快的拒绝', async () => {
    clock = at('12:45');
    const scannedAt = at('08:30');
    const code = makeCanteenCode(SECRET, cook.id, cook.epoch, scannedAt);
    const late = await scan(boss.cookie, { code, scannedAt: new Date(scannedAt).toISOString() });
    expect([late.status, late.body.status, late.body.checkin.meal]).toEqual([200, 'ok', 'breakfast']);
    const tooOld = at('12:00', yesterday) - 60 * 60_000;
    const r = await scan(boss.cookie, { code: makeCanteenCode(SECRET, cook.id, cook.epoch, tooOld), scannedAt: new Date(tooOld).toISOString() });
    expect(r.body.error.code).toBe('SCAN_TOO_OLD');
    const ahead = clock + 5 * 60_000;
    expect((await scan(boss.cookie, { code: makeCanteenCode(SECRET, cook.id, cook.epoch, ahead), scannedAt: new Date(ahead).toISOString() })).body.error.code).toBe('CLOCK_AHEAD');
  });

  it('手动登记、搜人；撤销后同一餐可以重新登记', async () => {
    clock = at('12:50');
    const people = await c(boss.cookie, 'GET', '/api/canteen/people?q=王');
    expect(people.body.map((p: any) => p.name)).toEqual(['王师傅']);
    const manual = await scan(boss.cookie, { employeeId: cook.id, note: '手机没电' });
    expect([manual.body.status, manual.body.checkin.method, manual.body.checkin.note]).toEqual(['ok', 'manual', '手机没电']);
    expect((await scan(boss.cookie, { employeeId: cook.id })).body.status).toBe('already');
    const voided = await c(boss.cookie, 'POST', `/api/canteen/checkins/${manual.body.checkin.id}/void`, { reason: '登记错了人' });
    expect([voided.status, voided.body.voidReason, voided.body.voidedByName]).toEqual([200, '登记错了人', '陈姐']);
    expect((await c(boss.cookie, 'POST', `/api/canteen/checkins/${manual.body.checkin.id}/void`, { reason: '再撤一次' })).body.voidReason).toBe('登记错了人');
    expect((await scan(boss.cookie, { employeeId: cook.id })).body.status).toBe('ok');
    const today2 = await c(boss.cookie, 'GET', '/api/canteen/today');
    expect([today2.body.current.meal, today2.body.counts.lunch]).toEqual(['lunch', 2]);
  });

  it('打卡记录只能撤销，不能改、不能删', async () => {
    const [row] = await ctx.sql<{ id: number }[]>`SELECT id FROM canteen_checkins WHERE voided_at IS NULL LIMIT 1`;
    await expect(ctx.sql`UPDATE canteen_checkins SET employee_name = '改名' WHERE id = ${row!.id}`).rejects.toThrow(/只能撤销/);
    await expect(ctx.sql`DELETE FROM canteen_checkins WHERE id = ${row!.id}`).rejects.toThrow(/禁止删除/);
  });

  it('停用：马上扫不进、登录失效；重新启用后旧手机的码也作废', async () => {
    clock = at('13:00');
    const list = (await admin('GET', '/api/erp/canteen/employees')).body;
    const row = list.find((e: any) => e.id === emp.id);
    const off = await admin('PUT', `/api/erp/canteen/employees/${emp.id}`, { empNo: row.empNo, name: row.name, departmentId: row.departmentId, role: row.role, active: false, version: row.version });
    expect([off.status, off.body.active]).toEqual([200, false]);
    const code = makeCanteenCode(SECRET, emp.id, emp.epoch, clock);
    expect((await scan(boss.cookie, { code })).body.error.code).toBe('EMPLOYEE_INACTIVE');
    expect((await c(emp.cookie, 'GET', '/api/canteen/me')).status).toBe(401);
    const on = await admin('PUT', `/api/erp/canteen/employees/${emp.id}`, { empNo: row.empNo, name: row.name, departmentId: row.departmentId, role: row.role, active: true, version: off.body.version });
    expect(on.status).toBe(200);
    clock = at('18:30');
    expect((await scan(boss.cookie, { code: makeCanteenCode(SECRET, emp.id, emp.epoch, clock) })).body.error.code).toBe('CODE_INVALID');
    // 密码还在：重新登录拿到新的码钥匙
    const back = await c(null, 'POST', '/api/canteen/login', { empNo: 'E100', password: 'Fan-tang-2026' });
    expect(back.body.codeEpoch).toBe(emp.epoch + 1);
    emp = { ...emp, cookie: back.cookie!, epoch: back.body.codeEpoch };
  });

  it('版本号对不上拒绝；内容一样的重提照样成功', async () => {
    const row = (await admin('GET', '/api/erp/canteen/employees')).body.find((e: any) => e.id === emp.id);
    const body = { empNo: row.empNo, name: '阿美美', departmentId: row.departmentId, role: row.role, active: true, version: row.version };
    expect((await admin('PUT', `/api/erp/canteen/employees/${emp.id}`, body)).status).toBe(200);
    expect((await admin('PUT', `/api/erp/canteen/employees/${emp.id}`, body)).status).toBe(200);
    expect((await admin('PUT', `/api/erp/canteen/employees/${emp.id}`, { ...body, name: '又改' })).body.error.code).toBe('VERSION_CHANGED');
  });

  it('重新开通：同一编号返回同一张；旧登录与旧码作废，设新密码后能用', async () => {
    const key = randomUUID();
    const a = await admin('POST', `/api/erp/canteen/employees/${emp.id}/activation`, { clientKey: key });
    const b = await admin('POST', `/api/erp/canteen/employees/${emp.id}/activation`, { clientKey: key });
    expect([a.status, a.body.code === b.body.code]).toEqual([200, true]);
    expect((await c(emp.cookie, 'GET', '/api/canteen/me')).status).toBe(401);
    expect((await c(null, 'POST', '/api/canteen/login', { empNo: 'E100', password: 'Fan-tang-2026' })).body.error.code).toBe('NOT_ACTIVATED');
    const joined = await c(null, 'POST', '/api/canteen/join', { code: a.body.code, password: 'Mei-new-2026' });
    expect(joined.status).toBe(200);
    clock = at('18:40');
    expect((await scan(boss.cookie, { code: makeCanteenCode(SECRET, emp.id, emp.epoch, clock) })).body.error.code).toBe('CODE_INVALID');
    emp = { ...emp, cookie: joined.cookie!, epoch: joined.body.codeEpoch };
    expect((await scan(boss.cookie, { code: makeCanteenCode(SECRET, emp.id, emp.epoch, clock) })).body.status).toBe('already');
  });

  it('改密码：码钥匙换新，别的手机退出，这台继续用', async () => {
    const other = await c(null, 'POST', '/api/canteen/login', { empNo: 'E100', password: 'Mei-new-2026' });
    const changed = await c(emp.cookie, 'PUT', '/api/canteen/me/password', { oldPassword: 'Mei-new-2026', newPassword: 'Mei-third-2026' });
    expect([changed.status, changed.body.codeEpoch]).toEqual([200, emp.epoch + 1]);
    expect((await c(other.cookie, 'GET', '/api/canteen/me')).status).toBe(401);
    expect((await c(emp.cookie, 'GET', '/api/canteen/me')).status).toBe(200);
    expect((await c(emp.cookie, 'PUT', '/api/canteen/me/password', { oldPassword: 'wrong-pass', newPassword: 'whatever-22' })).body.error.code).toBe('WRONG_PASSWORD');
    emp = { ...emp, epoch: changed.body.codeEpoch };
  });

  it('换头像、这个月吃了几顿、我的记录', async () => {
    expect((await c(emp.cookie, 'PUT', '/api/canteen/me/avatar', { avatar: '🐼' })).body.avatar).toBe('🐼');
    expect((await c(emp.cookie, 'PUT', '/api/canteen/me/avatar', { avatar: '<b>' })).status).toBe(400);
    const me = (await c(emp.cookie, 'GET', '/api/canteen/me')).body;
    expect([me.employee.avatar, me.mealsThisMonth]).toEqual(['🐼', 2]);
    const meals = (await c(emp.cookie, 'GET', `/api/canteen/me/meals?month=${today.slice(0, 7)}`)).body;
    expect(meals.map((m: any) => m.meal).sort()).toEqual(['dinner', 'lunch']);
  });
});

describe('菜单与点赞', () => {
  const dishes = [
    { id: 'd1', name: '红烧肉', emoji: '', tags: ['star'] },
    { id: 'd2', name: '清炒时蔬', emoji: '', tags: ['veg'] },
    { id: 'd3', name: '番茄蛋汤', emoji: '🍅', tags: [] },
  ];
  let menuId: number;

  it('员工不能改菜单；厨师保存草稿，员工看不到', async () => {
    expect((await c(emp.cookie, 'PUT', `/api/canteen/menus/${today}/lunch`, { clientKey: randomUUID(), version: 0, dishes, published: false })).status).toBe(403);
    const draft = await c(cook.cookie, 'PUT', `/api/canteen/menus/${today}/lunch`, { clientKey: randomUUID(), version: 0, dishes, note: '今天有甜品', published: false });
    expect([draft.status, draft.body.version, draft.body.published]).toEqual([200, 1, false]);
    expect(draft.body.dishes.map((d: any) => d.emoji)).toEqual(['🍖', '🥬', '🍅']);
    menuId = draft.body.id;
    expect((await c(emp.cookie, 'GET', `/api/canteen/menus?from=${today}&to=${today}`)).body).toEqual([]);
    expect((await c(cook.cookie, 'GET', `/api/canteen/menus?from=${today}&to=${today}`)).body).toHaveLength(1);
  });

  it('发布；版本号对不上拒绝，同一编号重提返回同一个结果；空菜单不能发布', async () => {
    const key = randomUUID();
    const body = { clientKey: key, version: 1, dishes, note: '今天有甜品', published: true };
    const pub = await c(cook.cookie, 'PUT', `/api/canteen/menus/${today}/lunch`, body);
    expect([pub.status, pub.body.version, pub.body.published]).toEqual([200, 2, true]);
    expect((await c(cook.cookie, 'PUT', `/api/canteen/menus/${today}/lunch`, body)).body.version).toBe(2);
    const stale = await c(boss.cookie, 'PUT', `/api/canteen/menus/${today}/lunch`, { ...body, clientKey: randomUUID(), dishes: dishes.slice(0, 1) });
    expect([stale.status, stale.body.error.code]).toEqual([409, 'MENU_CHANGED']);
    const empty = await c(cook.cookie, 'PUT', `/api/canteen/menus/${today}/dinner`, { clientKey: randomUUID(), version: 0, dishes: [], published: true });
    expect(empty.body.error.code).toBe('MENU_EMPTY');
    const far = await c(cook.cookie, 'PUT', `/api/canteen/menus/2020-01-01/lunch`, { clientKey: randomUUID(), version: 0, dishes, published: false });
    expect(far.body.error.code).toBe('MENU_OUT_OF_RANGE');
    const seen = (await c(emp.cookie, 'GET', `/api/canteen/menus?from=${today}&to=${today}`)).body;
    expect(seen.map((m: any) => [m.meal, m.dishes.length, m.note])).toEqual([['lunch', 3, '今天有甜品']]);
  });

  it('点赞：重复点不多算，取消就减；没有的菜、草稿不能点', async () => {
    const like = (cookie: string, dishId: string, liked = true) => c(cookie, 'PUT', '/api/canteen/likes', { menuId, dishId, liked });
    expect((await like(emp.cookie, 'd1')).body).toEqual({ likes: 1, liked: true });
    expect((await like(emp.cookie, 'd1')).body.likes).toBe(1);
    expect((await like(boss.cookie, 'd1')).body.likes).toBe(2);
    expect((await like(emp.cookie, 'd1', false)).body.likes).toBe(1);
    expect((await like(emp.cookie, 'zz')).status).toBe(404);
    const draft = await c(cook.cookie, 'PUT', `/api/canteen/menus/${today}/dinner`, { clientKey: randomUUID(), version: 0, dishes, published: false });
    expect((await c(emp.cookie, 'PUT', '/api/canteen/likes', { menuId: draft.body.id, dishId: 'd1', liked: true })).status).toBe(404);
    const mine = (await c(boss.cookie, 'GET', `/api/canteen/menus?from=${today}&to=${today}`)).body.find((m: any) => m.meal === 'lunch');
    expect([mine.likes.d1, mine.myLikes]).toEqual([1, ['d1']]);
  });
});

describe('管理后台', () => {
  it('概览：今天各餐人数、名单统计、赞最多的菜', async () => {
    const o = (await admin('GET', '/api/erp/canteen/overview')).body;
    expect(o.enabled).toBe(true);
    expect(o.departmentName).toBe('员工食堂');
    expect(o.people.managers).toBe(1);
    expect(o.people.cooks).toBe(1);
    expect(o.days).toHaveLength(14);
    expect(o.days.at(-1).date).toBe(today);
    expect(o.topDishes[0]).toMatchObject({ name: '红烧肉', likes: 1 });
  });

  it('用餐记录：筛选、导出、后台撤销', async () => {
    const all = (await admin('GET', `/api/erp/canteen/checkins?from=${today}&to=${today}`)).body;
    expect(all.rows.length).toBeGreaterThanOrEqual(4);
    expect([all.total, all.truncated]).toEqual([all.rows.length, false]);
    expect(all.valid).toBe(all.rows.filter((r: any) => !r.voidedAt).length);
    const lunch = (await admin('GET', `/api/erp/canteen/checkins?from=${today}&to=${today}&meal=lunch&voided=exclude`)).body.rows;
    expect(lunch.every((r: any) => r.meal === 'lunch' && !r.voidedAt)).toBe(true);
    const byName = (await admin('GET', `/api/erp/canteen/checkins?from=${today}&to=${today}&q=${encodeURIComponent('阿美')}`)).body.rows;
    expect(byName.length).toBeGreaterThan(0);
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/erp/canteen/checkins.csv?from=${today}&to=${today}`, headers: { cookie: ctx.owner } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.replace(/^﻿/, '').split(/\r?\n/)[0]).toBe('日期,餐次,工号,姓名,部门,方式,扫到的时间,登记人,备注,状态,撤销原因');
    const target = lunch[0];
    const v = await admin('POST', `/api/erp/canteen/checkins/${target.id}/void`, { reason: '后台核对：重复' });
    expect([v.status, v.body.voidedByName]).toEqual([200, '测试店主']);
  });

  it('负责人不能撤销别人登记的；关掉模块后员工端马上停', async () => {
    const boss2 = await hire('M002', '刘哥', 'manager', deptId);
    const [row] = await ctx.sql<{ id: number }[]>`SELECT id FROM canteen_checkins WHERE recorder_id = ${boss.id} AND voided_at IS NULL LIMIT 1`;
    expect((await c(boss2.cookie, 'POST', `/api/canteen/checkins/${row!.id}/void`, { reason: '试试' })).status).toBe(403);
    expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: false } })).status).toBe(200);
    expect((await c(boss2.cookie, 'GET', '/api/canteen/me')).status).toBe(503);
    expect((await admin('GET', '/api/erp/canteen/overview')).status).toBe(403);
  });
});

describe('员工端口的边界：编码过的地址、登录限次', () => {
  it('编码过的地址照样核对来源与模块开关（/%61pi/… 与 /api/… 是同一个接口）', async () => {
    expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: false } })).status).toBe(200);
    const closed = await canteen.inject({ method: 'POST', url: '/%61pi/canteen/login', payload: { empNo: 'E002', password: 'zhou-2026' } });
    expect([closed.statusCode, closed.json().error.code]).toEqual([503, 'CANTEEN_CLOSED']);
    expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: true } })).status).toBe(200);
    const cross = await canteen.inject({ method: 'POST', url: '/%61pi/canteen/login', headers: { origin: 'https://evil.example.com' }, payload: { empNo: 'E002', password: 'zhou-2026' } });
    expect([cross.statusCode, cross.json().error.code]).toEqual([403, 'BAD_ORIGIN']);
  });

  it('同一来源 IP 只记失败：大家一起登录不会互相挡住；失败 30 次后先拦下', async () => {
    const from = (remoteAddress: string, password: string) =>
      canteen.inject({ method: 'POST', url: '/api/canteen/login', remoteAddress, payload: { empNo: 'E002', password } });
    for (let i = 0; i < 35; i++) expect((await from('10.9.0.1', 'zhou-2026')).statusCode).toBe(200);
    for (let i = 0; i < 30; i++) {
      const r = await from('10.9.0.2', 'definitely-wrong');
      expect([401, 429]).toContain(r.statusCode);
      if (i % 4 === 3) await ctx.sql`UPDATE canteen_employees SET locked_until = NULL, failed_logins = 0 WHERE emp_no = 'E002'`;
    }
    const blocked = await from('10.9.0.2', 'zhou-2026');
    expect([blocked.statusCode, blocked.json().error.code]).toEqual([429, 'TOO_MANY_ATTEMPTS']);
    expect((await from('10.9.0.3', 'zhou-2026')).statusCode).toBe(200);
  });
});

describe('Codex 审查 9d12ae8 的修正', () => {
  it('会话顺延时浏览器的 Cookie 也顺延（30 天，用着就一直不用重新登录）', async () => {
    const login = await c(null, 'POST', '/api/canteen/login', { empNo: 'E002', password: 'zhou-2026' });
    const fresh = await canteen.inject({ method: 'GET', url: '/api/canteen/me', headers: { cookie: login.cookie! } });
    expect(fresh.cookies.find((k) => k.name === 'yuzu_canteen_sid')).toBeUndefined();
    await ctx.sql`UPDATE canteen_sessions SET last_seen_at = now() - interval '2 hours'`;
    const renewed = await canteen.inject({ method: 'GET', url: '/api/canteen/me', headers: { cookie: login.cookie! } });
    const cookie = renewed.cookies.find((k) => k.name === 'yuzu_canteen_sid');
    expect([renewed.statusCode, cookie?.value, cookie?.maxAge, cookie?.httpOnly, cookie?.sameSite]).toEqual([200, login.cookie!.split('=')[1], 30 * 86_400, true, 'Strict']);
  });

  it('用餐记录超过页面能列的条数：页面给出合计并标出列不下，导出表格不截断', async () => {
    const [{ ownerId }, [emp]] = [ctx, await ctx.sql<{ id: number }[]>`SELECT id FROM canteen_employees WHERE emp_no = 'E100'`];
    // 2,001 条已撤销的记录（不占「每餐一次」的唯一索引）
    await ctx.sql`
      INSERT INTO canteen_checkins (employee_id, emp_no, employee_name, department_name, meal_date, meal, method, scanned_at, recorder_id, recorder_name,
                                    client_key, voided_at, void_reason, voided_by_staff)
      SELECT ${emp!.id}::bigint, 'E100', '阿美', '', ${yesterday}::date, 'lunch', 'manual', now(), ${emp!.id}::bigint, '合成', gen_random_uuid(), now(),
             '合成：测列表上限', ${ownerId}::bigint
      FROM generate_series(1, 2001)`;
    const r = (await admin('GET', `/api/erp/canteen/checkins?from=${yesterday}&to=${today}`)).body;
    expect(r.rows).toHaveLength(2000);
    expect(r.truncated).toBe(true);
    expect(r.total).toBeGreaterThan(2001);
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/erp/canteen/checkins.csv?from=${yesterday}&to=${today}`, headers: { cookie: ctx.owner } });
    expect(csv.body.replace(/^\uFEFF/, '').trim().split(/\r?\n/)).toHaveLength(r.total + 1);
  });
});

describe('店里局域网用 http 打开（K18）', () => {
  it('手机上纯 JS 算的饭卡码（不靠 WebCrypto）扫得进', async () => {
    const lan = await hire('L001', '小局', 'staff', otherDeptId);
    clock = at('12:10');
    const code = signCanteenCode(lan.me.codeKey, lan.id, clock).text;
    expect(code).toBe(makeCanteenCode(SECRET, lan.id, lan.epoch, clock));
    const r = await scan(boss.cookie, { code });
    expect([r.status, r.body.status, r.body.checkin.empNo]).toEqual([200, 'ok', 'L001']);
  });

  it('登录 Cookie：https 或公网地址加 Secure；局域网 http 打开的不加（不然浏览器存不下）', async () => {
    const secureOn = { ...ctx.config, canteen: { port: null, host: '127.0.0.1', codeSecret: SECRET, cookieSecure: true, trustProxy: ['127.0.0.1'] } };
    const secureOff = { ...secureOn, canteen: { ...secureOn.canteen, cookieSecure: false } };
    const apps = { on: await buildCanteenApp(ctx.sql, secureOn, { clock: () => clock, openCacheMs: 0 }), off: await buildCanteenApp(ctx.sql, secureOff, { clock: () => clock, openCacheMs: 0 }) };
    try {
      const secureFlag = async (app: FastifyInstance, headers: Record<string, string>) => {
        const res = await app.inject({ method: 'POST', url: '/api/canteen/login', headers, payload: { empNo: 'L001', password: 'Fan-tang-2026' } });
        expect(res.statusCode, res.body).toBe(200);
        return res.cookies.find((k) => k.name === 'yuzu_canteen_sid')?.secure ?? false;
      };
      // CANTEEN_COOKIE_SECURE=true（compose.canteen.yaml 的默认）
      expect(await secureFlag(apps.on, { host: 'staff.example.com' })).toBe(true);
      expect(await secureFlag(apps.on, { host: '192.168.1.20:8090' })).toBe(false);
      expect(await secureFlag(apps.on, { host: 'yuzu.local:8090' })).toBe(false);
      expect(await secureFlag(apps.on, { host: '192.168.1.20:8090', 'x-forwarded-proto': 'https' })).toBe(true);
      // 没设：https 打开的照样加
      expect(await secureFlag(apps.off, { host: 'staff.example.com', 'x-forwarded-proto': 'https' })).toBe(true);
      expect(await secureFlag(apps.off, { host: '192.168.1.20:8090' })).toBe(false);
    } finally {
      await apps.on.close();
      await apps.off.close();
    }
  });
});
