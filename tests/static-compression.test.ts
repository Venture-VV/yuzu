// 前端静态资源预压缩（测试服首次打开慢：主脚本约 1 MB、没有压缩传输）：
//   构建时用 scripts/compress-assets.mjs 写出 .br / .gz，服务端按浏览器的 Accept-Encoding 直接发压缩好的文件；
//   内容类型、缓存规则、nosniff 不变；不支持压缩的浏览器照常拿到原文件；小文件、字体不压缩。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import { setup, type TestContext } from './helpers';

let ctx: TestContext;
let app: FastifyInstance;
let dir: string;
const js = 'console.log("浴族 yuzu");\n'.repeat(400);

beforeAll(async () => {
  ctx = await setup();
  dir = await mkdtemp(join(tmpdir(), 'yuzu-static-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>浴族</title>');
  await writeFile(join(dir, 'assets', 'app-abc123.js'), js);
  await writeFile(join(dir, 'assets', 'font-abc123.woff2'), Buffer.alloc(4096, 7));
  // 与构建时同一个脚本
  execFileSync(process.execPath, ['scripts/compress-assets.mjs', dir]);
  const before = process.env.STATIC_DIR;
  process.env.STATIC_DIR = dir;
  try {
    app = await buildApp(ctx.sql, ctx.config);
  } finally {
    if (before === undefined) delete process.env.STATIC_DIR;
    else process.env.STATIC_DIR = before;
  }
});
afterAll(async () => {
  await app?.close();
  await ctx.close();
  await rm(dir, { recursive: true, force: true });
});

describe('静态资源预压缩', () => {
  it('构建脚本只压缩够大的文本文件：脚本有 .br / .gz，首页（太小）与字体（本身已压缩）没有', () => {
    expect(existsSync(join(dir, 'assets', 'app-abc123.js.br'))).toBe(true);
    expect(existsSync(join(dir, 'assets', 'app-abc123.js.gz'))).toBe(true);
    expect(existsSync(join(dir, 'index.html.br'))).toBe(false);
    expect(existsSync(join(dir, 'assets', 'font-abc123.woff2.gz'))).toBe(false);
  });

  it('浏览器支持 brotli 时发 .br，只支持 gzip 时发 .gz；内容与原文件一致，类型、长期缓存、nosniff 不变', async () => {
    const br = await app.inject({ url: '/assets/app-abc123.js', headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(br.statusCode).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['content-type']).toMatch(/^application\/javascript/);
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(br.headers['x-content-type-options']).toBe('nosniff');
    expect(String(br.headers.vary)).toMatch(/accept-encoding/i);
    expect(br.rawPayload.length).toBeLessThan(Buffer.byteLength(js) / 4);
    expect(brotliDecompressSync(br.rawPayload).toString()).toBe(js);

    const gz = await app.inject({ url: '/assets/app-abc123.js', headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.rawPayload).toString()).toBe(js);
  });

  it('构建产物里缺的脚本、模型回 404，不拿首页顶替（8.0.12：识别库会把收到的页面当成模型存下来）；前端路由照常回首页', async () => {
    for (const url of ['/assets/missing-abc123.js', '/concierge/ocr/lang/chi_sim.traineddata.gz', '/concierge/ocr/name-model.onnx?v=1']) {
      const res = await app.inject({ url, headers: { 'accept-encoding': 'br, gzip' } });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toMatch(/^text\/plain/);
      expect(res.headers['cache-control'], url).toBe('no-store');
      expect(res.body, url).not.toContain('浴族');
    }
    const page = await app.inject({ url: '/concierge' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('浴族');
  });

  it('不支持压缩时发原文件；首页与前端路由照常不缓存', async () => {
    const plain = await app.inject({ url: '/assets/app-abc123.js', headers: { 'accept-encoding': 'identity' } });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toBe(js);
    for (const url of ['/', '/erp/revenue']) {
      const page = await app.inject({ url, headers: { 'accept-encoding': 'br, gzip' } });
      expect(page.statusCode, url).toBe(200);
      expect(page.headers['content-type'], url).toMatch(/^text\/html/);
      expect(page.headers['cache-control'], url).toBe('no-cache');
      expect(page.body, url).toContain('浴族');
    }
  });
});
