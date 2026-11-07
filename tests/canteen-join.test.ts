// 员工食堂 · 柚子饭堂第二期（docs/CANTEEN.md 第 14、16 节）：员工自己登记（开关、用户名与手机号、当作登录的重试、限次；不要注册口令）、
// 用用户名或手机号登录、后台的注册二维码与名单、跟柚子说（每天最多几条、同一编号重发、内容不能改不能删、柚子信箱看过与回信、导出）。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCanteenApp } from '../src/server/modules/canteen/portal';
import { api, setup, type TestContext } from './helpers';

const SECRET = 'canteen-join-test-secret-0123456789abcdef-012345';

let ctx: TestContext;
let canteen: FastifyInstance;

async function c<T = any>(cookie: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, remoteAddress = '10.1.0.1') {
  const res = await canteen.inject({ method, url, remoteAddress, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.headers['content-type']?.toString().includes('json') ? res.json() : res.body;
  const set = res.cookies.find((k) => k.name === 'yuzu_canteen_sid');
  return { status: res.statusCode, body: body as T, cookie: set ? `yuzu_canteen_sid=${set.value}` : null };
}

const admin = <T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => api<T>(ctx.app, ctx.owner, method, url, payload);
const register = (body: Record<string, unknown>, ip?: string) => c(null, 'POST', '/api/canteen/register', { password: 'Yuzi-2026!', ...body }, ip);

beforeAll(async () => {
  ctx = await setup();
  const config = { ...ctx.config, canteen: { port: null, host: '127.0.0.1', codeSecret: SECRET, cookieSecure: false, trustProxy: [] } };
  canteen = await buildCanteenApp(ctx.sql, config, { openCacheMs: 0 });
  expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: true } })).status).toBe(200);
});

afterAll(async () => {
  await canteen?.close();
  await ctx?.close();
});

describe('注册二维码（后台）', () => {
  it('没打开时不能登记；打开以后能登记、有链接（填了员工入口地址时）；不要注册口令', async () => {
    const before = await admin('GET', '/api/erp/canteen/registration');
    expect([before.status, before.body.enabled, before.body.link]).toEqual([200, false, null]);
    expect(before.body).not.toHaveProperty('code');
    expect((await c(null, 'GET', '/api/canteen/register')).body).toEqual({ open: false });
    const closed = await c(null, 'POST', '/api/canteen/register', { username: '小林', phone: '13800138000', password: 'Yuzi-2026!' });
    expect([closed.status, closed.body.error.code]).toEqual([422, 'REGISTRATION_CLOSED']);

    const s = (await admin('GET', '/api/erp/canteen/settings')).body;
    expect((await admin('PUT', '/api/erp/canteen/settings', { ...s, portalUrl: 'https://staff.example.com' })).status).toBe(200);
    const opened = await admin('PUT', '/api/erp/canteen/registration', { enabled: true, rev: before.body.rev });
    expect([opened.status, opened.body.enabled, opened.body.link, opened.body.rev]).toEqual([200, true, 'https://staff.example.com/#reg', before.body.rev + 1]);
    expect((await c(null, 'GET', '/api/canteen/register')).body).toEqual({ open: true });
    const [audit] = await ctx.sql<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM audit_logs WHERE action = 'settings_updated' AND detail->>'key' = 'canteen_registration' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail).toMatchObject({ enabledBefore: false, enabledAfter: true });
  });

  it('开关带上看到的 rev：回复没收到时再点一次、或者晚到的那一下，不会把开关改回去', async () => {
    const seen = (await admin('GET', '/api/erp/canteen/registration')).body;
    expect(seen.enabled).toBe(true);
    // 没带 rev 的拒绝
    expect((await admin('PUT', '/api/erp/canteen/registration', { enabled: false })).status).toBe(400);
    // 已经是要的样子就不用改（rev 不变），带的 rev 旧了也一样
    const same = await admin('PUT', '/api/erp/canteen/registration', { enabled: true, rev: seen.rev - 1 });
    expect([same.status, same.body.enabled, same.body.rev]).toEqual([200, true, seen.rev]);
    // 关一下、又打开；之前那个「关」（旧 rev）晚到：拒绝，开关还开着
    const off = await admin('PUT', '/api/erp/canteen/registration', { enabled: false, rev: seen.rev });
    const on = await admin('PUT', '/api/erp/canteen/registration', { enabled: true, rev: off.body.rev });
    expect([off.body.enabled, on.body.enabled, on.body.rev]).toEqual([false, true, seen.rev + 2]);
    const late = await admin('PUT', '/api/erp/canteen/registration', { enabled: false, rev: seen.rev });
    expect([late.status, late.body.error.code]).toEqual([409, 'REGISTRATION_CHANGED']);
    expect((await admin('GET', '/api/erp/canteen/registration')).body.enabled).toBe(true);
  });

  it('以前带口令的链接、页面照样能登记（口令不再核对）；第二期存过的口令不再用', async () => {
    expect((await c(null, 'GET', '/api/canteen/register?code=ZZZZ2222')).body).toEqual({ open: true });
    const r = await c(null, 'POST', '/api/canteen/register', { code: 'ZZZZ2222', username: '旧海报', phone: '13300133111', password: 'Yuzi-2026!' });
    expect([r.status, r.body.employee?.source]).toEqual([200, 'self']);
    // 第二期的库里存着口令：读的时候不看，下次保存时去掉
    await ctx.sql`UPDATE settings SET value = value || '{"code": "ABCD2345"}'::jsonb WHERE key = 'canteen_registration'`;
    const view = (await admin('GET', '/api/erp/canteen/registration')).body;
    expect(view).not.toHaveProperty('code');
    const off = await admin('PUT', '/api/erp/canteen/registration', { enabled: false, rev: view.rev });
    await admin('PUT', '/api/erp/canteen/registration', { enabled: true, rev: off.body.rev });
    const [row] = await ctx.sql<{ value: Record<string, unknown> }[]>`SELECT value FROM settings WHERE key = 'canteen_registration'`;
    expect(row!.value).toEqual({ enabled: true, rev: view.rev + 2 });
  });
});

describe('自己登记', () => {
  let lin: { cookie: string; id: number };

  it('填用户名、手机号、密码就开好账号并登录：普通员工、工号 ZC 加编号、自己登记', async () => {
    const r = await register({ username: '林小雨', phone: '138 0013 8000' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.cookie).toBeTruthy();
    expect(r.body.employee).toMatchObject({ name: '林小雨', username: '林小雨', role: 'staff', source: 'self', department: '' });
    expect(r.body.employee.empNo).toMatch(/^ZC[0-9]{4}$/);
    expect(r.body.codeKey).toBeTruthy();
    lin = { cookie: r.cookie!, id: r.body.employee.id };
    expect((await c(lin.cookie, 'GET', '/api/canteen/me')).body.employee.username).toBe('林小雨');
    const [row] = await ctx.sql<{ phone: string; source: string; createdBy: number | null }[]>`SELECT phone, source, created_by FROM canteen_employees WHERE id = ${lin.id}`;
    expect(row).toEqual({ phone: '13800138000', source: 'self', createdBy: null });
    const [audit] = await ctx.sql<{ detail: { op: string; phone: string } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'canteen_employee' AND target_id = ${String(lin.id)}`;
    expect(audit!.detail).toMatchObject({ op: 'self_register', phone: '138****8000' });
  });

  it('用户名、手机号、工号都能登录；用户名不分大小写', async () => {
    expect((await c(null, 'POST', '/api/canteen/login', { account: '林小雨', password: 'Yuzi-2026!' })).status).toBe(200);
    expect((await c(null, 'POST', '/api/canteen/login', { account: '13800138000', password: 'Yuzi-2026!' })).status).toBe(200);
    expect((await c(null, 'POST', '/api/canteen/login', { account: '+86 138-0013-8000', password: 'Yuzi-2026!' })).status).toBe(200);
    const empNo = (await c(lin.cookie, 'GET', '/api/canteen/me')).body.employee.empNo;
    expect((await c(null, 'POST', '/api/canteen/login', { account: empNo.toLowerCase(), password: 'Yuzi-2026!' })).status).toBe(200);
    // 老版本只传 empNo 照样认
    expect((await c(null, 'POST', '/api/canteen/login', { empNo, password: 'Yuzi-2026!' })).status).toBe(200);
    const r = await register({ username: 'Lily', phone: '13900139000' });
    expect(r.status).toBe(200);
    expect((await c(null, 'POST', '/api/canteen/login', { account: 'lily', password: 'Yuzi-2026!' })).status).toBe(200);
  });

  it('同一个手机号再登记、密码对的当作登录（原样重试不报错），不对的提示去登录', async () => {
    const again = await register({ username: '林小雨', phone: '13800138000' });
    expect([again.status, again.body.employee.id]).toEqual([200, lin.id]);
    const other = await register({ username: '别人', phone: '13800138000', password: 'Another-2026' });
    expect([other.status, other.body.error.code]).toEqual([409, 'PHONE_TAKEN']);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM canteen_employees WHERE phone = '13800138000'`;
    expect(n!.n).toBe(1);
    // 当作登录那次的失败也计数
    const [f] = await ctx.sql<{ failedLogins: number }[]>`SELECT failed_logins FROM canteen_employees WHERE id = ${lin.id}`;
    expect(f!.failedLogins).toBe(1);
  });

  it('用户名、手机号、密码的规矩；用户名与别人的用户名、工号都不能撞', async () => {
    const cases: [Record<string, unknown>, number, string?][] = [
      [{ username: '林', phone: '13700137001' }, 400],
      [{ username: '有 空格', phone: '13700137002' }, 400],
      [{ username: '12345', phone: '13700137003' }, 400],
      [{ username: 'zc0099', phone: '13700137004' }, 400],
      [{ username: '小周', phone: '1370013700' }, 400],
      [{ username: '小周', phone: '23700137005' }, 400],
      [{ username: '小周', phone: '13700137006', password: '123456' }, 400],
      [{ username: '小周', phone: '13700137007', password: '13700137007' }, 400],
      [{ username: '林小雨', phone: '13700137008' }, 409, 'USERNAME_TAKEN'],
      [{ username: 'LILY', phone: '13700137009' }, 409, 'USERNAME_TAKEN'],
    ];
    for (const [body, status, errorCode] of cases) {
      const r = await register(body);
      expect(r.status, JSON.stringify([body, r.body])).toBe(status);
      if (errorCode) expect(r.body.error.code).toBe(errorCode);
    }
    // 后台加人的工号也算：用户名不能和工号一样
    expect((await admin('POST', '/api/erp/canteen/employees', { empNo: 'A777', name: '阿七', role: 'staff', departmentId: null })).status).toBe(200);
    const taken = await register({ username: 'a777', phone: '13700137011' });
    expect([taken.status, taken.body.error.code]).toEqual([409, 'USERNAME_TAKEN']);
    // 反过来：后台加人时工号不能和别人的用户名一样
    const clash = await admin('POST', '/api/erp/canteen/employees', { empNo: 'LILY', name: '莉莉', role: 'staff', departmentId: null });
    expect([clash.status, clash.body.error.code]).toEqual([409, 'EMP_NO_TAKEN']);
    const preview = await admin('POST', '/api/erp/canteen/employees/batch', { text: 'LILY 莉莉', apply: false });
    expect(preview.body.rows[0].status).toBe('error');
  });

  it('同时登记同一个用户名只成功一个', async () => {
    const results = await Promise.all([register({ username: '双胞胎', phone: '13600136001' }), register({ username: '双胞胎', phone: '13600136002' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('后台：名单里看得到自己登记的、用户名与手机号，可以改工号、停用；停用后登录不了', async () => {
    const list = (await admin('GET', '/api/erp/canteen/employees')).body as any[];
    const row = list.find((e) => e.id === lin.id);
    expect(row).toMatchObject({ username: '林小雨', phone: '13800138000', source: 'self', activated: true });
    const renamed = await admin('PUT', `/api/erp/canteen/employees/${lin.id}`, { empNo: 'B012', name: '林小雨', departmentId: null, role: 'staff', active: true, version: row.version });
    expect([renamed.status, renamed.body.empNo, renamed.body.username]).toEqual([200, 'B012', '林小雨']);
    expect((await c(null, 'POST', '/api/canteen/login', { account: 'B012', password: 'Yuzi-2026!' })).status).toBe(200);
    expect((await admin('GET', '/api/erp/canteen/overview')).body.registration.selfRegistered).toBeGreaterThanOrEqual(3);
    const off = await admin('PUT', `/api/erp/canteen/employees/${lin.id}`, { empNo: 'B012', name: '林小雨', departmentId: null, role: 'staff', active: false, version: renamed.body.version });
    expect(off.status).toBe(200);
    expect((await c(lin.cookie, 'GET', '/api/canteen/me')).status).toBe(401);
    expect((await c(null, 'POST', '/api/canteen/login', { account: '林小雨', password: 'Yuzi-2026!' })).body.error.code).toBe('EMPLOYEE_INACTIVE');
    // 停用的人用同一个手机号再登记：不会开新号
    const back = await register({ username: '林小雨', phone: '13800138000' });
    expect([back.status, back.body.error.code]).toEqual([403, 'EMPLOYEE_INACTIVE']);
    await admin('PUT', `/api/erp/canteen/employees/${lin.id}`, { empNo: 'B012', name: '林小雨', departmentId: null, role: 'staff', active: true, version: off.body.version });
  });

  it('关掉自己登记以后登记不了；再打开照常', async () => {
    const off = await admin('PUT', '/api/erp/canteen/registration', { enabled: false, rev: (await admin('GET', '/api/erp/canteen/registration')).body.rev });
    expect([off.status, off.body.enabled]).toEqual([200, false]);
    expect((await register({ username: '晚来的', phone: '13500135001' })).body.error.code).toBe('REGISTRATION_CLOSED');
    expect((await c(null, 'GET', '/api/canteen/register')).body).toEqual({ open: false });
    const on = await admin('PUT', '/api/erp/canteen/registration', { enabled: true, rev: off.body.rev });
    expect(on.body.enabled).toBe(true);
    expect((await register({ username: '晚来的', phone: '13500135001' })).status).toBe(200);
  });

  it('同一来源 IP 一小时最多登记 60 个（只算成功的）；别的 IP 不受影响', async () => {
    for (let i = 0; i < 60; i++) {
      const r = await register({ username: `批量${i}`, phone: `1310000${String(i).padStart(4, '0')}` }, '10.7.0.1');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const blocked = await register({ username: '批量60', phone: '13100000060' }, '10.7.0.1');
    expect([blocked.status, blocked.body.error.code]).toEqual([429, 'TOO_MANY_REGISTRATIONS']);
    // 名额用完了，原样重试已经开好的那一个（回复没收到时）照样当作登录
    const retry = await register({ username: '批量59', phone: '13100000059' }, '10.7.0.1');
    expect([retry.status, retry.body.employee?.username]).toEqual([200, '批量59']);
    expect((await register({ username: '批量60', phone: '13100000060' }, '10.7.0.2')).status).toBe(200);
  });

  it('同时来的几个登记也不会挤过每小时的上限（先占名额，没开成新账号的再还回去）', async () => {
    const ip = '10.7.0.9';
    for (let i = 0; i < 59; i++) {
      const r = await register({ username: `并发${i}`, phone: `1320000${String(i).padStart(4, '0')}` }, ip);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    // 当作登录的（同一个手机号、密码对）不占名额
    expect((await register({ username: '并发0', phone: '13200000000' }, ip)).status).toBe(200);
    const burst = await Promise.all([0, 1, 2].map((i) => register({ username: `并发尾${i}`, phone: `1320000${String(80 + i).padStart(4, '0')}` }, ip)));
    expect(burst.map((r) => r.status).sort()).toEqual([200, 429, 429]);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM canteen_employees WHERE username LIKE '并发尾%'`;
    expect(n!.n).toBe(1);
  });

  it('同时有人登记用户名 b888、后台加工号 B888：只成功一个（登录名锁串行）', async () => {
    for (let round = 0; round < 3; round++) {
      const name = `R${round}88`;
      const [reg, made] = await Promise.all([
        register({ username: name.toLowerCase(), phone: `1340013400${round}` }, '10.5.0.1'),
        admin('POST', '/api/erp/canteen/employees', { empNo: name, name: `并发工号${round}`, role: 'staff', departmentId: null }),
      ]);
      expect([reg.status, made.status].sort(), JSON.stringify([reg.body, made.body])).toEqual([200, 409]);
      const [n] = await ctx.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM canteen_employees WHERE lower(username) = lower(${name}) OR emp_no = ${name}`;
      expect(n!.n).toBe(1);
    }
  });

  it('后台有人用一串数字当工号：同样数字的手机号照样能登记（登记只按手机号找）', async () => {
    expect((await admin('POST', '/api/erp/canteen/employees', { empNo: '13300133000', name: '数字工号', role: 'staff', departmentId: null })).status).toBe(200);
    const r = await register({ username: '真手机号', phone: '13300133000' });
    expect([r.status, r.body.employee?.username], JSON.stringify(r.body)).toEqual([200, '真手机号']);
    // 后台那位没有被记失败、没有被锁
    const [e] = await ctx.sql<{ failedLogins: number; locked: boolean }[]>`
      SELECT failed_logins, locked_until IS NOT NULL AS locked FROM canteen_employees WHERE emp_no = '13300133000'`;
    expect(e).toEqual({ failedLogins: 0, locked: false });
  });

  it('关掉模块后登记也停', async () => {
    expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: false } })).status).toBe(200);
    const r = await register({ username: '模块关了', phone: '13200132001' });
    expect([r.status, r.body.error.code]).toEqual([503, 'CANTEEN_CLOSED']);
    expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: true } })).status).toBe(200);
  });
});

describe('跟柚子说', () => {
  let a: { cookie: string; id: number };
  let b: { cookie: string; id: number };

  beforeAll(async () => {
    const ra = await register({ username: '阿信', phone: '15800158001' }, '10.3.0.1');
    const rb = await register({ username: '阿美', phone: '15800158002' }, '10.3.0.1');
    a = { cookie: ra.cookie!, id: ra.body.employee.id };
    b = { cookie: rb.cookie!, id: rb.body.employee.id };
  });

  it('发心愿与碎碎念；同一个操作编号重发返回同一条；没登录不行', async () => {
    const key = randomUUID();
    const wish = await c(a.cookie, 'POST', '/api/canteen/feedback', { clientKey: key, kind: 'wish', content: '  想在手机上看排班表  ' });
    expect(wish.status, JSON.stringify(wish.body)).toBe(200);
    expect(wish.body).toMatchObject({ kind: 'wish', content: '想在手机上看排班表', read: false, reply: null });
    const again = await c(a.cookie, 'POST', '/api/canteen/feedback', { clientKey: key, kind: 'wish', content: '想在手机上看排班表' });
    expect(again.body.id).toBe(wish.body.id);
    // 别人用这个编号不行
    expect((await c(b.cookie, 'POST', '/api/canteen/feedback', { clientKey: key, kind: 'chat', content: '我的' })).body.error.code).toBe('CLIENT_KEY_USED');
    expect((await c(a.cookie, 'POST', '/api/canteen/feedback', { clientKey: randomUUID(), kind: 'chat', content: '今天的汤有点咸' })).status).toBe(200);
    expect((await c(null, 'POST', '/api/canteen/feedback', { clientKey: randomUUID(), kind: 'chat', content: 'x' })).status).toBe(401);
    const mine = await c(a.cookie, 'GET', '/api/canteen/feedback');
    expect(mine.body.map((r: { content: string }) => r.content)).toEqual(['今天的汤有点咸', '想在手机上看排班表']);
    expect((await c(b.cookie, 'GET', '/api/canteen/feedback')).body).toEqual([]);
  });

  it('空的、太长的、种类不对的拒绝；每人每天最多 20 条', async () => {
    expect((await c(b.cookie, 'POST', '/api/canteen/feedback', { clientKey: randomUUID(), kind: 'chat', content: '   ' })).status).toBe(400);
    expect((await c(b.cookie, 'POST', '/api/canteen/feedback', { clientKey: randomUUID(), kind: 'chat', content: '字'.repeat(501) })).status).toBe(400);
    expect((await c(b.cookie, 'POST', '/api/canteen/feedback', { clientKey: randomUUID(), kind: 'angry', content: '哼' })).status).toBe(400);
    for (let i = 0; i < 20; i++) expect((await c(b.cookie, 'POST', '/api/canteen/feedback', { clientKey: randomUUID(), kind: 'chat', content: `第 ${i + 1} 条` })).status).toBe(200);
    const over = await c(b.cookie, 'POST', '/api/canteen/feedback', { clientKey: randomUUID(), kind: 'chat', content: '第 21 条' });
    expect([over.status, over.body.error.code]).toEqual([422, 'FEEDBACK_DAILY_LIMIT']);
  });

  it('柚子信箱：没看过的排前面、按种类筛选；看过、回信（回信自动算看过），员工看得到回信', async () => {
    const list = await admin('GET', '/api/erp/canteen/feedback?kind=wish');
    expect(list.status).toBe(200);
    expect(list.body.rows.map((r: { content: string }) => r.content)).toEqual(['想在手机上看排班表']);
    expect(list.body.unread).toBe(22);
    expect((await admin('GET', '/api/erp/canteen/overview')).body.feedbackUnread).toBe(22);
    const wish = list.body.rows[0];
    expect(wish).toMatchObject({ name: '阿信', kind: 'wish', readAt: null });

    const read = await admin('POST', `/api/erp/canteen/feedback/${wish.id}/read`);
    expect([read.status, read.body.readByName]).toEqual([200, '测试店主']);
    const chat = (await admin('GET', '/api/erp/canteen/feedback?kind=chat&status=unread')).body.rows.find((r: { content: string }) => r.content === '今天的汤有点咸');
    const reply = await admin('POST', `/api/erp/canteen/feedback/${chat.id}/reply`, { clientKey: randomUUID(), reply: '收到！已经跟厨师说了，明天少放点盐～' });
    expect(reply.status).toBe(200);
    expect(reply.body.readAt).not.toBeNull();
    expect((await admin('POST', `/api/erp/canteen/feedback/${chat.id}/reply`, { clientKey: randomUUID(), reply: ' ' })).status).toBe(400);
    expect((await admin('POST', `/api/erp/canteen/feedback/${chat.id}/reply`, { reply: '没带操作编号' })).status).toBe(400);
    expect((await admin('GET', '/api/erp/canteen/feedback?status=replied')).body.rows).toHaveLength(1);
    const mine = (await c(a.cookie, 'GET', '/api/canteen/feedback')).body;
    expect(mine.find((r: { id: number }) => r.id === chat.id)).toMatchObject({ read: true, reply: '收到！已经跟厨师说了，明天少放点盐～' });
    expect(mine.find((r: { id: number }) => r.id === wish.id)).toMatchObject({ read: true, reply: null });
    expect((await admin('GET', '/api/erp/canteen/feedback')).body.unread).toBe(20);
    // 店员没有管理权限；员工端口上没有后台的接口
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/erp/canteen/feedback')).status).toBe(403);
    expect((await c(a.cookie, 'GET', '/api/erp/canteen/feedback')).status).toBe(404);
  });

  it('回信的结果待确认：同一个编号只记一次、晚到的旧请求不会把新回信改回去；能查回；作废以后原请求到了也不改', async () => {
    const row = (await admin('GET', '/api/erp/canteen/feedback?kind=wish')).body.rows[0];
    const k1 = randomUUID();
    const first = await admin('POST', `/api/erp/canteen/feedback/${row.id}/reply`, { clientKey: k1, reply: '排班表在排期里了' });
    expect([first.status, first.body.reply]).toEqual([200, '排班表在排期里了']);
    // 查回：按编号找得到，refId 是那一条
    expect((await admin('GET', `/api/erp/ops/${k1}?type=canteen_reply`)).body).toEqual({ found: true, abandoned: false, refId: row.id });
    // 之后改了回信；第一次那个编号原样重提（回复没收到时）只返回那一条，不会把回信改回去
    expect((await admin('POST', `/api/erp/canteen/feedback/${row.id}/reply`, { clientKey: randomUUID(), reply: '排班表下周上线' })).status).toBe(200);
    const replay = await admin('POST', `/api/erp/canteen/feedback/${row.id}/reply`, { clientKey: k1, reply: '排班表在排期里了' });
    expect([replay.status, replay.body.reply]).toEqual([200, '排班表下周上线']);
    // 同一个编号换了内容：拒绝
    const changed = await admin('POST', `/api/erp/canteen/feedback/${row.id}/reply`, { clientKey: k1, reply: '别的话' });
    expect([changed.status, changed.body.error.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    // 已经记上的不能作废：作废返回查回的结果
    expect((await admin('POST', `/api/erp/ops/${k1}/abandon`, { type: 'canteen_reply' })).body).toMatchObject({ found: true, abandoned: false });

    // 结果不明的那次先确认作废，原请求晚到了也不改回信
    const k2 = randomUUID();
    expect((await admin('GET', `/api/erp/ops/${k2}?type=canteen_reply`)).body).toEqual({ found: false, abandoned: false });
    expect((await admin('POST', `/api/erp/ops/${k2}/abandon`, { type: 'canteen_reply', summary: '回信给 阿信' })).body).toEqual({ found: false, abandoned: true });
    const late = await admin('POST', `/api/erp/canteen/feedback/${row.id}/reply`, { clientKey: k2, reply: '晚到的旧回信' });
    expect([late.status, late.body.error.code]).toEqual([409, 'OP_ABANDONED']);
    expect((await admin('GET', '/api/erp/canteen/feedback?kind=wish')).body.rows[0].reply).toBe('排班表下周上线');
    // 店员不能查回、作废这一类
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/erp/ops/${k1}?type=canteen_reply`)).status).toBe(403);
  });

  it('导出表格不截断；内容发出后不能改、不能删', async () => {
    const csv = await ctx.app.inject({ method: 'GET', url: '/api/erp/canteen/feedback.csv', headers: { cookie: ctx.owner } });
    expect(csv.statusCode).toBe(200);
    const lines = csv.body.replace(/^﻿/, '').trim().split(/\r?\n/);
    expect(lines[0]).toBe('时间,工号,名字,种类,内容,看过,回信,回信时间,回信人');
    expect(lines).toHaveLength(23);
    await expect(ctx.sql`UPDATE canteen_feedback SET content = '改了' WHERE employee_id = ${a.id}`).rejects.toThrow(/不能改/);
    await expect(ctx.sql`DELETE FROM canteen_feedback WHERE employee_id = ${a.id}`).rejects.toThrow(/禁止删除/);
  });
});
