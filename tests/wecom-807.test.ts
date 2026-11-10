// 8.0.7 A4 企业微信每周一推（docs/ERP_V807.md 第 4 节，V19、V20，迁移 104）：
//   · 没配机器人地址时「发一条试试」说清楚；配了以后试发能推出去，10 秒内不能连着试；
//   · 每周一 9:00（门店时区）以后、开关打开时推一次，同一周不推第二次；开关关着、不是周一、9 点前都不推；
//   · 发不出去的隔 5 分钟再试，最多 3 次；发送中断（租约过了）的记失败、照样再试；
//   · 出错原因里不带机器人地址（地址相当于密码）；没有设置权限的进不来。
// 机器人用本机的 HTTP 服务模拟（开发、测试环境认 http 地址）。

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWecomConfig } from '../src/server/config';
import { runWecomWeekly } from '../src/server/modules/wecom';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let server: Server;
let base = '';
const received: { url: string; body: any }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { errcode: 0, errmsg: 'ok' } };

/** 门店时区（Asia/Shanghai）某天几点 */
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+08:00`);
const weekly = () => ctx.sql<{ periodKey: string; status: string; attempts: number; error: string | null }[]>`
  SELECT period_key::text AS period_key, status, attempts, error FROM wecom_pushes WHERE kind = 'weekly' ORDER BY period_key`;

beforeAll(async () => {
  ctx = await setup();
  expect(ctx.config.timezone).toBe('Asia/Shanghai');
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: JSON.parse(raw || 'null') });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await ctx.close();
});

describe('机器人地址的配置', () => {
  it('只认 https；开发、测试另认 http；格式不对的当作没配', () => {
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc';
    expect(loadWecomConfig({}, 'production')).toEqual({ webhook: null, invalid: false });
    expect(loadWecomConfig({ ERP_WECOM_WEBHOOK: ` ${url} ` }, 'production')).toEqual({ webhook: url, invalid: false });
    expect(loadWecomConfig({ ERP_WECOM_WEBHOOK: 'http://127.0.0.1:1/x' }, 'production')).toEqual({ webhook: null, invalid: true });
    expect(loadWecomConfig({ ERP_WECOM_WEBHOOK: 'http://127.0.0.1:1/x' }, 'trial')).toEqual({ webhook: null, invalid: true });
    expect(loadWecomConfig({ ERP_WECOM_WEBHOOK: 'http://127.0.0.1:1/x' }, 'test').webhook).toBe('http://127.0.0.1:1/x');
    expect(loadWecomConfig({ ERP_WECOM_WEBHOOK: 'qyapi.weixin.qq.com' }, 'production')).toEqual({ webhook: null, invalid: true });
  });
});

describe('发一条试试', () => {
  it('没配时说清楚；配了推得出去、记下结果；10 秒内不能连着试；店员进不来', async () => {
    ctx.config.wecom = { webhook: null, invalid: false };
    let st = (await api(ctx.app, ctx.owner, 'GET', '/api/settings/wecom')).body;
    expect(st).toMatchObject({ configured: false, invalid: false, enabled: false, recent: [] });
    const no = await api(ctx.app, ctx.owner, 'POST', '/api/settings/wecom/test', {});
    expect(no.status).toBe(422);
    expect(no.body.error.code).toBe('WECOM_NOT_CONFIGURED');

    ctx.config.wecom = { webhook: `${base}/hook?key=secret-key-1`, invalid: false };
    const ok = await api(ctx.app, ctx.owner, 'POST', '/api/settings/wecom/test', {});
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, error: null, push: { kind: 'test', status: 'sent', attempts: 1 } });
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/hook?key=secret-key-1');
    expect(received[0]!.body.msgtype).toBe('markdown');
    const content = received[0]!.body.markdown.content as string;
    expect(content).toContain('推送试发');
    expect(content).toContain('收到这条说明机器人地址配好了');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(4096);

    const again = await api(ctx.app, ctx.owner, 'POST', '/api/settings/wecom/test', {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('WECOM_TOO_FAST');
    expect(received).toHaveLength(1);

    st = (await api(ctx.app, ctx.owner, 'GET', '/api/settings/wecom')).body;
    expect(st.configured).toBe(true);
    expect(st.recent[0]).toMatchObject({ kind: 'test', status: 'sent', createdByName: expect.any(String) });
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'wecom_push'`;
    expect(audit!.n).toBe(1);

    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/settings/wecom')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/settings/wecom/test', {})).status).toBe(403);
  });

  it('企业微信不收、连不上：记下原因，原因里不带机器人地址', async () => {
    await ctx.sql`UPDATE wecom_pushes SET created_at = created_at - interval '1 minute' WHERE kind = 'test'`;
    reply = { status: 200, body: { errcode: 93000, errmsg: 'invalid webhook url' } };
    const bad = (await api(ctx.app, ctx.owner, 'POST', '/api/settings/wecom/test', {})).body;
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('93000');
    expect(bad.push.status).toBe('failed');
    reply = { status: 200, body: { errcode: 0, errmsg: 'ok' } };

    // 没有在听的端口：连不上
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    await ctx.sql`UPDATE wecom_pushes SET created_at = created_at - interval '1 minute' WHERE kind = 'test'`;
    ctx.config.wecom = { webhook: `http://127.0.0.1:${port}/hook?key=secret-key-2`, invalid: false };
    const down = (await api(ctx.app, ctx.owner, 'POST', '/api/settings/wecom/test', {})).body;
    expect(down.ok).toBe(false);
    expect(down.error).toMatch(/企业微信连不上/);
    const errors = await ctx.sql<{ error: string | null }[]>`SELECT error FROM wecom_pushes WHERE error IS NOT NULL`;
    for (const e of errors) expect(e.error).not.toMatch(/secret-key|127\.0\.0\.1/);
    ctx.config.wecom = { webhook: `${base}/hook?key=secret-key-1`, invalid: false };
  });
});

describe('每周一推', () => {
  it('开关关着、不是周一、9 点前不推；周一 9 点以后推一次，同一周不推第二次', async () => {
    received.length = 0;
    const deps = { sql: ctx.sql, config: ctx.config };
    expect(await runWecomWeekly(deps, at('2026-11-16', '10:00'))).toBeNull(); // 开关默认关
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { wecomWeeklyPush: true })).status).toBe(200);
    expect(await runWecomWeekly(deps, at('2026-11-15', '10:00'))).toBeNull(); // 周日
    expect(await runWecomWeekly(deps, at('2026-11-17', '10:00'))).toBeNull(); // 周二不补推
    expect(await runWecomWeekly(deps, at('2026-11-16', '08:59'))).toBeNull();
    // 没配地址的不推
    ctx.config.wecom = { webhook: null, invalid: false };
    expect(await runWecomWeekly(deps, at('2026-11-16', '09:00'))).toBeNull();
    ctx.config.wecom = { webhook: `${base}/hook?key=secret-key-1`, invalid: false };
    expect(received).toHaveLength(0);

    const r = await runWecomWeekly(deps, at('2026-11-16', '09:00'));
    expect(r).toMatchObject({ ok: true, error: null });
    expect(received).toHaveLength(1);
    const content = received[0]!.body.markdown.content as string;
    expect(content).toContain('每周提醒');
    expect(content).toContain('2026-11-16');
    expect(content).toContain('详情到 ERP 里看');
    expect(await runWecomWeekly(deps, at('2026-11-16', '09:01'))).toBeNull();
    expect(await runWecomWeekly(deps, at('2026-11-16', '23:59'))).toBeNull();
    expect(received).toHaveLength(1);
    expect(await weekly()).toEqual([{ periodKey: '2026-11-16', status: 'sent', attempts: 1, error: null }]);
  });

  it('只写开着的 ERP 模块：模块全开时写本周应付、待审批、快到期、逾期应收', async () => {
    const all = Object.fromEntries(
      (await api(ctx.app, ctx.owner, 'GET', '/api/erp/modules')).body.modules.map((m: { key: string }) => [m.key, true]),
    );
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/erp/modules', { modules: all })).status).toBe(200);
    received.length = 0;
    const r = await runWecomWeekly({ sql: ctx.sql, config: ctx.config }, at('2026-11-23', '09:30'));
    expect(r?.ok).toBe(true);
    const content = received[0]!.body.markdown.content as string;
    for (const word of ['本周应付', '待审批', '快到期', '逾期应收']) expect(content).toContain(word);
  });

  it('发不出去隔 5 分钟再试、最多 3 次；发送中断的记失败、照样再试', async () => {
    const deps = { sql: ctx.sql, config: ctx.config };
    received.length = 0;
    reply = { status: 500, body: { errcode: -1, errmsg: 'system busy' } };
    const first = await runWecomWeekly(deps, at('2026-11-30', '09:00'));
    expect(first).toMatchObject({ ok: false });
    expect(first!.error).toContain('-1');
    expect(await runWecomWeekly(deps, at('2026-11-30', '09:01'))).toBeNull(); // 还没到 5 分钟
    const back = () => ctx.sql`UPDATE wecom_pushes SET finished_at = finished_at - interval '6 minutes' WHERE kind = 'weekly' AND period_key = '2026-11-30'`;
    await back();
    expect((await runWecomWeekly(deps, at('2026-11-30', '09:06')))!.ok).toBe(false);
    await back();
    expect((await runWecomWeekly(deps, at('2026-11-30', '09:12')))!.ok).toBe(false);
    await back();
    expect(await runWecomWeekly(deps, at('2026-11-30', '09:18'))).toBeNull(); // 试满 3 次不再试
    expect(received).toHaveLength(3);
    expect((await weekly()).find((w) => w.periodKey === '2026-11-30')).toMatchObject({ status: 'failed', attempts: 3 });

    // 发送中断：认领了、租约过了还在「发送中」——记失败，隔 5 分钟再试
    reply = { status: 200, body: { errcode: 0, errmsg: 'ok' } };
    await ctx.sql`INSERT INTO wecom_pushes (kind, period_key, status, attempts, claimed_until) VALUES ('weekly', '2026-12-07', 'sending', 1, now() - interval '1 minute')`;
    expect(await runWecomWeekly(deps, at('2026-12-07', '09:05'))).toBeNull();
    expect((await weekly()).find((w) => w.periodKey === '2026-12-07')).toMatchObject({ status: 'failed', attempts: 1, error: '发送中断（应用重启或超时）' });
    await ctx.sql`UPDATE wecom_pushes SET finished_at = finished_at - interval '6 minutes' WHERE kind = 'weekly' AND period_key = '2026-12-07'`;
    expect((await runWecomWeekly(deps, at('2026-12-07', '09:11')))!.ok).toBe(true);
    expect((await weekly()).find((w) => w.periodKey === '2026-12-07')).toMatchObject({ status: 'sent', attempts: 2, error: null });
  });
});
