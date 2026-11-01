// 底图转换的后台接口（飞书需求 RQ-004 第二段，v0.7.15）：上传 → 单独的进程转换 → 预览（底图、轮廓、例外、与台账和在用批次的差异）→ 启用；
// 在用底图的只读接口（第三段房态图用）、每层 SVG 的权限、自检、只追加。图纸是合成样例（src/server/demo/floorplan-sample.ts）。

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActiveFloorplan, FloorplanDetail, FloorplanList } from '../src/shared/floorplans';
import expected from '../src/server/demo/floorplan-expected.json';
import { floorplanSampleDxf } from '../src/server/demo/floorplan-sample';
import { floorplanChecks } from '../src/server/modules/floorplans';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const upload = (content: string, fileName = 'sample.dxf', cookie = ctx.owner) =>
  api(ctx.app, cookie, 'POST', '/api/admin/floorplans', { fileName, contentBase64: b64(content), note: '' });
const detail = async (id: number, cookie = ctx.owner) => (await api(ctx.app, cookie, 'GET', `/api/admin/floorplans/${id}`)).body as FloorplanDetail;
/** 等转换进程跑完 */
async function waitReady(id: number): Promise<FloorplanDetail> {
  for (let i = 0; i < 300; i++) {
    const d = await detail(id);
    if (d.batch.status !== 'converting') return d;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('转换超时');
}
const codes = (list: { code: string }[]) => list.map((x) => x.code).sort();
const readCsv = (file: string) => readFileSync(file, 'utf8').replace(/^﻿/, '');

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'boss', displayName: '店长', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  boss = await login(ctx.app, 'boss');
  // 样例台账（docs/data 的区域清单、空间清单）：比对按这份
  for (const [kind, file] of [
    ['zones', 'docs/data/space-zones-sample.csv'],
    ['spaces', 'docs/data/space-ledger-sample.csv'],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', { kind, fileName: file, csv: readCsv(file), encoding: 'UTF-8', clientKey: randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
});
afterAll(async () => ctx.close());

describe('上传与转换', () => {
  let v1 = 0;

  it('不是 DWG / DXF 的文件、空文件直接拒绝，不记批次', async () => {
    const bad = await upload('楼层,编码\nL3,S301', 'a.csv');
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('FLOORPLAN_FORMAT');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/floorplans', { fileName: 'a.dwg', contentBase64: '' })).status).toBe(400);
    expect(((await api(ctx.app, ctx.owner, 'GET', '/api/admin/floorplans')).body as FloorplanList).batches).toEqual([]);
  });

  it('店员不能上传、不能看批次', async () => {
    expect((await upload(floorplanSampleDxf(), 'a.dxf', ctx.clerk)).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/floorplans')).status).toBe(403);
  });

  it('上传后立刻返回「转换中」；转换完成后有两层底图、11 个编码与例外', async () => {
    const r = await upload(floorplanSampleDxf(1), '样例图纸.dxf');
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.batch).toMatchObject({ status: 'converting', fileName: '样例图纸.dxf', fileFormat: 'dxf', converter: 'yuzu-floorplan/1' });
    v1 = r.body.batch.id;
    // 转换中再传另一份：拒绝（同时只转换一份）
    const busy = await upload(floorplanSampleDxf(2), 'v2.dxf');
    if (busy.status === 409) expect(busy.body.error.code).toBe('FLOORPLAN_BUSY');
    else expect(busy.status).toBe(202); // 极少数情况下第一份已经转完
    const d = await waitReady(v1);
    expect(d.batch.status, d.batch.error ?? '').toBe('ready');
    expect(d.floors.map((f) => f.code)).toEqual(expected.floors);
    expect(d.batch).toMatchObject({ floorCount: 2, roomCount: 11, okCount: 8 });
    expect(codes(d.rooms.filter((x) => x.status === 'ok'))).toEqual([...expected.v1.ok].sort());
    expect(codes(d.rooms.filter((x) => x.status === 'merged'))).toEqual(expected.v1.merged);
    expect(codes(d.rooms.filter((x) => x.status === 'leak'))).toEqual(expected.v1.leak);
    expect(d.report!.layers.find((l) => l.name === 'P-活动家具')).toMatchObject({ cls: 'exclude' });
    expect(d.report!.worker!.peakRssMb).toBeGreaterThan(0);
    // 第二份要是被接下了，也等它转完，后面的用例按顺序来
    if (busy.status === 202) await waitReady(busy.body.batch.id);
  }, 60_000);

  it('与空间台账比对：图上多出的、台账多出的、原始标注变了的，以台账为准', async () => {
    const d = await detail(v1);
    const diff = d.ledgerDiff!;
    expect(codes(diff.onlyDrawing)).toEqual(expected.v1.ledgerDiff.onlyDrawing);
    expect(codes(diff.onlyLedger)).toEqual(expected.v1.ledgerDiff.onlyLedger);
    expect(diff.floorMismatch).toEqual([]);
    expect(codes(diff.labelChanged)).toEqual(expected.v1.ledgerDiff.labelChanged);
    expect(diff.labelChanged[0]).toMatchObject({ drawingLabel: '样例 SPA T302 1人间', ledgerLabel: '样例 SPA T302 2人间' });
    expect(diff.matched).toBe(expected.v1.ledgerDiff.matched);
    // 还没有在用的批次：不比
    expect(d.batchDiff).toBeNull();
  });

  it('同一份图纸再传：回到原来那一批，不重复转换', async () => {
    const again = await upload(floorplanSampleDxf(1), '换个名字.dxf');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, batch: { id: v1 } });
  });

  it('每层底图：后台能看任何一批；没启用的批次前台岗位看不到', async () => {
    const svg = await ctx.app.inject({ method: 'GET', url: `/api/floorplans/${v1}/floors/L3/svg`, headers: { cookie: ctx.owner } });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(svg.body).toContain('class="wall"');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/floorplans/${v1}/floors/L3/svg`)).status).toBe(404);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/floorplans/${v1}/floors/L9/svg`)).status).toBe(404);
  });

  it('启用：店长可以启用；在用的底图前台客房岗位能读（房间按编码对上台账）', async () => {
    expect(((await api(ctx.app, ctx.clerk, 'GET', '/api/floorplans/active')).body as ActiveFloorplan).batchId).toBeNull();
    const r = await api(ctx.app, boss, 'POST', `/api/admin/floorplans/${v1}/activate`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.batch).toMatchObject({ status: 'active', activatedByName: '店长' });
    // 再点一次：不报错
    expect((await api(ctx.app, boss, 'POST', `/api/admin/floorplans/${v1}/activate`)).status).toBe(200);
    const active = (await api(ctx.app, ctx.clerk, 'GET', '/api/floorplans/active')).body as ActiveFloorplan;
    expect(active.batchId).toBe(v1);
    expect(active.floors.map((f) => f.svgUrl)).toEqual([`/api/floorplans/${v1}/floors/L2/svg`, `/api/floorplans/${v1}/floors/L3/svg`]);
    expect(active.rooms.find((x) => x.code === 'T301')).toMatchObject({ status: 'ok', displayName: '样例 SPA 1人间' });
    expect(active.rooms.find((x) => x.code === 'T301')!.spaceId).toBeGreaterThan(0);
    expect(active.rooms.find((x) => x.code === 'T303')).toMatchObject({ spaceId: null, displayName: null });
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/floorplans/${v1}/floors/L3/svg`)).status).toBe(200);
    const audit = await ctx.sql`SELECT action FROM audit_logs WHERE target_type = 'floorplan_batch' ORDER BY id`;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['floorplan_upload', 'floorplan_activate']));
  });

  it('第二版：与在用的那一批比对出房间增减、编码变更；启用后原来的换下，换下的不能再启用', async () => {
    const r = await upload(floorplanSampleDxf(2), '样例图纸第二版.dxf');
    expect([200, 202]).toContain(r.status);
    const v2 = r.body.batch.id as number;
    const d = await waitReady(v2);
    expect(d.batch.status).toBe('ready');
    expect(codes(d.rooms.filter((x) => x.status === 'ok'))).toEqual([...expected.v2.ok].sort());
    const diff = d.batchDiff!;
    expect(diff.againstBatchId).toBe(v1);
    expect(diff.added).toEqual([]);
    expect(diff.removed.map((x) => x.code)).toEqual(expected.v2.batchDiffAgainstV1.removed);
    expect(diff.renamed.map((x) => [x.from, x.to])).toEqual(expected.v2.batchDiffAgainstV1.renamed);
    expect(diff.moved).toEqual([]);
    const act = await api(ctx.app, ctx.owner, 'POST', `/api/admin/floorplans/${v2}/activate`);
    expect(act.status).toBe(200);
    const list = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/floorplans')).body as FloorplanList;
    expect(list.activeId).toBe(v2);
    expect(list.batches.find((b) => b.id === v1)!.status).toBe('retired');
    const again = await api(ctx.app, ctx.owner, 'POST', `/api/admin/floorplans/${v1}/activate`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('FLOORPLAN_NOT_READY');
    // 在用的那批与它换下的那批比
    expect((await detail(v2)).batchDiff!.againstBatchId).toBe(v1);
    // 原来那一批的底图前台看不到了
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/floorplans/${v1}/floors/L3/svg`)).status).toBe(404);
  }, 60_000);

  it('spaces.geojson：每个编码一个要素，配上的是多边形、例外是点', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/admin/floorplans/${v1}/geojson`, headers: { cookie: ctx.owner } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('spaces');
    const g = res.json();
    expect(g.type).toBe('FeatureCollection');
    expect(g.features).toHaveLength(11);
    expect(g.features.find((f: { properties: { code: string } }) => f.properties.code === 'T301').geometry.type).toBe('Polygon');
    expect(g.features.find((f: { properties: { code: string } }) => f.properties.code === 'W306').geometry.type).toBe('Point');
  });

  it('读不了的图纸记「转换失败」与原因；失败的同一份可以重传', async () => {
    const r = await upload('AC1032 不是真的 DWG', 'broken.dwg');
    expect(r.status).toBe(202);
    const d = await waitReady(r.body.batch.id);
    expect(d.batch).toMatchObject({ status: 'failed', fileFormat: 'dwg' });
    expect(d.batch.error).toMatch(/读不了这个文件/);
    const again = await upload('AC1032 不是真的 DWG', 'broken.dwg');
    expect(again.status).toBe(202);
    expect(again.body.batch.id).not.toBe(r.body.batch.id);
    await waitReady(again.body.batch.id);
    const act = await api(ctx.app, ctx.owner, 'POST', `/api/admin/floorplans/${r.body.batch.id}/activate`);
    expect(act.status).toBe(409);
  }, 60_000);

  it('自检通过；底图与轮廓只追加，批次不能删', async () => {
    for (const c of await floorplanChecks(ctx.sql)) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    await expect(ctx.sql`UPDATE floorplan_rooms SET label = 'x' WHERE batch_id = ${v1}`).rejects.toThrow(/只追加/);
    await expect(ctx.sql`DELETE FROM floorplan_floors WHERE batch_id = ${v1}`).rejects.toThrow(/只追加/);
    await expect(ctx.sql`DELETE FROM floorplan_batches WHERE id = ${v1}`).rejects.toThrow(/不能删除/);
    await expect(ctx.sql`UPDATE floorplan_batches SET status = 'ready' WHERE id = ${v1}`).rejects.toThrow(/状态不能/);
  });
});
