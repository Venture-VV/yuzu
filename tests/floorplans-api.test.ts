// 底图转换的后台接口（飞书需求 RQ-004 第二段，v0.7.15）：上传 → 单独的进程转换 → 预览（底图、轮廓、例外、与台账和在用批次的差异）→ 启用；
// 在用底图的只读接口（第三段房态图用）、每层 SVG 的权限、自检、只追加。图纸是合成样例（src/server/demo/floorplan-sample.ts）。

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActiveFloorplan, FloorplanDetail, FloorplanList } from '../src/shared/floorplans';
import expected from '../src/server/demo/floorplan-expected.json';
import { floorplanSampleDxf, floorplanSampleFloorSwapDxf } from '../src/server/demo/floorplan-sample';
import { floorplanChecks } from '../src/server/modules/floorplans';
import { createStaff } from '../src/server/modules/staff';
import { buildApp } from '../src/server/app';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
/** 入库登记（v0.7.19）：来源、收图日期必填；UTC 日期不会晚于门店当地的今天 */
const RECEIVED_ON = new Date().toISOString().slice(0, 10);
const upload = (content: string, fileName = 'sample.dxf', cookie = ctx.owner, extra: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', '/api/admin/floorplans', { fileName, contentBase64: b64(content), note: '', sourceKind: 'designer', receivedOn: RECEIVED_ON, ...extra });
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
/** 启用：带上页面看到的在用批次 */
const activate = (id: number, expectedActiveId: number | null, cookie = ctx.owner) => api(ctx.app, cookie, 'POST', `/api/admin/floorplans/${id}/activate`, { expectedActiveId });
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
    // 不带页面上的在用批次：拒绝
    expect((await api(ctx.app, boss, 'POST', `/api/admin/floorplans/${v1}/activate`)).status).toBe(400);
    const r = await activate(v1, null, boss);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.batch).toMatchObject({ status: 'active', activatedByName: '店长' });
    // 同一次启用再发一次（结果不明后重提）：已经在用，不报错
    expect((await activate(v1, null, boss)).status).toBe(200);
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
    expect(diff.moved).toEqual(expected.v2.batchDiffAgainstV1.moved);
    expect(diff.floorChanged).toEqual(expected.v2.batchDiffAgainstV1.floorChanged);
    // 页面还以为没有在用的（例如超时后迟到的请求、另一个标签页）：在用的已经是第一版，拒绝，第一版不被换下
    const stale = await activate(v2, null);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('FLOORPLAN_STALE');
    expect(((await api(ctx.app, ctx.owner, 'GET', '/api/admin/floorplans')).body as FloorplanList).activeId).toBe(v1);
    const act = await activate(v2, v1);
    expect(act.status).toBe(200);
    const list = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/floorplans')).body as FloorplanList;
    expect(list.activeId).toBe(v2);
    expect(list.batches.find((b) => b.id === v1)!.status).toBe('retired');
    // 已换下的不能「启用」，要写原因「换回」（v0.7.19）
    const again = await activate(v1, v2);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('FLOORPLAN_NOT_READY');
    expect(again.body.error.message).toContain('换回这一批');
    // 第二版那次启用晚到地再发一次：已经在用，不报错，也不换下什么
    expect((await activate(v2, v1)).status).toBe(200);
    expect(((await api(ctx.app, ctx.owner, 'GET', '/api/admin/floorplans')).body as FloorplanList).activeId).toBe(v2);
    // 在用的那批与它换下的那批比
    expect((await detail(v2)).batchDiff!.againstBatchId).toBe(v1);
    // 原来那一批的底图前台看不到了
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/floorplans/${v1}/floors/L3/svg`)).status).toBe(404);
  }, 60_000);

  it('与在用的那一批比对：同一个编码换了楼层单独列出（不算增减、不算挪动）', async () => {
    // 第二版上把三层的 T305 与二层的 X201 对调（docs/data/floorplan-sample-v2-swap.dxf）
    const r = await upload(floorplanSampleFloorSwapDxf(), '编码对调.dxf');
    expect(r.status).toBe(202);
    const d = await waitReady(r.body.batch.id);
    expect(d.batch.status, d.batch.error ?? '').toBe('ready');
    // 楼层按图上的标题定，不因为编码的楼层位对不上而认错
    expect(d.floors.map((f) => f.code)).toEqual(expected.v2swap.floors);
    const want = expected.v2swap.batchDiffAgainstV2;
    expect(d.batchDiff!.floorChanged).toEqual(want.floorChanged);
    expect(d.batchDiff!.added).toEqual(want.added);
    expect(d.batchDiff!.removed.map((x) => x.code)).toEqual(want.removed);
    expect(d.batchDiff!.renamed.map((x) => [x.from, x.to])).toEqual(want.renamed);
    expect(d.batchDiff!.moved).toEqual(want.moved);
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
    const act = await activate(r.body.batch.id, null);
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

describe('同时只转换一份；应用重启时没转完的记失败（v0.7.15 验收报告的测试缺口）', () => {
  it('有一份在转换时再上传另一份：409 FLOORPLAN_BUSY、写明是哪一份、不留批次；重启后那一份记「转换中断」，再上传就能转', async () => {
    // 占住转换：直接放一批「转换中」（代替一个还没跑完的转换进程）
    const [busy] = await ctx.sql<{ id: number }[]>`
      INSERT INTO floorplan_batches (file_name, file_sha256, file_bytes, file_format, converter, created_by)
      VALUES ('占着转换的图纸.dwg', ${'a'.repeat(64)}, 1024, 'dwg', 'yuzu-floorplan/1', ${ctx.ownerId}) RETURNING id`;
    const count = async () => (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM floorplan_batches`)[0]!.n;
    const before = await count();
    const content = `999\n测试：占着转换时上传 ${Date.now()}\n${floorplanSampleDxf(1)}`;
    const r = await upload(content, '另一份.dxf');
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error.code).toBe('FLOORPLAN_BUSY');
    expect(r.body.error.message).toContain('占着转换的图纸.dwg');
    expect(await count()).toBe(before);
    // 应用重启（新起一个实例）：启动时把没转完的记失败
    const restarted = await buildApp(ctx.sql, ctx.config);
    await restarted.ready();
    await restarted.close();
    const [after] = await ctx.sql<{ status: string; error: string | null; finishedAt: string | null }[]>`
      SELECT status, error, finished_at FROM floorplan_batches WHERE id = ${busy!.id}`;
    expect(after).toMatchObject({ status: 'failed', error: '转换中断（系统重启），请重新上传' });
    expect(after!.finishedAt).not.toBeNull();
    // 不再占着：再上传就接下来转换
    const again = await upload(content, '另一份.dxf');
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    const d = await waitReady(again.body.batch.id);
    expect(d.batch.status, d.batch.error ?? '').toBe('ready');
  }, 60_000);
});

// ───────────────────────── v0.7.19 图纸治理与补画轮廓（docs/FLOORPLAN_FINISH.md 第 4、5 节） ─────────────────────────

const list = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/floorplans')).body as FloorplanList;
const byName = async (name: string) => (await list()).batches.find((b) => b.fileName === name)!;
const restore = (id: number, body: Record<string, unknown>, cookie = ctx.owner) => api(ctx.app, cookie, 'POST', `/api/admin/floorplans/${id}/restore`, body);
const original = (id: number, cookie = ctx.owner) => ctx.app.inject({ method: 'GET', url: `/api/admin/floorplans/${id}/original`, headers: { cookie } });

describe('图纸治理（v0.7.19）：入库登记、原图纸、底图档案与在用历史、换回旧底图', () => {
  it('上传要登记来源与收图日期，收图日期不能晚于今天；登记记在批次上、不能改；勾了「保存原图纸」的能下载（店员不能），没勾的 404', async () => {
    const content = `999\n图纸治理 ${Date.now()}\n${floorplanSampleDxf(1)}`;
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/floorplans', { fileName: 'x.dxf', contentBase64: b64(content), receivedOn: RECEIVED_ON })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/floorplans', { fileName: 'x.dxf', contentBase64: b64(content), sourceKind: 'designer' })).status).toBe(400);
    const future = await upload(content, 'x.dxf', ctx.owner, { receivedOn: '2999-01-01' });
    expect(future.status).toBe(422);
    expect(future.body.error.code).toBe('FUTURE_DATE');
    const r = await upload(content, '登记样例.dxf', ctx.owner, { sourceKind: 'store', sourceNote: '门店自测第 3 版', saveOriginal: true, pdfScale: 100 });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const d = await waitReady(r.body.batch.id);
    expect(d.batch.status, d.batch.error ?? '').toBe('ready');
    // DXF 不用比例：填了也不记
    expect(d.batch).toMatchObject({ sourceKind: 'store', sourceNote: '门店自测第 3 版', receivedOn: RECEIVED_ON, originalSaved: true, pdfScale: null, outlineCount: 0 });
    await expect(ctx.sql`UPDATE floorplan_batches SET source_note = 'x' WHERE id = ${d.batch.id}`).rejects.toThrow(/入库登记不能改/);
    const res = await original(d.batch.id);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString('utf8')).toBe(content);
    expect(res.headers['content-disposition']).toContain(encodeURIComponent('登记样例.dxf'));
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'export' AND target_type = 'floorplan_original'`;
    expect(audit!.n).toBe(1);
    expect((await original(d.batch.id, ctx.clerk)).statusCode).toBe(403);
    expect((await original((await byName('样例图纸第二版.dxf')).id)).statusCode).toBe(404);
    await expect(ctx.sql`DELETE FROM floorplan_originals WHERE batch_id = ${d.batch.id}`).rejects.toThrow(/只追加/);
  }, 60_000);

  it('换回旧底图：原因必填；页面看到的在用批次对不上拒绝；原来在用的换下（记原因）；在用历史记启用、换下、换回；记下当时的台账比对', async () => {
    const v1b = await byName('样例图纸.dxf');
    const v2b = await byName('样例图纸第二版.dxf');
    expect([v1b.status, v2b.status]).toEqual(['retired', 'active']);
    expect((await restore(v1b.id, { expectedActiveId: v2b.id })).status).toBe(400);
    expect((await restore(v1b.id, { expectedActiveId: v2b.id, reason: '错' })).status).toBe(400);
    expect((await restore(v1b.id, { expectedActiveId: null, reason: '第二版有误' })).body.error.code).toBe('FLOORPLAN_STALE');
    expect((await restore(v1b.id, { expectedActiveId: v2b.id, reason: '第二版有误' }, ctx.clerk)).status).toBe(403);
    const ready = (await byName('登记样例.dxf'))!;
    expect((await restore(ready.id, { expectedActiveId: v2b.id, reason: '试一下' })).body.error.code).toBe('FLOORPLAN_NOT_RETIRED');
    const reason = '第二版有误，先用回第一版';
    const r = await restore(v1b.id, { expectedActiveId: v2b.id, reason });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body as FloorplanDetail;
    expect(d.batch).toMatchObject({ status: 'active', retiredAt: null, retireReason: null });
    expect(d.activationLedgerDiff).toMatchObject({ kind: 'restore' });
    expect(d.activationLedgerDiff!.diff.matched).toBe(d.ledgerDiff!.matched);
    expect(d.history.map((h) => h.kind)).toEqual(['restore', 'retire', 'activate']);
    const l = await list();
    expect(l.activeId).toBe(v1b.id);
    expect(l.batches.find((b) => b.id === v2b.id)).toMatchObject({ status: 'retired', retireReason: reason, retiredByName: '测试店主' });
    expect(l.history.slice(0, 2).map((h) => [h.batchId, h.kind, h.reason])).toEqual([
      [v1b.id, 'restore', reason],
      [v2b.id, 'retire', reason],
    ]);
    // 迟到的重发：已经在用，不报错、不再换
    expect((await restore(v1b.id, { expectedActiveId: v2b.id, reason })).status).toBe(200);
    expect(((await api(ctx.app, ctx.clerk, 'GET', '/api/floorplans/active')).body as ActiveFloorplan).batchId).toBe(v1b.id);
    // 启用另一批时写换下的原因
    const act = await api(ctx.app, ctx.owner, 'POST', `/api/admin/floorplans/${ready.id}/activate`, { expectedActiveId: v1b.id, reason: '门店自测版更准' });
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    expect((await byName('样例图纸.dxf')).retireReason).toBe('门店自测版更准');
    expect((act.body as FloorplanDetail).activationLedgerDiff).toMatchObject({ kind: 'activate' });
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'floorplan_restore'`;
    expect(audit!.n).toBe(1);
    for (const c of await floorplanChecks(ctx.sql)) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }, 60_000);
});

describe('例外房间补画轮廓（v0.7.19）', () => {
  it('在用（或待启用）的批次上给例外编码点出轮廓：房态图读到补画的轮廓与面积；重画旧的作废留历史；页面看到的对不上拒绝；作废回到位置点；换下的只读', async () => {
    const activeId = (await list()).activeId!;
    const d0 = await detail(activeId);
    const leak = d0.rooms.find((r) => r.code === 'W306')!;
    expect(leak).toMatchObject({ status: 'leak', polygon: null, drawn: null });
    const [x, y] = leak.labelAt;
    const square = (h: number): [number, number][] => [
      [x - h, y - h],
      [x + h, y - h],
      [x + h, y + h],
      [x - h, y + h],
    ];
    const put = (code: string, body: Record<string, unknown>, cookie = ctx.owner, batch = activeId) =>
      api(ctx.app, cookie, 'PUT', `/api/admin/floorplans/${batch}/outlines/${code}`, body);
    const map = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/floormap')).body as { floorplanRev: number };
    expect((await put('W306', { polygon: square(100), expectedOutlineId: null }, ctx.clerk)).status).toBe(403);
    expect((await put('T301', { polygon: square(100), expectedOutlineId: null })).body.error.code).toBe('OUTLINE_NOT_EXCEPTION');
    expect((await put('Z999', { polygon: square(100), expectedOutlineId: null })).status).toBe(404);
    expect((await put('W306', { polygon: [[-5, 0], [100, 0], [100, 100]], expectedOutlineId: null })).body.error.code).toBe('OUTLINE_OUTSIDE');
    expect(
      (await put('W306', { polygon: [[x - 100, y - 100], [x + 100, y + 100], [x + 100, y - 100], [x - 100, y + 100]], expectedOutlineId: null })).body.error.code,
    ).toBe('OUTLINE_CROSSED');
    expect((await put('W306', { polygon: square(3), expectedOutlineId: null })).body.error.code).toBe('OUTLINE_TOO_SMALL');
    expect((await put('W306', { polygon: [[x, y], [x + 10, y]], expectedOutlineId: null })).status).toBe(400);

    const rev0 = (await map()).floorplanRev;
    const r = await put('W306', { polygon: square(150), expectedOutlineId: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const first = r.body.outlineId as number;
    const active = (await api(ctx.app, ctx.clerk, 'GET', '/api/floorplans/active')).body as ActiveFloorplan;
    const room = active.rooms.find((v) => v.code === 'W306')!;
    // 转换结果不变（仍是例外），轮廓与面积用补画的：3 米 × 3 米
    expect(room.status).toBe('leak');
    expect(room.polygon).toEqual(square(150));
    expect(room.areaM2).toBe(9);
    expect(room.drawn).toMatchObject({ id: first, byName: '测试店主' });
    expect(active.outlineRev).toBeGreaterThan(0);
    expect((await map()).floorplanRev).toBeGreaterThan(rev0);
    // 页面看到的补画对不上（别人刚画过）：拒绝
    expect((await put('W306', { polygon: square(120), expectedOutlineId: null })).body.error.code).toBe('OUTLINE_STALE');
    const r2 = await put('W306', { polygon: square(120), expectedOutlineId: first });
    expect(r2.status).toBe(200);
    const rows = await ctx.sql<{ voidedAt: string | null }[]>`SELECT voided_at FROM floorplan_room_outlines WHERE batch_id = ${activeId} AND code = 'W306' ORDER BY id`;
    expect(rows.map((v) => v.voidedAt !== null)).toEqual([true, false]);
    expect((await detail(activeId)).batch.outlineCount).toBe(1);
    await expect(ctx.sql`DELETE FROM floorplan_room_outlines WHERE id = ${first}`).rejects.toThrow(/不能删除/);
    await expect(ctx.sql`UPDATE floorplan_room_outlines SET area_centi_m2 = 1 WHERE id = ${first}`).rejects.toThrow(/只能作废一次/);
    for (const c of await floorplanChecks(ctx.sql)) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    // geojson 里 W306 变成多边形
    const g = (await ctx.app.inject({ method: 'GET', url: `/api/admin/floorplans/${activeId}/geojson`, headers: { cookie: ctx.owner } })).json();
    expect(g.features.find((f: { properties: { code: string } }) => f.properties.code === 'W306').geometry.type).toBe('Polygon');
    // 作废补画：回到只显示位置点
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/floorplans/${activeId}/outlines/W306/void`, { expectedOutlineId: first })).body.error.code).toBe('OUTLINE_STALE');
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/admin/floorplans/${activeId}/outlines/W306/void`, { expectedOutlineId: r2.body.outlineId });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(((await api(ctx.app, ctx.clerk, 'GET', '/api/floorplans/active')).body as ActiveFloorplan).rooms.find((w) => w.code === 'W306')!.polygon).toBeNull();
    // 已换下的批次只读
    const retired = (await list()).batches.find((b) => b.status === 'retired')!;
    expect((await put('W306', { polygon: square(150), expectedOutlineId: null }, ctx.owner, retired.id)).body.error.code).toBe('FLOORPLAN_READONLY');
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'floorplan_outline'`;
    expect(audit!.n).toBe(3);
  }, 60_000);
});
