// 小程序网关的工作台版面转发、定时发布零缓存延迟与断外网旧版面兜底测试（8.1.2，docs/STUDIO_MP.md 第 5 节）。

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../src/gateway/app';
import type { GatewayConfig } from '../src/gateway/config';
import { createUpstream, UpstreamDown, type Upstream } from '../src/gateway/upstream';
import { createMockWechat } from '../src/gateway/wechat';
import { buildMpApp } from '../src/server/modules/mp/app';
import { setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
const SESSION = 'test-session-secret-0123456789abcdef-0123';
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/studio/mp', import.meta.url));

let ctx: TestContext;
let yuzuMp: FastifyInstance;
let upstreamUrl: string;
let realUpstream: Upstream;
let storeOnline = true;
let gw: FastifyInstance;
let nextVersion = 1;

function loadFixtureDoc(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as { doc: Record<string, unknown> };
  return JSON.parse(JSON.stringify(raw.doc)) as Record<string, unknown>;
}

async function insertMpVersion(doc: unknown, effectiveAtOffsetMs: number | null = null): Promise<number> {
  const version = nextVersion++;
  const docJson = JSON.stringify(doc);
  const docHash = createHash('sha256').update(docJson).digest('hex');
  const [row] =
    effectiveAtOffsetMs === null
      ? await ctx.sql<{ id: number }[]>`
          INSERT INTO studio_versions (surface, version, kind, doc, doc_hash, client_key, request_hash, published_by, published_at)
          VALUES ('mp', ${version}, 'publish', ${ctx.sql.json(doc as never)}, ${docHash}, ${randomUUID()}, ${docHash}, ${ctx.ownerId}, now() - interval '1 minute')
          RETURNING id`
      : await ctx.sql<{ id: number }[]>`
          INSERT INTO studio_versions (surface, version, kind, doc, doc_hash, client_key, request_hash, published_by, published_at, effective_at)
          VALUES (
            'mp',
            ${version},
            'publish',
            ${ctx.sql.json(doc as never)},
            ${docHash},
            ${randomUUID()},
            ${docHash},
            ${ctx.ownerId},
            now() - interval '10 seconds',
            now() + (${effectiveAtOffsetMs} * interval '1 millisecond')
          )
          RETURNING id`;
  return Number(row!.id);
}

beforeAll(async () => {
  ctx = await setup();
  yuzuMp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } });
  await yuzuMp.listen({ host: '127.0.0.1', port: 0 });
  upstreamUrl = `http://127.0.0.1:${(yuzuMp.server.address() as AddressInfo).port}`;
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })})`;

  realUpstream = createUpstream(upstreamUrl, KEY);
  const switchableUpstream: Upstream = {
    call: (method, path, opts) => {
      if (!storeOnline) return Promise.reject(new UpstreamDown('store down'));
      return realUpstream.call(method, path, opts);
    },
  };

  const config: GatewayConfig = {
    host: '127.0.0.1',
    port: 0,
    trustProxy: false,
    upstreamUrl,
    gatewayKey: KEY,
    sessionSecret: SESSION,
    sessionDays: 7,
    mockWechat: true,
    wechat: null,
    reminderSeconds: 0,
    subscribeState: 'developer',
    logLevel: 'silent',
  };
  gw = await buildGateway({ config, wechat: createMockWechat(), upstream: switchableUpstream });
});

afterAll(async () => {
  await gw.close();
  await yuzuMp.close();
  await ctx.close();
});

describe('小程序网关 /v1/studio 与 /v1/studio/assets/:id', () => {
  it('在线时每次直读 yuzu（freshMs = 0）：定时发布到点后下一次请求零延迟拿到新版；门店断网时回退网关缓存（stale）', async () => {
    // 1. 还没发布：在线返回 { layout: null }
    const empty = await gw.inject({ method: 'GET', url: '/v1/studio' });
    expect(empty.statusCode).toBe(200);
    expect(empty.headers['cache-control']).toBe('no-store');
    expect(empty.json()).toEqual({ layout: null });

    // 2. 发布第 1 版：紧接着再调 /v1/studio 立即拿到 v1（不被上一秒的 null 缓存挡住）
    const v1Id = await insertMpVersion(loadFixtureDoc('01-home-default'));
    const r1 = await gw.inject({ method: 'GET', url: '/v1/studio' });
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['x-cache']).toBe('miss');
    expect(r1.json().layout.id).toBe(v1Id);

    // 3. 定时 300ms 后生效的第 2 版：到点前读仍是 v1，到点后无需等 60 秒缓存立即拿到 v2
    const doc2 = loadFixtureDoc('02-member-default') as { theme: { colors: Record<string, string> } };
    doc2.theme.colors.bg = '#F0E7D8';
    const v2Id = await insertMpVersion(doc2, 300);

    expect((await gw.inject({ method: 'GET', url: '/v1/studio' })).json().layout.id).toBe(v1Id);
    await new Promise((r) => setTimeout(r, 400));
    const r2 = await gw.inject({ method: 'GET', url: '/v1/studio' });
    expect(r2.headers['x-cache']).toBe('miss');
    expect(r2.json().layout.id).toBe(v2Id);

    // 4. 门店突然断外网：网关用刚存下的第 2 版兜底（x-cache: stale），并带 x-fetched-at 供手机计算 7 天上限
    storeOnline = false;
    const offlineRes = await gw.inject({ method: 'GET', url: '/v1/studio' });
    expect(offlineRes.statusCode).toBe(200);
    expect(offlineRes.headers['x-cache']).toBe('stale');
    expect(offlineRes.headers['x-fetched-at']).toBeTruthy();
    expect(offlineRes.json().layout.id).toBe(v2Id);
    storeOnline = true;
  });

  it('素材在网关长期缓存（第二次命中 fresh），SVG 保留禁止脚本的 CSP，非法编号在网关直接 400', async () => {
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><rect width="12" height="12" fill="#937051"/></svg>', 'utf8');
    const svgId = createHash('sha256').update(svgBytes).digest('hex');
    await ctx.sql`
      INSERT INTO studio_assets (id, mime, data, size_bytes, width, height, name, uploaded_by)
      VALUES (${svgId}, 'image/svg+xml', ${svgBytes}, ${svgBytes.length}, 12, 12, 'icon.svg', ${ctx.ownerId})`;

    const doc = loadFixtureDoc('03-activity-poster') as { screens: { activity: { nodes: Record<string, unknown>[] } } };
    doc.screens.activity.nodes[0] = { ...doc.screens.activity.nodes[0], type: 'image', asset: svgId };
    await insertMpVersion(doc);

    const first = await gw.inject({ method: 'GET', url: `/v1/studio/assets/${svgId}` });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-cache']).toBe('miss');
    expect(first.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(first.headers['content-security-policy']).toContain("default-src 'none'");

    // 第二次取同一张素材：门店断网也直接从网关内存 fresh 命中，且 SVG CSP 不丢
    storeOnline = false;
    const second = await gw.inject({ method: 'GET', url: `/v1/studio/assets/${svgId}` });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-cache']).toBe('fresh');
    expect(second.headers['content-security-policy']).toContain("default-src 'none'");
    storeOnline = true;

    const bad = await gw.inject({ method: 'GET', url: '/v1/studio/assets/UPPERCASE_OR_SHORT' });
    expect(bad.statusCode).toBe(400);
  });
});
