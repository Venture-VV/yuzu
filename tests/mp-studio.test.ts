// 小程序端口的工作台版面与素材只读接口（8.1.2，docs/STUDIO_MP.md 第 5 节）：
//   · 只认网关密钥、遵循小程序总开关；员工端口不暴露 /api/mp/studio*；
//   · 未发布返回 { layout: null }；发布后返回展开组件实例后的版面（cache-control: no-store）；
//   · 定时发布：到点前读旧版，到点后立即切到新版；撤销后立即回退；
//   · 素材：只给 mp 已发布（含定时未到点）版面里引用的图片，未引用或只给别的界面（emenu）用的图片一律 404；SVG 带禁止脚本 CSP。

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultStudioDoc } from '../src/shared/studio';
import { buildMpApp } from '../src/server/modules/mp/app';
import { MP_GATEWAY_HEADER } from '../src/shared/mp';
import { setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/studio/mp', import.meta.url));

let ctx: TestContext;
let mp: FastifyInstance;
let nextVersion = 1;

function loadFixtureDoc(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as { doc: Record<string, unknown> };
  return JSON.parse(JSON.stringify(raw.doc)) as Record<string, unknown>;
}

async function insertAsset(bytes: Buffer, mime: 'image/png' | 'image/svg+xml', name = 'test'): Promise<string> {
  const id = createHash('sha256').update(bytes).digest('hex');
  await ctx.sql`
    INSERT INTO studio_assets (id, mime, data, size_bytes, width, height, name, uploaded_by)
    VALUES (${id}, ${mime}, ${bytes}, ${bytes.length}, 16, 16, ${name}, ${ctx.ownerId})
    ON CONFLICT (id) DO NOTHING`;
  return id;
}

async function insertVersion(
  doc: unknown,
  opts: { surface?: 'mp' | 'emenu'; publishedAtOffsetSec?: number; effectiveAtOffsetMs?: number | null } = {},
): Promise<number> {
  const surface = opts.surface ?? 'mp';
  const version = nextVersion++;
  const docJson = JSON.stringify(doc);
  const docHash = createHash('sha256').update(docJson).digest('hex');
  const pubSec = opts.publishedAtOffsetSec ?? -60;
  const effMs = opts.effectiveAtOffsetMs ?? null;
  const [row] =
    effMs === null
      ? await ctx.sql<{ id: number }[]>`
          INSERT INTO studio_versions (surface, version, kind, doc, doc_hash, client_key, request_hash, published_by, published_at)
          VALUES (${surface}, ${version}, 'publish', ${ctx.sql.json(doc as never)}, ${docHash}, ${randomUUID()}, ${docHash}, ${ctx.ownerId}, now() + (${pubSec} * interval '1 second'))
          RETURNING id`
      : await ctx.sql<{ id: number }[]>`
          INSERT INTO studio_versions (surface, version, kind, doc, doc_hash, client_key, request_hash, published_by, published_at, effective_at)
          VALUES (
            ${surface},
            ${version},
            'publish',
            ${ctx.sql.json(doc as never)},
            ${docHash},
            ${randomUUID()},
            ${docHash},
            ${ctx.ownerId},
            now() + (${pubSec} * interval '1 second'),
            now() + (${effMs} * interval '1 millisecond')
          )
          RETURNING id`;
  return Number(row!.id);
}

const get = (url: string, key: string | null = KEY) =>
  mp.inject({ method: 'GET', url, headers: key === null ? {} : { [MP_GATEWAY_HEADER]: key } });

const setEnabled = (enabled: boolean) =>
  ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

beforeAll(async () => {
  ctx = await setup();
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } });
});

afterAll(async () => {
  await mp.close();
  await ctx.close();
});

describe('/api/mp/studio 与 /api/mp/studio/assets/:id', () => {
  it('鉴权与开关：不带网关密钥 401，小程序关闭时 403，员工端口不暴露', async () => {
    expect((await get('/api/mp/studio', null)).statusCode).toBe(401);
    expect((await get('/api/mp/studio', 'wrong-key')).statusCode).toBe(401);

    await setEnabled(false);
    const closed = await get('/api/mp/studio');
    expect(closed.statusCode).toBe(403);
    expect(closed.json().error.code).toBe('MP_DISABLED');

    const staffRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/mp/studio',
      headers: { cookie: ctx.owner, [MP_GATEWAY_HEADER]: KEY },
    });
    expect(staffRes.statusCode).toBe(404);

    await setEnabled(true);
  });

  it('未发布时返回 { layout: null } 且响应头为 no-store', async () => {
    const res = await get('/api/mp/studio');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ layout: null });
  });

  it('已发布版面：组件实例在服务端展开成普通节点，定时未到点不提前露出、到点立即生效、撤销立即回退', async () => {
    const doc1 = loadFixtureDoc('01-home-default') as {
      theme: { colors: Record<string, string> };
      components?: Record<string, unknown>;
      screens: { activity: { nodes: Record<string, unknown>[] } };
    };
    doc1.components = {
      'c-tag01': {
        name: '活动角标',
        node: {
          type: 'text',
          id: 'master-tag',
          name: '角标字',
          x: 0,
          y: 0,
          w: 120,
          h: 28,
          rotate: 0,
          opacity: 1,
          hidden: false,
          locked: false,
          sizing: { w: 'fixed', h: 'fixed' },
          text: { zh: '限时礼遇', en: 'LIMITED' },
          font: 'zh',
          size: 14,
          weight: 600,
          color: '$wood',
          align: 'center',
          valign: 'middle',
          lineHeight: 1.4,
          letterSpacing: 0,
          italic: false,
          underline: false,
          fill: '$wood6',
        },
      },
    };
    doc1.screens.activity.nodes.unshift({
      type: 'instance',
      id: 'inst-1',
      name: '角标实例',
      component: 'c-tag01',
      x: 0,
      y: 0,
      w: 140,
      h: 32,
      rotate: 0,
      opacity: 1,
      hidden: false,
      locked: false,
      sizing: { w: 'fixed', h: 'fixed' },
    });

    const v1Id = await insertVersion(doc1, { publishedAtOffsetSec: -120 });
    const r1 = await get('/api/mp/studio');
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['cache-control']).toBe('no-store');
    const l1 = r1.json().layout;
    expect(l1.id).toBe(v1Id);
    // 组件实例已展开成 text 节点，小程序不用自己认 instance
    expect(l1.doc.screens.activity.nodes[0]).toMatchObject({ id: 'inst-1', type: 'text', w: 140, h: 32, text: { zh: '限时礼遇' } });

    // 定时在 350ms 后生效的第二版：到点前仍返回 v1，到点后立即切到 v2
    const doc2 = loadFixtureDoc('03-activity-poster') as { theme: { colors: Record<string, string> } };
    doc2.theme.colors.bg = '#EDE3D2';
    const v2Id = await insertVersion(doc2, { publishedAtOffsetSec: -10, effectiveAtOffsetMs: 350 });

    expect((await get('/api/mp/studio')).json().layout.id).toBe(v1Id);
    await new Promise((r) => setTimeout(r, 450));
    const r2 = await get('/api/mp/studio');
    expect(r2.json().layout.id).toBe(v2Id);
    expect(r2.json().layout.doc.theme.colors.bg).toBe('#EDE3D2');

    // 撤销第 2 版后立即回退到第 1 版
    await ctx.sql`INSERT INTO studio_version_cancels (version_id, cancelled_by, reason) VALUES (${v2Id}, ${ctx.ownerId}, '活动延期')`;
    expect((await get('/api/mp/studio')).json().layout.id).toBe(v1Id);
  });

  it('素材读取：只允许下载小程序已发布（含定时未到点）版面里引用的图，SVG 带 CSP，未引用或非法编号一律 404', async () => {
    const posterBytes = readFileSync(join(FIXTURES_DIR, 'assets', '00424d7a0218b97c8e5bbae2da9e8b7cd341468e9b8780d77d0f3754b3cc8ca8.png'));
    const posterId = await insertAsset(posterBytes, 'image/png', 'poster.png');

    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#937051"/></svg>', 'utf8');
    const futureSvgId = await insertAsset(svgBytes, 'image/svg+xml', 'badge.svg');

    const unusedBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>', 'utf8');
    const unusedId = await insertAsset(unusedBytes, 'image/svg+xml', 'unused.svg');

    const emenuOnlyBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><rect width="12" height="12"/></svg>', 'utf8');
    const emenuOnlyId = await insertAsset(emenuOnlyBytes, 'image/svg+xml', 'emenu-only.svg');

    // 别的界面（emenu）已发布版面引用的图片，小程序端口也不能下载
    const emenuDoc = defaultStudioDoc('emenu');
    const firstScreen = Object.values(emenuDoc.screens)[0]!;
    firstScreen.nodes.push({
      type: 'image',
      id: 'emenu-bg-img',
      name: '',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      rotate: 0,
      opacity: 1,
      hidden: false,
      locked: false,
      asset: emenuOnlyId,
      fit: 'cover',
      radius: 0,
      fill: null,
    });
    await insertVersion(emenuDoc, { surface: 'emenu', publishedAtOffsetSec: -60 });

    // 定时在 1 小时后才生效的小程序版面同时保留 posterId 并新增 futureSvgId：提前预热也能取到
    const futureDoc = loadFixtureDoc('03-activity-poster') as {
      screens: { activity: { nodes: Record<string, unknown>[] } };
    };
    futureDoc.screens.activity.nodes.push({
      ...futureDoc.screens.activity.nodes[0],
      id: 'future-badge',
      type: 'image',
      asset: futureSvgId,
    });
    await insertVersion(futureDoc, { publishedAtOffsetSec: -10, effectiveAtOffsetMs: 3600 * 1000 });

    const pngRes = await get(`/api/mp/studio/assets/${posterId}`);
    expect(pngRes.statusCode).toBe(200);
    expect(pngRes.headers['content-type']).toBe('image/png');
    expect(pngRes.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(pngRes.rawPayload.equals(posterBytes)).toBe(true);

    const svgRes = await get(`/api/mp/studio/assets/${futureSvgId}`);
    expect(svgRes.statusCode).toBe(200);
    expect(svgRes.headers['content-type']).toBe('image/svg+xml');
    expect(svgRes.headers['content-security-policy']).toContain("default-src 'none'");

    // 素材库里有但没被任何 mp 版面用过的图、或只被 emenu 用过的图：一律 404，防止遍历素材库
    expect((await get(`/api/mp/studio/assets/${unusedId}`)).statusCode).toBe(404);
    expect((await get(`/api/mp/studio/assets/${emenuOnlyId}`)).statusCode).toBe(404);
    expect((await get('/api/mp/studio/assets/not-a-sha256')).statusCode).toBe(404);
  });
});
