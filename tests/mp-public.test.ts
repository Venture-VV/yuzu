// 微信小程序第一期 ①（小程序线，docs/MINIPROGRAM.md 第 12 节）：单开的小程序端口只认网关；
// 默认关闭；门店信息与轮播、价目、对客导览、图片的只读接口；员工端口上没有 /api/mp/*；配置不全不开端口。

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMpConfig } from '../src/server/config';
import { buildMpApp } from '../src/server/modules/mp/app';
import { MP_GATEWAY_HEADER } from '../src/shared/mp';
import { setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
let ctx: TestContext;
let mp: FastifyInstance;

beforeAll(async () => {
  ctx = await setup();
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } });
});
afterAll(async () => {
  await mp.close();
  await ctx.close();
});

const get = (url: string, key: string | null = KEY, extra: Record<string, string> = {}) =>
  mp.inject({ method: 'GET', url, headers: { ...(key === null ? {} : { [MP_GATEWAY_HEADER]: key }), ...extra } });
const setEnabled = (enabled: boolean) =>
  ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
async function addImage(bytes: string, mime = 'image/png'): Promise<number> {
  const data = Buffer.from(bytes);
  const sha = createHash('sha256').update(data).digest('hex');
  const [row] = await ctx.sql<{ id: number }[]>`
    INSERT INTO mp_images (sha256, mime, data, size_bytes, created_by) VALUES (${sha}, ${mime}, ${data}, ${data.length}, ${ctx.ownerId}) RETURNING id`;
  return row!.id;
}

describe('小程序端口只认网关', () => {
  it('没带、带错网关密钥都拒绝；员工会话不算数', async () => {
    for (const key of [null, '', 'wrong', KEY.slice(0, -1), `${KEY}x`]) {
      const res = await get('/api/mp/health', key);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('MP_GATEWAY_REJECTED');
    }
    const withCookie = await get('/api/mp/health', null, { cookie: ctx.owner });
    expect(withCookie.statusCode).toBe(401);
  });

  it('带对密钥能查门店系统是否连得上（不看开关）', async () => {
    await setEnabled(false);
    const res = await get('/api/mp/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, version: ctx.config.version });
  });

  it('员工端口上没有 /api/mp/*', async () => {
    for (const url of ['/api/mp/health', '/api/mp/home', '/api/mp/prices']) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.owner, [MP_GATEWAY_HEADER]: KEY } });
      expect(res.statusCode).toBe(404);
    }
  });

  it('没配或配得太短的网关密钥不开端口', async () => {
    await expect(buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: null } })).rejects.toThrow(/MP_GATEWAY_KEY/);
    await expect(buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: 'short' } })).rejects.toThrow(/MP_GATEWAY_KEY/);
  });
});

describe('配置', () => {
  it('没设 MP_PORT 不开；开了必须配足够长的网关密钥、不能与 PORT 相同', () => {
    expect(loadMpConfig({}, 8080).port).toBeNull();
    expect(() => loadMpConfig({ MP_PORT: '8081' }, 8080)).toThrow(/MP_GATEWAY_KEY/);
    expect(() => loadMpConfig({ MP_PORT: '8081', MP_GATEWAY_KEY: 'too-short' }, 8080)).toThrow(/MP_GATEWAY_KEY/);
    expect(() => loadMpConfig({ MP_PORT: '8080', MP_GATEWAY_KEY: KEY }, 8080)).toThrow(/不能与 PORT 相同/);
    expect(() => loadMpConfig({ MP_PORT: 'abc', MP_GATEWAY_KEY: KEY }, 8080)).toThrow(/端口号/);
    expect(() => loadMpConfig({ MP_CODE_SECRET: 'short' }, 8080)).toThrow(/MP_CODE_SECRET/);
    expect(loadMpConfig({ MP_PORT: '8081', MP_GATEWAY_KEY: KEY, MP_HOST: '100.64.0.1' }, 8080)).toEqual({ port: 8081, host: '100.64.0.1', gatewayKey: KEY, codeSecret: null });
  });
});

describe('小程序默认关闭', () => {
  it('没开时顾客的接口一律 403', async () => {
    await setEnabled(false);
    for (const url of ['/api/mp/home', '/api/mp/prices', '/api/mp/guide', '/api/mp/images/1']) {
      const res = await get(url);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('MP_DISABLED');
    }
  });
});

describe('公开只读接口', () => {
  beforeAll(async () => {
    await setEnabled(true);
  });

  it('门店信息：两家店，本系统所在的是宝安店', async () => {
    const res = await get('/api/mp/home');
    expect(res.statusCode).toBe(200);
    const home = res.json();
    expect(home.stores.map((s: { code: string; isHome: boolean }) => [s.code, s.isHome])).toEqual([['baoan', true], ['futian', false]]);
    expect(home.stores[0]).toMatchObject({ name: '宝安店', hours: '', address: '', phone: '', latitude: null, longitude: null, notice: '', imageId: null });
    // 隐藏的门店不给
    await ctx.sql`UPDATE mp_stores SET visible = false WHERE code = 'futian'`;
    expect((await get('/api/mp/home')).json().stores.map((s: { code: string }) => s.code)).toEqual(['baoan']);
    await ctx.sql`UPDATE mp_stores SET visible = true, latitude = 22.5, longitude = 113.9 WHERE code = 'futian'`;
    expect((await get('/api/mp/home')).json().stores[1]).toMatchObject({ latitude: 22.5, longitude: 113.9 });
  });

  it('首页轮播按营业日、只给启用的', async () => {
    const img = await addImage('banner-a');
    await ctx.sql`
      INSERT INTO mp_banners (title, image_id, link, starts_on, ends_on, sort_order, active, created_by) VALUES
        ('一直有', ${img}, 'prices', NULL, NULL, 2, true, ${ctx.ownerId}),
        ('已结束', ${img}, 'none', '2020-01-01', '2020-01-31', 1, true, ${ctx.ownerId}),
        ('还没开始', ${img}, 'none', '2999-01-01', NULL, 1, true, ${ctx.ownerId}),
        ('停用了', ${img}, 'guide', NULL, NULL, 0, false, ${ctx.ownerId}),
        ('排前面', ${img}, 'guide', NULL, NULL, 1, true, ${ctx.ownerId})`;
    const banners = (await get('/api/mp/home')).json().banners;
    expect(banners.map((b: { title: string }) => b.title)).toEqual(['排前面', '一直有']);
    expect(banners[1]).toMatchObject({ link: 'prices', imageId: img });
  });

  it('价目：门票两档与价目表项目，带对外介绍', async () => {
    const [item] = await ctx.sql<{ id: number }[]>`
      INSERT INTO service_items (name, category, price, duration_minutes) VALUES ('演示·日式指压', '全身按摩', 40900, 90) RETURNING id`;
    await ctx.sql`INSERT INTO service_item_prices (item_id, tier, price) VALUES (${item!.id}, 'standard', 40900), (${item!.id}, 'professional', 48900)`;
    const img = await addImage('item-intro');
    await ctx.sql`INSERT INTO mp_item_intros (item_id, intro, image_id) VALUES (${item!.id}, '日式手法，舒缓肩颈', ${img})`;
    const [off] = await ctx.sql<{ id: number }[]>`INSERT INTO service_items (name, price, active) VALUES ('演示·停用项目', 100, false) RETURNING id`;

    const prices = (await get('/api/mp/prices')).json();
    expect(prices.tickets.find((t: { name: string }) => t.name === '全日自助餐')).toMatchObject({ price12h: 99900, price24h: 119900 });
    const shown = prices.items.find((i: { id: number }) => i.id === item!.id);
    expect(shown).toMatchObject({
      name: '演示·日式指压',
      category: '全身按摩',
      durationMinutes: 90,
      prices: [{ tier: 'standard', price: 40900 }, { tier: 'professional', price: 48900 }],
      intro: '日式手法，舒缓肩颈',
      imageId: img,
    });
    expect(prices.items.some((i: { id: number }) => i.id === off!.id)).toBe(false);
  });

  it('对客导览：没有在用的底图时没有楼层；底图地址不对时 404 且不缓存', async () => {
    const guide = (await get('/api/mp/guide')).json();
    expect(guide.floors).toEqual([]);
    expect(guide.zones).toEqual([]);
    const svg = await get('/api/mp/guide/floors/L1/svg?b=1');
    expect(svg.statusCode).toBe(404);
    expect(svg.headers['cache-control']).toBe('no-store');
  });

  it('图片按编号给原图与类型，可以长期缓存；没有的 404', async () => {
    const id = await addImage('jpeg-bytes', 'image/jpeg');
    const res = await get(`/api/mp/images/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.rawPayload.toString()).toBe('jpeg-bytes');
    expect((await get('/api/mp/images/999999')).statusCode).toBe(404);
    expect((await get('/api/mp/images/abc')).statusCode).toBe(400);
  });
});

describe('只追加与约束', () => {
  it('绑定记录不能删、不能改，只能解绑一次', async () => {
    const [m] = await ctx.sql<{ id: number }[]>`
      INSERT INTO members (member_no, name, phone) VALUES ('MP-T1', '演示·绑定', '13800001111') RETURNING id`;
    const [b] = await ctx.sql<{ id: number }[]>`
      INSERT INTO mp_bindings (openid, member_id, phone, client_key) VALUES ('openid-test-1', ${m!.id}, '13800001111', gen_random_uuid()) RETURNING id`;
    await expect(ctx.sql`DELETE FROM mp_bindings WHERE id = ${b!.id}`).rejects.toMatchObject({ code: 'P0001' });
    await expect(ctx.sql`UPDATE mp_bindings SET phone = '13800002222' WHERE id = ${b!.id}`).rejects.toMatchObject({ code: 'P0001' });
    // 同一个微信、同一位会员同时只能有一条有效绑定
    await expect(
      ctx.sql`INSERT INTO mp_bindings (openid, member_id, phone, client_key) VALUES ('openid-test-1', ${m!.id}, '13800001111', gen_random_uuid())`,
    ).rejects.toMatchObject({ code: '23505' });
    await ctx.sql`UPDATE mp_bindings SET unbound_at = now(), unbound_by = ${ctx.ownerId}, unbind_reason = '换手机号', unbind_client_key = gen_random_uuid() WHERE id = ${b!.id}`;
    await expect(ctx.sql`UPDATE mp_bindings SET unbind_reason = '改原因' WHERE id = ${b!.id}`).rejects.toMatchObject({ code: 'P0001' });
    // 解绑之后可以重新绑定
    await ctx.sql`INSERT INTO mp_bindings (openid, member_id, phone, client_key) VALUES ('openid-test-1', ${m!.id}, '13800001111', gen_random_uuid())`;
  });

  it('门店、轮播、项目介绍不能删；图片只追加', async () => {
    await expect(ctx.sql`DELETE FROM mp_stores WHERE code = 'futian'`).rejects.toMatchObject({ code: 'P0001' });
    const id = await addImage('immutable');
    await expect(ctx.sql`UPDATE mp_images SET mime = 'image/webp' WHERE id = ${id}`).rejects.toMatchObject({ code: 'P0001' });
    // 本系统所在的门店只能有一家
    await expect(ctx.sql`UPDATE mp_stores SET is_home = true WHERE code = 'futian'`).rejects.toMatchObject({ code: '23505' });
  });
});
