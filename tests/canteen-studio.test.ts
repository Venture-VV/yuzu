// 员工食堂接上 UI 工作台（8.1.2，docs/WORKBENCH_V811.md 第 8 节）：设计师在主端口的工作台改员工食堂的版面、发布；
// 员工端口（柚子饭堂）登录着的员工取得到发布的那一版（组件已经展开）、版面里用到的图、预览码的草稿；
// 饭卡码那一块去不掉、改不了大小。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultStudioDoc, type StudioDoc, type StudioNode } from '../src/shared/studio';
import { buildCanteenApp } from '../src/server/modules/canteen/portal';
import { api, setup, type TestContext } from './helpers';

const SECRET = 'canteen-test-secret-0123456789abcdef-0123456789';
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_2x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mNk+M9Qz8DAwMAAAA4AAf8Y9gqmAAAAAElFTkSuQmCC';

let ctx: TestContext;
let canteen: FastifyInstance;
let cookie: string;

async function c<T = any>(method: 'GET' | 'POST', url: string, withCookie = true) {
  const res = await canteen.inject({ method, url, headers: withCookie && cookie ? { cookie } : {} });
  const body = res.headers['content-type']?.toString().includes('json') ? res.json() : res.body;
  return { status: res.statusCode, body: body as T, headers: res.headers };
}
const owner = <T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => api<T>(ctx.app, ctx.owner, method, url, payload);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const base = { name: '', rotate: 0, opacity: 1, hidden: false, locked: false };

beforeAll(async () => {
  ctx = await setup();
  const config = { ...ctx.config, canteen: { port: null, host: '127.0.0.1', codeSecret: SECRET, cookieSecure: false, trustProxy: [] } };
  canteen = await buildCanteenApp(ctx.sql, config, { openCacheMs: 0 });
  expect((await owner('PUT', '/api/erp/modules', { modules: { canteen: true } })).status).toBe(200);
  const made = await owner('POST', '/api/erp/canteen/employees', { empNo: 'S001', name: '林小柚', role: 'staff', departmentId: null });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const card = (await owner('GET', `/api/erp/canteen/activation-cards?ids=${made.body.employee.id}`)).body[0];
  const joined = await canteen.inject({ method: 'POST', url: '/api/canteen/join', payload: { code: card.code, password: 'Fan-tang-2026' } });
  expect(joined.statusCode, joined.body).toBe(200);
  const sid = joined.cookies.find((k) => k.name === 'yuzu_canteen_sid')!;
  cookie = `yuzu_canteen_sid=${sid.value}`;
});

afterAll(async () => {
  await canteen?.close();
  await ctx?.close();
});

describe('员工食堂的版面', () => {
  it('工作台里有「员工食堂」；没发布过时员工取到的是空（用内置的默认 = 原来的样子）；没登录取不到', async () => {
    const overview = (await owner('GET', '/api/studio')).body;
    expect(overview.surfaces.map((s: { surface: string }) => s.surface)).toContain('canteen');
    const s = (await owner('GET', '/api/studio/canteen')).body;
    expect(s.draft.doc).toEqual(defaultStudioDoc('canteen'));
    expect((await c('GET', '/api/canteen/studio')).body).toEqual({ layout: null });
    expect((await c('GET', '/api/canteen/studio', false)).status).toBe(401);
  });

  it('饭卡码那一块去不掉、改不了大小；功能块不能挪到别的屏', async () => {
    const s = (await owner('GET', '/api/studio/canteen')).body;
    const noQr = clone(s.draft.doc) as StudioDoc;
    noQr.screens.code!.nodes = noQr.screens.code!.nodes.filter((n) => n.type !== 'block' || n.block !== 'cn.qr');
    const saved = await owner('PUT', '/api/studio/canteen/draft', { rev: s.draft.rev, doc: noQr });
    expect(saved.status).toBe(200);
    const pub = await owner('POST', '/api/studio/canteen/publish', { clientKey: randomUUID(), rev: saved.body.rev, note: '去掉饭卡码' });
    expect([pub.status, pub.body.error.code]).toEqual([422, 'STUDIO_CHECK']);
    expect(pub.body.error.message).toContain('饭卡码');
    // 改宽高规则、改大小：存不进去
    const bigger = clone(s.draft.doc) as StudioDoc;
    const qr = bigger.screens.code!.nodes.find((n) => n.type === 'block' && n.block === 'cn.qr')!;
    qr.sizing = { w: 'fixed', h: 'fixed' };
    const r1 = await owner('PUT', '/api/studio/canteen/draft', { rev: saved.body.rev, doc: bigger });
    expect([r1.status, r1.body.error.code]).toEqual([422, 'STUDIO_INVALID']);
    const moved = clone(s.draft.doc) as StudioDoc;
    moved.screens.home!.nodes.push(moved.screens.code!.nodes.find((n) => n.type === 'block' && n.block === 'cn.qr')!);
    const r2 = await owner('PUT', '/api/studio/canteen/draft', { rev: saved.body.rev, doc: moved });
    expect([r2.status, r2.body.error.code]).toEqual([422, 'STUDIO_INVALID']);
    // 放回默认
    expect((await owner('PUT', '/api/studio/canteen/draft', { rev: saved.body.rev, doc: defaultStudioDoc('canteen') })).status).toBe(200);
  });

  it('发布以后员工取到这一版：先后、加的图、换的主题色；组件已经展开；图只给版面里用到的', async () => {
    const used = (await owner('POST', '/api/studio/assets', { name: '饭堂海报.png', data: PNG_1x1 })).body.id as string;
    const unused = (await owner('POST', '/api/studio/assets', { name: '没用的.png', data: PNG_2x1 })).body.id as string;
    const s = (await owner('GET', '/api/studio/canteen')).body;
    const doc = clone(s.draft.doc) as StudioDoc;
    // 「跟柚子说」挪到最前面；饭卡码按钮下面放一张海报（组件），柚黄换深一点
    const home = doc.screens.home!.nodes;
    const talk = home.splice(home.findIndex((n) => n.type === 'block' && n.block === 'cn.talk'), 1)[0]!;
    home.unshift(talk);
    doc.components = {
      'c-poster1': {
        name: '海报',
        node: { type: 'image', id: 'pic', ...base, x: 0, y: 0, w: 343, h: 120, asset: used, fit: 'cover', radius: 16, fill: null, sizing: { w: 'fill', h: 'fixed' } } as StudioNode,
      },
    };
    home.splice(home.findIndex((n) => n.type === 'block' && n.block === 'cn.codeButton') + 1, 0, { type: 'instance', id: 'poster', ...base, x: 0, y: 0, w: 343, h: 120, component: 'c-poster1', sizing: { w: 'fill', h: 'fixed' } });
    doc.theme.colors.yuzu = '#d9b23f';
    const saved = await owner('PUT', '/api/studio/canteen/draft', { rev: s.draft.rev, doc });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const pub = await owner('POST', '/api/studio/canteen/publish', { clientKey: randomUUID(), rev: saved.body.rev, note: '饭堂首页加海报' });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body.screensChanged).toEqual(expect.arrayContaining(['theme', 'home', 'components']));

    const got = (await c('GET', '/api/canteen/studio')).body;
    expect(got.layout).toMatchObject({ id: pub.body.id, version: pub.body.version });
    const read = got.layout.doc as StudioDoc;
    expect(read.surface).toBe('canteen');
    expect(read.theme.colors.yuzu).toBe('#d9b23f');
    expect(read.components).toBeUndefined();
    expect(read.screens.home!.nodes[0]).toMatchObject({ type: 'block', block: 'cn.talk' });
    expect(read.screens.home!.nodes.find((n) => n.id === 'poster')).toMatchObject({ type: 'image', asset: used, radius: 16 });

    const img = await c('GET', `/api/canteen/studio/assets/${used}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(String(img.headers['cache-control'])).toContain('immutable');
    expect((await c('GET', `/api/canteen/studio/assets/${unused}`)).status).toBe(404);
    expect((await c('GET', '/api/canteen/studio/assets/not-a-hash')).status).toBe(404);
    expect((await c('GET', `/api/canteen/studio/assets/${used}`, false)).status).toBe(401);
  });

  it('预览码：员工手机上看草稿的样子；别的界面的码、过期或乱写的码取不到', async () => {
    const draft = clone((await owner('GET', '/api/studio/canteen')).body.draft.doc) as StudioDoc;
    draft.theme.colors.ink = '#222222';
    const code = (await owner('POST', '/api/studio/canteen/preview-code', { doc: draft })).body.code as string;
    const r = await c('GET', `/api/canteen/studio/preview/${code}`);
    expect(r.status).toBe(200);
    expect(r.body.layout.doc.theme.colors.ink).toBe('#222222');
    // 小写也认
    expect((await c('GET', `/api/canteen/studio/preview/${code.toLowerCase()}`)).status).toBe(200);
    const menuCode = (await owner('POST', '/api/studio/emenu/preview-code', { doc: defaultStudioDoc('emenu') })).body.code as string;
    expect((await c('GET', `/api/canteen/studio/preview/${menuCode}`)).status).toBe(404);
    expect((await c('GET', '/api/canteen/studio/preview/NOTACODE')).status).toBe(404);
    await ctx.sql`UPDATE studio_preview_codes SET expires_at = now() - interval '1 minute' WHERE code = ${code}`;
    expect((await c('GET', `/api/canteen/studio/preview/${code}`)).status).toBe(404);
    expect((await c('GET', `/api/canteen/studio/preview/${menuCode}`, false)).status).toBe(401);
  });
});
