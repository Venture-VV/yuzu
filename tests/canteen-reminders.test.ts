// 员工食堂 · 饭点提醒（店主 2026-11-10，docs/CANTEEN.md 第 19 节，K23、K24，迁移 120）：
//   · 员工在手机上打开提醒：推送地址只认浏览器推送服务的（测试另认本机的模拟服务）、钥匙要对；同一台手机换人登录后改到新的人名下；
//     一个人最多 5 台；关掉、退出登录只停自己名下的；自己选哪几顿不要；
//   · 后台的设置：默认话术、整份保存带 rev（对不上拒绝）、开着的要有标题和话、记审计；
//   · 到点发：开饭前不发；到点后 30 分钟之内发一次；自己关了这一顿、已经打过卡、停用的不发；{名字}{菜单}换好；同一顿不重发；
//     推送服务说订阅没了的停用、别的失败记原因；进程中断后接着发没发过的；模块关了、提醒关了、这一顿没开饭都不发；
//   · 发一条试试：员工给自己、后台给某位员工；连点挡下；没开提醒的说清楚；后台看得到今天发了没有、谁开着、没送到的原因。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCanteenApp } from '../src/server/modules/canteen/portal';
import { runCanteenReminders } from '../src/server/modules/canteen/push';
import { buildApp } from '../src/server/app';
import { runMinuteJobs } from '../src/server/jobs';
import type { AppConfig } from '../src/server/config';
import { api, setup, type TestContext } from './helpers';
import { fakePhone, mockPushService } from './push-helpers';

const SECRET = 'canteen-reminders-test-secret-0123456789abcdef-01';

let ctx: TestContext;
let canteen: FastifyInstance;
let config: AppConfig;
let push: Awaited<ReturnType<typeof mockPushService>>;

async function c<T = any>(cookie: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await canteen.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.headers['content-type']?.toString().includes('json') ? res.json() : res.body;
  return { status: res.statusCode, body: body as T };
}
/** 员工后台：与员工端口同一份配置（认本机的模拟推送服务），用店主登录 */
let main: FastifyInstance;
const admin = <T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => api<T>(main, ctx.owner, method, url, payload);

async function hire(empNo: string, name: string, role: 'staff' | 'cook' | 'manager' = 'staff', departmentId: number | null = null) {
  const made = await admin('POST', '/api/erp/canteen/employees', { empNo, name, role, departmentId });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const id = made.body.employee.id as number;
  const card = (await admin('GET', `/api/erp/canteen/activation-cards?ids=${id}`)).body[0];
  const res = await canteen.inject({ method: 'POST', url: '/api/canteen/join', payload: { code: card.code, password: 'Fan-tang-2026' } });
  expect(res.statusCode, res.body).toBe(200);
  const sid = res.cookies.find((k) => k.name === 'yuzu_canteen_sid')!.value;
  return { id, name, cookie: `yuzu_canteen_sid=${sid}` };
}
type Person = Awaited<ReturnType<typeof hire>>;

/** 一台假手机打开提醒（推送地址在模拟推送服务上，路径带名字好认） */
async function subscribe(who: Person, label: string, platform: 'ios' | 'android' | 'other' = 'ios') {
  const phone = fakePhone();
  const endpoint = `${push.base}/push/${label}`;
  const r = await c(who.cookie, 'PUT', '/api/canteen/push/subscription', { endpoint, keys: { p256dh: phone.p256dh, auth: phone.auth }, platform }, { origin: 'https://staff.example.com', host: 'staff.example.com' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { ...phone, endpoint, path: `/push/${label}` };
}
type Phone = Awaited<ReturnType<typeof subscribe>>;

/** 门店时区（上海）某天某时刻 */
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+08:00`);

async function checkin(who: Person, date: string, meal: string, recorder: Person) {
  await ctx.sql`
    INSERT INTO canteen_checkins (employee_id, emp_no, employee_name, meal_date, meal, method, scanned_at, recorder_id, recorder_name, client_key)
    SELECT id, emp_no, name, ${date}, ${meal}, 'manual', now(), ${recorder.id}, '负责人', ${randomUUID()} FROM canteen_employees WHERE id = ${who.id}`;
}

async function publishMenu(date: string, meal: string, dishes: string[], by: Person) {
  await ctx.sql`
    INSERT INTO canteen_menus (menu_date, meal, dishes, published, published_at, updated_by)
    VALUES (${date}, ${meal}, ${ctx.sql.json(dishes.map((name, i) => ({ id: `d${i}`, name, emoji: '🍚', tags: [] })) as never)}, true, now(), ${by.id})
    ON CONFLICT (menu_date, meal) DO UPDATE SET dishes = EXCLUDED.dishes, published = true`;
}

/** 后台整份保存提醒设置（patch 改其中几顿） */
async function saveReminders(patch: Record<string, Record<string, unknown>>) {
  const cur = (await admin('GET', '/api/erp/canteen/reminders')).body.settings;
  const next = { rev: cur.rev, reminders: cur.reminders.map((r: { meal: string }) => ({ ...r, ...(patch[r.meal] ?? {}) })) };
  const r = await admin('PUT', '/api/erp/canteen/reminders', next);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

let dept: number;
let boss: Person;
let lin: Person;
let zhou: Person;
let wang: Person;
let chen: Person;
/** 到点发的用例里开的手机（后面试发、后台的用例接着用） */
let linPhone: Phone;
let linPad: Phone;
let wangPhone: Phone;
let zhouPhone: Phone;
let chenPhone: Phone;

beforeAll(async () => {
  ctx = await setup();
  push = await mockPushService();
  config = {
    ...ctx.config,
    canteen: { port: null, host: '127.0.0.1', codeSecret: SECRET, cookieSecure: false, trustProxy: [], pushLocalEndpoints: true, pushContact: null },
  };
  canteen = await buildCanteenApp(ctx.sql, config, { openCacheMs: 0 });
  main = await buildApp(ctx.sql, config);
  expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: true } })).status).toBe(200);
  dept = (await admin('POST', '/api/erp/canteen/department', {})).body.departmentId;
  boss = await hire('M201', '陈姐', 'manager', dept);
  lin = await hire('E201', '小林');
  zhou = await hire('E202', '小周');
  wang = await hire('E203', '老王');
  chen = await hire('E204', '阿陈');
});

afterAll(async () => {
  await canteen?.close();
  await main?.close();
  await push?.close();
  await ctx?.close();
});

describe('员工在手机上打开饭点提醒', () => {
  it('推送地址只认浏览器推送服务的，钥匙要对；打开以后这个人名下多一台；只在员工端口上', async () => {
    const info = await c(lin.cookie, 'GET', '/api/canteen/push');
    expect(info.status).toBe(200);
    expect(info.body.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    // 默认：午餐、晚餐开饭时提醒（K23）
    expect(info.body.meals).toEqual([
      { meal: 'lunch', time: '10:30' },
      { meal: 'dinner', time: '16:30' },
    ]);
    expect(info.body).toMatchObject({ muted: [], devices: 0 });
    expect((await c(null, 'GET', '/api/canteen/push')).status).toBe(401);
    // 主端口上没有员工端的接口
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/canteen/push')).status).toBe(404);

    const phone = fakePhone();
    const put = (endpoint: string, keys = { p256dh: phone.p256dh, auth: phone.auth }) => c(lin.cookie, 'PUT', '/api/canteen/push/subscription', { endpoint, keys, platform: 'android' });
    for (const bad of ['https://evil.example.com/push/x', 'http://10.0.0.8/push', 'https://100.100.100.200/latest/meta-data', 'http://192.168.1.2:9000/push']) {
      const r = await put(bad);
      expect(r.status, bad).toBe(422);
      expect(r.body.error.code).toBe('PUSH_ENDPOINT');
    }
    const badKeys = await put(`${push.base}/push/lin-bad`, { p256dh: 'AAAA', auth: phone.auth });
    expect(badKeys.status).toBe(422);
    expect(badKeys.body.error.code).toBe('PUSH_KEYS');
    expect((await c(lin.cookie, 'PUT', '/api/canteen/push/subscription', { endpoint: `${push.base}/push/x` })).status).toBe(400);

    const ok = await put(`${push.base}/push/lin-1`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.devices).toBe(1);
    // 同一台手机再核对一遍：还是一台
    expect((await put(`${push.base}/push/lin-1`)).body.devices).toBe(1);
    const [row] = await ctx.sql<{ employeeId: number; platform: string; disabledAt: Date | null }[]>`
      SELECT employee_id, platform, disabled_at FROM canteen_push_subscriptions WHERE endpoint = ${`${push.base}/push/lin-1`}`;
    expect(row).toMatchObject({ employeeId: lin.id, platform: 'android', disabledAt: null });
  });

  it('同一台手机换人登录后打开：改到新的人名下；一个人最多 5 台，多了停用最早的', async () => {
    const phone = fakePhone();
    const endpoint = `${push.base}/push/shared`;
    const body = { endpoint, keys: { p256dh: phone.p256dh, auth: phone.auth } };
    expect((await c(zhou.cookie, 'PUT', '/api/canteen/push/subscription', body)).body.devices).toBe(1);
    expect((await c(wang.cookie, 'PUT', '/api/canteen/push/subscription', body)).body.devices).toBe(1);
    expect((await c(zhou.cookie, 'GET', '/api/canteen/push')).body.devices).toBe(0);

    for (let i = 1; i <= 6; i++) await subscribe(chen, `chen-${i}`);
    expect((await c(chen.cookie, 'GET', '/api/canteen/push')).body.devices).toBe(5);
    const rows = await ctx.sql<{ endpoint: string; disabledReason: string | null }[]>`
      SELECT endpoint, disabled_reason FROM canteen_push_subscriptions WHERE employee_id = ${chen.id} ORDER BY id`;
    expect(rows.map((r) => r.disabledReason)).toEqual(['off', null, null, null, null, null]);
    // 收拾干净：阿陈的手机都关掉，后面的用例只看自己开的
    for (const r of rows) await c(chen.cookie, 'POST', '/api/canteen/push/off', { endpoint: r.endpoint });
    expect((await c(chen.cookie, 'GET', '/api/canteen/push')).body.devices).toBe(0);

    await c(wang.cookie, 'POST', '/api/canteen/push/off', { endpoint });
  });

  it('不停换新的推送地址：一个人一天最多记 20 个；已经记过的地址照样能再打开', async () => {
    const du = await hire('E209', '小杜');
    for (let i = 1; i <= 20; i++) await subscribe(du, `du-${i}`);
    const extra = fakePhone();
    const tooMany = await c(du.cookie, 'PUT', '/api/canteen/push/subscription', { endpoint: `${push.base}/push/du-21`, keys: { p256dh: extra.p256dh, auth: extra.auth } });
    expect(tooMany.status).toBe(429);
    expect(tooMany.body.error.code).toBe('PUSH_TOO_MANY');
    const again = await c(du.cookie, 'PUT', '/api/canteen/push/subscription', { endpoint: `${push.base}/push/du-1`, keys: { p256dh: extra.p256dh, auth: extra.auth } });
    expect(again.status).toBe(200);
    // 收拾干净：小杜停用，后面的用例不发给他
    const row = (await admin('GET', '/api/erp/canteen/employees')).body.find((e: { id: number }) => e.id === du.id);
    expect((await admin('PUT', `/api/erp/canteen/employees/${du.id}`, { ...row, active: false })).status).toBe(200);
  });

  it('关掉、退出登录只停自己名下的；自己选哪几顿不要', async () => {
    const mine = await subscribe(zhou, 'zhou-tmp');
    // 别人关不掉我的
    await c(lin.cookie, 'POST', '/api/canteen/push/off', { endpoint: mine.endpoint });
    expect((await c(zhou.cookie, 'GET', '/api/canteen/push')).body.devices).toBe(1);
    const off = await c(zhou.cookie, 'POST', '/api/canteen/push/off', { endpoint: mine.endpoint, reason: 'logout' });
    expect(off.body.devices).toBe(0);
    const [row] = await ctx.sql<{ disabledReason: string }[]>`SELECT disabled_reason FROM canteen_push_subscriptions WHERE endpoint = ${mine.endpoint}`;
    expect(row!.disabledReason).toBe('logout');

    const muted = await c(zhou.cookie, 'PUT', '/api/canteen/push/muted', { muted: ['dinner', 'lunch', 'dinner'] });
    expect(muted.status).toBe(200);
    expect(muted.body.muted).toEqual(['lunch', 'dinner']);
    expect((await c(zhou.cookie, 'PUT', '/api/canteen/push/muted', { muted: ['brunch'] })).status).toBe(400);
    expect((await c(zhou.cookie, 'PUT', '/api/canteen/push/muted', { muted: ['dinner'] })).body.muted).toEqual(['dinner']);
  });
});

describe('后台：提醒的设置', () => {
  it('默认话术；整份保存带 rev，对不上拒绝；开着的要有标题和话、时间写成 HH:MM；记审计', async () => {
    const view = await admin('GET', '/api/erp/canteen/reminders');
    expect(view.status).toBe(200);
    const lunch = view.body.settings.reminders.find((r: { meal: string }) => r.meal === 'lunch');
    expect(lunch).toMatchObject({ enabled: true, time: null, title: '柚子喊你吃午饭啦 🍱', open: 'code' });
    expect(lunch.lines[0]).toBe('午饭时间到！饭堂开饭啦，柚子已经闻到饭香了～记得亮饭卡码哦');
    expect(view.body.settings.reminders.map((r: { enabled: boolean }) => r.enabled)).toEqual([false, true, true, false]);
    expect(view.body.settings.rev).toBe(0);

    const rev0 = view.body.settings;
    const edit = (patch: Record<string, unknown>, rev = rev0.rev) => ({
      rev,
      reminders: rev0.reminders.map((r: { meal: string }) => (r.meal === 'lunch' ? { ...r, ...patch } : r)),
    });
    expect((await admin('PUT', '/api/erp/canteen/reminders', edit({ lines: ['  ', ''] }))).status).toBe(400);
    expect((await admin('PUT', '/api/erp/canteen/reminders', edit({ title: '   ' }))).status).toBe(400);
    expect((await admin('PUT', '/api/erp/canteen/reminders', edit({ time: '25:00' }))).status).toBe(400);
    expect((await admin('PUT', '/api/erp/canteen/reminders', edit({ lines: ['长'.repeat(81)] }))).status).toBe(400);
    expect((await admin('PUT', '/api/erp/canteen/reminders', edit({ open: 'kitchen' }))).status).toBe(400);
    // 关着的可以不写话
    const saved = await admin('PUT', '/api/erp/canteen/reminders', {
      rev: 0,
      reminders: rev0.reminders.map((r: { meal: string }) =>
        r.meal === 'lunch' ? { ...r, time: '11:30', lines: ['  {名字}，午饭啦！今天有{菜单}  ', '', '午饭时间到！'] } : r.meal === 'supper' ? { ...r, lines: [] } : r,
      ),
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.settings.rev).toBe(1);
    expect(saved.body.settings.reminders.find((r: { meal: string }) => r.meal === 'lunch')).toMatchObject({ time: '11:30', lines: ['{名字}，午饭啦！今天有{菜单}', '午饭时间到！'] });
    // 拿着旧的 rev 再存：别人刚改过
    const stale = await admin('PUT', '/api/erp/canteen/reminders', edit({ time: '12:00' }, 0));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('REMINDERS_CHANGED');
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'settings_updated' AND detail->>'key' = 'canteen_reminders'`;
    expect(audit!.n).toBe(1);
    // 员工端跟着变：午餐 11:30
    expect((await c(lin.cookie, 'GET', '/api/canteen/push')).body.meals).toEqual([
      { meal: 'lunch', time: '11:30' },
      { meal: 'dinner', time: '16:30' },
    ]);
  });
});

describe('到点发饭点提醒', () => {
  const day = '2026-11-12';

  it('开饭前不发；到点发给开着提醒的人：自己关了这一顿、已经打过卡、停用的不发；{名字}{菜单}换好；同一顿只发一次', async () => {
    // 前面的用例里小林开着 lin-1：关掉，换两台新的
    await c(lin.cookie, 'POST', '/api/canteen/push/off', { endpoint: `${push.base}/push/lin-1` });
    linPhone = await subscribe(lin, 'lin-phone', 'ios');
    linPad = await subscribe(lin, 'lin-pad', 'other');
    wangPhone = await subscribe(wang, 'wang-phone', 'android');
    zhouPhone = await subscribe(zhou, 'zhou-phone', 'android');
    chenPhone = await subscribe(chen, 'chen-phone', 'ios');
    // 小周关了午餐的提醒；老王已经打过午餐的卡；阿陈停用了
    await c(zhou.cookie, 'PUT', '/api/canteen/push/muted', { muted: ['lunch'] });
    await checkin(wang, day, 'lunch', boss);
    const chenRow = (await admin('GET', '/api/erp/canteen/employees')).body.find((e: { id: number }) => e.id === chen.id);
    expect((await admin('PUT', `/api/erp/canteen/employees/${chen.id}`, { ...chenRow, departmentId: chenRow.departmentId, active: false, version: chenRow.version })).status).toBe(200);
    await publishMenu(day, 'lunch', ['红烧肉', '番茄炒蛋', '清炒时蔬', '紫菜蛋花汤'], boss);

    push.hits.length = 0;
    expect(await runCanteenReminders({ sql: ctx.sql, config }, at(day, '11:29'))).toEqual([]);
    expect(push.hits).toHaveLength(0);

    const sent = await runCanteenReminders({ sql: ctx.sql, config }, at(day, '11:30'));
    expect(sent).toEqual([{ meal: 'lunch', date: day, sent: 2, failed: 0, skippedCheckedIn: 1 }]);
    expect(push.hits.map((h) => h.path).sort()).toEqual([linPad.path, linPhone.path].sort());
    for (const hit of push.hits) {
      const phone = hit.path === linPhone.path ? linPhone : linPad;
      const msg = JSON.parse(phone.open(hit.body));
      // 2026-11-12 轮到第二句：{名字}{菜单}换好；菜多了写「等 4 道菜」
      expect(msg).toEqual({ v: 1, title: '柚子喊你吃午饭啦 🍱', body: '午饭时间到！', tag: 'meal-lunch', url: '/#/code', badge: 1 });
      expect(hit.headers.ttl).toBe('1800');
      expect(hit.headers.urgency).toBe('high');
      expect(hit.headers.topic).toBe('meal-lunch');
      const claims = JSON.parse(Buffer.from(String(hit.headers.authorization).split('.')[1]!, 'base64url').toString());
      expect(claims.sub).toBe('https://staff.example.com');
    }
    // 小周关了午餐、老王打过卡、阿陈停用：都没收到
    for (const p of [zhouPhone, wangPhone, chenPhone]) expect(push.hits.some((h) => h.path === p.path)).toBe(false);

    // 同一分钟、下一分钟再跑：不重发
    push.hits.length = 0;
    expect(await runCanteenReminders({ sql: ctx.sql, config }, at(day, '11:30'))).toEqual([]);
    expect(await runCanteenReminders({ sql: ctx.sql, config }, at(day, '11:45'))).toEqual([]);
    expect(push.hits).toHaveLength(0);
    // 发送记录：每台手机一行
    const rows = await ctx.sql<{ status: string }[]>`
      SELECT d.status FROM canteen_reminder_deliveries d JOIN canteen_reminder_runs r ON r.id = d.run_id WHERE r.meal_date = ${day} AND r.meal = 'lunch'`;
    expect(rows.map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('{名字}、{菜单}：轮到带它们的那句时换成真的；没发布菜单的那天不用带 {菜单} 的句子', async () => {
    // 2026-11-13 轮到第一句「{名字}，午饭啦！今天有{菜单}」
    const next = '2026-11-13';
    await publishMenu(next, 'lunch', ['红烧肉', '番茄炒蛋', '清炒时蔬', '紫菜蛋花汤'], boss);
    push.hits.length = 0;
    const sent = await runCanteenReminders({ sql: ctx.sql, config }, at(next, '11:40'));
    expect(sent).toEqual([{ meal: 'lunch', date: next, sent: 3, failed: 0, skippedCheckedIn: 0 }]);
    const linHit = push.hits.find((h) => h.path === linPhone.path)!;
    expect(JSON.parse(linPhone.open(linHit.body)).body).toBe('小林，午饭啦！今天有红烧肉、番茄炒蛋、清炒时蔬等 4 道菜');
    const wangHit = push.hits.find((h) => h.path === wangPhone.path)!;
    expect(JSON.parse(wangPhone.open(wangHit.body)).body).toBe('老王，午饭啦！今天有红烧肉、番茄炒蛋、清炒时蔬等 4 道菜');

    // 2026-11-15 也轮到第一句，但没发布菜单：用不带 {菜单} 的「午饭时间到！」
    push.hits.length = 0;
    await runCanteenReminders({ sql: ctx.sql, config }, at('2026-11-15', '11:30'));
    expect(JSON.parse(linPhone.open(push.hits.find((h) => h.path === linPhone.path)!.body)).body).toBe('午饭时间到！');
  });

  it('过了到点 30 分钟不再补发（应用停过）；模块关了、提醒关了、这一顿没开饭都不发', async () => {
    push.hits.length = 0;
    expect(await runCanteenReminders({ sql: ctx.sql, config }, at('2026-11-16', '12:00'))).toEqual([]);
    expect(await runCanteenReminders({ sql: ctx.sql, config }, at('2026-11-16', '15:00'))).toEqual([]);

    // 晚餐 16:30（开饭时）：模块关了不发
    expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: false } })).status).toBe(200);
    expect(await runCanteenReminders({ sql: ctx.sql, config }, at('2026-11-16', '16:30'))).toEqual([]);
    expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: true } })).status).toBe(200);
    // 提醒关了不发
    await saveReminders({ dinner: { enabled: false } });
    expect(await runCanteenReminders({ sql: ctx.sql, config }, at('2026-11-16', '16:31'))).toEqual([]);
    await saveReminders({ dinner: { enabled: true } });
    // 晚餐没开饭不发
    const s = (await admin('GET', '/api/erp/canteen/settings')).body;
    await admin('PUT', '/api/erp/canteen/settings', { ...s, meals: s.meals.map((m: { meal: string }) => (m.meal === 'dinner' ? { ...m, enabled: false } : m)) });
    expect(await runCanteenReminders({ sql: ctx.sql, config }, at('2026-11-16', '16:32'))).toEqual([]);
    await admin('PUT', '/api/erp/canteen/settings', s);
    expect(push.hits).toHaveLength(0);
    // 开回来、还在 30 分钟之内：照发
    const sent = await runCanteenReminders({ sql: ctx.sql, config }, at('2026-11-16', '16:33'));
    expect(sent.map((r) => r.meal)).toEqual(['dinner']);
    expect(push.hits.length).toBeGreaterThan(0);
  });

  it('推送服务说订阅没了：停用这台；别的失败记原因、这台照样留着；每分钟的自动任务里也会发', async () => {
    push.statusFor.set(linPad.path, 410);
    push.statusFor.set(wangPhone.path, 503);
    push.hits.length = 0;
    const logs: string[] = [];
    await runMinuteJobs({ sql: ctx.sql, config }, { info: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) }, { now: at('2026-11-17', '11:30'), birthday: false });
    expect(logs.find((l) => l.startsWith('饭点提醒'))).toBe('饭点提醒（2026-11-17 午餐）：送到 1 台手机、2 台没送到');
    const rows = await ctx.sql<{ endpoint: string; disabledReason: string | null; failures: number; lastError: string | null }[]>`
      SELECT endpoint, disabled_reason, failures, last_error FROM canteen_push_subscriptions WHERE endpoint IN (${linPad.endpoint}, ${wangPhone.endpoint}, ${linPhone.endpoint})`;
    const by = (e: string) => rows.find((r) => r.endpoint === e)!;
    expect(by(linPad.endpoint)).toMatchObject({ disabledReason: 'gone', failures: 1 });
    expect(by(wangPhone.endpoint)).toMatchObject({ disabledReason: null, failures: 1 });
    expect(by(wangPhone.endpoint).lastError).toContain('503');
    expect(by(linPhone.endpoint)).toMatchObject({ disabledReason: null, failures: 0, lastError: null });
    for (const r of rows) expect(r.lastError ?? '').not.toContain(push.base);
    push.statusFor.clear();
    // 后台：没送到的原因（停用的那台也列出来）
    const view = (await admin('GET', '/api/erp/canteen/reminders')).body;
    expect(view.failures.map((f: { name: string }) => f.name).sort()).toEqual(['小林', '老王']);
  });

  it('进程在发送中断了：租约过期以后接着发没发过的手机，发过的（结果不明的也算）不再发', async () => {
    const d = '2026-11-18';
    const [run] = await ctx.sql<{ id: number }[]>`
      INSERT INTO canteen_reminder_runs (meal_date, meal, due_at, title, line, open_page, lease_until)
      VALUES (${d}, 'lunch', ${at(d, '11:30')}, '柚子喊你吃午饭啦 🍱', '午饭时间到！', 'code', now() + interval '5 minutes')
      RETURNING id`;
    const [linSub] = await ctx.sql<{ id: number }[]>`SELECT id FROM canteen_push_subscriptions WHERE endpoint = ${linPhone.endpoint}`;
    await ctx.sql`INSERT INTO canteen_reminder_deliveries (run_id, subscription_id, employee_id) VALUES (${run!.id}, ${linSub!.id}, ${lin.id})`;
    push.hits.length = 0;
    // 租约还没过期：别的进程正在发，不插手
    expect(await runCanteenReminders({ sql: ctx.sql, config }, at(d, '11:33'))).toEqual([]);
    expect(push.hits).toHaveLength(0);
    await ctx.sql`UPDATE canteen_reminder_runs SET lease_until = now() - interval '1 second' WHERE id = ${run!.id}`;
    const resumed = await runCanteenReminders({ sql: ctx.sql, config }, at(d, '11:34'));
    expect(resumed).toHaveLength(1);
    expect(push.hits.map((h) => h.path)).toEqual([wangPhone.path]);
    const [after] = await ctx.sql<{ status: string; sent: number }[]>`SELECT status, sent FROM canteen_reminder_runs WHERE id = ${run!.id}`;
    // 中断前记下的那台结果不明：不算送到、也不重发
    expect(after).toMatchObject({ status: 'done', sent: 1 });
  });
});

describe('发一条试试、后台看提醒的情况', () => {
  it('员工给自己的手机发：柚子的问候；连点挡下；没开提醒的说清楚', async () => {
    const mine = await subscribe(zhou, 'zhou-test', 'android');
    push.hits.length = 0;
    const r = await c(zhou.cookie, 'POST', '/api/canteen/push/test', {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ devices: 2, sent: 2, errors: [] });
    const hit = push.hits.find((h) => h.path === mine.path)!;
    expect(JSON.parse(mine.open(hit.body))).toMatchObject({ title: '柚子来试试嗓子 🍊', body: '小周，饭点提醒打开啦！到了开饭时间，柚子就在这里喊你吃饭～', url: '/#/home' });
    const again = await c(zhou.cookie, 'POST', '/api/canteen/push/test', {});
    expect(again.status).toBe(429);
    const nobody = await c(boss.cookie, 'POST', '/api/canteen/push/test', {});
    expect(nobody.status).toBe(422);
    expect(nobody.body.error.code).toBe('PUSH_NO_DEVICE');
  });

  it('后台给某位员工发这一顿今天的提醒（标题写试发）；停用的、不存在的拒绝', async () => {
    push.hits.length = 0;
    const r = await admin('POST', '/api/erp/canteen/reminders/test', { employeeId: lin.id, meal: 'dinner' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ devices: 1, sent: 1 });
    const msg = JSON.parse(linPhone.open(push.hits[0]!.body));
    expect(msg.title).toBe('（试发）柚子喊你吃晚饭啦 🍲');
    expect(msg.url).toBe('/#/code');
    expect((await admin('POST', '/api/erp/canteen/reminders/test', { employeeId: chen.id, meal: null })).status).toBe(422);
    expect((await admin('POST', '/api/erp/canteen/reminders/test', { employeeId: 999999, meal: null })).status).toBe(404);
    expect((await admin('POST', '/api/erp/canteen/reminders/test', { meal: 'lunch' })).status).toBe(400);
  });

  it('后台看得到：开着提醒的人与手机（停用的人不算）、今天每顿发了没有', async () => {
    const view = await admin('GET', '/api/erp/canteen/reminders');
    expect(view.status).toBe(200);
    // 小林（lin-phone）、老王、小周（zhou-phone、zhou-test）；阿陈停用了不算
    expect(view.body.people).toBe(3);
    expect(view.body.devices).toEqual({ total: 4, ios: 1, android: 3, other: 0 });
    expect(view.body.recipients.map((p: { name: string; devices: number }) => [p.name, p.devices])).toEqual([
      ['小周', 2],
      ['小林', 1],
      ['老王', 1],
    ]);
    expect(view.body.recipients.find((p: { name: string }) => p.name === '小周').muted).toEqual(['lunch']);
    expect(view.body.runs.map((r: { meal: string; state: string }) => [r.meal, r.state])).toEqual([
      ['breakfast', 'off'],
      ['lunch', expect.any(String)],
      ['dinner', expect.any(String)],
      ['supper', 'off'],
    ]);
  });
});
