// 员工食堂 · 柚子信箱交给食堂负责人在手机上看、回信（店主 2026-11-10，docs/CANTEEN.md 第 18 节，K20，迁移 096）：
//   · 只有负责人能看（普通员工、厨师 403；没登录 401；改成普通员工以后马上看不了）；
//   · 与后台同一份信箱：负责人看过、回信，后台写「某某（食堂负责人）」；员工看到的照旧是「柚子回信」；
//   · 看过的人记第一次看过的那位（负责人、管理员谁先都行），回信的人记最后一次回信的那位；
//   · 回信带操作编号：同一个编号重发只返回那一条、不再改一遍（晚到的旧请求不会把之后的回信改回去），换了内容拒绝，同时交两次只记一次；
//   · 操作编号表只追加。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCanteenApp } from '../src/server/modules/canteen/portal';
import { api, setup, type TestContext } from './helpers';

const SECRET = 'canteen-mailbox-test-secret-0123456789abcdef-0123';

let ctx: TestContext;
let canteen: FastifyInstance;

async function c<T = any>(cookie: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await canteen.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.headers['content-type']?.toString().includes('json') ? res.json() : res.body;
  return { status: res.statusCode, body: body as T };
}

const admin = <T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => api<T>(ctx.app, ctx.owner, method, url, payload);

/** 加一位员工并用开通码开通，返回会话 Cookie 与编号 */
async function hire(empNo: string, name: string, role: 'staff' | 'cook' | 'manager', departmentId: number | null) {
  const made = await admin('POST', '/api/erp/canteen/employees', { empNo, name, role, departmentId });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const id = made.body.employee.id as number;
  const card = (await admin('GET', `/api/erp/canteen/activation-cards?ids=${id}`)).body[0];
  const res = await canteen.inject({ method: 'POST', url: '/api/canteen/join', payload: { code: card.code, password: 'Fan-tang-2026' } });
  expect(res.statusCode, res.body).toBe(200);
  const sid = res.cookies.find((k) => k.name === 'yuzu_canteen_sid')!.value;
  return { id, name, cookie: `yuzu_canteen_sid=${sid}` };
}

let dept: number;
let worker: Awaited<ReturnType<typeof hire>>;
let cook: Awaited<ReturnType<typeof hire>>;
let boss: Awaited<ReturnType<typeof hire>>;
let boss2: Awaited<ReturnType<typeof hire>>;

/** 员工跟柚子说一句，返回那一条的编号 */
async function say(content: string, kind: 'wish' | 'chat' = 'chat') {
  const r = await c(worker.cookie, 'POST', '/api/canteen/feedback', { clientKey: randomUUID(), kind, content });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id as number;
}
const reply = (who: { cookie: string }, id: number, text: string, clientKey = randomUUID()) =>
  c(who.cookie, 'POST', `/api/canteen/mailbox/${id}/reply`, { clientKey, reply: text });
const adminRow = async (id: number) => (await admin('GET', '/api/erp/canteen/feedback')).body.rows.find((r: { id: number }) => r.id === id);
const dbRow = async (id: number) =>
  (
    await ctx.sql<{ readBy: number | null; readByEmployee: number | null; repliedBy: number | null; repliedByEmployee: number | null; reply: string | null }[]>`
      SELECT read_by, read_by_employee, replied_by, replied_by_employee, reply FROM canteen_feedback WHERE id = ${id}`
  )[0]!;

beforeAll(async () => {
  ctx = await setup();
  const config = { ...ctx.config, canteen: { port: null, host: '127.0.0.1', codeSecret: SECRET, cookieSecure: false, trustProxy: [] } };
  canteen = await buildCanteenApp(ctx.sql, config, { openCacheMs: 0 });
  expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: true } })).status).toBe(200);
  dept = (await admin('POST', '/api/erp/canteen/department', {})).body.departmentId;
  worker = await hire('E101', '小林', 'staff', null);
  cook = await hire('C101', '王厨', 'cook', dept);
  boss = await hire('M101', '陈姐', 'manager', dept);
  boss2 = await hire('M102', '刘哥', 'manager', dept);
});

afterAll(async () => {
  await canteen?.close();
  await ctx?.close();
});

describe('柚子信箱：只有食堂负责人能在手机上看', () => {
  it('普通员工、厨师 403，没登录 401；负责人能看，没看过的排前面、能按看过没有筛选', async () => {
    const first = await say('红烧肉太好吃了');
    const second = await say('想在手机上看排班表', 'wish');
    for (const who of [worker, cook]) {
      const r = await c(who.cookie, 'GET', '/api/canteen/mailbox');
      expect([r.status, r.body.error.code]).toEqual([403, 'FORBIDDEN']);
      expect((await reply(who, first, '收到')).status).toBe(403);
      expect((await c(who.cookie, 'POST', `/api/canteen/mailbox/${first}/read`)).status).toBe(403);
    }
    expect((await c(null, 'GET', '/api/canteen/mailbox')).status).toBe(401);

    const list = await c(boss.cookie, 'GET', '/api/canteen/mailbox');
    expect(list.status).toBe(200);
    expect(list.body.rows.map((r: { id: number }) => r.id).slice(0, 2)).toEqual([second, first]);
    expect(list.body.rows[0]).toMatchObject({ name: '小林', empNo: 'E101', kind: 'wish', content: '想在手机上看排班表', readAt: null, reply: null });
    expect((await c(boss.cookie, 'GET', '/api/canteen/mailbox/unread')).body).toEqual({ unread: list.body.unread });
    expect(list.body.unread).toBeGreaterThanOrEqual(2);

    // 筛选与后台同一套
    await c(boss.cookie, 'POST', `/api/canteen/mailbox/${first}/read`);
    const unread = await c(boss.cookie, 'GET', '/api/canteen/mailbox?status=unread');
    expect(unread.body.rows.map((r: { id: number }) => r.id)).toContain(second);
    expect(unread.body.rows.map((r: { id: number }) => r.id)).not.toContain(first);
    const wishes = await c(boss.cookie, 'GET', '/api/canteen/mailbox?kind=wish');
    expect(wishes.body.rows.every((r: { kind: string }) => r.kind === 'wish')).toBe(true);
  });
});

describe('看过与回信', () => {
  it('负责人标看过：后台写「陈姐（食堂负责人）看过」；再点、管理员再点都不变（记第一次看过的那位）', async () => {
    const id = await say('今天的汤有点咸');
    const read = await c(boss.cookie, 'POST', `/api/canteen/mailbox/${id}/read`);
    expect([read.status, read.body.readByName]).toEqual([200, '陈姐（食堂负责人）']);
    const again = await c(boss2.cookie, 'POST', `/api/canteen/mailbox/${id}/read`);
    expect([again.body.readAt, again.body.readByName]).toEqual([read.body.readAt, '陈姐（食堂负责人）']);
    expect((await admin('POST', `/api/erp/canteen/feedback/${id}/read`)).body.readByName).toBe('陈姐（食堂负责人）');
    expect(await dbRow(id)).toMatchObject({ readBy: null, readByEmployee: boss.id });
    expect((await adminRow(id)).readByName).toBe('陈姐（食堂负责人）');
  });

  it('负责人回信：员工在「我说过的」里看到；后台写是哪位负责人回的；回信也算看过；审计记下是哪位负责人', async () => {
    const id = await say('想吃酸菜鱼', 'wish');
    const r = await reply(boss, id, '收到啦，下周三安排上！');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id, reply: '收到啦，下周三安排上！', repliedByName: '陈姐（食堂负责人）', readByName: '陈姐（食堂负责人）' });
    expect(r.body.readAt).not.toBeNull();

    const mine = (await c(worker.cookie, 'GET', '/api/canteen/feedback')).body.find((x: { id: number }) => x.id === id);
    expect(mine).toMatchObject({ read: true, reply: '收到啦，下周三安排上！' });
    expect((await adminRow(id)).repliedByName).toBe('陈姐（食堂负责人）');
    expect(await dbRow(id)).toMatchObject({ repliedBy: null, repliedByEmployee: boss.id, readByEmployee: boss.id });

    const audits = await ctx.sql<{ staffId: number | null; detail: Record<string, unknown> }[]>`
      SELECT staff_id, detail FROM audit_logs WHERE action = 'canteen_feedback' AND target_id = ${String(id)}`;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ staffId: null, detail: { op: 'reply', before: null, after: '收到啦，下周三安排上！', by: 'canteen_manager', employeeId: boss.id, employeeName: '陈姐' } });
  });

  it('管理员先看过、负责人再回信：看过的人还是管理员；回信的人是最后回信的那位（另一边清空）', async () => {
    const id = await say('饭堂的空调有点冷');
    await admin('POST', `/api/erp/canteen/feedback/${id}/read`);
    const byBoss = await reply(boss, id, '已经调高两度');
    expect([byBoss.status, byBoss.body.readByName, byBoss.body.repliedByName]).toEqual([200, '测试店主', '陈姐（食堂负责人）']);
    expect(await dbRow(id)).toMatchObject({ readBy: ctx.ownerId, readByEmployee: null, repliedBy: null, repliedByEmployee: boss.id });

    // 管理员在后台改回信：回信的人换成管理员，负责人那一列清空
    const byAdmin = await admin('POST', `/api/erp/canteen/feedback/${id}/reply`, { clientKey: randomUUID(), reply: '空调已经请师傅看过了' });
    expect([byAdmin.status, byAdmin.body.repliedByName]).toEqual([200, '测试店主']);
    expect(await dbRow(id)).toMatchObject({ repliedBy: ctx.ownerId, repliedByEmployee: null });

    // 另一位负责人再改：回信的人换成他
    const byBoss2 = await reply(boss2, id, '师傅说明天来换滤网');
    expect([byBoss2.status, byBoss2.body.repliedByName, byBoss2.body.readByName]).toEqual([200, '刘哥（食堂负责人）', '测试店主']);
    expect(await dbRow(id)).toMatchObject({ readBy: ctx.ownerId, repliedBy: null, repliedByEmployee: boss2.id });
  });

  it('负责人先看过、管理员回信：看过的人还是负责人（管理员回信不再给看过的人记一个管理员）', async () => {
    const id = await say('米饭偏硬');
    await c(boss.cookie, 'POST', `/api/canteen/mailbox/${id}/read`);
    const byAdmin = await admin('POST', `/api/erp/canteen/feedback/${id}/reply`, { clientKey: randomUUID(), reply: '明天多放点水' });
    expect([byAdmin.status, byAdmin.body.readByName, byAdmin.body.repliedByName]).toEqual([200, '陈姐（食堂负责人）', '测试店主']);
    expect(await dbRow(id)).toMatchObject({ readBy: null, readByEmployee: boss.id, repliedBy: ctx.ownerId, repliedByEmployee: null });
  });
});

describe('回信的操作编号（结果待确认）', () => {
  it('同一个编号原样重发：返回那一条、不再改一遍、不多记审计；换了内容、换了那一条、换了人都拒绝', async () => {
    const id = await say('能不能多做点素菜', 'wish');
    const other = await say('谢谢阿姨');
    const key = randomUUID();
    const first = await reply(boss, id, '好的，加一道清炒时蔬', key);
    const again = await reply(boss, id, '好的，加一道清炒时蔬', key);
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.body).toEqual(first.body);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'canteen_feedback' AND target_id = ${String(id)}`;
    expect(n!.n).toBe(1);

    const changed = await reply(boss, id, '换个说法', key);
    expect([changed.status, changed.body.error.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    const elsewhere = await reply(boss, other, '好的，加一道清炒时蔬', key);
    expect([elsewhere.status, elsewhere.body.error.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    const someoneElse = await reply(boss2, id, '好的，加一道清炒时蔬', key);
    expect([someoneElse.status, someoneElse.body.error.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect((await dbRow(other)).reply).toBeNull();
  });

  it('晚到的旧请求不会把之后的回信改回去', async () => {
    const id = await say('周五能吃火锅吗', 'wish');
    const key = randomUUID();
    expect((await reply(boss, id, '我问问老板', key)).status).toBe(200);
    expect((await admin('POST', `/api/erp/canteen/feedback/${id}/reply`, { clientKey: randomUUID(), reply: '周五安排火锅！' })).status).toBe(200);
    // 负责人那次的回复没收到，原样重发：只返回那一条，回信还是管理员后来写的
    const late = await reply(boss, id, '我问问老板', key);
    expect([late.status, late.body.reply, late.body.repliedByName]).toEqual([200, '周五安排火锅！', '测试店主']);
  });

  it('同一个编号同时交两次只记一次', async () => {
    const id = await say('汤很好喝');
    const key = randomUUID();
    const [a, b] = await Promise.all([reply(boss, id, '谢谢喜欢～', key), reply(boss, id, '谢谢喜欢～', key)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [ops] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM canteen_feedback_reply_ops WHERE client_key = ${key}`;
    const [audits] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'canteen_feedback' AND target_id = ${String(id)}`;
    expect([ops!.n, audits!.n]).toEqual([1, 1]);
  });

  it('回信最多 300 字、不能空；没有这一条 404；操作编号表只追加', async () => {
    const id = await say('想要一个打包盒');
    expect((await reply(boss, id, 'x'.repeat(301))).status).toBe(400);
    expect((await reply(boss, id, '   ')).status).toBe(400);
    expect((await c(boss.cookie, 'POST', `/api/canteen/mailbox/${id}/reply`, { clientKey: 'not-a-uuid', reply: '好' })).status).toBe(400);
    expect((await reply(boss, 99_999_999, '好')).status).toBe(404);
    expect((await c(boss.cookie, 'POST', '/api/canteen/mailbox/99999999/read')).status).toBe(404);
    expect((await reply(boss, id, '门口放了一摞，随便拿')).status).toBe(200);
    await expect(ctx.sql`UPDATE canteen_feedback_reply_ops SET request_hash = 'x'`).rejects.toThrow(/只追加/);
    await expect(ctx.sql`DELETE FROM canteen_feedback_reply_ops`).rejects.toThrow(/只追加/);
  });
});

describe('负责人换了角色', () => {
  it('改成普通员工以后马上看不了、回不了', async () => {
    const id = await say('最后一条');
    const row = (await admin('GET', '/api/erp/canteen/employees')).body.find((e: { id: number }) => e.id === boss2.id);
    const changed = await admin('PUT', `/api/erp/canteen/employees/${boss2.id}`, {
      empNo: row.empNo,
      name: row.name,
      departmentId: row.departmentId,
      role: 'staff',
      active: true,
      version: row.version,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((await c(boss2.cookie, 'GET', '/api/canteen/mailbox')).status).toBe(403);
    expect((await reply(boss2, id, '收到')).status).toBe(403);
  });
});
