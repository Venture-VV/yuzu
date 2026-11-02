// v0.7.19 · 飞书需求 RQ-004 第四段（docs/FLOORPLAN_FINISH.md 第 2 节）：对客导览——在用底图上按区域并成色块（后场不显示）、
// 中英文区域名、设施图标（按底图文字自动识别，员工区不认；手工补加、挪位置、隐藏；重新识别只替换自动的）、不带房号与经营数据、
// 去掉文字的底图、权限（所有岗位默认能看，岗位权限可以去掉）、后台的分类与颜色（版本号）、轮播秒数、规则总表。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectMarkerKind, type GuideAdmin, type GuideData } from '../src/shared/guide';
import type { FloorplanDetail } from '../src/shared/floorplans';
import { floorplanSampleDxf } from '../src/server/demo/floorplan-sample';
import { localToMm, mmToLocal, svgLabels } from '../src/server/modules/guide';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string; // 店总
let am: string; // 客户经理
let bo: string; // 后勤
let batchId = 0;
const readCsv = (file: string) => readFileSync(file, 'utf8').replace(/^﻿/, '');
const guide = async (cookie = ctx.clerk) => (await api(ctx.app, cookie, 'GET', '/api/guide')).body as GuideData;
const admin = async (cookie = ctx.owner) => (await api(ctx.app, cookie, 'GET', '/api/admin/guide')).body as GuideAdmin;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'am', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'bo', displayName: '后勤', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  [boss, am, bo] = [await login(ctx.app, 'boss'), await login(ctx.app, 'am'), await login(ctx.app, 'bo')];
  for (const [kind, file] of [
    ['zones', 'docs/data/space-zones-sample.csv'],
    ['spaces', 'docs/data/space-ledger-sample.csv'],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', { kind, fileName: file, csv: readCsv(file), encoding: 'UTF-8', clientKey: randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  // 样例台账导入时不带区域：SPA 房、足浴房挂到样例 SPA 区，客房挂到样例客房区，派对房挂到样例派对区
  const ledger = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/spaces')).body as {
    spaces: { id: number; code: string; version: number }[];
    zones: { id: number; name: string }[];
  };
  const zoneId = (name: string) => ledger.zones.find((z) => z.name === name)!.id;
  for (const [zone, codes] of [
    ['样例SPA区', ['T301', 'T302', 'V312', 'U310']],
    ['样例客房区', ['W301', 'W302']],
    ['样例派对区', ['X201']],
  ] as const) {
    const spaces = ledger.spaces.filter((x) => (codes as readonly string[]).includes(x.code)).map((x) => ({ id: x.id, version: x.version }));
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/bulk-zone', { spaces, zoneId: zoneId(zone) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  const up = await api(ctx.app, ctx.owner, 'POST', '/api/admin/floorplans', {
    fileName: '样例（带设施文字）.dxf',
    contentBase64: Buffer.from(floorplanSampleDxf(1, { facilities: true })).toString('base64'),
    sourceKind: 'other',
    receivedOn: new Date().toISOString().slice(0, 10),
  });
  expect(up.status, JSON.stringify(up.body)).toBe(202);
  batchId = up.body.batch.id;
  for (let i = 0; i < 300; i++) {
    const d = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/floorplans/${batchId}`)).body as FloorplanDetail;
    if (d.batch.status !== 'converting') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const plans = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/floorplans')).body as { activeId: number | null; activationSeq: number };
  const act = await api(ctx.app, ctx.owner, 'POST', `/api/admin/floorplans/${batchId}/activate`, { expectedActiveId: plans.activeId, expectedSeq: plans.activationSeq });
  expect(act.status, JSON.stringify(act.body)).toBe(200);
}, 60_000);
afterAll(async () => ctx.close());

describe('识别与坐标（纯函数）', () => {
  it('按关键字认设施，员工区、后场不认；底图文字解析；本地坐标与图纸毫米互换', () => {
    expect(detectMarkerKind('卫生间')).toBe('toilet');
    expect(detectMarkerKind('男卫')).toBe('toilet');
    expect(detectMarkerKind('WC')).toBe('toilet');
    expect(detectMarkerKind('客梯')).toBe('elevator');
    expect(detectMarkerKind('楼梯')).toBe('stairs');
    expect(detectMarkerKind('前台接待')).toBe('reception');
    expect(detectMarkerKind('出入口')).toBe('entrance');
    expect(detectMarkerKind('更衣室')).toBe('locker');
    expect(detectMarkerKind('自助餐厅')).toBe('dining');
    expect(detectMarkerKind('吸烟区')).toBe('smoking');
    for (const t of ['员工更衣', '货梯', '布草间', '设备间', '技师休息', '大厅', '']) expect(detectMarkerKind(t)).toBeNull();
    expect(svgLabels('<svg><g class="labels" fill="#6b7280"><text x="10" y="-2" font-size="30">卫生间</text><text x="5" y="6" font-size="30" transform="rotate(90 5 6)">A&amp;B</text></g></svg>')).toEqual([
      { x: 10, y: -2, text: '卫生间' },
      { x: 5, y: 6, text: 'A&B' },
    ]);
    const plan = { unitMm: 1 };
    const f = { frame: [-500, -14500, 30500, 500] };
    const mm = localToMm(plan, f, [1750, 120]);
    expect(mm).toEqual([17000, -700]);
    expect(mmToLocal(plan, f, mm)).toEqual([1750, 120]);
  });
});

describe('对客导览数据', () => {
  it('所有岗位默认都能看；按区域并成色块，写中英文区域名；不带房号、房态、人员', async () => {
    for (const cookie of [ctx.clerk, boss, am, bo]) expect((await api(ctx.app, cookie, 'GET', '/api/guide')).status).toBe(200);
    const g = await guide();
    expect(g.batchId).toBe(batchId);
    expect(g.floors.map((f) => f.code)).toEqual(['L2', 'L3']);
    expect(g.floors[0]!.svgUrl).toBe(`/api/guide/floors/L2/svg?b=${batchId}`);
    expect(g.zones.length).toBeGreaterThan(0);
    for (const z of g.zones) {
      expect(z.polygons.length).toBeGreaterThan(0);
      expect(z.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(z.kind).not.toBe('back');
    }
    // 不带房号（编码）：JSON 里没有任何编码
    const json = JSON.stringify(g);
    for (const code of ['T301', 'W301', 'X201', 'V312']) expect(json).not.toContain(code);
    expect(g.carouselSeconds).toBe(15);
  });

  it('底图去掉了图上的文字（员工区名称、设计标注不显示）；没有「看对客导览」的岗位 403', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/guide/floors/L3/svg?b=${batchId}`, headers: { cookie: ctx.clerk } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.body).not.toContain('class="labels"');
    expect(res.body).not.toContain('员工更衣');
    expect(res.body).toContain('class="wall"');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/guide/floors/L9/svg?b=${batchId}`, headers: { cookie: ctx.clerk } })).statusCode).toBe(404);
    // 地址上的批次不是在用的（页面还停在换底图之前）：不给，也不让浏览器缓存（Codex 复审 c0a1a7d）；不带批次 400
    const stale = await ctx.app.inject({ method: 'GET', url: `/api/guide/floors/L3/svg?b=${batchId + 1000}`, headers: { cookie: ctx.clerk } });
    expect(stale.statusCode).toBe(404);
    expect(stale.headers['cache-control']).toBe('no-store');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/guide/floors/L3/svg', headers: { cookie: ctx.clerk } })).statusCode).toBe(400);
    // 岗位权限去掉「看对客导览」：后勤看不到了
    const perms = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/permissions')).body as { effective: Record<string, string[]> };
    expect(perms.effective.backoffice).toContain('guide.view');
    const backoffice = perms.effective.backoffice!.filter((p) => p !== 'guide.view');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/permissions', { roles: { backoffice } })).status).toBe(200);
    const bo2 = await login(ctx.app, 'bo');
    expect((await api(ctx.app, bo2, 'GET', '/api/guide')).status).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/guide/floors/L3/svg`, headers: { cookie: bo2 } })).statusCode).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/permissions', { roles: { backoffice: [...backoffice, 'guide.view'] } })).status).toBe(200);
  });
});

describe('后台：区域的导览分类与颜色', () => {
  it('改成后场的区域从导览图上消失；单独指定颜色；版本号对不上拒绝；店员不能改', async () => {
    const a = await admin();
    const shown = a.zones.find((z) => z.drawnSpaces > 0)!;
    expect(shown.kind).toBe('public');
    const save = (body: Record<string, unknown>, cookie = ctx.owner) => api(ctx.app, cookie, 'PUT', `/api/admin/guide/zones/${shown.id}`, body);
    expect((await save({ kind: 'back', color: null, version: shown.version }, ctx.clerk)).status).toBe(403);
    expect((await save({ kind: 'nope', color: null, version: shown.version })).status).toBe(400);
    expect((await save({ kind: 'active', color: 'red', version: shown.version })).status).toBe(400);
    const r = await save({ kind: 'active', color: '#AA3322', version: shown.version }, boss);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = (r.body as GuideAdmin).zones.find((z) => z.id === shown.id)!;
    expect(after).toMatchObject({ kind: 'active', color: '#aa3322', shownColor: '#aa3322', version: shown.version + 1 });
    expect((await guide()).zones.find((z) => z.id === shown.id)).toMatchObject({ kind: 'active', color: '#aa3322' });
    // 页面上的版本号对不上（刚被别人改过）：拒绝
    expect((await save({ kind: 'quiet', color: null, version: shown.version })).body.error.code).toBe('ZONE_STALE');
    const back = await save({ kind: 'back', color: null, version: after.version });
    expect(back.status).toBe(200);
    expect((await guide()).zones.some((z) => z.id === shown.id)).toBe(false);
    const restored = (back.body as GuideAdmin).zones.find((z) => z.id === shown.id)!;
    expect((await save({ kind: 'quiet', color: null, version: restored.version })).status).toBe(200);
    // 没单独指定颜色的按分类取色（静区冷色）
    expect((await guide()).zones.find((z) => z.id === shown.id)!.color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('后台：设施图标', () => {
  it('按在用底图识别：卫生间、楼梯、电梯、前台、出入口认出来，员工更衣不认；导览图上画出来', async () => {
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/guide/markers/detect', {})).status).toBe(403);
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/guide/markers/detect', {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ detected: 6, replaced: 0 });
    const a = r.body.admin as GuideAdmin;
    expect(a.markers.map((m) => `${m.floorCode}:${m.kind}`).sort()).toEqual(['L2:elevator', 'L2:entrance', 'L2:reception', 'L3:elevator', 'L3:stairs', 'L3:toilet']);
    expect(a.markers.every((m) => m.source === 'auto' && m.onPlan && !m.hidden)).toBe(true);
    const g = await guide();
    expect(g.markers).toHaveLength(6);
    expect(g.markers.find((m) => m.kind === 'toilet')).toMatchObject({ floorCode: 'L3', label: '卫生间', labelEn: 'Restroom' });
  });

  it('手工补加、挪位置、隐藏、改中英文标签（版本号）；重新识别只替换自动识别的，手工加的不动', async () => {
    const floor = (await admin()).floors.find((f) => f.code === 'L3')!;
    // 补加带操作编号（缺了 400）
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/guide/markers', { floorCode: 'L3', kind: 'smoking', x: 100, y: 100 })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/guide/markers', { clientKey: randomUUID(), floorCode: 'L3', kind: 'smoking', x: -1, y: 10 })).body.error.code).toBe('MARKER_OUTSIDE');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/guide/markers', { clientKey: randomUUID(), floorCode: 'L9', kind: 'smoking', x: 10, y: 10 })).body.error.code).toBe('FLOOR_NOT_ON_PLAN');
    const key = randomUUID();
    const body = { clientKey: key, floorCode: 'L3', kind: 'smoking', x: 100, y: 100, label: '室外吸烟区', labelEn: 'Outdoor Smoking' };
    const add = await api(ctx.app, ctx.owner, 'POST', '/api/admin/guide/markers', body);
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    const manual = (add.body as GuideAdmin).markers.find((m) => m.source === 'manual')!;
    // 没收到结果又点了一次（同一个操作编号，位置略有不同）：不再加一个（Codex 复审 c0a1a7d）
    const again1 = await api(ctx.app, ctx.owner, 'POST', '/api/admin/guide/markers', { ...body, x: 120, y: 110 });
    expect(again1.status).toBe(200);
    expect((again1.body as GuideAdmin).markers.filter((m) => m.source === 'manual')).toHaveLength(1);
    // 同一个编号用到另一种图标上：拒绝
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/guide/markers', { ...body, kind: 'toilet' })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(manual).toMatchObject({ kind: 'smoking', x: 100, y: 100, label: '室外吸烟区', labelEn: 'Outdoor Smoking' });
    // 挪位置（存图纸坐标）
    const moved = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/guide/markers/${manual.id}`, { kind: 'smoking', x: floor.width - 50, y: 60, hidden: false, label: '室外吸烟区', labelEn: 'Outdoor Smoking', version: manual.version });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const m2 = (moved.body as GuideAdmin).markers.find((m) => m.id === manual.id)!;
    expect([m2.x, m2.y, m2.version]).toEqual([floor.width - 50, 60, manual.version + 1]);
    expect(m2.xMm).not.toBe(manual.xMm);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/guide/markers/${manual.id}`, { kind: 'smoking', hidden: true, version: manual.version })).body.error.code).toBe('MARKER_STALE');
    // 隐藏一个自动识别的电梯
    const elev = (await admin()).markers.find((m) => m.floorCode === 'L3' && m.kind === 'elevator')!;
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/guide/markers/${elev.id}`, { kind: 'elevator', hidden: true, version: elev.version })).status).toBe(200);
    expect((await guide()).markers.some((m) => m.id === elev.id)).toBe(false);
    expect((await guide()).markers.some((m) => m.id === manual.id)).toBe(true);
    // 重新识别：自动的 6 个替换掉（隐藏的那个也重新认出来），手工的留着
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/admin/guide/markers/detect', {});
    expect(again.body).toMatchObject({ detected: 6, replaced: 6 });
    const a = again.body.admin as GuideAdmin;
    expect(a.markers.filter((m) => m.source === 'auto')).toHaveLength(6);
    expect(a.markers.find((m) => m.id === manual.id)).toMatchObject({ x: floor.width - 50, y: 60, source: 'manual' });
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('guide_marker_saved', 'guide_markers_detected')`;
    expect(audit!.n).toBe(5);
  });
});

describe('轮播秒数与规则总表', () => {
  it('店主改轮播秒数（5–300），店总不能改；规则总表列出开单即占用与轮播（待确认）', async () => {
    expect((await api(ctx.app, boss, 'PUT', '/api/admin/guide/rules', { carouselSeconds: 20 })).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/guide/rules', { carouselSeconds: 3 })).status).toBe(400);
    const r = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/guide/rules', { carouselSeconds: 20 });
    expect(r.status).toBe(200);
    expect((r.body as GuideAdmin).rules.carouselSeconds).toBe(20);
    expect((await guide()).carouselSeconds).toBe(20);
    const catalog = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/rules')).body as { key: string; group: string; isDefault: boolean; pending: boolean }[];
    expect(catalog.filter((x) => x.group === 'floormap').map((x) => [x.key, x.isDefault, x.pending])).toEqual([
      ['usage_rules.businessTypes', true, true],
      ['guide_rules.carouselSeconds', false, true],
    ]);
  });
});
