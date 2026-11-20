// 8.0.21 自定义字段（docs/FINANCE_V8021.md 第 1 节，CW-J / CW10）：会员、供应商、物料、合同四类，每类启用的最多 10 个。
//   · 定义：后台「数据字典与字段」维护（修改经营规则）；读定义照那一类的查看权限。
//   · 值：详情页「其他信息」一块单独保存，带看到的值的摘要（对不上拒绝），权限照那一类的维护权限；不动业务表、不改业务行的版本号。
//   · 按字段查：后台「数据字典与字段」按某个字段查对象、导出。
// 不进账务口径、不参与结账与任何计算。
// 锁：定义的写入先取「自定义字段 + 类别」的咨询锁（同一类串行，数启用的个数、取编号），修改再锁定义一行（带版本号）；
//     值的保存先取「自定义字段值 + 类别 + 对象」的咨询锁（同一个对象的保存串行，核对摘要），不锁业务行（只读地核对对象存在）。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_ENTITY_LABELS,
  CUSTOM_FIELD_TYPE_LABELS,
  CUSTOM_FIELD_TYPES,
  MAX_CUSTOM_FIELD_DEFS,
  MAX_CUSTOM_FIELD_LABEL,
  MAX_CUSTOM_FIELD_OPTION_LENGTH,
  MAX_CUSTOM_FIELD_OPTIONS,
  MAX_CUSTOM_FIELDS,
  normalizeCustomValue,
  type CustomFieldDef,
  type CustomFieldEntity,
  type CustomFieldSearchResult,
  type CustomFieldSearchRow,
  type CustomFieldSheet,
} from '@shared/custom-fields';
import { can, type Permission } from '@shared/permissions';
import { guard, sessionReady } from '../auth/guard';
import { isUniqueViolation, readSnapshot, type Db } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { csvReply, toCsv } from '../lib/csv';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { hashRequest } from '../lib/idempotency';
import { idParam, parse } from '../lib/validate';

/** 各类的查看、维护权限（与那一类原来的页面一致） */
const READ_PERMS: Record<CustomFieldEntity, Permission[]> = {
  member: ['member.read'],
  supplier: ['inventory.read', 'contract.read'],
  material: ['inventory.read'],
  contract: ['contract.read'],
};
const WRITE_PERMS: Record<CustomFieldEntity, Permission> = {
  member: 'member.write',
  supplier: 'inventory.master',
  material: 'inventory.master',
  contract: 'contract.manage',
};

const canRead = (req: FastifyRequest, entity: CustomFieldEntity) => can(req.actor, 'settings.manage') || READ_PERMS[entity].some((p) => can(req.actor, p));

function assertRead(req: FastifyRequest, entity: CustomFieldEntity) {
  if (req.actor.mustChangePassword) throw forbidden('首次登录请先修改密码');
  if (!canRead(req, entity)) throw forbidden();
}

/** 按字段查会列出名单：除了维护字段的权限，还要能看那一类 */
function assertSearch(req: FastifyRequest, entity: CustomFieldEntity) {
  if (!READ_PERMS[entity].some((p) => can(req.actor, p))) throw forbidden(`当前岗位看不了${CUSTOM_FIELD_ENTITY_LABELS[entity]}`);
}

const EntityField = z.enum(CUSTOM_FIELD_ENTITIES, '没有这一类');
const EntityParam = z.object({ entity: EntityField });
const EntityIdParam = z.object({ entity: EntityField, id: z.coerce.number().int().positive('编号不正确') });

interface DefRow {
  id: number;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldDef['type'];
  options: string[];
  inList: boolean;
  active: boolean;
  sort: number;
  version: number;
}
const toDef = (r: DefRow): CustomFieldDef => ({ ...r, id: Number(r.id), options: r.options ?? [] });

export async function listDefs(db: Db, entity?: CustomFieldEntity, activeOnly = false): Promise<CustomFieldDef[]> {
  const rows = await db<DefRow[]>`
    SELECT id, entity, key, label, type, options, in_list, active, sort, version
    FROM custom_field_defs
    WHERE (${entity ?? null}::text IS NULL OR entity = ${entity ?? null}) AND (NOT ${activeOnly} OR active)
    ORDER BY entity, NOT active, sort, id`;
  return rows.map(toDef);
}

async function getDef(db: Db, id: number): Promise<CustomFieldDef> {
  const [r] = await db<DefRow[]>`SELECT id, entity, key, label, type, options, in_list, active, sort, version FROM custom_field_defs WHERE id = ${id}`;
  if (!r) throw notFound('这个字段不存在');
  return toDef(r);
}

const LabelField = z.string('请填写字段名称').trim().min(1, '请填写字段名称').max(MAX_CUSTOM_FIELD_LABEL, `字段名称最多 ${MAX_CUSTOM_FIELD_LABEL} 个字`);
const OptionsField = z
  .array(z.string().trim().min(1, '选项不能为空').max(MAX_CUSTOM_FIELD_OPTION_LENGTH, `每个选项最多 ${MAX_CUSTOM_FIELD_OPTION_LENGTH} 个字`))
  .max(MAX_CUSTOM_FIELD_OPTIONS, `选项最多 ${MAX_CUSTOM_FIELD_OPTIONS} 个`)
  .refine((l) => new Set(l).size === l.length, '选项重复了');
const CreateDefInput = z.object({
  entity: EntityField,
  label: LabelField,
  type: z.enum(CUSTOM_FIELD_TYPES, '字段类型不对'),
  options: OptionsField.default([]),
  inList: z.boolean().default(false),
});
const UpdateDefInput = z.object({
  expectedVersion: z.number('缺少版本号，请刷新后重试').int().min(1),
  label: LabelField.optional(),
  options: OptionsField.optional(),
  inList: z.boolean().optional(),
  active: z.boolean().optional(),
  sort: z.number().int().min(0).max(1000).optional(),
});

const lockEntityDefs = (db: Db, entity: CustomFieldEntity) => db`SELECT pg_advisory_xact_lock(hashtext(${'custom_field_defs:' + entity}))`;

async function assertActiveRoom(db: Db, entity: CustomFieldEntity) {
  const [c] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM custom_field_defs WHERE entity = ${entity} AND active`;
  if (c!.n >= MAX_CUSTOM_FIELDS) {
    throw unprocessable('TOO_MANY_FIELDS', `${CUSTOM_FIELD_ENTITY_LABELS[entity]}启用的字段最多 ${MAX_CUSTOM_FIELDS} 个；不用的请先停用`);
  }
}

function labelTaken(error: unknown) {
  return isUniqueViolation(error, 'custom_field_defs_label_uq');
}

export async function createDef(deps: Deps, raw: unknown, ctx: OpContext): Promise<CustomFieldDef> {
  const input = parse(CreateDefInput, raw);
  if (input.type === 'select' && input.options.length === 0) throw badRequest('选项类的字段至少要有一个选项');
  const options = input.type === 'select' ? input.options : [];
  try {
    const id = await deps.sql.begin(async (tx) => {
      await lockEntityDefs(tx, input.entity);
      await assertActiveRoom(tx, input.entity);
      const used = await tx<{ key: string }[]>`SELECT key FROM custom_field_defs WHERE entity = ${input.entity}`;
      if (used.length >= MAX_CUSTOM_FIELD_DEFS) {
        throw unprocessable('TOO_MANY_FIELDS', `${CUSTOM_FIELD_ENTITY_LABELS[input.entity]}的字段（连停用的）最多 ${MAX_CUSTOM_FIELD_DEFS} 个；停用的可以改名再启用`);
      }
      const taken = new Set(used.map((u) => u.key));
      let n = 1;
      while (taken.has(`f${n}`)) n += 1;
      const [order] = await tx<{ next: number }[]>`SELECT coalesce(max(sort), 0) + 1 AS next FROM custom_field_defs WHERE entity = ${input.entity}`;
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO custom_field_defs (entity, key, label, type, options, in_list, sort, created_by)
        VALUES (${input.entity}, ${'f' + n}, ${input.label}, ${input.type}, ${tx.json(options)}, ${input.inList}, ${order!.next}, ${ctx.actor.id})
        RETURNING id`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'custom_field_def',
        targetType: 'custom_field_def',
        targetId: row!.id,
        detail: { created: { entity: CUSTOM_FIELD_ENTITY_LABELS[input.entity], label: input.label, type: CUSTOM_FIELD_TYPE_LABELS[input.type], options } },
        ip: ctx.ip,
      });
      return Number(row!.id);
    });
    return getDef(deps.sql, id);
  } catch (error) {
    if (labelTaken(error)) throw conflict('FIELD_EXISTS', `「${input.label}」已经有了`);
    throw error;
  }
}

export async function updateDef(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<CustomFieldDef> {
  const input = parse(UpdateDefInput, raw);
  const current = await getDef(deps.sql, id);
  try {
    await deps.sql.begin(async (tx) => {
      await lockEntityDefs(tx, current.entity);
      const [d] = await tx<DefRow[]>`
        SELECT id, entity, key, label, type, options, in_list, active, sort, version FROM custom_field_defs WHERE id = ${id} FOR UPDATE`;
      if (!d) throw notFound('这个字段不存在');
      if (d.version !== input.expectedVersion) throw conflict('FIELD_CHANGED', '这个字段刚被别人改过，请刷新后再改');
      const next = {
        label: input.label ?? d.label,
        options: d.type === 'select' ? (input.options ?? d.options) : [],
        inList: input.inList ?? d.inList,
        active: input.active ?? d.active,
        sort: input.sort ?? d.sort,
      };
      if (d.type === 'select' && next.options.length === 0) throw badRequest('选项类的字段至少要有一个选项');
      if (input.options && d.type !== 'select') throw badRequest('只有选项类的字段有选项');
      const same = next.label === d.label && JSON.stringify(next.options) === JSON.stringify(d.options) && next.inList === d.inList && next.active === d.active && next.sort === d.sort;
      if (same) return;
      if (next.active && !d.active) await assertActiveRoom(tx, d.entity);
      await tx`
        UPDATE custom_field_defs
        SET label = ${next.label}, options = ${tx.json(next.options)}, in_list = ${next.inList}, active = ${next.active}, sort = ${next.sort},
            version = version + 1, updated_at = now()
        WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'custom_field_def',
        targetType: 'custom_field_def',
        targetId: id,
        detail: {
          entity: CUSTOM_FIELD_ENTITY_LABELS[d.entity],
          before: { label: d.label, options: d.options, inList: d.inList, active: d.active },
          after: { label: next.label, options: next.options, inList: next.inList, active: next.active },
        },
        ip: ctx.ip,
      });
    });
  } catch (error) {
    if (labelTaken(error)) throw conflict('FIELD_EXISTS', '启用的字段里已经有这个名称');
    throw error;
  }
  return getDef(deps.sql, id);
}

// ───────────────────────── 值 ─────────────────────────

/** 对象在不在（停用、作废的也算在，值照样能看能改） */
async function assertEntityExists(db: Db, entity: CustomFieldEntity, id: number) {
  const rows =
    entity === 'member'
      ? await db`SELECT 1 FROM members WHERE id = ${id}`
      : entity === 'supplier'
        ? await db`SELECT 1 FROM suppliers WHERE id = ${id}`
        : entity === 'material'
          ? await db`SELECT 1 FROM materials WHERE id = ${id}`
          : await db`SELECT 1 FROM contracts WHERE id = ${id}`;
  if (!rows.length) throw notFound(`${CUSTOM_FIELD_ENTITY_LABELS[entity]}不存在`);
}

/** 这个对象所有字段（连停用的）的值，按字段编号 */
async function valuesOf(db: Db, entity: CustomFieldEntity, id: number): Promise<Map<number, string>> {
  const rows = await db<{ fieldId: number; value: string }[]>`
    SELECT v.field_id, v.value FROM custom_field_values v JOIN custom_field_defs d ON d.id = v.field_id
    WHERE d.entity = ${entity} AND v.entity_id = ${id}`;
  return new Map(rows.map((r) => [Number(r.fieldId), r.value]));
}

const sheetHash = (values: Map<number, string>) => hashRequest([...values.entries()].sort((a, b) => a[0] - b[0]));

export async function getSheet(db: Db, entity: CustomFieldEntity, id: number): Promise<CustomFieldSheet> {
  await assertEntityExists(db, entity, id);
  const defs = await listDefs(db, entity, true);
  const values = await valuesOf(db, entity, id);
  const byKey: Record<string, string> = {};
  for (const d of defs) {
    const v = values.get(d.id);
    if (v !== undefined) byKey[d.key] = v;
  }
  return { defs, values: byKey, hash: sheetHash(values) };
}

const SaveInput = z.object({
  expectedHash: z.string('缺少摘要，请刷新后重试').min(1),
  values: z.record(z.string(), z.string().max(400, '内容太长了').nullable()),
});

export async function saveSheet(deps: Deps, entity: CustomFieldEntity, id: number, raw: unknown, ctx: OpContext): Promise<CustomFieldSheet> {
  const input = parse(SaveInput, raw);
  await deps.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`custom_field_values:${entity}:${id}`}))`;
    await assertEntityExists(tx, entity, id);
    const current = await valuesOf(tx, entity, id);
    if (sheetHash(current) !== input.expectedHash) throw conflict('FIELDS_CHANGED', '这几项刚被别人改过，请刷新后再改');
    const defs = await listDefs(tx, entity, true);
    const byKey = new Map(defs.map((d) => [d.key, d]));
    const changes: { def: CustomFieldDef; before: string | null; after: string | null }[] = [];
    for (const [key, rawValue] of Object.entries(input.values)) {
      const def = byKey.get(key);
      if (!def) throw badRequest('有一项字段已经停用或不存在，请刷新后重试');
      const before = current.get(def.id) ?? null;
      // 没改的原样留着（选项删了以后，老值照样留着，不因为别的格保存而报错）
      if ((rawValue ?? '').trim() === (before ?? '')) continue;
      const after = normalizeCustomValue(def, rawValue);
      if (after !== null && typeof after === 'object') throw badRequest(after.error);
      if (after === before) continue;
      changes.push({ def, before, after });
    }
    for (const c of changes) {
      if (c.after === null) {
        await tx`DELETE FROM custom_field_values WHERE field_id = ${c.def.id} AND entity_id = ${id}`;
      } else {
        await tx`
          INSERT INTO custom_field_values (field_id, entity_id, value, updated_by)
          VALUES (${c.def.id}, ${id}, ${c.after}, ${ctx.actor.id})
          ON CONFLICT (field_id, entity_id) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      }
    }
    if (changes.length) {
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'custom_field_value',
        targetType: entity,
        targetId: id,
        detail: { entity: CUSTOM_FIELD_ENTITY_LABELS[entity], changes: changes.map((c) => ({ field: c.def.label, before: c.before, after: c.after })) },
        ip: ctx.ip,
      });
    }
  });
  return getSheet(deps.sql, entity, id);
}

/** 列表上显示的几列：这些对象在「列表里显示」的字段上的值 */
export async function listValues(db: Db, entity: CustomFieldEntity, ids: number[]): Promise<{ defs: CustomFieldDef[]; values: Record<string, Record<string, string>> }> {
  const defs = (await listDefs(db, entity, true)).filter((d) => d.inList);
  const values: Record<string, Record<string, string>> = {};
  if (!defs.length || !ids.length) return { defs, values };
  const rows = await db<{ fieldId: number; entityId: number; value: string }[]>`
    SELECT field_id, entity_id, value FROM custom_field_values
    WHERE field_id IN ${db(defs.map((d) => d.id))} AND entity_id IN ${db(ids)}`;
  const keyOf = new Map(defs.map((d) => [d.id, d.key]));
  for (const r of rows) {
    const k = String(r.entityId);
    (values[k] ??= {})[keyOf.get(Number(r.fieldId))!] = r.value;
  }
  return { defs, values };
}

// ───────────────────────── 按字段查 ─────────────────────────

const SEARCH_LIMIT = 500;
const SearchQuery = z.object({
  fieldId: z.coerce.number('请选字段').int().positive('请选字段'),
  // 空 = 填了的都列出来；文字类按包含查，其余按等于
  q: z.string().trim().max(200).default(''),
});

export async function searchByField(db: Db, entity: CustomFieldEntity, raw: unknown, limit = SEARCH_LIMIT): Promise<CustomFieldSearchResult> {
  const q = parse(SearchQuery, raw);
  const def = await getDef(db, q.fieldId);
  if (def.entity !== entity) throw badRequest('这个字段不是这一类的');
  const pattern = def.type === 'text' ? `%${q.q.replace(/[\\%_]/g, (c) => '\\' + c)}%` : q.q;
  const match = q.q === '' ? db`TRUE` : def.type === 'text' ? db`v.value ILIKE ${pattern}` : db`v.value = ${pattern}`;
  const source =
    entity === 'member'
      ? db`SELECT id, member_no AS code, name, status <> 'active' AS inactive FROM members`
      : entity === 'supplier'
        ? db`SELECT id, code, name, NOT active AS inactive FROM suppliers`
        : entity === 'material'
          ? db`SELECT id, code, name, NOT active AS inactive FROM materials`
          : db`SELECT id, contract_no AS code, title AS name, status IN ('voided', 'terminated') AS inactive FROM contracts`;
  const rows = await db<(CustomFieldSearchRow & { entityId: number })[]>`
    SELECT o.id AS entity_id, o.code, o.name, o.inactive, v.value
    FROM custom_field_values v JOIN (${source}) o ON o.id = v.entity_id
    WHERE v.field_id = ${def.id} AND ${match}
    ORDER BY o.inactive, o.code
    LIMIT ${limit + 1}`;
  return {
    def,
    rows: rows.slice(0, limit).map((r) => ({ ...r, entityId: Number(r.entityId) })),
    truncated: rows.length > limit,
  };
}

export function registerCustomFieldRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 定义：后台维护（修改经营规则）看全部；各页只取自己那一类启用的
  app.get('/api/custom-fields/defs', { preHandler: sessionReady }, async (req) => {
    const { entity } = parse(z.object({ entity: EntityField.optional() }), req.query ?? {});
    if (!entity) {
      if (!can(req.actor, 'settings.manage')) throw forbidden();
      return listDefs(sql);
    }
    assertRead(req, entity);
    return listDefs(sql, entity, !can(req.actor, 'settings.manage'));
  });
  app.post('/api/custom-fields/defs', { preHandler: guard('settings.manage') }, async (req, reply) => {
    const def = await createDef(deps, req.body, ctxOf(req));
    reply.code(201);
    return def;
  });
  app.put('/api/custom-fields/defs/:id', { preHandler: guard('settings.manage') }, async (req) => updateDef(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));

  // 按字段查、导出（后台「数据字典与字段」）
  app.get('/api/custom-fields/:entity/search', { preHandler: guard('settings.manage') }, async (req) => {
    const { entity } = parse(EntityParam, req.params);
    assertSearch(req, entity);
    return readSnapshot(sql, (tx) => searchByField(tx, entity, req.query ?? {}));
  });
  app.get('/api/custom-fields/:entity/search.csv', { preHandler: guard('settings.manage') }, async (req, reply) => {
    const { entity } = parse(EntityParam, req.params);
    assertSearch(req, entity);
    const result = await readSnapshot(sql, (tx) => searchByField(tx, entity, req.query ?? {}, 5000));
    await writeAudit(sql, {
      staffId: req.actor.id,
      action: 'custom_field_value',
      targetType: 'custom_field_def',
      targetId: result.def.id,
      detail: { exported: { entity: CUSTOM_FIELD_ENTITY_LABELS[entity], field: result.def.label, count: result.rows.length } },
      ip: req.ip,
    });
    const codeTitle = { member: '会员号', supplier: '供应商编码', material: '物料编码', contract: '合同号' }[entity];
    const nameTitle = { member: '姓名', supplier: '供应商', material: '物料', contract: '合同标题' }[entity];
    const csv = toCsv([[codeTitle, nameTitle, result.def.label, '状态'], ...result.rows.map((r) => [r.code, r.name, r.value, r.inactive ? '已停用' : '在用'])]);
    return csvReply(reply, `${CUSTOM_FIELD_ENTITY_LABELS[entity]}-${result.def.label}.csv`, csv);
  });

  // 列表上显示的几列
  app.get('/api/custom-fields/:entity/values', { preHandler: sessionReady }, async (req) => {
    const { entity } = parse(EntityParam, req.params);
    assertRead(req, entity);
    const { ids } = parse(
      z.object({
        ids: z
          .string()
          .default('')
          .transform((s) => [...new Set(s.split(',').filter(Boolean).map(Number))])
          .refine((l) => l.length <= 500 && l.every((n) => Number.isInteger(n) && n > 0), '编号不正确'),
      }),
      req.query ?? {},
    );
    return readSnapshot(sql, (tx) => listValues(tx, entity, ids));
  });

  // 一个对象的「其他信息」
  app.get('/api/custom-fields/:entity/:id', { preHandler: sessionReady }, async (req) => {
    const { entity, id } = parse(EntityIdParam, req.params);
    assertRead(req, entity);
    return readSnapshot(sql, (tx) => getSheet(tx, entity, id));
  });
  app.put('/api/custom-fields/:entity/:id', { preHandler: sessionReady }, async (req) => {
    const { entity, id } = parse(EntityIdParam, req.params);
    if (req.actor.mustChangePassword) throw forbidden('首次登录请先修改密码');
    if (!can(req.actor, WRITE_PERMS[entity])) throw forbidden();
    return saveSheet(deps, entity, id, req.body, ctxOf(req));
  });
}
