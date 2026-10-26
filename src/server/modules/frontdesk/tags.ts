// 手牌池：批量建牌、锁定 / 解锁、改分区、停用。在店手牌不能改分区、停用或锁定（先换牌）。

import { z } from 'zod';
import { TAG_CODE_PATTERN, ZONES, type HandTag } from '@shared/frontdesk';
import type { Db } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { OpContext } from '../../lib/context';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import type { Deps } from '../../lib/context';
import { setTxTimeouts } from './common';

export async function listTags(db: Db): Promise<(HandTag & { inUse: boolean; lockedByName: string | null; lockedAt: string | null })[]> {
  return db`
    SELECT t.id, t.code, t.zone, t.locked, t.lock_reason, t.active, t.is_synthetic, t.locked_at,
           s.display_name AS locked_by_name,
           EXISTS (SELECT 1 FROM visits v WHERE v.tag_id = t.id AND v.status = 'open') AS in_use
    FROM hand_tags t LEFT JOIN staff s ON s.id = t.locked_by
    ORDER BY CASE t.zone WHEN 'male' THEN 0 WHEN 'female' THEN 1 ELSE 2 END, length(t.code), t.code`;
}

export const BatchInput = z
  .object({
    prefix: z.string().trim().toUpperCase().regex(/^[A-Z]{0,2}$/, '前缀只能是 0–2 个英文字母'),
    from: z.number().int().min(0).max(99999),
    to: z.number().int().min(0).max(99999),
    /** 数字位数，不足补 0，例如 3 → 001 */
    width: z.number().int().min(1).max(5),
    zone: z.enum(ZONES, '请选择分区'),
  })
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
      INSERT INTO hand_tags (code, zone) SELECT unnest(${codes}::text[]), ${input.zone}
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

async function lockTag(tx: Db, id: number) {
  const [tag] = await tx<{ id: number; code: string; zone: string; locked: boolean; active: boolean; inUse: boolean }[]>`
    SELECT id, code, zone, locked, active,
           EXISTS (SELECT 1 FROM visits v WHERE v.tag_id = hand_tags.id AND v.status = 'open') AS in_use
    FROM hand_tags WHERE id = ${id} FOR UPDATE`;
  if (!tag) throw notFound('手牌不存在');
  return tag;
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

export const UpdateInput = z.object({ zone: z.enum(ZONES, '请选择分区'), active: z.boolean() });

export async function updateHandTag(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const input = parse(UpdateInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const tag = await lockTag(tx, id);
    if (tag.inUse && (tag.zone !== input.zone || !input.active)) {
      throw conflict('TAG_IN_USE', `手牌 ${tag.code} 上有在店客人，不能改分区或停用`);
    }
    await tx`UPDATE hand_tags SET zone = ${input.zone}, active = ${input.active}, updated_at = now() WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'hand_tag_updated',
      targetType: 'hand_tag',
      targetId: id,
      detail: { code: tag.code, before: { zone: tag.zone, active: tag.active }, after: input },
      ip: ctx.ip,
    });
  });
}
