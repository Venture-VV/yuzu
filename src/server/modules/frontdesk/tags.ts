// 手牌池：按清单导入、批量建牌、锁定 / 解锁、改分区与柜型、停用。在店手牌不能改分区、柜型、停用或锁定（先换牌）。

import { z } from 'zod';
import { MAX_VIP_LEVEL, normalizeTagCode, tagArea, TAG_CODE_PATTERN, TAG_KINDS, ZONES, type HandTag } from '@shared/frontdesk';
import { HAND_TAG_IMPORT_MAX_ROWS, type HandTagImportReport } from '@shared/hand-tag-import';
import type { Db, Sql } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { OpContext } from '../../lib/context';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import type { Deps } from '../../lib/context';
import { setTxTimeouts } from './common';

export async function listTags(db: Db): Promise<(HandTag & { inUse: boolean; lockedByName: string | null; lockedAt: string | null })[]> {
  return db`
    SELECT t.id, t.code, t.zone, t.kind, t.vip_level, t.locked, t.lock_reason, t.active, t.is_synthetic, t.locked_at,
           s.display_name AS locked_by_name,
           EXISTS (SELECT 1 FROM visits v WHERE v.tag_id = t.id AND v.status = 'open') AS in_use
    FROM hand_tags t LEFT JOIN staff s ON s.id = t.locked_by
    ORDER BY CASE t.zone WHEN 'male' THEN 0 WHEN 'female' THEN 1 ELSE 2 END, t.kind = 'vip', t.vip_level,
             regexp_replace(t.code, '[0-9]', '', 'g'), length(t.code), t.code`;
}

const vipLevel = z.number().int().min(1, 'VIP 等级从 1 开始').max(MAX_VIP_LEVEL, `VIP 等级最多 ${MAX_VIP_LEVEL} 级`).nullable().default(null);
const kindLevelOk = (v: { kind: string; vipLevel: number | null }) => (v.kind === 'vip') === (v.vipLevel !== null);
const KIND_LEVEL_MESSAGE = 'VIP 柜需要选择等级，普通柜不设等级';

export const BatchInput = z
  .object({
    prefix: z.string().trim().toUpperCase().regex(/^[A-Z]{0,2}$/, '前缀只能是 0–2 个英文字母'),
    from: z.number().int().min(0).max(99999),
    to: z.number().int().min(0).max(99999),
    /** 数字位数，不足补 0，例如 3 → 001 */
    width: z.number().int().min(1).max(5),
    zone: z.enum(ZONES, '请选择男宾或女宾'),
    kind: z.enum(TAG_KINDS, '请选择柜型').default('normal'),
    vipLevel,
  })
  .refine(kindLevelOk, KIND_LEVEL_MESSAGE)
  .refine((v) => v.to >= v.from, '结束号不能小于起始号')
  .refine((v) => v.to - v.from < 500, '一次最多建 500 张手牌')
  .refine((v) => String(v.to).length <= v.width, '结束号的位数超过了设定位数');

export async function batchCreate(deps: Deps, raw: unknown, ctx: OpContext) {
  const input = parse(BatchInput, raw);
  const codes: string[] = [];
  for (let n = input.from; n <= input.to; n++) codes.push(`${input.prefix}${String(n).padStart(input.width, '0')}`);
  if (!codes.every((c) => TAG_CODE_PATTERN.test(c))) throw badRequest('生成的牌号格式不正确');
  return deps.sql.begin(async (tx) => {
    const rows = await tx<{ code: string }[]>`
      INSERT INTO hand_tags (code, zone, kind, vip_level) SELECT unnest(${codes}::text[]), ${input.zone}, ${input.kind}, ${input.vipLevel}
      ON CONFLICT (code) DO NOTHING RETURNING code`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'hand_tags_created',
      targetType: 'hand_tag',
      detail: { ...input, created: rows.length, skipped: codes.length - rows.length },
      ip: ctx.ip,
    });
    return { created: rows.length, skipped: codes.filter((c) => !rows.some((r) => r.code === c)) };
  });
}

/**
 * 先锁定手牌行，再用单独的查询判断是否在店。
 * 不能把占用判断写进同一条 FOR UPDATE 语句：等锁期间发牌事务提交的来访，对那条语句的快照不可见，
 * 会把刚发出的手牌误判为空闲，于是锁定 / 停用 / 改分区与发牌同时成功。
 */
async function lockTag(tx: Db, id: number) {
  const [tag] = await tx<{ id: number; code: string; zone: string; kind: string; vipLevel: number | null; locked: boolean; active: boolean }[]>`
    SELECT id, code, zone, kind, vip_level, locked, active FROM hand_tags WHERE id = ${id} FOR UPDATE`;
  if (!tag) throw notFound('手牌不存在');
  const [use] = await tx<{ inUse: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM visits WHERE tag_id = ${id} AND status = 'open') AS in_use`;
  return { ...tag, inUse: use!.inUse };
}

export const LockInput = z.object({ reason: z.string().trim().min(2, '请填写锁定原因（至少 2 个字）').max(100, '原因最多 100 字') });

export async function lockHandTag(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const input = parse(LockInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const tag = await lockTag(tx, id);
    if (tag.inUse) throw conflict('TAG_IN_USE', `手牌 ${tag.code} 上有在店客人，请先给客人换牌并勾选「锁定原手牌」`);
    if (tag.locked) throw conflict('TAG_ALREADY_LOCKED', `手牌 ${tag.code} 已经是锁定状态`);
    await tx`
      UPDATE hand_tags SET locked = true, lock_reason = ${input.reason}, locked_by = ${ctx.actor.id}, locked_at = now(), updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'hand_tag_locked', targetType: 'hand_tag', targetId: id, detail: { code: tag.code, reason: input.reason }, ip: ctx.ip });
  });
}

export async function unlockHandTag(deps: Deps, id: number, ctx: OpContext) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const tag = await lockTag(tx, id);
    if (!tag.locked) return;
    await tx`UPDATE hand_tags SET locked = false, lock_reason = NULL, locked_by = NULL, locked_at = NULL, updated_at = now() WHERE id = ${id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'hand_tag_unlocked', targetType: 'hand_tag', targetId: id, detail: { code: tag.code }, ip: ctx.ip });
  });
}

export const UpdateInput = z
  .object({
    zone: z.enum(ZONES, '请选择男宾或女宾'),
    active: z.boolean(),
    // 旧版本页面不带柜型时保持原样
    kind: z.enum(TAG_KINDS, '请选择柜型').optional(),
    vipLevel: vipLevel.optional(),
  })
  .refine((v) => v.kind === undefined || kindLevelOk({ kind: v.kind, vipLevel: v.vipLevel ?? null }), KIND_LEVEL_MESSAGE);

export async function updateHandTag(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const input = parse(UpdateInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const tag = await lockTag(tx, id);
    const kind = input.kind ?? tag.kind;
    const level = input.kind === undefined ? tag.vipLevel : (input.vipLevel ?? null);
    if (tag.inUse && (tag.zone !== input.zone || !input.active || tag.kind !== kind || tag.vipLevel !== level)) {
      throw conflict('TAG_IN_USE', `手牌 ${tag.code} 上有在店客人，不能改分区、柜型或停用`);
    }
    await tx`
      UPDATE hand_tags SET zone = ${input.zone}, active = ${input.active}, kind = ${kind}, vip_level = ${level}, updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'hand_tag_updated',
      targetType: 'hand_tag',
      targetId: id,
      detail: {
        code: tag.code,
        before: { zone: tag.zone, active: tag.active, kind: tag.kind, vipLevel: tag.vipLevel },
        after: { zone: input.zone, active: input.active, kind, vipLevel: level },
      },
      ip: ctx.ip,
    });
  });
}

// ───────────────────────── 按清单导入 ─────────────────────────

export const ImportInput = z.object({
  rows: z
    .array(
      z
        .object({
          code: z.string().transform(normalizeTagCode).pipe(z.string().regex(TAG_CODE_PATTERN, '牌号格式不正确')),
          zone: z.enum(ZONES, '性别应为 male / female'),
          kind: z.enum(TAG_KINDS, '柜型应为 normal / vip'),
          vipLevel,
        })
        .refine(kindLevelOk, KIND_LEVEL_MESSAGE),
    )
    .min(1, '清单里没有柜号')
    .max(HAND_TAG_IMPORT_MAX_ROWS, `一次最多导入 ${HAND_TAG_IMPORT_MAX_ROWS} 个柜号`),
  /** 同时停用不在清单里的手牌（在店的不动） */
  deactivateMissing: z.boolean().default(false),
  /** 只预览，不写入 */
  dryRun: z.boolean().default(true),
});
export type ImportInputData = z.input<typeof ImportInput>;

/**
 * 按清单导入：清单是柜池的准确描述。
 *   · 新牌号 → 建立；已有牌号 → 分区、柜型、等级以清单为准，停用的恢复启用；锁定状态不变；
 *   · 在店的手牌不改动（先换牌），列入 blocked；
 *   · 勾选 deactivateMissing 时，停用清单外的空闲手牌；
 *   · 先锁定全部手牌（id 升序）再判断在店，与发牌、换牌串行。
 */
export async function importHandTags(
  sql: Sql,
  raw: ImportInputData,
  audit: { staffId: number | null; ip?: string; via: 'web' | 'cli' | 'demo' },
  options: { synthetic?: boolean } = {},
): Promise<HandTagImportReport> {
  const input = parse(ImportInput, raw);
  const dupes = input.rows.map((r) => r.code).filter((c, i, all) => all.indexOf(c) !== i);
  if (dupes.length) throw badRequest(`清单里牌号重复：${[...new Set(dupes)].slice(0, 5).join('、')}`);
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const existing = await tx<{ id: number; code: string; zone: string; kind: string; vipLevel: number | null; active: boolean }[]>`
      SELECT id, code, zone, kind, vip_level, active FROM hand_tags ORDER BY id ${input.dryRun ? tx`` : tx`FOR UPDATE`}`;
    const inUse = new Set(
      (await tx<{ tagId: number }[]>`SELECT tag_id FROM visits WHERE status = 'open'`).map((r) => r.tagId),
    );
    const byCode = new Map(existing.map((t) => [t.code, t]));
    const listed = new Set(input.rows.map((r) => r.code));

    const create: typeof input.rows = [];
    const update: { id: number; code: string; zone: string; kind: string; vipLevel: number | null }[] = [];
    const blocked: HandTagImportReport['blocked'] = [];
    let unchanged = 0;
    for (const r of input.rows) {
      const t = byCode.get(r.code);
      if (!t) {
        create.push(r);
        continue;
      }
      const same = t.zone === r.zone && t.kind === r.kind && t.vipLevel === r.vipLevel;
      if (same && t.active) {
        unchanged += 1;
      } else if (!same && inUse.has(t.id)) {
        blocked.push({ code: r.code, reason: '在店，分区或柜型未修改（客人换牌后再导入）' });
      } else {
        update.push({ id: t.id, code: r.code, zone: r.zone, kind: r.kind, vipLevel: r.vipLevel });
      }
    }
    const deactivate: { id: number; code: string }[] = [];
    if (input.deactivateMissing) {
      for (const t of existing) {
        if (listed.has(t.code) || !t.active) continue;
        if (inUse.has(t.id)) blocked.push({ code: t.code, reason: '不在清单里，但有在店客人，未停用' });
        else deactivate.push({ id: t.id, code: t.code });
      }
    }

    const groupKey = (r: (typeof input.rows)[number]) => `${r.zone}|${r.kind}|${r.vipLevel ?? ''}|${r.kind === 'vip' ? '' : tagArea(r.code)}`;
    const groups = new Map<string, HandTagImportReport['groups'][number]>();
    for (const r of input.rows) {
      const k = groupKey(r);
      const g = groups.get(k) ?? { zone: r.zone, kind: r.kind, vipLevel: r.vipLevel, area: r.kind === 'vip' ? '' : tagArea(r.code), count: 0 };
      g.count += 1;
      groups.set(k, g);
    }

    if (!input.dryRun) {
      if (create.length) {
        const rows = await tx<{ code: string }[]>`
          INSERT INTO hand_tags (code, zone, kind, vip_level, is_synthetic)
          SELECT u.code, u.zone, u.kind, u.vip_level, ${options.synthetic ?? false}
          FROM unnest(${create.map((r) => r.code)}::text[], ${create.map((r) => r.zone)}::text[], ${create.map((r) => r.kind)}::text[],
                      ${create.map((r) => r.vipLevel) as never}::smallint[]) AS u(code, zone, kind, vip_level)
          ON CONFLICT (code) DO NOTHING RETURNING code`;
        if (rows.length !== create.length) throw conflict('TAGS_CHANGED', '手牌池刚刚有其他人新建了手牌，请重新预览后再导入');
      }
      if (update.length) {
        await tx`
          UPDATE hand_tags t SET zone = u.zone, kind = u.kind, vip_level = u.vip_level, active = true, updated_at = now()
          FROM unnest(${update.map((u) => u.id)}::bigint[], ${update.map((u) => u.zone)}::text[], ${update.map((u) => u.kind)}::text[],
                      ${update.map((u) => u.vipLevel) as never}::smallint[]) AS u(id, zone, kind, vip_level)
          WHERE t.id = u.id`;
      }
      if (deactivate.length) {
        await tx`UPDATE hand_tags SET active = false, updated_at = now() WHERE id IN ${tx(deactivate.map((d) => d.id))}`;
      }
    }

    const report: HandTagImportReport = {
      dryRun: input.dryRun,
      total: input.rows.length,
      created: create.length,
      updated: update.length,
      unchanged,
      deactivated: deactivate.length,
      blocked,
      samples: {
        created: create.slice(0, 20).map((r) => r.code),
        updated: update.slice(0, 20).map((r) => r.code),
        deactivated: deactivate.slice(0, 20).map((r) => r.code),
      },
      groups: [...groups.values()],
    };
    if (!input.dryRun) {
      await writeAudit(tx, {
        staffId: audit.staffId,
        action: 'hand_tags_imported',
        targetType: 'hand_tag',
        detail: {
          via: audit.via,
          total: report.total,
          created: report.created,
          updated: report.updated,
          unchanged: report.unchanged,
          deactivated: report.deactivated,
          blocked: report.blocked.length,
          deactivateMissing: input.deactivateMissing,
        },
        ip: audit.ip,
      });
    }
    return report;
  });
}
