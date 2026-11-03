// 微信小程序第一期 ②（小程序线，docs/MINIPROGRAM.md 第 5 节）：后台「小程序」模块——权限（mp.content / mp.unbind）、
// 对顾客开放的开关、门店信息（版本号）、图片（按文件头认格式、同图只存一份）、首页轮播（操作编号重提、版本号）、项目介绍。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMpApp } from '../src/server/modules/mp/app';
import { createStaff } from '../src/server/modules/staff';
import { MP_GATEWAY_HEADER } from '../src/shared/mp';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
let ctx: TestContext;
let mp: FastifyInstance;
let duty: string;
let am: string;
let kehu: string;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-body')]);

beforeAll(async () => {
  ctx = await setup();
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } });
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'kehu', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  // 维护内容的是店总（MP7：客户经理不进后台，v0.6.0）
  am = await login(ctx.app, 'boss');
  kehu = await login(ctx.app, 'kehu');
});
afterAll(async () => {
  await mp.close();
  await ctx.close();
});

const admin = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/mp')).body;
const upload = (bytes: Buffer, mime = 'image/png', cookie = am) => api(ctx.app, cookie, 'POST', '/api/admin/mp/images', { mime, data: bytes.toString('base64') });
const mpGet = (url: string) => mp.inject({ method: 'GET', url, headers: { [MP_GATEWAY_HEADER]: KEY } });

describe('权限', () => {
  it('店员、客户经理进不了；值班经理能看（管解绑）不能改；店总能改内容', async () => {
    expect((await api(ctx.app, kehu, 'GET', '/api/admin/mp')).status).toBe(403);
    expect((await api(ctx.app, kehu, 'GET', '/api/admin/overview')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/mp')).status).toBe(403);
    expect((await api(ctx.app, duty, 'GET', '/api/admin/mp')).status).toBe(200);
    expect((await api(ctx.app, duty, 'PUT', '/api/admin/mp/rules', { enabled: true })).status).toBe(403);
    expect((await upload(PNG, 'image/png', duty)).status).toBe(403);
    expect((await api(ctx.app, am, 'GET', '/api/admin/mp')).status).toBe(200);
    expect((await api(ctx.app, null, 'GET', '/api/admin/mp')).status).toBe(401);
  });
});

describe('对顾客开放的开关', () => {
  it('默认关闭；打开后小程序端口能用；记审计', async () => {
    expect((await admin()).rules).toEqual({ enabled: false });
    expect((await mpGet('/api/mp/home')).statusCode).toBe(403);
    const res = await api(ctx.app, am, 'PUT', '/api/admin/mp/rules', { enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
    expect((await mpGet('/api/mp/home')).statusCode).toBe(200);
    expect((await api(ctx.app, am, 'PUT', '/api/admin/mp/rules', {})).status).toBe(400);
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'settings_updated' AND detail->>'key' = 'mp_rules'`;
    expect(audit!.n).toBe(1);
  });
});

describe('门店信息', () => {
  it('带版本号改；版本号对不上拒绝；定位要一起填', async () => {
    const baoan = (await admin()).stores.find((s: { code: string }) => s.code === 'baoan');
    const body = { version: baoan.version, name: '宝安店', hours: '全天营业', address: '深圳市宝安区（演示地址）', phone: '0755-0000 0000', latitude: 22.55, longitude: 113.88, notice: '演示公告', imageId: null, visible: true };
    const res = await api(ctx.app, am, 'PUT', '/api/admin/mp/stores/baoan', body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ hours: '全天营业', latitude: 22.55, longitude: 113.88, version: baoan.version + 1 });
    const stale = await api(ctx.app, am, 'PUT', '/api/admin/mp/stores/baoan', { ...body, hours: '晚到的' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await api(ctx.app, am, 'PUT', '/api/admin/mp/stores/baoan', { ...body, version: baoan.version + 1, longitude: null })).status).toBe(400);
    expect((await api(ctx.app, am, 'PUT', '/api/admin/mp/stores/nowhere', body)).status).toBe(404);
    const home = (await mpGet('/api/mp/home')).json();
    expect(home.stores[0]).toMatchObject({ code: 'baoan', hours: '全天营业', notice: '演示公告' });
  });
});

describe('图片', () => {
  it('按文件头认格式；同一张图只存一份；员工端口能预览', async () => {
    const a = await upload(PNG);
    expect(a.status).toBe(201);
    const again = await upload(PNG);
    expect(again.body.id).toBe(a.body.id);
    expect((await upload(PNG, 'image/jpeg')).body.error.code).toBe('IMAGE_INVALID');
    expect((await upload(Buffer.from('not an image at all'), 'image/png')).body.error.code).toBe('IMAGE_INVALID');
    expect((await upload(Buffer.alloc(1_100_000, 1), 'image/png')).status).toBe(422);
    const preview = await ctx.app.inject({ method: 'GET', url: `/api/admin/mp/images/${a.body.id}`, headers: { cookie: duty } });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('image/png');
    expect(preview.rawPayload.equals(PNG)).toBe(true);
  });
});

describe('首页轮播', () => {
  it('新建带操作编号，重提返回原来那条；改带版本号；停用后小程序不显示', async () => {
    const img = (await upload(JPEG, 'image/jpeg')).body.id as number;
    const clientKey = randomUUID();
    const body = { clientKey, title: '冬日汤泉', imageId: img, link: 'prices', startsOn: null, endsOn: null, sortOrder: 1 };
    const created = await api(ctx.app, am, 'POST', '/api/admin/mp/banners', body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: '冬日汤泉', link: 'prices', active: true, version: 1, replayed: false });
    const replay = await api(ctx.app, am, 'POST', '/api/admin/mp/banners', body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: created.body.id, replayed: true });
    expect((await admin()).banners).toHaveLength(1);
    expect((await api(ctx.app, am, 'POST', '/api/admin/mp/banners', { ...body, clientKey: randomUUID(), imageId: 999999 })).status).toBe(400);
    expect((await api(ctx.app, am, 'POST', '/api/admin/mp/banners', { ...body, clientKey: randomUUID(), startsOn: '2026-12-31', endsOn: '2026-12-01' })).status).toBe(400);

    expect((await mpGet('/api/mp/home')).json().banners.map((b: { title: string }) => b.title)).toEqual(['冬日汤泉']);
    const update = { version: 1, title: '冬日汤泉', imageId: img, link: 'guide', startsOn: null, endsOn: null, sortOrder: 1, active: false };
    const saved = await api(ctx.app, am, 'PUT', `/api/admin/mp/banners/${created.body.id}`, update);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ link: 'guide', active: false, version: 2 });
    expect((await api(ctx.app, am, 'PUT', `/api/admin/mp/banners/${created.body.id}`, update)).body.error.code).toBe('VERSION_CONFLICT');
    expect((await mpGet('/api/mp/home')).json().banners).toEqual([]);
  });
});

describe('项目介绍', () => {
  it('第一次写版本号是 0；之后带版本号改；对不上拒绝；小程序价目跟着变', async () => {
    const [item] = await ctx.sql<{ id: number }[]>`INSERT INTO service_items (name, category, price) VALUES ('演示·扬州搓澡', '沐浴', 18900) RETURNING id`;
    await ctx.sql`INSERT INTO service_item_prices (item_id, tier, price) VALUES (${item!.id}, 'standard', 18900)`;
    const row = (await admin()).items.find((i: { itemId: number }) => i.itemId === item!.id);
    expect(row).toMatchObject({ intro: '', imageId: null, version: 0 });
    const first = await api(ctx.app, am, 'PUT', `/api/admin/mp/items/${item!.id}/intro`, { version: 0, intro: '老师傅手法', imageId: null });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ intro: '老师傅手法', version: 1 });
    expect((await api(ctx.app, am, 'PUT', `/api/admin/mp/items/${item!.id}/intro`, { version: 0, intro: '晚到的' })).body.error.code).toBe('VERSION_CONFLICT');
    const second = await api(ctx.app, am, 'PUT', `/api/admin/mp/items/${item!.id}/intro`, { version: 1, intro: '老师傅手法，30 分钟' });
    expect(second.body.version).toBe(2);
    expect((await api(ctx.app, am, 'PUT', '/api/admin/mp/items/999999/intro', { version: 0, intro: 'x' })).status).toBe(404);
    const prices = (await mpGet('/api/mp/prices')).json();
    expect(prices.items.find((i: { id: number }) => i.id === item!.id).intro).toBe('老师傅手法，30 分钟');
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'mp_content_saved' AND target_type = 'mp_item_intro'`;
    expect(audit!.n).toBe(2);
  });
});
