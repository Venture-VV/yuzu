// 底图转换（飞书需求 RQ-004 第二段，v0.7.15，见 docs/FLOORPLAN.md）：
//   · 后台上传 DWG / ASCII DXF（≤ 30 MB）→ 记一个「转换批次」→ 单独的转换进程读图、分楼层、围合房间、出每层 SVG（floorplan/）；
//     图纸文件本身不进数据库，只记文件名、大小、摘要；同一份图纸（摘要）、同一版转换程序只转换一次，重传同一份直接回到那一批；
//   · 同时只转换一份；转换超过 15 分钟停掉、记失败；应用重启时没转完的记失败（重新上传即可）；
//   · 预览：每层底图 + 房间轮廓、例外清单、与空间台账比对（以台账为准，不按图纸改台账，D6）、与在用的那一批比对（房间增减、编码变更）；
//   · 店主、店总「启用」一批（原来在用的换下）；第三段房态图读在用的那一批（/api/floorplans/active）。
// 加锁：启用先取「底图」咨询锁（全部串行），再改批次；上传只靠唯一索引兜底（同一份文件、同时只转换一份）。

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  MAX_FLOORPLAN_FILE_BYTES,
  type ActiveFloorplan,
  type FloorplanBatch,
  type FloorplanBatchDiff,
  type FloorplanBatchStatus,
  type FloorplanDetail,
  type FloorplanFloor,
  type FloorplanLedgerDiff,
  type FloorplanList,
  type FloorplanReport,
  type FloorplanRoom,
  type FloorplanRoomStatus,
} from '@shared/floorplans';
import { can } from '@shared/permissions';
import type { Db, Sql } from '../db';
import { isUniqueViolation } from '../db';
import { guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { CONVERTER_VERSION, LOCAL_UNIT_MM } from '../floorplan/convert';
import { spacesGeoJson } from '../floorplan/geojson';
import type { Pt } from '../floorplan/model';
import { detectFormat, type DrawingFormat } from '../floorplan/read';
import { startConversion, type RunningConversion, type WorkerOutput } from '../floorplan/run';
import { setTxTimeouts } from './inventory/common';

/** 转换超过这么久停掉（需求：30 分钟内出新底图与差异报告） */
export const FLOORPLAN_TIMEOUT_MS = 15 * 60_000;

// ───────────────────────── 读取 ─────────────────────────

/** 列名转成驼峰后正好是 FloorplanBatch 的样子 */
type BatchRow = FloorplanBatch;

const batchSelect = (db: Db) => db`
  SELECT b.id, b.file_name, b.file_bytes, b.file_sha256, b.file_format, b.converter, b.status, b.error, b.note,
         b.created_at, cb.display_name AS created_by_name, b.finished_at, b.activated_at, ab.display_name AS activated_by_name,
         b.retired_at, b.read_ms, b.convert_ms,
         (SELECT count(*) FROM floorplan_floors f WHERE f.batch_id = b.id)::int AS floor_count,
         (SELECT count(*) FROM floorplan_rooms r WHERE r.batch_id = b.id)::int AS room_count,
         (SELECT count(*) FROM floorplan_rooms r WHERE r.batch_id = b.id AND r.status = 'ok')::int AS ok_count
  FROM floorplan_batches b
  LEFT JOIN staff cb ON cb.id = b.created_by
  LEFT JOIN staff ab ON ab.id = b.activated_by`;

const toBatch = (r: BatchRow): FloorplanBatch => ({ ...r, id: Number(r.id), fileBytes: Number(r.fileBytes) });

async function getBatch(db: Db, id: number): Promise<FloorplanBatch> {
  const [row] = await db<BatchRow[]>`${batchSelect(db)} WHERE b.id = ${id}`;
  if (!row) throw notFound('没有这个底图批次');
  return toBatch(row);
}

export async function listFloorplans(db: Db): Promise<FloorplanList> {
  const rows = await db<BatchRow[]>`${batchSelect(db)} ORDER BY b.id DESC LIMIT 50`;
  const batches = rows.map(toBatch);
  // 列表只取最近 50 批；在用的那批更早时也带上
  const [active] = await db<{ id: number }[]>`SELECT id FROM floorplan_batches WHERE status = 'active'`;
  if (active && !batches.some((b) => b.id === Number(active.id))) batches.push(await getBatch(db, Number(active.id)));
  return {
    batches,
    activeId: active ? Number(active.id) : null,
    converting: batches.find((b) => b.status === 'converting') ?? null,
  };
}

interface FloorRow {
  floorCode: string;
  title: string;
  width: number;
  height: number;
  svgBytes: number;
  pathCount: number;
  frame: [number, number, number, number];
}
interface RoomRow {
  floorCode: string;
  code: string;
  label: string;
  status: FloorplanRoomStatus;
  mergedWith: string[];
  closeMm: number | null;
  polygon: [number, number][] | null;
  labelX: number;
  labelY: number;
  areaCentiM2: number | null;
}

const svgUrl = (batchId: number, floorCode: string) => `/api/floorplans/${batchId}/floors/${floorCode}/svg`;

async function batchFloors(db: Db, batchId: number) {
  const rows = await db<FloorRow[]>`
    SELECT floor_code, title, width, height, svg_bytes, path_count, frame FROM floorplan_floors WHERE batch_id = ${batchId} ORDER BY floor_code`;
  return rows.map((f) => ({
    floor: {
      code: f.floorCode,
      title: f.title,
      width: f.width,
      height: f.height,
      svgBytes: f.svgBytes,
      pathCount: f.pathCount,
      svgUrl: svgUrl(batchId, f.floorCode),
    } satisfies FloorplanFloor,
    frame: f.frame,
  }));
}

async function batchRooms(db: Db, batchId: number): Promise<FloorplanRoom[]> {
  const rows = await db<RoomRow[]>`
    SELECT floor_code, code, label, status, merged_with, close_mm, polygon, label_x, label_y, area_centi_m2
    FROM floorplan_rooms WHERE batch_id = ${batchId} ORDER BY floor_code, code`;
  return rows.map((r) => ({
    floorCode: r.floorCode,
    code: r.code,
    label: r.label,
    status: r.status,
    mergedWith: r.mergedWith,
    closeMm: r.closeMm,
    polygon: r.polygon,
    labelAt: [r.labelX, r.labelY],
    areaM2: r.areaCentiM2 === null ? null : r.areaCentiM2 / 100,
  }));
}

const normLabel = (s: string) => s.replace(/\s+/g, '');

/** 与空间台账比对：编码是主键；只比图上这几层的在用空间 */
async function ledgerDiff(db: Db, floors: string[], rooms: FloorplanRoom[]): Promise<FloorplanLedgerDiff> {
  const ledger = await db<{ code: string; displayName: string; sourceLabel: string; active: boolean; floorCode: string }[]>`
    SELECT s.code, s.display_name, s.source_label, s.active, f.code AS floor_code FROM spaces s JOIN floors f ON f.id = s.floor_id`;
  const byCode = new Map(ledger.map((s) => [s.code, s]));
  const drawn = new Set(rooms.map((r) => r.code));
  const diff: FloorplanLedgerDiff = { onlyDrawing: [], onlyLedger: [], floorMismatch: [], labelChanged: [], matched: 0 };
  for (const r of rooms) {
    const s = byCode.get(r.code);
    if (!s || !s.active) {
      diff.onlyDrawing.push({ floorCode: r.floorCode, code: r.code, label: r.label, ledgerInactive: !!s });
      continue;
    }
    if (s.floorCode !== r.floorCode) {
      diff.floorMismatch.push({ code: r.code, drawingFloor: r.floorCode, ledgerFloor: s.floorCode });
      continue;
    }
    diff.matched++;
    if (s.sourceLabel && normLabel(s.sourceLabel) !== normLabel(r.label)) diff.labelChanged.push({ code: r.code, drawingLabel: r.label, ledgerLabel: s.sourceLabel });
  }
  const floorSet = new Set(floors);
  for (const s of ledger) {
    if (s.active && floorSet.has(s.floorCode) && !drawn.has(s.code)) diff.onlyLedger.push({ floorCode: s.floorCode, code: s.code, displayName: s.displayName });
  }
  diff.onlyLedger.sort((a, b) => a.floorCode.localeCompare(b.floorCode) || a.code.localeCompare(b.code));
  return diff;
}

function insidePolygon([x, y]: Pt, poly: [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** 与另一批比对（新 = 这一批）：位置都换成图纸坐标再比（两批的图框可能不同） */
async function batchDiff(db: Db, batchId: number, status: FloorplanBatchStatus, rooms: FloorplanRoom[], frames: Map<string, number[]>, unitMm: number): Promise<FloorplanBatchDiff | null> {
  const [against] =
    status === 'active'
      ? await db<{ id: number }[]>`SELECT id FROM floorplan_batches WHERE status = 'retired' AND id <> ${batchId} ORDER BY retired_at DESC, id DESC LIMIT 1`
      : await db<{ id: number }[]>`SELECT id FROM floorplan_batches WHERE status = 'active' AND id <> ${batchId}`;
  if (!against) return null;
  const otherId = Number(against.id);
  const oldRooms = await batchRooms(db, otherId);
  const oldFrames = new Map((await batchFloors(db, otherId)).map((f) => [f.floor.code, f.frame as number[]]));
  const k = LOCAL_UNIT_MM / unitMm;
  const world = (fr: number[] | undefined, [x, y]: [number, number]): Pt => (fr ? [fr[0]! + x * k, fr[3]! - y * k] : [x * k, -y * k]);
  const local = (fr: number[] | undefined, [x, y]: Pt): Pt => (fr ? [(x - fr[0]!) / k, (fr[3]! - y) / k] : [x / k, -y / k]);
  const newCodes = new Set(rooms.map((r) => r.code));
  const oldCodes = new Set(oldRooms.map((r) => r.code));
  const diff: FloorplanBatchDiff = { againstBatchId: otherId, added: [], removed: [], renamed: [], moved: [], floorChanged: [] };
  const addedCands = rooms.filter((r) => !oldCodes.has(r.code));
  const removedCands = oldRooms.filter((r) => !newCodes.has(r.code));
  const usedOld = new Set<string>();
  for (const n of addedCands) {
    const nw = world(frames.get(n.floorCode), n.labelAt);
    const match = removedCands.find((o) => {
      if (o.floorCode !== n.floorCode || usedOld.has(o.code)) return false;
      const ow = world(oldFrames.get(o.floorCode), o.labelAt);
      // 同一个位置：旧编码的文字落在新轮廓里，或新编码的文字落在旧轮廓里，或两处文字相距不到 1.5 米
      if (n.polygon && insidePolygon(local(frames.get(n.floorCode), ow), n.polygon)) return true;
      if (o.polygon && insidePolygon(local(oldFrames.get(o.floorCode), nw), o.polygon)) return true;
      return Math.hypot(nw[0] - ow[0], nw[1] - ow[1]) * unitMm < 1500;
    });
    if (match) {
      usedOld.add(match.code);
      diff.renamed.push({ floorCode: n.floorCode, from: match.code, to: n.code });
    } else diff.added.push({ floorCode: n.floorCode, code: n.code });
  }
  for (const o of removedCands) if (!usedOld.has(o.code)) diff.removed.push({ floorCode: o.floorCode, code: o.code });
  const oldByCode = new Map(oldRooms.map((r) => [r.code, r]));
  for (const n of rooms) {
    const o = oldByCode.get(n.code);
    if (!o) continue;
    // 同一个编码换了楼层（v0.7.15 审查）：单独列出，不当作位置挪动
    if (o.floorCode !== n.floorCode) {
      diff.floorChanged.push({ code: n.code, from: o.floorCode, to: n.floorCode });
      continue;
    }
    const nw = world(frames.get(n.floorCode), n.labelAt);
    const ow = world(oldFrames.get(o.floorCode), o.labelAt);
    const d = (Math.hypot(nw[0] - ow[0], nw[1] - ow[1]) * unitMm) / 1000;
    if (d > 2) diff.moved.push({ floorCode: n.floorCode, code: n.code, distanceM: Math.round(d * 10) / 10 });
  }
  return diff;
}

export async function floorplanDetail(db: Db, id: number): Promise<FloorplanDetail> {
  const batch = await getBatch(db, id);
  const [meta] = await db<{ report: FloorplanReport | null }[]>`SELECT report FROM floorplan_batches WHERE id = ${id}`;
  const report = meta?.report ?? null;
  if (batch.status === 'converting' || batch.status === 'failed') return { batch, floors: [], rooms: [], report, ledgerDiff: null, batchDiff: null };
  const floorRows = await batchFloors(db, id);
  const rooms = await batchRooms(db, id);
  const unitMm = Number((report?.params as { unitMm?: number } | undefined)?.unitMm ?? 1) || 1;
  return {
    batch,
    floors: floorRows.map((f) => f.floor),
    rooms,
    report,
    ledgerDiff: await ledgerDiff(
      db,
      floorRows.map((f) => f.floor.code),
      rooms,
    ),
    batchDiff: await batchDiff(db, id, batch.status, rooms, new Map(floorRows.map((f) => [f.floor.code, f.frame as number[]])), unitMm),
  };
}

/** 在用的底图（第三段房态图用）：房间按编码对上空间台账 */
export async function activeFloorplan(db: Db): Promise<ActiveFloorplan> {
  const [b] = await db<{ id: number; activatedAt: string }[]>`SELECT id, activated_at FROM floorplan_batches WHERE status = 'active'`;
  if (!b) return { batchId: null, activatedAt: null, floors: [], rooms: [] };
  const id = Number(b.id);
  const floors = (await batchFloors(db, id)).map((f) => f.floor);
  const rooms = await batchRooms(db, id);
  const spaces = await db<{ id: number; code: string; displayName: string }[]>`
    SELECT id, code, display_name FROM spaces WHERE active AND code IN ${db(rooms.length ? rooms.map((r) => r.code) : [''])}`;
  const byCode = new Map(spaces.map((s) => [s.code, s]));
  return {
    batchId: id,
    activatedAt: b.activatedAt,
    floors,
    rooms: rooms.map((r) => {
      const s = byCode.get(r.code);
      return { ...r, spaceId: s ? Number(s.id) : null, displayName: s?.displayName ?? null };
    }),
  };
}

// ───────────────────────── 上传与转换 ─────────────────────────

const UploadSchema = z.object({
  fileName: z.string('请选择图纸文件').trim().min(1, '请选择图纸文件').max(200, '文件名太长（最多 200 个字）'),
  contentBase64: z.string('请选择图纸文件').min(1, '请选择图纸文件'),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
});

async function sameFileBatch(db: Db, sha: string): Promise<FloorplanBatch | null> {
  const [row] = await db<BatchRow[]>`${batchSelect(db)} WHERE b.file_sha256 = ${sha} AND b.converter = ${CONVERTER_VERSION} AND b.status <> 'failed'`;
  return row ? toBatch(row) : null;
}

async function markFailed(db: Db, batchId: number, error: string, extra: { report?: FloorplanReport; readMs?: number; convertMs?: number } = {}) {
  await db`
    UPDATE floorplan_batches
    SET status = 'failed', error = ${error.slice(0, 500)}, finished_at = now(),
        report = ${extra.report ? db.json(extra.report as never) : null}, read_ms = ${extra.readMs ?? null}, convert_ms = ${extra.convertMs ?? null}
    WHERE id = ${batchId} AND status = 'converting'`;
}

/** 把转换结果写进去；批次已不在「转换中」（例如应用重启时被记成失败）就不写 */
export async function storeConversion(db: Sql, batchId: number, out: WorkerOutput): Promise<void> {
  if (!out.ok || !out.result) return markFailed(db, batchId, out.error ?? '转换失败');
  const r = out.result;
  const report: FloorplanReport = {
    source: r.source,
    layers: r.layers,
    issues: r.issues,
    params: r.params as unknown as Record<string, unknown>,
    worker: { readMs: out.readMs ?? null, peakRssMb: out.peakRssMb ?? null },
  };
  if (!r.floors.length) {
    return markFailed(db, batchId, '图上没认出楼层：没有房号与楼层标题，或结构图层的名字不在白名单里（看转换报告里的图层清单）', {
      report,
      readMs: out.readMs,
      convertMs: r.convertMs,
    });
  }
  await db.begin(async (tx) => {
    const [b] = await tx<{ id: number }[]>`
      UPDATE floorplan_batches
      SET status = 'ready', report = ${tx.json(report as never)}, read_ms = ${out.readMs ?? null}, convert_ms = ${r.convertMs}, finished_at = now()
      WHERE id = ${batchId} AND status = 'converting' RETURNING id`;
    if (!b) return;
    for (const f of r.floors) {
      await tx`
        INSERT INTO floorplan_floors (batch_id, floor_code, title, width, height, frame, svg, svg_bytes, path_count)
        VALUES (${batchId}, ${f.code}, ${f.title.slice(0, 16)}, ${f.width}, ${f.height}, ${tx.json(f.frame as never)}, ${f.svg}, ${f.svgBytes}, ${f.pathCount})`;
    }
    for (const room of r.rooms) {
      await tx`
        INSERT INTO floorplan_rooms (batch_id, floor_code, code, label, status, merged_with, close_mm, polygon, label_x, label_y, area_centi_m2)
        VALUES (${batchId}, ${room.floor}, ${room.code}, ${room.label.slice(0, 60)}, ${room.status}, ${room.with}, ${room.closeMm},
                ${room.polygon ? tx.json(room.polygon as never) : null}, ${room.labelAt[0]}, ${room.labelAt[1]},
                ${room.areaM2 === null ? null : Math.round(room.areaM2 * 100)})`;
    }
  });
}

/** 转换任务：同时只有一份（数据库唯一索引兜底）；应用关闭时停掉 */
export class FloorplanJobs {
  private running = new Map<number, RunningConversion>();
  private pending = new Set<Promise<void>>();
  constructor(
    private readonly db: Sql,
    private readonly timeoutMs = FLOORPLAN_TIMEOUT_MS,
    private readonly log: (msg: string, err?: unknown) => void = () => {},
  ) {}

  start(batchId: number, bytes: Buffer, format: DrawingFormat) {
    const p = this.run(batchId, bytes, format).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private async run(batchId: number, bytes: Buffer, format: DrawingFormat) {
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'yuzu-floorplan-'));
      const input = join(dir, `drawing.${format}`);
      const output = join(dir, 'result.json');
      await writeFile(input, bytes);
      const conv = startConversion(input, output, this.timeoutMs);
      this.running.set(batchId, conv);
      const out = await conv.done;
      await storeConversion(this.db, batchId, out);
      this.log(out.ok ? `底图批次 ${batchId} 转换完成` : `底图批次 ${batchId} 转换失败：${out.error}`);
    } catch (error) {
      this.log(`底图批次 ${batchId} 转换出错`, error);
      await markFailed(this.db, batchId, `转换出错：${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    } finally {
      this.running.delete(batchId);
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** 等正在跑的转换结束（测试用） */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  stopAll() {
    for (const c of this.running.values()) c.kill();
  }
}

export async function uploadFloorplan(
  db: Db,
  jobs: FloorplanJobs,
  raw: unknown,
  actor: Actor,
  ip?: string,
): Promise<{ batch: FloorplanBatch; replayed: boolean }> {
  const input = parse(UploadSchema, raw);
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (!bytes.length) throw unprocessable('FLOORPLAN_EMPTY', '文件是空的');
  if (bytes.length > MAX_FLOORPLAN_FILE_BYTES) throw unprocessable('FLOORPLAN_TOO_LARGE', `图纸超过 ${MAX_FLOORPLAN_FILE_BYTES / 1024 / 1024} MB`);
  const format = detectFormat(bytes);
  if (!format) throw unprocessable('FLOORPLAN_FORMAT', '只收 DWG 或 ASCII DXF 图纸（这个文件的开头不是 DWG / DXF 的格式）');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const same = await sameFileBatch(db, sha);
  if (same) return { batch: same, replayed: true };
  let id: number;
  try {
    const [row] = await db<{ id: number }[]>`
      INSERT INTO floorplan_batches (file_name, file_sha256, file_bytes, file_format, converter, note, created_by)
      VALUES (${input.fileName}, ${sha}, ${bytes.length}, ${format}, ${CONVERTER_VERSION}, ${input.note}, ${actor.id})
      RETURNING id`;
    id = Number(row!.id);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const again = await sameFileBatch(db, sha);
    if (again) return { batch: again, replayed: true };
    const [busy] = await db<{ fileName: string }[]>`SELECT file_name FROM floorplan_batches WHERE status = 'converting'`;
    throw conflict('FLOORPLAN_BUSY', `正在转换另一份图纸${busy ? `（${busy.fileName}）` : ''}，等它转换完再上传`);
  }
  await writeAudit(db, {
    staffId: actor.id,
    action: 'floorplan_upload',
    targetType: 'floorplan_batch',
    targetId: id,
    detail: { fileName: input.fileName, bytes: bytes.length, sha256: sha, format },
    ip,
  });
  jobs.start(id, bytes, format);
  return { batch: await getBatch(db, id), replayed: false };
}

// ───────────────────────── 启用 ─────────────────────────

const ActivateSchema = z.object({
  // 页面上看到的在用批次（没有为 null）：对不上说明刚被换过，这次不启用（v0.7.15 审查：超时后迟到的启用请求不能把后来启用的那批换下）
  expectedActiveId: z.number('缺少页面上的在用批次，请刷新后重试').int().positive().nullable(),
});

export async function activateFloorplan(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string): Promise<{ replayed: boolean }> {
  const { sql } = deps;
  const { expectedActiveId } = parse(ActivateSchema, raw);
  try {
    return await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('floorplans', 0))`;
      const rows = await tx<{ id: number; status: FloorplanBatchStatus }[]>`
        SELECT id, status FROM floorplan_batches WHERE id = ${id} OR status = 'active' ORDER BY id FOR UPDATE`;
      const target = rows.find((r) => Number(r.id) === id);
      if (!target) throw notFound('没有这个底图批次');
      if (target.status === 'active') return { replayed: true };
      if (target.status !== 'ready') {
        throw conflict(
          'FLOORPLAN_NOT_READY',
          target.status === 'converting' ? '还在转换，转换完成后才能启用' : target.status === 'failed' ? '转换失败的批次不能启用' : '已换下的批次不能再启用，请重新上传图纸',
        );
      }
      const previous = rows.find((r) => r.status === 'active');
      if ((previous ? Number(previous.id) : null) !== expectedActiveId) {
        throw conflict(
          'FLOORPLAN_STALE',
          '在用的底图刚被换过（可能是刚才没收到结果的那次启用已经生效，或有人同时在操作），这次没有启用；请刷新后看一下再决定',
        );
      }
      if (previous) await tx`UPDATE floorplan_batches SET status = 'retired', retired_by = ${actor.id}, retired_at = now() WHERE id = ${previous.id}`;
      await tx`UPDATE floorplan_batches SET status = 'active', activated_by = ${actor.id}, activated_at = now() WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'floorplan_activate',
        targetType: 'floorplan_batch',
        targetId: id,
        detail: { previous: previous ? Number(previous.id) : null },
        ip,
      });
      return { replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('FLOORPLAN_BUSY', '刚有人启用了另一批底图，请刷新后再看');
    throw error;
  }
}

// ───────────────────────── 自检 ─────────────────────────

/** 底图的自检（cli check 与备份核验共用）：在用的批次有底图、房间都有楼层、轮廓都在图框内 */
export async function floorplanChecks(db: Db): Promise<{ label: string; ok: boolean; detail: string }[]> {
  const [active] = await db<{ id: number; floors: number; rooms: number; ok: number }[]>`
    SELECT b.id, (SELECT count(*) FROM floorplan_floors f WHERE f.batch_id = b.id)::int AS floors,
           (SELECT count(*) FROM floorplan_rooms r WHERE r.batch_id = b.id)::int AS rooms,
           (SELECT count(*) FROM floorplan_rooms r WHERE r.batch_id = b.id AND r.status = 'ok')::int AS ok
    FROM floorplan_batches b WHERE b.status = 'active'`;
  const outside = await db<{ ref: string }[]>`
    SELECT r.batch_id || '/' || r.code AS ref
    FROM floorplan_rooms r JOIN floorplan_floors f ON f.batch_id = r.batch_id AND f.floor_code = r.floor_code
    WHERE r.label_x < 0 OR r.label_y < 0 OR r.label_x > f.width OR r.label_y > f.height
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(r.polygon, '[]'::jsonb)) p
                  WHERE (p->>0)::numeric < 0 OR (p->>1)::numeric < 0 OR (p->>0)::numeric > f.width OR (p->>1)::numeric > f.height)
    LIMIT 5`;
  const [counts] = await db<{ batches: number; converting: number }[]>`
    SELECT count(*)::int AS batches, count(*) FILTER (WHERE status = 'converting')::int AS converting FROM floorplan_batches`;
  const emptyActive = active && active.floors === 0;
  return [
    {
      label: '底图批次与房间轮廓一致',
      ok: !emptyActive && outside.length === 0,
      detail: emptyActive
        ? `在用的底图批次 #${active.id} 没有底图`
        : outside.length
          ? `${outside.length} 个房间的位置或轮廓超出图框（如 ${outside.map((o) => o.ref).join('、')}）`
          : active
            ? `在用批次 #${active.id}：${active.floors} 层、编码 ${active.rooms} 个（配上轮廓 ${active.ok} 个）；共 ${counts!.batches} 批${counts!.converting ? `，转换中 ${counts!.converting} 批` : ''}`
            : `还没有启用的底图（共 ${counts!.batches} 批）`,
    },
  ];
}

// ───────────────────────── 路由 ─────────────────────────

export function registerFloorplanRoutes(app: FastifyInstance, deps: Deps, jobs = new FloorplanJobs(deps.sql, FLOORPLAN_TIMEOUT_MS, (msg, err) => (err ? app.log.error({ err }, msg) : app.log.info(msg)))) {
  const { sql } = deps;
  const ADMIN = ['settings.manage', 'catalog.manage'] as const;
  // 与空间台账同一组权限（店主、店总）
  const admin = guardAny(...ADMIN);
  // 在用的底图：后台与前台客房岗位都能看（第三段房态图）
  const READ = [...ADMIN, 'room.operate', 'room.housekeep', 'frontdesk.checkout'] as const;
  const read = guardAny(...READ);
  const FloorParams = z.object({
    id: z.coerce.number().int().positive('编号不正确'),
    floor: z.string().regex(/^[A-Z][0-9A-Z]{0,3}$/, '楼层不正确'),
  });
  const isAdmin = (req: FastifyRequest) => ADMIN.some((p) => can(req.actor, p));

  // 应用启动时：上次没转完的（应用重启、进程被杀）记失败，重新上传即可
  app.addHook('onReady', async () => {
    await sql`
      UPDATE floorplan_batches SET status = 'failed', error = '转换中断（系统重启），请重新上传', finished_at = now()
      WHERE status = 'converting'`;
  });
  app.addHook('onClose', async () => jobs.stopAll());

  app.get('/api/admin/floorplans', { preHandler: admin }, async () => listFloorplans(sql));
  app.post('/api/admin/floorplans', { preHandler: admin, bodyLimit: Math.ceil((MAX_FLOORPLAN_FILE_BYTES * 4) / 3) + 64 * 1024 }, async (req, reply) => {
    const r = await uploadFloorplan(sql, jobs, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 202);
    return r;
  });
  app.get('/api/admin/floorplans/:id', { preHandler: admin }, async (req) => floorplanDetail(sql, parse(idParam, req.params).id));
  app.post('/api/admin/floorplans/:id/activate', { preHandler: admin }, async (req) => {
    const id = parse(idParam, req.params).id;
    await activateFloorplan(deps, id, req.body, req.actor, req.ip);
    return floorplanDetail(sql, id);
  });
  // spaces.geojson：每个编码一个要素（配上的是多边形，例外是文字所在的点）
  app.get('/api/admin/floorplans/:id/geojson', { preHandler: admin }, async (req, reply) => {
    const id = parse(idParam, req.params).id;
    const batch = await getBatch(sql, id);
    const rooms = await batchRooms(sql, id);
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'floorplan_geojson', targetId: id, ip: req.ip });
    const body = spacesGeoJson(
      rooms.map((r) => ({ floor: r.floorCode, code: r.code, label: r.label, status: r.status, with: r.mergedWith, closeMm: r.closeMm, polygon: r.polygon, labelAt: r.labelAt, areaM2: r.areaM2 })),
      { batchId: id, file: batch.fileName, converter: batch.converter },
    );
    reply
      .header('content-type', 'application/geo+json; charset=utf-8')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`spaces-${id}.geojson`)}`);
    return JSON.stringify(body);
  });

  app.get('/api/floorplans/active', { preHandler: read }, async () => activeFloorplan(sql));
  // 每层底图（SVG）：在用的那批前台客房岗位也能看；其他批次只有后台能看
  app.get('/api/floorplans/:id/floors/:floor/svg', { preHandler: read }, async (req, reply) => {
    const { id, floor } = parse(FloorParams, req.params);
    const [row] = await sql<{ svg: string; status: FloorplanBatchStatus }[]>`
      SELECT f.svg, b.status FROM floorplan_floors f JOIN floorplan_batches b ON b.id = f.batch_id WHERE f.batch_id = ${id} AND f.floor_code = ${floor}`;
    if (!row || (row.status !== 'active' && !isAdmin(req))) throw notFound('没有这一层的底图');
    reply
      .header('content-type', 'image/svg+xml; charset=utf-8')
      // 底图只追加、不会变：可以缓存；SVG 里不允许脚本与外部资源
      .header('cache-control', 'private, max-age=86400')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    return row.svg;
  });
}
