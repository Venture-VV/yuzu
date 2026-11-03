// 对客导览（飞书需求 RQ-004 第四段，v0.7.19，见 docs/FLOORPLAN_FINISH.md 第 2 节）：
//   · 对客页面（GET /api/guide，「看对客导览」，默认所有岗位）：在用底图的楼层；按区域把空间轮廓并成色块（后场不显示），
//     区域中英文名、设施图标；底图去掉图上的文字（/api/guide/floors/:floor/svg）；不带房号、房态、人员、任何经营数据；
//   · 后台（空间台账 → 对客导览，店主、店总）：区域的导览分类与颜色、设施图标（按在用底图的文字自动识别，可挪位置、隐藏、补加）、
//     大屏轮播秒数（店主）。图标存图纸坐标（毫米），换了底图也能对上位置。
// 加锁：区域的导览分类与颜色走空间台账的咨询锁（与台账的其他写入串行）、带版本号；图标修改只锁那一行、带版本号；
// 重新识别先取「导览图标」咨询锁，只替换自动识别的，手工加的不动。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_GUIDE_RULES,
  GUIDE_COLOR_PATTERN,
  GUIDE_KINDS,
  GUIDE_MARKER_KINDS,
  GUIDE_MARKER_LABELS,
  MAX_CAROUSEL_SECONDS,
  MIN_CAROUSEL_SECONDS,
  detectMarkerKind,
  zoneColor,
  type GuideAdmin,
  type GuideAdminMarker,
  type GuideAdminZone,
  type GuideData,
  type GuideFloor,
  type GuideKind,
  type GuideMarker,
  type GuideMarkerKind,
  type GuideRules,
  type GuideZone,
} from '@shared/guide';
import type { Db } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { LOCAL_UNIT_MM } from '../floorplan/convert';
import { setTxTimeouts } from '../lib/tx';
import { batchFloors, batchRooms } from './floorplans';
import { loadSettings } from './settings';
import { lockLedger } from './spaces';
import { ctxOf } from '../lib/context';
import { saveRuleSetting } from '../lib/rule-settings';

// ───────────────────────── 规则 ─────────────────────────

export async function loadGuideRules(db: Db): Promise<GuideRules> {
  const [row] = await db<{ value: Partial<GuideRules> }[]>`SELECT value FROM settings WHERE key = 'guide_rules'`;
  return { ...DEFAULT_GUIDE_RULES, ...(row?.value ?? {}) };
}

const RulesInput = z.object({
  carouselSeconds: z
    .number('轮播秒数不正确')
    .int('轮播秒数要是整数')
    .min(MIN_CAROUSEL_SECONDS, `轮播每层至少 ${MIN_CAROUSEL_SECONDS} 秒`)
    .max(MAX_CAROUSEL_SECONDS, `轮播每层最多 ${MAX_CAROUSEL_SECONDS} 秒`),
});

async function saveGuideRules(deps: Deps, raw: unknown, ctx: OpContext) {
  const next = parse(RulesInput, raw);
  await saveRuleSetting(deps.sql, 'guide_rules', loadGuideRules, () => next, ctx);
}

// ───────────────────────── 坐标：本地（10 毫米一单位，图框左上角为原点、y 向下）↔ 图纸（毫米） ─────────────────────────

interface FloorFrame {
  code: string;
  title: string;
  width: number;
  height: number;
  frame: number[];
}

interface ActivePlan {
  batchId: number;
  unitMm: number;
  floors: FloorFrame[];
}

async function activePlan(db: Db): Promise<ActivePlan | null> {
  const [b] = await db<{ id: number; report: { params?: { unitMm?: number } } | null }[]>`SELECT id, report FROM floorplan_batches WHERE status = 'active'`;
  if (!b) return null;
  const batchId = Number(b.id);
  const floors = (await batchFloors(db, batchId)).map((f) => ({ code: f.floor.code, title: f.floor.title, width: f.floor.width, height: f.floor.height, frame: f.frame as number[] }));
  return { batchId, unitMm: Number(b.report?.params?.unitMm ?? 1) || 1, floors };
}

/** 本地坐标 → 图纸毫米 */
export function localToMm(plan: { unitMm: number }, f: { frame: number[] }, [x, y]: [number, number]): [number, number] {
  const k = LOCAL_UNIT_MM / plan.unitMm;
  return [Math.round((f.frame[0]! + x * k) * plan.unitMm), Math.round((f.frame[3]! - y * k) * plan.unitMm)];
}

/** 图纸毫米 → 本地坐标 */
export function mmToLocal(plan: { unitMm: number }, f: { frame: number[] }, [xMm, yMm]: [number, number]): [number, number] {
  const k = LOCAL_UNIT_MM / plan.unitMm;
  return [Math.round((xMm / plan.unitMm - f.frame[0]!) / k), Math.round((f.frame[3]! - yMm / plan.unitMm) / k)];
}

const guideSvgUrl = (batchId: number, floorCode: string) => `/api/guide/floors/${floorCode}/svg?b=${batchId}`;
const toGuideFloor = (batchId: number, f: FloorFrame): GuideFloor => ({ code: f.code, title: f.title, width: f.width, height: f.height, svgUrl: guideSvgUrl(batchId, f.code) });

// ───────────────────────── 区域色块 ─────────────────────────

function polygonArea(poly: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j]![0] + poly[i]![0]) * (poly[j]![1] - poly[i]![1]);
  return Math.abs(a / 2);
}

function polygonCentroid(poly: [number, number][]): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x0, y0] = poly[j]!;
    const [x1, y1] = poly[i]!;
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

interface ZoneRow {
  id: number;
  version: number;
  floorCode: string;
  floorName: string;
  name: string;
  nameEn: string;
  kind: GuideKind;
  color: string | null;
  sortOrder: number;
  active: boolean;
}

async function zoneRows(db: Db): Promise<ZoneRow[]> {
  return db<ZoneRow[]>`
    SELECT z.id, z.version, f.code AS floor_code, f.name AS floor_name, z.name, z.name_en, z.guide_kind AS kind, z.guide_color AS color, z.sort_order, (z.active AND f.active) AS active
    FROM zones z JOIN floors f ON f.id = z.floor_id
    ORDER BY f.sort_order, f.code, z.sort_order, z.id`;
}

/** 每个区域的色块：在用底图上、区域里在用空间的轮廓（后场、停用的区域不画） */
async function zoneShapes(db: Db, plan: ActivePlan | null) {
  const zones = await zoneRows(db);
  const shapes = new Map<number, { polygons: [number, number][][]; area: number; labelAt: [number, number] | null }>();
  const colors = new Map<number, string | null>();
  // 颜色：同一层、同一分类里按区域顺序轮流取色
  const counter = new Map<string, number>();
  for (const z of zones) {
    if (!z.active) continue;
    const key = `${z.floorCode}:${z.kind}`;
    const i = counter.get(key) ?? 0;
    counter.set(key, i + 1);
    colors.set(Number(z.id), zoneColor(z.kind, z.color, i));
  }
  if (plan) {
    const rooms = await batchRooms(db, plan.batchId);
    const spaces = await db<{ code: string; zoneId: number; floorCode: string }[]>`
      SELECT sp.code, sp.zone_id, f.code AS floor_code FROM spaces sp JOIN floors f ON f.id = sp.floor_id WHERE sp.active AND sp.zone_id IS NOT NULL`;
    const zoneOf = new Map(spaces.map((s) => [s.code, { zoneId: Number(s.zoneId), floorCode: s.floorCode }]));
    for (const r of rooms) {
      const s = zoneOf.get(r.code);
      if (!s || !r.polygon || s.floorCode !== r.floorCode) continue;
      const cur = shapes.get(s.zoneId) ?? { polygons: [], area: 0, labelAt: null };
      cur.polygons.push(r.polygon);
      shapes.set(s.zoneId, cur);
    }
    for (const sh of shapes.values()) {
      let total = 0;
      let cx = 0;
      let cy = 0;
      for (const p of sh.polygons) {
        const a = polygonArea(p);
        const [x, y] = polygonCentroid(p);
        total += a;
        cx += x * a;
        cy += y * a;
      }
      sh.area = total;
      sh.labelAt = total > 0 ? [Math.round(cx / total), Math.round(cy / total)] : polygonCentroid(sh.polygons[0]!);
    }
  }
  return { zones, shapes, colors };
}

// ───────────────────────── 图标 ─────────────────────────

interface MarkerRow {
  id: number;
  floorCode: string;
  kind: GuideMarkerKind;
  xMm: number;
  yMm: number;
  label: string;
  labelEn: string;
  source: 'auto' | 'manual';
  hidden: boolean;
  version: number;
}

const markerRows = (db: Db) =>
  db<MarkerRow[]>`SELECT id, floor_code, kind, x_mm, y_mm, label, label_en, source, hidden, version FROM guide_markers ORDER BY floor_code, kind, id`;

function placeMarker(plan: ActivePlan | null, m: MarkerRow): { x: number; y: number; onPlan: boolean } {
  const f = plan?.floors.find((x) => x.code === m.floorCode);
  if (!plan || !f) return { x: 0, y: 0, onPlan: false };
  const [x, y] = mmToLocal(plan, f, [Number(m.xMm), Number(m.yMm)]);
  return { x, y, onPlan: x >= 0 && y >= 0 && x <= f.width && y <= f.height };
}

const markerLabel = (m: Pick<MarkerRow, 'kind' | 'label' | 'labelEn'>) => ({
  label: m.label || GUIDE_MARKER_LABELS[m.kind].zh,
  labelEn: m.labelEn || GUIDE_MARKER_LABELS[m.kind].en,
});

// ───────────────────────── 读取 ─────────────────────────

/** 对客页面的数据：没有房号、房态、人员 */
export async function guideData(db: Db): Promise<GuideData> {
  const settings = await loadSettings(db);
  const rules = await loadGuideRules(db);
  const plan = await activePlan(db);
  if (!plan) return { storeName: settings.storeName, batchId: null, floors: [], zones: [], markers: [], carouselSeconds: rules.carouselSeconds };
  const { zones, shapes, colors } = await zoneShapes(db, plan);
  const floorCodes = new Set(plan.floors.map((f) => f.code));
  const outZones: GuideZone[] = [];
  for (const z of zones) {
    const sh = shapes.get(Number(z.id));
    const color = colors.get(Number(z.id));
    if (!z.active || z.kind === 'back' || !sh || !sh.polygons.length || !color || !floorCodes.has(z.floorCode)) continue;
    outZones.push({ id: Number(z.id), floorCode: z.floorCode, name: z.name, nameEn: z.nameEn, kind: z.kind, color, polygons: sh.polygons, labelAt: sh.labelAt!, area: Math.round(sh.area) });
  }
  const markers: GuideMarker[] = [];
  for (const m of await markerRows(db)) {
    if (m.hidden) continue;
    const p = placeMarker(plan, m);
    if (!p.onPlan) continue;
    markers.push({ id: Number(m.id), floorCode: m.floorCode, kind: m.kind, x: p.x, y: p.y, ...markerLabel(m) });
  }
  return { storeName: settings.storeName, batchId: plan.batchId, floors: plan.floors.map((f) => toGuideFloor(plan.batchId, f)), zones: outZones, markers, carouselSeconds: rules.carouselSeconds };
}

export async function guideAdmin(db: Db): Promise<GuideAdmin> {
  const plan = await activePlan(db);
  const { zones, shapes, colors } = await zoneShapes(db, plan);
  const counts = new Map(
    (await db<{ zoneId: number; n: number }[]>`SELECT zone_id, count(*)::int AS n FROM spaces WHERE active AND zone_id IS NOT NULL GROUP BY zone_id`).map((r) => [Number(r.zoneId), r.n]),
  );
  const outZones: GuideAdminZone[] = zones
    .filter((z) => z.active)
    .map((z) => ({
      id: Number(z.id),
      version: z.version,
      floorCode: z.floorCode,
      floorName: z.floorName,
      name: z.name,
      nameEn: z.nameEn,
      kind: z.kind,
      color: z.color,
      shownColor: colors.get(Number(z.id)) ?? null,
      drawnSpaces: shapes.get(Number(z.id))?.polygons.length ?? 0,
      spaceCount: counts.get(Number(z.id)) ?? 0,
    }));
  const markers: GuideAdminMarker[] = (await markerRows(db)).map((m) => {
    const p = placeMarker(plan, m);
    return { id: Number(m.id), floorCode: m.floorCode, kind: m.kind, x: p.x, y: p.y, ...markerLabel(m), source: m.source, hidden: m.hidden, version: m.version, xMm: Number(m.xMm), yMm: Number(m.yMm), onPlan: p.onPlan };
  });
  return { rules: await loadGuideRules(db), batchId: plan?.batchId ?? null, floors: plan ? plan.floors.map((f) => toGuideFloor(plan.batchId, f)) : [], zones: outZones, markers };
}

// ───────────────────────── 后台：区域的导览分类与颜色 ─────────────────────────

const ZoneInput = z.object({
  kind: z.enum(GUIDE_KINDS, '请选择导览分类'),
  color: z
    .string()
    .trim()
    .toLowerCase()
    .regex(GUIDE_COLOR_PATTERN, '颜色要是 #rrggbb 格式')
    .nullish()
    .transform((v) => v ?? null),
  version: z.number('缺少版本号，请刷新后重试').int().min(1, '缺少版本号，请刷新后重试'),
});

async function saveZoneGuide(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const input = parse(ZoneInput, raw);
  await deps.sql.begin(async (tx) => {
    await lockLedger(tx);
    const [z] = await tx<{ version: number; name: string; kind: GuideKind; color: string | null }[]>`
      SELECT version, name, guide_kind AS kind, guide_color AS color FROM zones WHERE id = ${id} FOR UPDATE`;
    if (!z) throw notFound('没有这个区域');
    if (z.version !== input.version) throw conflict('ZONE_STALE', `区域「${z.name}」刚被修改过，这次没有保存；请刷新后再改`);
    await tx`UPDATE zones SET guide_kind = ${input.kind}, guide_color = ${input.color}, version = version + 1, updated_at = now() WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'space_zone_saved',
      targetType: 'zone',
      targetId: id,
      detail: { name: z.name, guide: { kind: input.kind, color: input.color }, before: { kind: z.kind, color: z.color } },
      ip: ctx.ip,
    });
  });
}

// ───────────────────────── 后台：设施图标 ─────────────────────────

const markerText = {
  label: z.string().trim().max(24, '中文标签最多 24 字').default(''),
  labelEn: z.string().trim().max(48, '英文标签最多 48 个字符').default(''),
};
const local = z.number('位置不正确').finite('位置不正确');
const NewMarker = z.object({
  /** 操作编号：同一次补加（含超时后重试）用同一个，重提得到原来那次的结果（Codex 复审 c0a1a7d） */
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  floorCode: z.string().regex(/^[A-Z][0-9A-Z]{0,3}$/, '楼层不正确'),
  kind: z.enum(GUIDE_MARKER_KINDS, '请选择图标'),
  x: local,
  y: local,
  ...markerText,
});
const EditMarker = z.object({
  kind: z.enum(GUIDE_MARKER_KINDS, '请选择图标'),
  /** 在在用底图上的位置（本地坐标）；不挪就不带 */
  x: local.nullish(),
  y: local.nullish(),
  hidden: z.boolean(),
  version: z.number('缺少版本号，请刷新后重试').int().min(1, '缺少版本号，请刷新后重试'),
  ...markerText,
});

function requireFloor(plan: ActivePlan | null, floorCode: string, x: number, y: number) {
  if (!plan) throw unprocessable('NO_ACTIVE_FLOORPLAN', '还没有在用的底图，先在「底图」里启用一批');
  const f = plan.floors.find((v) => v.code === floorCode);
  if (!f) throw unprocessable('FLOOR_NOT_ON_PLAN', `在用的底图上没有 ${floorCode} 这一层`);
  if (x < 0 || y < 0 || x > f.width || y > f.height) throw unprocessable('MARKER_OUTSIDE', '位置超出了这一层的图框');
  return f;
}

async function addMarker(deps: Deps, raw: unknown, ctx: OpContext): Promise<{ id: number; replayed: boolean }> {
  const input = parse(NewMarker, raw);
  // 同一个操作编号已经加过（上次没收到结果又点了一次）：返回原来那个，不再加一个
  const replay = async () => {
    const [seen] = await deps.sql<{ id: number; floorCode: string; kind: string }[]>`
      SELECT id, floor_code, kind FROM guide_markers WHERE client_key = ${input.clientKey}`;
    if (!seen) return null;
    if (seen.floorCode !== input.floorCode || seen.kind !== input.kind) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一个图标，请刷新页面后重新补加');
    return { id: Number(seen.id), replayed: true };
  };
  const before = await replay();
  if (before) return before;
  const plan = await activePlan(deps.sql);
  const f = requireFloor(plan, input.floorCode, input.x, input.y);
  const [xMm, yMm] = localToMm(plan!, f, [input.x, input.y]);
  const [row] = await deps.sql<{ id: number }[]>`
    INSERT INTO guide_markers (floor_code, kind, x_mm, y_mm, label, label_en, source, created_by, client_key)
    VALUES (${input.floorCode}, ${input.kind}, ${xMm}, ${yMm}, ${input.label}, ${input.labelEn}, 'manual', ${ctx.actor.id}, ${input.clientKey})
    ON CONFLICT (client_key) DO NOTHING
    RETURNING id`;
  // 两次重提同时到：后到的那次落在唯一约束上，返回先到的那个
  if (!row) return (await replay())!;
  const id = Number(row.id);
  await writeAudit(deps.sql, { staffId: ctx.actor.id, action: 'guide_marker_saved', targetType: 'guide_marker', targetId: id, detail: { floor: input.floorCode, kind: input.kind, added: true }, ip: ctx.ip });
  return { id, replayed: false };
}

async function editMarker(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<void> {
  const input = parse(EditMarker, raw);
  const plan = await activePlan(deps.sql);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [m] = await tx<{ floorCode: string; version: number; xMm: number; yMm: number }[]>`
      SELECT floor_code, version, x_mm, y_mm FROM guide_markers WHERE id = ${id} FOR UPDATE`;
    if (!m) throw notFound('没有这个图标');
    if (m.version !== input.version) throw conflict('MARKER_STALE', '这个图标刚被修改过，这次没有保存；请刷新后再改');
    let [xMm, yMm] = [Number(m.xMm), Number(m.yMm)];
    if (input.x != null && input.y != null) {
      const f = requireFloor(plan, m.floorCode, input.x, input.y);
      [xMm, yMm] = localToMm(plan!, f, [input.x, input.y]);
    }
    await tx`
      UPDATE guide_markers SET kind = ${input.kind}, x_mm = ${xMm}, y_mm = ${yMm}, label = ${input.label}, label_en = ${input.labelEn}, hidden = ${input.hidden},
             version = version + 1, updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'guide_marker_saved',
      targetType: 'guide_marker',
      targetId: id,
      detail: { kind: input.kind, hidden: input.hidden, moved: input.x != null && input.y != null },
      ip: ctx.ip,
    });
  });
}

/** 底图里的文字：<text x="…" y="…" font-size="…">内容</text>（转换程序写的格式，本地坐标） */
export function svgLabels(svg: string): { x: number; y: number; text: string }[] {
  const out: { x: number; y: number; text: string }[] = [];
  const block = svg.match(/<g class="labels"[^>]*>([\s\S]*?)<\/g>/);
  if (!block) return out;
  const re = /<text x="(-?\d+)" y="(-?\d+)"[^>]*>([^<]*)<\/text>/g;
  for (let m = re.exec(block[1]!); m; m = re.exec(block[1]!)) {
    const text = m[3]!
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
    out.push({ x: Number(m[1]), y: Number(m[2]), text });
  }
  return out;
}

/** 按在用底图重新识别：只替换自动识别的（手工加的不动）；同一层同一种设施相距不到 1 米的只留一个 */
export async function detectMarkers(deps: Deps, ctx: OpContext): Promise<{ detected: number; replaced: number }> {
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('guide_markers', 0))`;
    const plan = await activePlan(tx);
    if (!plan) throw unprocessable('NO_ACTIVE_FLOORPLAN', '还没有在用的底图，先在「底图」里启用一批');
    const found: { floor: string; kind: GuideMarkerKind; xMm: number; yMm: number }[] = [];
    for (const f of plan.floors) {
      const [row] = await tx<{ svg: string }[]>`SELECT svg FROM floorplan_floors WHERE batch_id = ${plan.batchId} AND floor_code = ${f.code}`;
      for (const t of svgLabels(row?.svg ?? '')) {
        const kind = detectMarkerKind(t.text);
        if (!kind) continue;
        const [xMm, yMm] = localToMm(plan, f, [t.x, t.y]);
        if (found.some((o) => o.floor === f.code && o.kind === kind && Math.hypot(o.xMm - xMm, o.yMm - yMm) < 1000)) continue;
        found.push({ floor: f.code, kind, xMm, yMm });
      }
    }
    const removed = await tx`DELETE FROM guide_markers WHERE source = 'auto' RETURNING id`;
    for (const m of found) {
      await tx`
        INSERT INTO guide_markers (floor_code, kind, x_mm, y_mm, source, created_by)
        VALUES (${m.floor}, ${m.kind}, ${m.xMm}, ${m.yMm}, 'auto', ${ctx.actor.id})`;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'guide_markers_detected',
      targetType: 'floorplan_batch',
      targetId: plan.batchId,
      detail: { detected: found.length, replaced: removed.length },
      ip: ctx.ip,
    });
    return { detected: found.length, replaced: removed.length };
  });
}

// ───────────────────────── 路由 ─────────────────────────

const FloorParam = z.object({ floor: z.string().regex(/^[A-Z][0-9A-Z]{0,3}$/, '楼层不正确') });
const SvgQuery = z.object({ b: z.coerce.number('缺少底图批次，请刷新页面').int('缺少底图批次，请刷新页面').positive('缺少底图批次，请刷新页面') });

export function registerGuideRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 对客页面：所有岗位默认都能看（门店大屏用只有这项权限的账号）
  const view = guard('guide.view');
  app.get('/api/guide', { preHandler: view }, async () => guideData(sql));
  // 在用底图的这一层，去掉图上的文字（对客不显示设计图上的标注、员工区名称）。
  // 地址带批次号（?b=）：只给在用的那一批、可以缓存；批次号不是在用的（页面还停在换底图之前）不给、也不让浏览器缓存，
  // 页面每分钟刷新后按新的批次号取（Codex 复审 c0a1a7d：原来不看批次号，换回旧底图后浏览器会把新一批的图当成旧一批的显示）
  app.get('/api/guide/floors/:floor/svg', { preHandler: view }, async (req, reply) => {
    const { floor } = parse(FloorParam, req.params);
    const { b } = parse(SvgQuery, req.query);
    const [row] = await sql<{ svg: string }[]>`
      SELECT f.svg FROM floorplan_floors f JOIN floorplan_batches bt ON bt.id = f.batch_id
      WHERE f.batch_id = ${b} AND bt.status = 'active' AND f.floor_code = ${floor}`;
    if (!row) {
      reply.header('cache-control', 'no-store');
      throw notFound('这一层的底图已经换了或没有，请刷新页面');
    }
    reply
      .header('content-type', 'image/svg+xml; charset=utf-8')
      .header('cache-control', 'private, max-age=86400')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    return row.svg.replace(/<g class="labels"[^>]*>[\s\S]*?<\/g>/, '');
  });

  // 后台（与空间台账同一组权限：店主、店总）
  const admin = guardAny('settings.manage', 'catalog.manage');
  app.get('/api/admin/guide', { preHandler: admin }, async () => guideAdmin(sql));
  app.put('/api/admin/guide/rules', { preHandler: guard('settings.manage') }, async (req) => {
    await saveGuideRules(deps, req.body, ctxOf(req));
    return guideAdmin(sql);
  });
  app.put('/api/admin/guide/zones/:id', { preHandler: admin }, async (req) => {
    await saveZoneGuide(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return guideAdmin(sql);
  });
  app.post('/api/admin/guide/markers', { preHandler: admin }, async (req) => {
    await addMarker(deps, req.body, ctxOf(req));
    return guideAdmin(sql);
  });
  app.put('/api/admin/guide/markers/:id', { preHandler: admin }, async (req) => {
    await editMarker(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return guideAdmin(sql);
  });
  app.post('/api/admin/guide/markers/detect', { preHandler: admin }, async (req) => {
    const r = await detectMarkers(deps, ctxOf(req));
    return { ...r, admin: await guideAdmin(sql) };
  });
}
