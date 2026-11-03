// 例外房间补画轮廓（v0.7.19，见 docs/FLOORPLAN_FINISH.md 第 5 节）：转换时没围出房间的例外编码（连到走廊或图外、几个编码连成一片、
// 文字附近找不到空地）在房态图上只显示位置点。店主、店总可以在这一批的底图上点出多边形补画，存在这一批上（转换结果本身不改）；
// 重画时旧的作废、留历史；换了新的一批不沿用。编码重复的不补画（要设计方核对后重新上传）；已换下的批次只读。
// 坐标与 floorplan_rooms 同一套本地坐标（10 毫米一单位，原点在该层图框左上角，y 向下）。
// 加锁：与启用、换回同一把「底图」咨询锁（全部串行），再锁这个编码现在的补画一行；页面看到的补画对不上就拒绝（OUTLINE_STALE）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_OUTLINE_POINTS } from '@shared/floorplans';
import type { Db, Tx } from '../db';
import type { guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { LOCAL_UNIT_MM } from '../floorplan/convert';
import { setTxTimeouts } from '../lib/tx';

type P = [number, number];

const OutlineParams = z.object({
  id: z.coerce.number().int().positive('编号不正确'),
  code: z.string().regex(/^[A-Z][0-9A-Z]{1,7}$/, '编码不正确'),
});
const point = z.tuple([z.number('坐标不正确').finite('坐标不正确'), z.number('坐标不正确').finite('坐标不正确')]);
// 页面上看到的这一批补画的版本（详情的 outlineRev：补画、作废都让它变大，只增不减）。只比「这个编码现在的补画」不够：
// 补画再作废以后又回到「没有补画」，迟到的第一次补画会把作废掉的轮廓画回来（Codex 复审 c0a1a7d）
const expectedRev = z.number('缺少页面上的补画版本，请刷新后重试').int().nonnegative();
const SaveSchema = z.object({
  polygon: z.array(point, '请画出轮廓').min(3, '轮廓至少 3 个点').max(MAX_OUTLINE_POINTS, `轮廓最多 ${MAX_OUTLINE_POINTS} 个点`),
  /** 页面上看到的这个编码现在的补画（没有为 null）：对不上说明刚被别人改过 */
  expectedOutlineId: z.number().int().positive().nullable(),
  expectedRev,
});
const VoidSchema = z.object({ expectedOutlineId: z.number('缺少页面上的补画，请刷新后重试').int().positive(), expectedRev });

/** 补画轮廓的版本：补画（新一行）、作废都会让它变大（页面据此重新取在用的底图，补画、作废时核对） */
export async function outlineRev(db: Db, batchId: number | null): Promise<number> {
  if (batchId === null) return 0;
  const [r] = await db<{ rev: number }[]>`
    SELECT (coalesce(max(id), 0) + count(*) FILTER (WHERE voided_at IS NOT NULL))::int AS rev FROM floorplan_room_outlines WHERE batch_id = ${batchId}`;
  return Number(r!.rev);
}

/** 多边形的有向面积（本地单位²） */
export function signedArea(poly: P[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j]![0] + poly[i]![0]) * (poly[j]![1] - poly[i]![1]);
  return a / 2;
}

const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
/** 两条线段（不含共用端点）是否相交 */
function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p: P, q: P, r: P) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (d1 === 0 && on(c, d, a)) || (d2 === 0 && on(c, d, b)) || (d3 === 0 && on(a, b, c)) || (d4 === 0 && on(a, b, d));
}

/** 边是否交叉（不相邻的两条边相交，或点重复） */
export function selfIntersects(poly: P[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (poly[i]![0] === poly[j]![0] && poly[i]![1] === poly[j]![1]) return true;
      // 相邻的边（共用一个点）不比
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!)) return true;
    }
  }
  return false;
}

/** 整理点：取整、去掉连续重复的点与重复的首尾点 */
export function normalizeOutline(polygon: P[]): P[] {
  const out: P[] = [];
  for (const [x, y] of polygon) {
    const p: P = [Math.round(x), Math.round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
  return out;
}

/** 面积（㎡ × 100）：本地一单位 = LOCAL_UNIT_MM 毫米 */
export const outlineAreaCentiM2 = (poly: P[]) => Math.round(Math.abs(signedArea(poly)) * (LOCAL_UNIT_MM / 1000) ** 2 * 100);

/** 取「底图」锁，核对批次与编码，锁这个编码现在的补画 */
async function lockTarget(tx: Tx, batchId: number, code: string) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended('floorplans', 0))`;
  const [b] = await tx<{ status: string }[]>`SELECT status FROM floorplan_batches WHERE id = ${batchId}`;
  if (!b) throw notFound('没有这个底图批次');
  if (b.status !== 'ready' && b.status !== 'active') {
    throw conflict('FLOORPLAN_READONLY', b.status === 'retired' ? '已换下的底图只读；要补画请先换回这一批' : '这一批还不能补画（转换中或转换失败）');
  }
  const rooms = await tx<{ floorCode: string; status: string }[]>`SELECT floor_code, status FROM floorplan_rooms WHERE batch_id = ${batchId} AND code = ${code}`;
  if (!rooms.length) throw notFound(`这一批的图上没有编码 ${code}`);
  if (rooms.length > 1 || rooms[0]!.status === 'duplicate') {
    throw unprocessable('OUTLINE_DUPLICATE', `编码 ${code} 在图上出现了不止一处，不能补画；请设计方核对编码后重新上传`);
  }
  if (rooms[0]!.status === 'ok') throw unprocessable('OUTLINE_NOT_EXCEPTION', `${code} 转换时已经配上轮廓，不用补画`);
  const [cur] = await tx<{ id: number }[]>`
    SELECT id FROM floorplan_room_outlines WHERE batch_id = ${batchId} AND code = ${code} AND voided_at IS NULL FOR UPDATE`;
  return { floorCode: rooms[0]!.floorCode, current: cur ? Number(cur.id) : null };
}

export async function saveOutline(deps: Deps, batchId: number, code: string, raw: unknown, actor: Actor, ip?: string): Promise<{ outlineId: number }> {
  const input = parse(SaveSchema, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const t = await lockTarget(tx, batchId, code);
    if (t.current !== input.expectedOutlineId || (await outlineRev(tx, batchId)) !== input.expectedRev) {
      throw conflict('OUTLINE_STALE', `${code} 的补画刚被改过（可能是刚才没收到结果的那次已经生效，或有人同时在改），请刷新后再画`);
    }
    const [floor] = await tx<{ width: number; height: number }[]>`
      SELECT width, height FROM floorplan_floors WHERE batch_id = ${batchId} AND floor_code = ${t.floorCode}`;
    const poly = normalizeOutline(input.polygon as P[]);
    if (poly.length < 3) throw unprocessable('OUTLINE_TOO_FEW', '轮廓至少 3 个不同的点');
    if (poly.some(([x, y]) => x < 0 || y < 0 || x > floor!.width || y > floor!.height)) throw unprocessable('OUTLINE_OUTSIDE', '轮廓超出了这一层的图框');
    if (selfIntersects(poly)) throw unprocessable('OUTLINE_CROSSED', '轮廓的边交叉了，请按房间的墙角顺序依次点');
    const area = outlineAreaCentiM2(poly);
    if (area < 50) throw unprocessable('OUTLINE_TOO_SMALL', '轮廓太小（不到 0.5 ㎡），请重画');
    if (t.current) await tx`UPDATE floorplan_room_outlines SET voided_by = ${actor.id}, voided_at = now() WHERE id = ${t.current}`;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO floorplan_room_outlines (batch_id, floor_code, code, polygon, area_centi_m2, created_by)
      VALUES (${batchId}, ${t.floorCode}, ${code}, ${tx.json(poly as never)}, ${area}, ${actor.id})
      RETURNING id`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'floorplan_outline',
      targetType: 'floorplan_batch',
      targetId: batchId,
      detail: { code, points: poly.length, areaM2: area / 100, ...(t.current ? { replaced: t.current } : {}) },
      ip,
    });
    return { outlineId: Number(row!.id) };
  });
}

/** 作废补画（回到只显示位置点） */
export async function voidOutline(deps: Deps, batchId: number, code: string, raw: unknown, actor: Actor, ip?: string): Promise<{ voided: number }> {
  const input = parse(VoidSchema, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const t = await lockTarget(tx, batchId, code);
    if (t.current === null || t.current !== input.expectedOutlineId || (await outlineRev(tx, batchId)) !== input.expectedRev) {
      throw conflict('OUTLINE_STALE', `${code} 的补画刚被改过，请刷新后再看`);
    }
    await tx`UPDATE floorplan_room_outlines SET voided_by = ${actor.id}, voided_at = now() WHERE id = ${t.current}`;
    await writeAudit(tx, { staffId: actor.id, action: 'floorplan_outline', targetType: 'floorplan_batch', targetId: batchId, detail: { code, voided: t.current }, ip });
    return { voided: t.current };
  });
}

export function registerOutlineRoutes(app: FastifyInstance, deps: Deps, admin: ReturnType<typeof guardAny>) {
  app.put('/api/admin/floorplans/:id/outlines/:code', { preHandler: admin }, async (req) => {
    const p = parse(OutlineParams, req.params);
    return saveOutline(deps, p.id, p.code, req.body, req.actor, req.ip);
  });
  app.post('/api/admin/floorplans/:id/outlines/:code/void', { preHandler: admin }, async (req) => {
    const p = parse(OutlineParams, req.params);
    return voidOutline(deps, p.id, p.code, req.body, req.actor, req.ip);
  });
}
