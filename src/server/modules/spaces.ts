// 空间台账（飞书需求 RQ-004 第一段，v0.7.14，见 docs/SPACES.md）：
//   · 楼层 → 区域 → 空间三级；空间编码（编码图上的，如 S301）是可读主键，建好后不能改，缺号不补；业务引用 spaces.id；
//   · 别名（品牌名、编码图原始标注、旧名）只追加，不用了停用一次；别名在不同空间之间可以重复（品牌图上 4 间「客房 C5」）；
//   · 核对状态：已核对 / 推断 / 待现场核对，改状态要写说明、留经办人；
//   · 导入空间清单、区域清单（附件草稿的列名）：先预览，有错误的整份不写；编码（区域名）已在台账里的不覆盖、列出差异；
//     同一个文件只能写入一次；写入带操作编号（结果待确认时查回、重提或作废，与 ERP 批量导入同一套）；
//   · 导出空间清单 CSV；只读的楼层 → 区域 → 空间树给以后的房态图、对客导览用。
// 客房的房间挂接空间在 rooms.ts（锁顺序：房间 → 空间）。谁能改：店主、店总（与后台「客房」同一组权限）。
// 加锁顺序：导入：按文件摘要的咨询锁 → 楼层表（共享）→ 区域表 → 空间表（导入期间与逐条新建、编辑串行）；
// 编辑空间：空间一行 → 区域一行（共享，确认在用）；别名：空间一行 → 别名一行；批量设区域：空间（id 升序）→ 区域一行（共享）。

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  FLOOR_CODE_RE,
  MAX_ALIAS,
  MAX_BUSINESS_TYPE,
  MAX_CAPACITY,
  MAX_DISPLAY_NAME,
  MAX_FLOOR_NAME,
  MAX_NAME_EN,
  MAX_SOURCE_LABEL,
  MAX_SPACE_NOTE,
  MAX_ZONE_NAME,
  ROOM_BUSINESS_TYPE,
  SPACE_ALIAS_KINDS,
  SPACE_ALIAS_LABELS,
  SPACE_BUSINESS_TYPES,
  SPACE_CODE_RE,
  SPACE_EXPORT_COLUMNS,
  SPACE_IMPORT_COLUMN_ALIASES,
  SPACE_IMPORT_COLUMNS,
  SPACE_IMPORT_KINDS,
  SPACE_IMPORT_LABELS,
  SPACE_VERIFY_LABELS,
  SPACE_VERIFY_STATUSES,
  ZONE_IMPORT_COLUMNS,
  areaText,
  parseArea,
  parseCapacity,
  parseSellable,
  parseVerifyStatus,
  verifyStatusFromNote,
  type Floor,
  type Space,
  type SpaceAlias,
  type SpaceImportDiff,
  type SpaceImportIssue,
  type SpaceImportKind,
  type SpaceImportPreview,
  type SpaceImportRecord,
  type SpaceLedger,
  type SpaceTree,
  type SpaceVerifyStatus,
  type Zone,
} from '@shared/spaces';
import type { Db, Tx } from '../db';
import { isUniqueViolation } from '../db';
import { guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps, OpContext } from '../lib/context';
import { toCsv } from '../lib/csv';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced, lockOpKey } from '../lib/fences';
import { readSheet, type Sheet } from '../lib/sheet-read';
import { idParam, parse } from '../lib/validate';
import { erpOpAbandoned } from './erp-ops';
import { setTxTimeouts } from './inventory/common';

const hashRequest = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const text = (label: string, max: number) =>
  z
    .string(`请填写${label}`)
    .trim()
    .min(1, `请填写${label}`)
    .max(max, `${label}最多 ${max} 个字`);
const optionalText = (label: string, max: number) => z.string().trim().max(max, `${label}最多 ${max} 个字`).default('');
const reasonText = (label: string) => z.string(`请填写${label}`).trim().min(2, `请填写${label}（至少 2 个字）`).max(200, `${label}最多 200 字`);

/** 一份导入文件最多多少行 */
export const SPACE_IMPORT_MAX_ROWS = 2000;

// ───────────────────────── 读取 ─────────────────────────

type SpaceRow = Omit<Space, 'aliases' | 'room'>;

export async function spaceLedger(db: Db): Promise<SpaceLedger> {
  const floors = await db<Floor[]>`
    SELECT f.id, f.code, f.name, f.sort_order, f.active,
           (SELECT count(*) FROM zones z WHERE z.floor_id = f.id AND z.active)::int AS zone_count,
           (SELECT count(*) FROM spaces s WHERE s.floor_id = f.id AND s.active)::int AS space_count
    FROM floors f ORDER BY f.sort_order, f.code`;
  const zones = await db<Zone[]>`
    SELECT z.id, z.floor_id, z.name, z.name_en, z.note, z.sort_order, z.active,
           (SELECT count(*) FROM spaces s WHERE s.zone_id = z.id AND s.active)::int AS space_count
    FROM zones z JOIN floors f ON f.id = z.floor_id ORDER BY f.sort_order, z.sort_order, z.id`;
  const rows = await db<SpaceRow[]>`
    SELECT s.id, s.code, s.floor_id, s.zone_id, s.business_type, s.capacity, s.area_centi_m2, s.display_name, s.name_en, s.sellable,
           s.verify_status, s.verified_at, vb.display_name AS verified_by_name, s.verify_note, s.source_label, s.note, s.active, s.import_id,
           s.created_at, s.updated_at
    FROM spaces s JOIN floors f ON f.id = s.floor_id LEFT JOIN staff vb ON vb.id = s.verified_by
    ORDER BY f.sort_order, s.code`;
  const aliases = await db<(SpaceAlias & { spaceId: number })[]>`
    SELECT a.id, a.space_id, a.alias, a.kind, a.active, a.created_at, cb.display_name AS created_by_name, a.retired_at, rb.display_name AS retired_by_name
    FROM space_aliases a LEFT JOIN staff cb ON cb.id = a.created_by LEFT JOIN staff rb ON rb.id = a.retired_by
    ORDER BY a.space_id, a.active DESC, a.id`;
  const rooms = await db<{ id: number; roomNo: string; active: boolean; spaceId: number }[]>`
    SELECT id, room_no, active, space_id FROM rooms WHERE space_id IS NOT NULL`;
  const aliasBySpace = new Map<number, SpaceAlias[]>();
  for (const { spaceId, ...a } of aliases) {
    const list = aliasBySpace.get(spaceId) ?? [];
    list.push(a);
    aliasBySpace.set(spaceId, list);
  }
  const roomBySpace = new Map(rooms.map((r) => [r.spaceId, { id: r.id, roomNo: r.roomNo, active: r.active }]));
  const spaces: Space[] = rows.map((s) => ({ ...s, aliases: aliasBySpace.get(s.id) ?? [], room: roomBySpace.get(s.id) ?? null }));
  const live = spaces.filter((s) => s.active);
  const roomSpaces = live.filter((s) => s.businessType === ROOM_BUSINESS_TYPE);
  return {
    floors,
    zones,
    spaces,
    businessTypes: [...new Set<string>([...SPACE_BUSINESS_TYPES, ...spaces.map((s) => s.businessType)])],
    counts: {
      spaces: spaces.length,
      active: live.length,
      unverified: live.filter((s) => s.verifyStatus !== 'confirmed').length,
      roomSpaces: roomSpaces.length,
      roomSpacesLinked: roomSpaces.filter((s) => s.room).length,
      roomSpacesWithoutBrand: roomSpaces.filter((s) => !s.aliases.some((a) => a.active && a.kind === 'brand')).length,
    },
  };
}

/** 只读的楼层 → 区域 → 空间树（只含在用的；以后的房态图、对客导览用） */
export async function spaceTree(db: Db): Promise<SpaceTree> {
  const ledger = await spaceLedger(db);
  const node = (s: Space) => ({
    id: s.id,
    code: s.code,
    businessType: s.businessType,
    capacity: s.capacity,
    displayName: s.displayName,
    nameEn: s.nameEn,
    sellable: s.sellable,
    verifyStatus: s.verifyStatus,
    aliases: s.aliases.filter((a) => a.active).map((a) => a.alias),
    roomId: s.room?.id ?? null,
  });
  const live = ledger.spaces.filter((s) => s.active);
  return {
    floors: ledger.floors
      .filter((f) => f.active)
      .map((f) => ({
        id: f.id,
        code: f.code,
        name: f.name,
        zones: ledger.zones
          .filter((z) => z.floorId === f.id && z.active)
          .map((z) => ({ id: z.id, name: z.name, nameEn: z.nameEn, spaces: live.filter((s) => s.zoneId === z.id).map(node) })),
        spaces: live.filter((s) => s.floorId === f.id && s.zoneId === null).map(node),
      })),
  };
}

// ───────────────────────── 楼层与区域 ─────────────────────────

const FloorCreateInput = z.object({
  code: z
    .string('请填写楼层编码')
    .trim()
    .toUpperCase()
    .regex(FLOOR_CODE_RE, '楼层编码是大写字母开头、最多 4 位的字母或数字，例如 L4、B1'),
  name: text('楼层名称', MAX_FLOOR_NAME),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
const FloorUpdateInput = z.object({
  name: text('楼层名称', MAX_FLOOR_NAME),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  active: z.boolean().default(true),
});

async function createFloor(deps: Deps, raw: unknown, ctx: OpContext) {
  const f = parse(FloorCreateInput, raw);
  await deps.sql.begin(async (tx) => {
    const [dup] = await tx`SELECT 1 FROM floors WHERE code = ${f.code}`;
    if (dup) throw conflict('FLOOR_CODE_TAKEN', `已有楼层 ${f.code}`);
    const [row] = await tx<{ id: number }[]>`INSERT INTO floors (code, name, sort_order) VALUES (${f.code}, ${f.name}, ${f.sortOrder}) RETURNING id`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'space_zone_saved', targetType: 'floor', targetId: row!.id, detail: { summary: `新建楼层 ${f.code}「${f.name}」` }, ip: ctx.ip });
  });
}

async function updateFloor(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const f = parse(FloorUpdateInput, raw);
  await deps.sql.begin(async (tx) => {
    const [cur] = await tx<{ code: string; name: string; active: boolean }[]>`SELECT code, name, active FROM floors WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw notFound('楼层不存在');
    if (!f.active && cur.active) {
      const [used] = await tx<{ zones: number; spaces: number }[]>`
        SELECT (SELECT count(*) FROM zones WHERE floor_id = ${id} AND active)::int AS zones,
               (SELECT count(*) FROM spaces WHERE floor_id = ${id} AND active)::int AS spaces`;
      if (used!.zones > 0 || used!.spaces > 0) {
        throw conflict('FLOOR_IN_USE', `楼层 ${cur.code} 还有 ${used!.zones} 个在用的区域、${used!.spaces} 个在用的空间，先把它们停用`);
      }
    }
    await tx`UPDATE floors SET name = ${f.name}, sort_order = ${f.sortOrder}, active = ${f.active}, updated_at = now() WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'space_zone_saved',
      targetType: 'floor',
      targetId: id,
      detail: { summary: `修改楼层 ${cur.code}${cur.name !== f.name ? `「${cur.name}」→「${f.name}」` : ''}${f.active === cur.active ? '' : f.active ? '（启用）' : '（停用）'}` },
      ip: ctx.ip,
    });
  });
}

const ZoneFields = {
  name: text('区域名称', MAX_ZONE_NAME),
  nameEn: optionalText('英文名', MAX_NAME_EN),
  note: optionalText('备注', MAX_SPACE_NOTE),
  sortOrder: z.number().int().min(0).max(9999).default(0),
};
const ZoneCreateInput = z.object({ floorId: z.number('请选择楼层').int().positive('请选择楼层'), ...ZoneFields });
const ZoneUpdateInput = z.object({ ...ZoneFields, active: z.boolean().default(true) });

async function createZone(deps: Deps, raw: unknown, ctx: OpContext) {
  const z0 = parse(ZoneCreateInput, raw);
  await deps.sql.begin(async (tx) => {
    const [floor] = await tx<{ code: string; active: boolean }[]>`SELECT code, active FROM floors WHERE id = ${z0.floorId} FOR SHARE`;
    if (!floor) throw notFound('楼层不存在，请刷新后重试');
    if (!floor.active) throw conflict('FLOOR_INACTIVE', `楼层 ${floor.code} 已停用`);
    const [dup] = await tx`SELECT 1 FROM zones WHERE floor_id = ${z0.floorId} AND lower(btrim(name)) = lower(${z0.name})`;
    if (dup) throw conflict('ZONE_NAME_TAKEN', `${floor.code} 已有区域「${z0.name}」`);
    try {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO zones (floor_id, name, name_en, note, sort_order) VALUES (${z0.floorId}, ${z0.name}, ${z0.nameEn}, ${z0.note}, ${z0.sortOrder}) RETURNING id`;
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'space_zone_saved', targetType: 'zone', targetId: row!.id, detail: { summary: `新建区域 ${floor.code}「${z0.name}」` }, ip: ctx.ip });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('ZONE_NAME_TAKEN', `${floor.code} 已有区域「${z0.name}」`);
      throw e;
    }
  });
}

async function updateZone(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const z0 = parse(ZoneUpdateInput, raw);
  await deps.sql.begin(async (tx) => {
    const [cur] = await tx<{ floorId: number; name: string; active: boolean }[]>`SELECT floor_id, name, active FROM zones WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw notFound('区域不存在');
    const [dup] = await tx`SELECT 1 FROM zones WHERE floor_id = ${cur.floorId} AND lower(btrim(name)) = lower(${z0.name}) AND id <> ${id}`;
    if (dup) throw conflict('ZONE_NAME_TAKEN', `这一层已有区域「${z0.name}」`);
    if (!z0.active && cur.active) {
      const [used] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM spaces WHERE zone_id = ${id} AND active`;
      if (used!.n > 0) throw conflict('ZONE_IN_USE', `区域「${cur.name}」还有 ${used!.n} 个在用的空间，先把它们改到别的区域或停用`);
    }
    if (z0.active && !cur.active) {
      const [floor] = await tx<{ code: string; active: boolean }[]>`SELECT code, active FROM floors WHERE id = ${cur.floorId} FOR SHARE`;
      if (!floor!.active) throw conflict('FLOOR_INACTIVE', `楼层 ${floor!.code} 已停用，先启用楼层`);
    }
    await tx`
      UPDATE zones SET name = ${z0.name}, name_en = ${z0.nameEn}, note = ${z0.note}, sort_order = ${z0.sortOrder}, active = ${z0.active}, updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'space_zone_saved',
      targetType: 'zone',
      targetId: id,
      detail: { summary: `修改区域「${cur.name}」${cur.name !== z0.name ? ` → 「${z0.name}」` : ''}${z0.active === cur.active ? '' : z0.active ? '（启用）' : '（停用）'}` },
      ip: ctx.ip,
    });
  });
}

// ───────────────────────── 空间 ─────────────────────────

const SpaceFields = {
  floorId: z.number('请选择楼层').int().positive('请选择楼层'),
  zoneId: z.number('区域不正确').int().positive('区域不正确').nullable().default(null),
  businessType: text('业态', MAX_BUSINESS_TYPE),
  capacity: z.number('容量不正确').int('容量要是整数').min(1, '容量至少 1 人').max(MAX_CAPACITY, `容量最多 ${MAX_CAPACITY} 人`).nullable().default(null),
  areaCentiM2: z.number('面积不正确').int('面积不正确').min(1, '面积要大于 0').max(100_000_000, '面积太大').nullable().default(null),
  displayName: text('显示名', MAX_DISPLAY_NAME),
  nameEn: optionalText('英文名', MAX_NAME_EN),
  sellable: z.boolean().default(true),
  sourceLabel: optionalText('编码图原始标注', MAX_SOURCE_LABEL),
  note: optionalText('备注', MAX_SPACE_NOTE),
};
export const SpaceCodeSchema = z
  .string('请填写编码')
  .trim()
  .toUpperCase()
  .regex(SPACE_CODE_RE, '编码是大写字母开头、2 到 8 位的字母或数字，例如 S301');
const SpaceCreateInput = z.object({
  code: SpaceCodeSchema,
  ...SpaceFields,
  verifyStatus: z.enum(SPACE_VERIFY_STATUSES, '核对状态不正确').default('confirmed'),
});
const SpaceUpdateInput = z.object({ ...SpaceFields, active: z.boolean().default(true) });

/** 楼层在用；区域在用、在同一层（加共享锁，与停用楼层、区域串行） */
async function checkPlace(tx: Tx, floorId: number, zoneId: number | null) {
  const [floor] = await tx<{ code: string; active: boolean }[]>`SELECT code, active FROM floors WHERE id = ${floorId} FOR SHARE`;
  if (!floor) throw notFound('楼层不存在，请刷新后重试');
  if (!floor.active) throw conflict('FLOOR_INACTIVE', `楼层 ${floor.code} 已停用`);
  if (zoneId !== null) {
    const [zone] = await tx<{ floorId: number; name: string; active: boolean }[]>`SELECT floor_id, name, active FROM zones WHERE id = ${zoneId} FOR SHARE`;
    if (!zone) throw notFound('区域不存在，请刷新后重试');
    if (!zone.active) throw conflict('ZONE_INACTIVE', `区域「${zone.name}」已停用`);
    if (zone.floorId !== floorId) throw unprocessable('ZONE_FLOOR_MISMATCH', `区域「${zone.name}」不在 ${floor.code}，请选这一层的区域`);
  }
  return floor;
}

async function createSpace(deps: Deps, raw: unknown, ctx: OpContext) {
  const s = parse(SpaceCreateInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const floor = await checkPlace(tx, s.floorId, s.zoneId);
    const [dup] = await tx<{ active: boolean }[]>`SELECT active FROM spaces WHERE code = ${s.code}`;
    if (dup) throw conflict('SPACE_CODE_TAKEN', `编码 ${s.code} 已在台账里${dup.active ? '' : '（已停用；编码不能重复使用，可以启用原来的）'}`);
    try {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO spaces (code, floor_id, zone_id, business_type, capacity, area_centi_m2, display_name, name_en, sellable,
                            verify_status, verified_by, verified_at, source_label, note, created_by)
        VALUES (${s.code}, ${s.floorId}, ${s.zoneId}, ${s.businessType}, ${s.capacity}, ${s.areaCentiM2}, ${s.displayName}, ${s.nameEn}, ${s.sellable},
                ${s.verifyStatus}, ${s.verifyStatus === 'confirmed' ? ctx.actor.id : null}, ${s.verifyStatus === 'confirmed' ? new Date() : null},
                ${s.sourceLabel}, ${s.note}, ${ctx.actor.id})
        RETURNING id`;
      if (s.sourceLabel) {
        await tx`INSERT INTO space_aliases (space_id, alias, kind, created_by) VALUES (${row!.id}, ${s.sourceLabel}, 'source', ${ctx.actor.id})`;
      }
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'space_saved',
        targetType: 'space',
        targetId: row!.id,
        detail: { summary: `新建空间 ${s.code}（${floor.code} · ${s.businessType} · ${s.displayName}）`, code: s.code },
        ip: ctx.ip,
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('SPACE_CODE_TAKEN', `编码 ${s.code} 刚被别人建了，请刷新后查看`);
      throw e;
    }
  });
}

/** 锁空间一行；不存在 404 */
async function lockSpace(tx: Tx, id: number) {
  const [cur] = await tx<
    {
      code: string;
      floorId: number;
      zoneId: number | null;
      businessType: string;
      displayName: string;
      active: boolean;
      sellable: boolean;
      verifyStatus: SpaceVerifyStatus;
    }[]
  >`SELECT code, floor_id, zone_id, business_type, display_name, active, sellable, verify_status FROM spaces WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound('空间不存在');
  return cur;
}

/** 挂着客房房间的空间：不能停用、不能改成别的业态（先在「客房 → 房间」里取消挂接） */
async function linkedRoom(tx: Tx, spaceId: number) {
  const [room] = await tx<{ roomNo: string }[]>`SELECT room_no FROM rooms WHERE space_id = ${spaceId}`;
  return room ?? null;
}

async function updateSpace(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const s = parse(SpaceUpdateInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const cur = await lockSpace(tx, id);
    if (s.active || s.floorId !== cur.floorId || s.zoneId !== cur.zoneId) await checkPlace(tx, s.floorId, s.zoneId);
    if ((!s.active && cur.active) || (s.businessType !== ROOM_BUSINESS_TYPE && cur.businessType === ROOM_BUSINESS_TYPE)) {
      const room = await linkedRoom(tx, id);
      if (room) {
        throw conflict('SPACE_HAS_ROOM', `空间 ${cur.code} 挂着客房房间「${room.roomNo}」，不能${s.active ? `改成「${s.businessType}」` : '停用'}；先在后台「客房 → 房间」里取消挂接`);
      }
    }
    await tx`
      UPDATE spaces SET floor_id = ${s.floorId}, zone_id = ${s.zoneId}, business_type = ${s.businessType}, capacity = ${s.capacity},
             area_centi_m2 = ${s.areaCentiM2}, display_name = ${s.displayName}, name_en = ${s.nameEn}, sellable = ${s.sellable},
             source_label = ${s.sourceLabel}, note = ${s.note}, active = ${s.active}, updated_at = now()
      WHERE id = ${id}`;
    const changes = [
      cur.displayName !== s.displayName ? `显示名「${cur.displayName}」→「${s.displayName}」` : '',
      cur.businessType !== s.businessType ? `业态 ${cur.businessType} → ${s.businessType}` : '',
      cur.sellable !== s.sellable ? (s.sellable ? '改为可售' : '改为不可售') : '',
      cur.active !== s.active ? (s.active ? '启用' : '停用') : '',
    ].filter(Boolean);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'space_saved',
      targetType: 'space',
      targetId: id,
      detail: { summary: `修改空间 ${cur.code}${changes.length ? `：${changes.join('，')}` : ''}`, code: cur.code },
      ip: ctx.ip,
    });
  });
}

const VerifyInput = z.object({
  status: z.enum(SPACE_VERIFY_STATUSES, '请选择核对状态'),
  note: reasonText('核对说明'),
});

async function verifySpace(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const v = parse(VerifyInput, raw);
  await deps.sql.begin(async (tx) => {
    const cur = await lockSpace(tx, id);
    await tx`
      UPDATE spaces SET verify_status = ${v.status}, verified_by = ${ctx.actor.id}, verified_at = now(), verify_note = ${v.note}, updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'space_saved',
      targetType: 'space',
      targetId: id,
      detail: {
        summary: `空间 ${cur.code} 核对状态：${SPACE_VERIFY_LABELS[cur.verifyStatus]} → ${SPACE_VERIFY_LABELS[v.status]}（${v.note}）`,
        code: cur.code,
        before: cur.verifyStatus,
        after: v.status,
      },
      ip: ctx.ip,
    });
  });
}

const AliasInput = z.object({
  alias: text('别名', MAX_ALIAS),
  kind: z.enum(SPACE_ALIAS_KINDS, '请选择别名类型'),
});

async function addAlias(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext) {
  const a = parse(AliasInput, raw);
  await deps.sql.begin(async (tx) => {
    const cur = await lockSpace(tx, spaceId);
    const [dup] = await tx`SELECT 1 FROM space_aliases WHERE space_id = ${spaceId} AND active AND lower(btrim(alias)) = lower(${a.alias})`;
    if (dup) throw conflict('ALIAS_EXISTS', `空间 ${cur.code} 已有别名「${a.alias}」`);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO space_aliases (space_id, alias, kind, created_by) VALUES (${spaceId}, ${a.alias}, ${a.kind}, ${ctx.actor.id}) RETURNING id`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'space_saved',
      targetType: 'space',
      targetId: spaceId,
      detail: { summary: `空间 ${cur.code} 加${SPACE_ALIAS_LABELS[a.kind]}「${a.alias}」`, code: cur.code, aliasId: row!.id },
      ip: ctx.ip,
    });
  });
}

async function retireAlias(deps: Deps, spaceId: number, aliasId: number, ctx: OpContext) {
  await deps.sql.begin(async (tx) => {
    const cur = await lockSpace(tx, spaceId);
    const [alias] = await tx<{ alias: string; active: boolean }[]>`SELECT alias, active FROM space_aliases WHERE id = ${aliasId} AND space_id = ${spaceId} FOR UPDATE`;
    if (!alias) throw notFound('别名不存在，请刷新后重试');
    if (!alias.active) throw conflict('ALIAS_RETIRED', `别名「${alias.alias}」已经停用`);
    await tx`UPDATE space_aliases SET active = false, retired_by = ${ctx.actor.id}, retired_at = now() WHERE id = ${aliasId}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'space_saved',
      targetType: 'space',
      targetId: spaceId,
      detail: { summary: `空间 ${cur.code} 停用别名「${alias.alias}」`, code: cur.code, aliasId },
      ip: ctx.ip,
    });
  });
}

const BulkZoneInput = z.object({
  spaceIds: z.array(z.number().int().positive(), '请选择空间').min(1, '请选择空间').max(500, '一次最多 500 个空间'),
  zoneId: z.number('区域不正确').int().positive('区域不正确').nullable(),
});

/** 批量设区域（空间清单没有「区域」列时导入后一次设好）：空间都要在区域那一层 */
async function bulkSetZone(deps: Deps, raw: unknown, ctx: OpContext) {
  const b = parse(BulkZoneInput, raw);
  const ids = [...new Set(b.spaceIds)].sort((x, y) => x - y);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const rows = await tx<{ id: number; code: string; floorId: number }[]>`SELECT id, code, floor_id FROM spaces WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
    if (rows.length !== ids.length) throw notFound('有空间不存在，请刷新后重试');
    let zoneName = '（不分区域）';
    if (b.zoneId !== null) {
      const [zone] = await tx<{ floorId: number; name: string; active: boolean }[]>`SELECT floor_id, name, active FROM zones WHERE id = ${b.zoneId} FOR SHARE`;
      if (!zone) throw notFound('区域不存在，请刷新后重试');
      if (!zone.active) throw conflict('ZONE_INACTIVE', `区域「${zone.name}」已停用`);
      const off = rows.filter((r) => r.floorId !== zone.floorId);
      if (off.length) throw unprocessable('ZONE_FLOOR_MISMATCH', `${off.map((r) => r.code).slice(0, 5).join('、')} 不在区域「${zone.name}」那一层`);
      zoneName = `「${zone.name}」`;
    }
    await tx`UPDATE spaces SET zone_id = ${b.zoneId}, updated_at = now() WHERE id IN ${tx(ids)}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'space_saved',
      targetType: 'space',
      detail: { summary: `${rows.length} 个空间设为区域${zoneName}（${rows.map((r) => r.code).slice(0, 6).join('、')}${rows.length > 6 ? '…' : ''}）`, codes: rows.map((r) => r.code) },
      ip: ctx.ip,
    });
  });
}

// ───────────────────────── 导入 ─────────────────────────

const FileFields = z.object({
  kind: z.enum(SPACE_IMPORT_KINDS, '请选择导入空间清单还是区域清单'),
  fileName: z.string().trim().min(1, '缺少文件名').max(200, '文件名太长'),
  /** CSV 的文字（浏览器已识别 UTF-8 / GBK） */
  csv: z.string().max(2_000_000, '文件太大，请分批导入').optional(),
  /** Excel 原文件（base64） */
  xlsxBase64: z.string().max(2_800_000, '文件太大，请分批导入').optional(),
  encoding: z.string().max(16).default(''),
});
const oneFile = (f: { csv?: string; xlsxBase64?: string }) => !!f.csv !== !!f.xlsxBase64;
const FileInput = FileFields.refine(oneFile, { message: '请选择一个 CSV 或 Excel 文件', path: ['csv'] });
const ApplyInput = FileFields.extend({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') }).refine(oneFile, {
  message: '请选择一个 CSV 或 Excel 文件',
  path: ['csv'],
});
type FileInputData = z.infer<typeof FileInput>;

/** 表头：去空格、全角括号改半角，再认其他写法（「容量」→「容量(人)」） */
const normalizeHeader = (h: string) => {
  const t = h.trim().replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '');
  return SPACE_IMPORT_COLUMN_ALIASES[t] ?? t;
};

interface NewSpace {
  row: number;
  code: string;
  floorId: number;
  zoneId: number | null;
  businessType: string;
  capacity: number | null;
  areaCentiM2: number | null;
  displayName: string;
  nameEn: string;
  sellable: boolean;
  verifyStatus: SpaceVerifyStatus;
  sourceLabel: string;
  note: string;
}
interface NewZone {
  row: number;
  floorId: number;
  name: string;
  nameEn: string;
  note: string;
}
interface Plan {
  sheet: Sheet;
  issues: SpaceImportIssue[];
  diffs: SpaceImportDiff[];
  spaces: NewSpace[];
  zones: NewZone[];
  skipCount: number;
}

/** 解析并逐行校验（预览与写入用同一套；写入时在锁住表之后再算一次） */
async function plan(db: Db, f: FileInputData): Promise<Plan> {
  const sheet = readSheet(f);
  const header = sheet.header.map(normalizeHeader);
  const columns: readonly string[] = f.kind === 'spaces' ? SPACE_IMPORT_COLUMNS : ZONE_IMPORT_COLUMNS;
  const required = f.kind === 'spaces' ? ['楼层', '编码', '业态'] : ['楼层', '区域名(中文)'];
  const col = new Map(columns.map((c) => [c, header.indexOf(c)]));
  const has = (name: string) => (col.get(name) ?? -1) >= 0;
  const empty: Plan = { sheet, issues: [], diffs: [], spaces: [], zones: [], skipCount: 0 };
  const missing = required.filter((c) => !has(c));
  if (missing.length) {
    return { ...empty, issues: [{ row: 1, message: `表头缺少「${missing.join('」「')}」列（${SPACE_IMPORT_LABELS[f.kind]}的列：${columns.join('、')}）` }] };
  }
  const issues: SpaceImportIssue[] = [];
  if (sheet.rows.length === 0) issues.push({ row: 1, message: '文件里只有表头，没有要导入的行' });
  if (sheet.rows.length > SPACE_IMPORT_MAX_ROWS) issues.push({ row: 1, message: `一份文件最多 ${SPACE_IMPORT_MAX_ROWS} 行，请分批导入` });
  const cell = (r: Sheet['rows'][number], name: string) => {
    const i = col.get(name) ?? -1;
    return i >= 0 ? (r.cells[i] ?? '').trim() : '';
  };
  const floors = await db<{ id: number; code: string; active: boolean }[]>`SELECT id, code, active FROM floors`;
  const floorByCode = new Map(floors.map((x) => [x.code, x]));
  const floorCodeById = new Map(floors.map((x) => [x.id, x.code]));
  const floorList = floors.filter((x) => x.active).map((x) => x.code).join('、');
  const zones = await db<{ id: number; floorId: number; name: string; nameEn: string; note: string; active: boolean }[]>`
    SELECT id, floor_id, name, name_en, note, active FROM zones`;
  const zoneKey = (floorId: number, name: string) => `${floorId}:${name.trim().toLowerCase()}`;
  const zoneByKey = new Map(zones.map((x) => [zoneKey(x.floorId, x.name), x]));
  const zoneNameById = new Map(zones.map((x) => [x.id, x.name]));
  const floorOf = (r: Sheet['rows'][number], p: string[]) => {
    const code = cell(r, '楼层').toUpperCase();
    const floor = floorByCode.get(code);
    if (!code) p.push('楼层为空');
    else if (!floor) p.push(`楼层「${cell(r, '楼层')}」不在台账里（现有 ${floorList}）`);
    else if (!floor.active) p.push(`楼层 ${code} 已停用`);
    return floor && floor.active ? floor : null;
  };
  const diffs: SpaceImportDiff[] = [];
  let skipCount = 0;

  if (f.kind === 'zones') {
    const seen = new Map<string, number>();
    const newZones: NewZone[] = [];
    for (const r of sheet.rows) {
      const p: string[] = [];
      const floor = floorOf(r, p);
      const name = cell(r, '区域名(中文)');
      const nameEn = cell(r, '区域名(英文)');
      const note = cell(r, '备注');
      if (!name) p.push('区域名为空');
      else if (name.length > MAX_ZONE_NAME) p.push(`区域名超过 ${MAX_ZONE_NAME} 个字`);
      if (nameEn.length > MAX_NAME_EN) p.push(`英文名超过 ${MAX_NAME_EN} 个字`);
      if (note.length > MAX_SPACE_NOTE) p.push(`备注超过 ${MAX_SPACE_NOTE} 个字`);
      if (floor && name) {
        const key = zoneKey(floor.id, name);
        if (seen.has(key)) p.push(`${floor.code}「${name}」与第 ${seen.get(key)} 行重复`);
        seen.set(key, r.row);
        const existing = zoneByKey.get(key);
        if (!p.length && existing) {
          skipCount++;
          const fields = [
            existing.nameEn !== nameEn ? { field: '英文名', ledger: existing.nameEn, file: nameEn } : null,
            existing.note !== note ? { field: '备注', ledger: existing.note, file: note } : null,
            !existing.active ? { field: '在用', ledger: '停用', file: '在用' } : null,
          ].filter((x): x is NonNullable<typeof x> => x !== null);
          if (fields.length) diffs.push({ row: r.row, key: `${floor.code} · ${existing.name}`, fields });
          continue;
        }
      }
      if (p.length) issues.push({ row: r.row, message: p.join('；') });
      else newZones.push({ row: r.row, floorId: floor!.id, name, nameEn, note });
    }
    return { sheet, issues, diffs, spaces: [], zones: newZones, skipCount };
  }

  const existing = new Map(
    (
      await db<
        {
          code: string;
          floorId: number;
          zoneId: number | null;
          businessType: string;
          capacity: number | null;
          areaCentiM2: number | null;
          displayName: string;
          nameEn: string;
          sellable: boolean;
          verifyStatus: SpaceVerifyStatus;
          sourceLabel: string;
          note: string;
          active: boolean;
        }[]
      >`SELECT code, floor_id, zone_id, business_type, capacity, area_centi_m2, display_name, name_en, sellable, verify_status, source_label, note, active FROM spaces`
    ).map((s) => [s.code, s]),
  );
  const seen = new Map<string, number>();
  const newSpaces: NewSpace[] = [];
  for (const r of sheet.rows) {
    const p: string[] = [];
    const floor = floorOf(r, p);
    const rawCode = cell(r, '编码');
    const code = rawCode.toUpperCase().replace(/\s+/g, '');
    const letter = cell(r, '区域字母').toUpperCase();
    const businessType = cell(r, '业态');
    const capacity = parseCapacity(cell(r, '容量(人)'));
    const area = parseArea(cell(r, '面积'));
    const displayName = cell(r, '建议显示名') || code;
    const nameEn = cell(r, '英文名');
    const sourceLabel = cell(r, '编码图原始标注');
    const note = cell(r, '备注');
    const zoneName = cell(r, '区域');
    const sellable = parseSellable(cell(r, '可售'));
    const verifyText = cell(r, '核对状态');
    const verifyStatus = verifyText ? parseVerifyStatus(verifyText) : verifyStatusFromNote(note);
    if (!code) p.push('编码为空');
    else if (!SPACE_CODE_RE.test(code)) p.push(`编码「${rawCode}」要是大写字母开头、2 到 8 位的字母或数字（如 S301）`);
    else if (seen.has(code)) p.push(`编码 ${code} 与第 ${seen.get(code)} 行重复`);
    if (code) seen.set(code, r.row);
    if (letter && code && !code.startsWith(letter)) p.push(`编码 ${code} 与区域字母「${letter}」对不上`);
    if (!businessType) p.push('业态为空');
    else if (businessType.length > MAX_BUSINESS_TYPE) p.push(`业态超过 ${MAX_BUSINESS_TYPE} 个字`);
    if (capacity === undefined) p.push(`容量「${cell(r, '容量(人)')}」要是 1 到 ${MAX_CAPACITY} 的整数（可以空着）`);
    if (area === undefined) p.push(`面积「${cell(r, '面积')}」要是大于 0 的数字（如 95、95m²，最多两位小数，可以空着）`);
    if (displayName.length > MAX_DISPLAY_NAME) p.push(`显示名超过 ${MAX_DISPLAY_NAME} 个字`);
    if (nameEn.length > MAX_NAME_EN) p.push(`英文名超过 ${MAX_NAME_EN} 个字`);
    if (sourceLabel.length > MAX_SOURCE_LABEL) p.push(`编码图原始标注超过 ${MAX_SOURCE_LABEL} 个字`);
    if (note.length > MAX_SPACE_NOTE) p.push(`备注超过 ${MAX_SPACE_NOTE} 个字`);
    if (sellable === undefined) p.push(`可售「${cell(r, '可售')}」只能写是或否（空着按是）`);
    if (verifyStatus === null) p.push(`核对状态「${verifyText}」只能写已核对、推断或待现场核对（空着按备注判断）`);
    let zoneId: number | null = null;
    if (zoneName && floor) {
      const zone = zoneByKey.get(zoneKey(floor.id, zoneName));
      if (!zone) p.push(`${floor.code} 没有区域「${zoneName}」（先导入区域清单或在台账里建）`);
      else if (!zone.active) p.push(`区域「${zoneName}」已停用`);
      else zoneId = zone.id;
    }
    const old = code ? existing.get(code) : undefined;
    if (!p.length && old) {
      // 编码已在台账里：不覆盖，列出差异
      skipCount++;
      const fields: SpaceImportDiff['fields'] = [];
      const diff = (field: string, ledger: string, file: string) => ledger !== file && fields.push({ field, ledger, file });
      diff('楼层', floorCodeById.get(old.floorId) ?? '', floor!.code);
      if (zoneName) diff('区域', old.zoneId ? (zoneNameById.get(old.zoneId) ?? '') : '', zoneName);
      diff('业态', old.businessType, businessType);
      diff('容量(人)', old.capacity === null ? '' : String(old.capacity), capacity === null || capacity === undefined ? '' : String(capacity));
      diff('面积', areaText(old.areaCentiM2), areaText(area ?? null));
      diff('建议显示名', old.displayName, displayName);
      if (has('英文名')) diff('英文名', old.nameEn, nameEn);
      diff('编码图原始标注', old.sourceLabel, sourceLabel);
      diff('备注', old.note, note);
      if (has('可售') && cell(r, '可售')) diff('可售', old.sellable ? '是' : '否', sellable ? '是' : '否');
      if (verifyText) diff('核对状态', SPACE_VERIFY_LABELS[old.verifyStatus], SPACE_VERIFY_LABELS[verifyStatus!]);
      if (!old.active) fields.push({ field: '在用', ledger: '停用', file: '在用' });
      if (fields.length) diffs.push({ row: r.row, key: code, fields });
      continue;
    }
    if (p.length) issues.push({ row: r.row, message: p.join('；') });
    else
      newSpaces.push({
        row: r.row,
        code,
        floorId: floor!.id,
        zoneId,
        businessType,
        capacity: capacity ?? null,
        areaCentiM2: area ?? null,
        displayName,
        nameEn,
        sellable: sellable!,
        verifyStatus: verifyStatus!,
        sourceLabel,
        note,
      });
  }
  return { sheet, issues, diffs, spaces: newSpaces, zones: [], skipCount };
}

async function duplicateOf(db: Db, sha256: string): Promise<SpaceImportPreview['duplicateOf']> {
  const [row] = await db<NonNullable<SpaceImportPreview['duplicateOf']>[]>`
    SELECT i.id, i.created_at, s.display_name AS created_by_name FROM space_imports i JOIN staff s ON s.id = i.created_by WHERE i.file_sha256 = ${sha256}`;
  return row ?? null;
}

export async function previewSpaceImport(db: Db, raw: unknown): Promise<SpaceImportPreview> {
  const f = parse(FileInput, raw);
  const p = await plan(db, f);
  const header = p.sheet.header;
  return {
    kind: f.kind,
    fileName: f.fileName,
    fileSha256: p.sheet.sha256,
    encoding: f.xlsxBase64 ? 'Excel' : f.encoding || 'UTF-8',
    rowCount: p.sheet.rows.length,
    createCount: f.kind === 'spaces' ? p.spaces.length : p.zones.length,
    skipCount: p.skipCount,
    inferredCount: p.spaces.filter((s) => s.verifyStatus === 'inferred').length,
    siteCheckCount: p.spaces.filter((s) => s.verifyStatus === 'site_check').length,
    issues: p.issues,
    diffs: p.diffs,
    duplicateOf: await duplicateOf(db, p.sheet.sha256),
    sample: p.sheet.rows.slice(0, 20).map((r) => Object.fromEntries(header.map((h, i) => [h || `第 ${i + 1} 列`, r.cells[i] ?? '']))),
  };
}

export async function getSpaceImport(db: Db, id: number): Promise<SpaceImportRecord> {
  const [row] = await db<SpaceImportRecord[]>`
    SELECT i.id, i.kind, i.file_name, i.row_count, i.created_count, i.skipped_count, s.display_name AS created_by_name, i.created_at
    FROM space_imports i JOIN staff s ON s.id = i.created_by WHERE i.id = ${id}`;
  if (!row) throw notFound('导入记录不存在');
  return row;
}

export async function listSpaceImports(db: Db): Promise<SpaceImportRecord[]> {
  return db<SpaceImportRecord[]>`
    SELECT i.id, i.kind, i.file_name, i.row_count, i.created_count, i.skipped_count, s.display_name AS created_by_name, i.created_at
    FROM space_imports i JOIN staff s ON s.id = i.created_by ORDER BY i.id DESC LIMIT 100`;
}

/** 写入：整份在一个事务里；同一个文件只写一次（重复提交得到原来那次的结果）；编码（区域名）已在台账里的不覆盖 */
export async function applySpaceImport(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ import: SpaceImportRecord; replayed: boolean }> {
  const f = parse(ApplyInput, raw);
  const requestHash = hashRequest({ ...f, clientKey: undefined });
  const r = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 同一个操作编号排队：重提得到原来那次的结果；页面上确认作废过的编号晚到也不写入
    await lockOpKey(tx, f.clientKey);
    const [seen] = await tx<{ opType: string; requestHash: string; refId: number }[]>`
      SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${f.clientKey}`;
    if (seen) {
      if (seen.opType !== 'space_import' || seen.requestHash !== requestHash) {
        throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次导入，请刷新页面后重新选择文件');
      }
      return { id: Number(seen.refId), replayed: true };
    }
    await assertNotFenced(tx, f.clientKey, 'space_import', erpOpAbandoned);
    const first = readSheet(f);
    // 同一个文件串行处理
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`space_import:${first.sha256}`}, 0))`;
    const keep = (importId: number) =>
      tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${f.clientKey}, 'space_import', ${requestHash}, ${importId}, ${actor.id})`;
    const dup = await duplicateOf(tx, first.sha256);
    if (dup) {
      await keep(dup.id);
      return { id: dup.id, replayed: true };
    }
    // 导入期间楼层、区域不变，空间（区域）编码与逐条新建串行：楼层 → 区域 → 空间
    await tx`LOCK TABLE floors IN SHARE MODE`;
    if (f.kind === 'spaces') {
      await tx`LOCK TABLE zones IN SHARE MODE`;
      await tx`LOCK TABLE spaces IN SHARE ROW EXCLUSIVE MODE`;
    } else await tx`LOCK TABLE zones IN SHARE ROW EXCLUSIVE MODE`;
    const p = await plan(tx, f);
    if (p.issues.length) {
      throw unprocessable('IMPORT_INVALID', `有 ${p.issues.length} 行要先改好才能导入：${p.issues.slice(0, 3).map((i) => `第 ${i.row} 行 ${i.message}`).join('；')}`, {
        issues: p.issues,
      });
    }
    const created = f.kind === 'spaces' ? p.spaces.length : p.zones.length;
    if (created === 0) throw unprocessable('IMPORT_NOTHING_NEW', `文件里的${f.kind === 'spaces' ? '编码' : '区域'}都已在台账里，没有要新建的（与台账不同的地方见预览里的差异）`);
    const [imp] = await tx<{ id: number }[]>`
      INSERT INTO space_imports (kind, file_name, file_sha256, row_count, created_count, skipped_count, created_by)
      VALUES (${f.kind}, ${f.fileName}, ${p.sheet.sha256}, ${p.sheet.rows.length}, ${created}, ${p.skipCount}, ${actor.id})
      RETURNING id`;
    const importId = imp!.id;
    await keep(importId);
    if (f.kind === 'zones') {
      for (const z0 of p.zones) {
        await tx`
          INSERT INTO zones (floor_id, name, name_en, note, sort_order, import_id)
          VALUES (${z0.floorId}, ${z0.name}, ${z0.nameEn}, ${z0.note}, ${z0.row}, ${importId})`;
      }
    } else {
      for (const s of p.spaces) {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO spaces (code, floor_id, zone_id, business_type, capacity, area_centi_m2, display_name, name_en, sellable,
                              verify_status, source_label, note, import_id, created_by)
          VALUES (${s.code}, ${s.floorId}, ${s.zoneId}, ${s.businessType}, ${s.capacity}, ${s.areaCentiM2}, ${s.displayName}, ${s.nameEn}, ${s.sellable},
                  ${s.verifyStatus}, ${s.sourceLabel}, ${s.note}, ${importId}, ${actor.id})
          RETURNING id`;
        // 编码图原始标注同时记为别名（可以按它搜到）
        if (s.sourceLabel) await tx`INSERT INTO space_aliases (space_id, alias, kind, created_by) VALUES (${row!.id}, ${s.sourceLabel}, 'source', ${actor.id})`;
      }
    }
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'space_import',
      targetType: 'space_import',
      targetId: importId,
      detail: {
        summary: `导入${SPACE_IMPORT_LABELS[f.kind]}「${f.fileName}」：新建 ${created} 个${p.skipCount ? `，已在台账里的 ${p.skipCount} 个不覆盖` : ''}`,
        kind: f.kind,
        fileName: f.fileName,
        rows: p.sheet.rows.length,
        created,
        skipped: p.skipCount,
        sha256: p.sheet.sha256,
      },
      ip,
    });
    return { id: importId, replayed: false };
  });
  return { import: await getSpaceImport(deps.sql, r.id), replayed: r.replayed };
}

// ───────────────────────── 导出 ─────────────────────────

export async function spacesCsv(db: Db): Promise<string> {
  const ledger = await spaceLedger(db);
  const floorCode = new Map(ledger.floors.map((f) => [f.id, f.code]));
  const zoneName = new Map(ledger.zones.map((z) => [z.id, z.name]));
  const rows: (string | number)[][] = [[...SPACE_EXPORT_COLUMNS, '在用']];
  for (const s of ledger.spaces) {
    rows.push([
      floorCode.get(s.floorId) ?? '',
      s.zoneId ? (zoneName.get(s.zoneId) ?? '') : '',
      s.code,
      s.businessType,
      s.capacity ?? '',
      areaText(s.areaCentiM2),
      s.displayName,
      s.nameEn,
      s.sourceLabel,
      s.aliases
        .filter((a) => a.active && a.kind !== 'source')
        .map((a) => a.alias)
        .join('、'),
      s.sellable ? '是' : '否',
      SPACE_VERIFY_LABELS[s.verifyStatus],
      s.note,
      s.active ? '是' : '否',
    ]);
  }
  return toCsv(rows);
}

// ───────────────────────── 自检 ─────────────────────────

/** 空间台账与客房挂接的自检（cli check 与备份核验共用） */
export async function spaceChecks(db: Db): Promise<{ label: string; ok: boolean; detail: string }[]> {
  // ① 编码唯一（大小写不敏感）、区域与空间在同一层、在用的空间不在停用的楼层
  const ledgerDiff = await db<{ ref: string }[]>`
    SELECT 'code ' || lower(code) AS ref FROM spaces GROUP BY lower(code) HAVING count(*) > 1
    UNION ALL
    SELECT s.code FROM spaces s JOIN zones z ON z.id = s.zone_id WHERE z.floor_id <> s.floor_id
    UNION ALL
    SELECT s.code FROM spaces s JOIN floors f ON f.id = s.floor_id WHERE s.active AND NOT f.active
    LIMIT 5`;
  const [ledger] = await db<{ spaces: number; active: number; unverified: number; zones: number }[]>`
    SELECT count(*)::int AS spaces, count(*) FILTER (WHERE active)::int AS active,
           count(*) FILTER (WHERE active AND verify_status <> 'confirmed')::int AS unverified,
           (SELECT count(*) FROM zones WHERE active)::int AS zones
    FROM spaces`;
  // ② 挂接的客房：空间是「客房」业态、在用，房号 = 空间编码；一个空间只挂一间（唯一索引兜底）
  const linkDiff = await db<{ ref: string }[]>`
    SELECT r.room_no AS ref FROM rooms r JOIN spaces s ON s.id = r.space_id
    WHERE s.business_type <> ${ROOM_BUSINESS_TYPE} OR NOT s.active OR r.room_no <> s.code
    LIMIT 5`;
  const [links] = await db<{ linked: number; unlinked: number }[]>`
    SELECT count(*) FILTER (WHERE space_id IS NOT NULL)::int AS linked, count(*) FILTER (WHERE space_id IS NULL AND active)::int AS unlinked FROM rooms`;
  return [
    {
      label: '空间台账编码唯一、区域与楼层一致',
      ok: ledgerDiff.length === 0,
      detail: ledgerDiff.length
        ? `${ledgerDiff.length} 处编码重复或楼层、区域不符（如 ${ledgerDiff.map((d) => d.ref).join('、')}）`
        : `空间 ${ledger!.spaces} 个（在用 ${ledger!.active} 个，其中没核对的 ${ledger!.unverified} 个），在用的区域 ${ledger!.zones} 个；编码不重复，空间与区域都在同一层`,
    },
    {
      label: '客房房间与空间台账挂接一致',
      ok: linkDiff.length === 0,
      detail: linkDiff.length
        ? `${linkDiff.length} 间房的挂接不符（空间不是在用的「客房」或房号不是空间编码，如 ${linkDiff.map((d) => d.ref).join('、')}）`
        : `挂接了空间的房间 ${links!.linked} 间，房号都是空间编码、空间都是在用的「客房」${links!.unlinked ? `；还没挂接的启用房间 ${links!.unlinked} 间` : ''}`,
    },
  ];
}

// ───────────────────────── 路由 ─────────────────────────

export function registerSpaceRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const ctxOf = (req: FastifyRequest): OpContext => ({ actor: req.actor, ip: req.ip });
  // 店主、店总：与后台「客房」同一组权限
  const admin = guardAny('settings.manage', 'catalog.manage');
  const bodyLimit = 4 * 1024 * 1024;
  const AliasParams = z.object({ id: z.coerce.number().int().positive('编号不正确'), aliasId: z.coerce.number().int().positive('编号不正确') });

  app.get('/api/admin/spaces', { preHandler: admin }, async () => spaceLedger(sql));
  app.post('/api/admin/spaces', { preHandler: admin }, async (req) => {
    await createSpace(deps, req.body, ctxOf(req));
    return spaceLedger(sql);
  });
  app.put('/api/admin/spaces/:id', { preHandler: admin }, async (req) => {
    await updateSpace(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return spaceLedger(sql);
  });
  app.post('/api/admin/spaces/:id/verify', { preHandler: admin }, async (req) => {
    await verifySpace(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return spaceLedger(sql);
  });
  app.post('/api/admin/spaces/:id/aliases', { preHandler: admin }, async (req) => {
    await addAlias(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return spaceLedger(sql);
  });
  app.post('/api/admin/spaces/:id/aliases/:aliasId/retire', { preHandler: admin }, async (req) => {
    const { id, aliasId } = parse(AliasParams, req.params);
    await retireAlias(deps, id, aliasId, ctxOf(req));
    return spaceLedger(sql);
  });
  app.post('/api/admin/spaces/bulk-zone', { preHandler: admin }, async (req) => {
    await bulkSetZone(deps, req.body, ctxOf(req));
    return spaceLedger(sql);
  });
  app.post('/api/admin/spaces/floors', { preHandler: admin }, async (req) => {
    await createFloor(deps, req.body, ctxOf(req));
    return spaceLedger(sql);
  });
  app.put('/api/admin/spaces/floors/:id', { preHandler: admin }, async (req) => {
    await updateFloor(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return spaceLedger(sql);
  });
  app.post('/api/admin/spaces/zones', { preHandler: admin }, async (req) => {
    await createZone(deps, req.body, ctxOf(req));
    return spaceLedger(sql);
  });
  app.put('/api/admin/spaces/zones/:id', { preHandler: admin }, async (req) => {
    await updateZone(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return spaceLedger(sql);
  });

  // 导入（先预览，再写入）与导入记录
  app.get('/api/admin/spaces/imports', { preHandler: admin }, async () => listSpaceImports(sql));
  app.post('/api/admin/spaces/imports/preview', { preHandler: admin, bodyLimit }, async (req) => previewSpaceImport(sql, req.body));
  app.post('/api/admin/spaces/imports', { preHandler: admin, bodyLimit }, async (req, reply) => {
    const r = await applySpaceImport(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });

  // 导出空间清单（给设计方、店主核对）
  app.get('/api/admin/spaces/export', { preHandler: admin }, async (req, reply) => {
    const csv = await spacesCsv(sql);
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'spaces', ip: req.ip });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent('空间台账.csv')}`);
    return csv;
  });

  // 只读的楼层 → 区域 → 空间树：以后的房态图、对客导览用；后台与前台客房岗位都能看
  app.get('/api/spaces/tree', { preHandler: guardAny('settings.manage', 'catalog.manage', 'room.operate', 'room.housekeep', 'frontdesk.checkout') }, async () =>
    spaceTree(sql),
  );
}
