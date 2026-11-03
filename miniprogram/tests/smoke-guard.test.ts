// 自动化冒烟脚本（e2e/smoke.mjs）的保护：只在实例标识为 demo 的独立演示库上跑；只读检查没过就不登录、不写数据；
// 写了数据（打开开关）之后，开发者工具起不来也要关上开关、回读核对。
// 用本机的假服务模拟 yuzu 与网关，真跑这个脚本（不要开发者工具：WECHAT_CLI 指向不存在的文件，启动必然失败）。
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../e2e/smoke.mjs', import.meta.url));

interface Seen {
  method: string;
  url: string;
  body: string;
}

let server: Server;
let base = '';
let instance: string | null = 'demo';
let mockWechat = true;
let enabled = false;
let seen: Seen[] = [];

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => resolve(body));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await read(req);
    seen.push({ method: req.method ?? '', url: req.url ?? '', body });
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/api/health') return json(200, instance === null ? { ok: true } : { ok: true, instance });
    if (req.method === 'GET' && url === '/gw/v1/health') return json(200, { ok: true, mockWechat, store: 'online' });
    if (req.method === 'POST' && url === '/api/auth/login') return json(200, { ok: true }, { 'set-cookie': 'yuzu_session=fake; Path=/' });
    if (req.method === 'GET' && url.startsWith('/api/members?')) return json(200, [{ id: 7 }]);
    if (req.method === 'GET' && url === '/api/admin/mp/members/7/bindings') return json(200, []);
    if (req.method === 'PUT' && url === '/api/admin/mp/rules') {
      enabled = (JSON.parse(body) as { enabled: boolean }).enabled;
      return json(200, { enabled });
    }
    if (req.method === 'GET' && url === '/api/admin/mp') return json(200, { rules: { enabled }, stores: [], banners: [], items: [] });
    return json(404, { error: { code: 'NOT_FOUND' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 跑一次脚本：返回退出码、输出与它发出的请求 */
function run(env: Record<string, string>): Promise<{ code: number | null; out: string; seen: Seen[] }> {
  seen = [];
  enabled = false;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH ?? '', GATEWAY_URL: `${base}/gw`, WECHAT_CLI: '/nonexistent/wechat-cli', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('close', (code) => resolve({ code, out, seen: [...seen] }));
  });
}

const writes = (s: Seen[]) => s.filter((r) => r.method !== 'GET');

describe('自动化冒烟脚本只在独立演示库上跑', () => {
  it('没写 YUZU_URL：不发任何请求', async () => {
    const r = await run({});
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('YUZU_URL');
    expect(r.seen).toEqual([]);
  });

  it('实例标识是试用、正式、测试或没设置：只读了健康检查就拒绝，不登录、不改开关', async () => {
    for (const value of ['trial', 'prod', 'shadow', 'test', '', null]) {
      instance = value;
      const r = await run({ YUZU_URL: base });
      expect(r.code, String(value)).not.toBe(0);
      expect(r.seen.map((s) => `${s.method} ${s.url}`), String(value)).toEqual(['GET /api/health']);
      expect(r.out).toContain('只在实例标识为 demo');
    }
    instance = 'demo';
  });

  it('参数不对（AppID、手机号）：在发任何请求之前拒绝', async () => {
    expect((await run({ YUZU_URL: base, MP_APPID: 'not-an-appid' })).seen).toEqual([]);
    expect((await run({ YUZU_URL: base, MEMBER_PHONE: '12345' })).seen).toEqual([]);
  });

  it('网关不是模拟微信：不登录、不写数据', async () => {
    mockWechat = false;
    const r = await run({ YUZU_URL: base });
    mockWechat = true;
    expect(r.code).not.toBe(0);
    expect(r.seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /api/health', 'GET /gw/v1/health']);
  });

  it('演示库、开发者工具起不来：打开过的开关关上，回读核对', async () => {
    const r = await run({ YUZU_URL: base });
    expect(r.code).not.toBe(0);
    const w = writes(r.seen).map((s) => `${s.method} ${s.url} ${s.body}`);
    expect(w).toEqual(['POST /api/auth/login {"username":"linlan","password":"yuzu2026"}', 'PUT /api/admin/mp/rules {"enabled":true}', 'PUT /api/admin/mp/rules {"enabled":false}']);
    expect(enabled).toBe(false);
    expect(r.out).toContain('✓ 收尾：小程序开关已关上');
    expect(r.out).toContain('✓ 收尾：没有留下有效绑定');
  });
});
