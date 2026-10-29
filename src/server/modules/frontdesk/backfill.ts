// 按实际时间补录纸质单（R1.9，店主 2026-10-29 决定要做；细则待确认，见 docs/PENDING_DECISIONS.md）。
//
// 系统停用期间前台用预编号的纸质应急单记录接待、挂账与结账；恢复后由值班经理及以上按纸质单上的实际时间补录：
//   · 接待、挂账、结账的请求多带一项 backfill（纸质单号 + 实际时间），服务端按实际时间办理（门票按实际在店时长计价，
//     营业日按实际时间归属），其余校验与平时相同（先开班、授权、团购券查重、幂等）；
//   · 实际时间在 BACKFILL_WINDOW_HOURS 小时以内、不晚于此刻；实际时间那一刻手牌或会员已被别的来访占用的，拒绝；
//     挂账、结账不能早于接待，结账不能早于已挂的明细；补录接待的客人结账时，在店时段里手牌、会员不能已有别的来访；
//   · 补录的结账不能用会员储值（储值流水按发生顺序连续记账，不能插到过去）；
//   · 每一步在 backfill_entries 留一条记录（与单据同一事务），日结与每日对账包的异常清单列出「补录」。

import { z } from 'zod';
import { BACKFILL_WINDOW_HOURS, SLIP_NO_PATTERN, type BackfillKind, type BackfillMark } from '@shared/backfill';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../../db';
import type { Actor } from '../../lib/context';
import { conflict, forbidden, unprocessable } from '../../lib/errors';

/** 请求里的补录信息；平时不带（不带时不进入请求摘要，升级前留下的待确认请求重提时仍能对上） */
export const BackfillInput = z
  .object({
    slipNo: z.string('请填写纸质单号').trim().regex(SLIP_NO_PATTERN, '纸质单号只能是字母、数字或短横线（最多 32 位）'),
    at: z.iso.datetime({ offset: true, message: '实际时间格式不正确' }),
  })
  .nullish()
  .transform((v) => v ?? undefined);
export type BackfillData = z.output<typeof BackfillInput>;

export interface Backfill {
  slipNo: string;
  at: Date;
}

/** 提示里的时间（门店时区，月-日 时:分） */
const fmt = (d: Date | string, timeZone: string) =>
  new Date(d).toLocaleString('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

/** 核对补录的权限与实际时间的范围（结账前核对按实际时间计价时也用它） */
export function checkBackfillAt(at: Date, actor: Actor, now = new Date()) {
  if (!can(actor, 'frontdesk.backfill')) throw forbidden('补录纸质单需要值班经理、店总或店主');
  if (at.getTime() > now.getTime() + 60_000) throw unprocessable('BACKFILL_FUTURE', '补录的实际时间不能晚于现在，请核对纸质单上的时间');
  if (now.getTime() - at.getTime() > BACKFILL_WINDOW_HOURS * 3_600_000) {
    throw unprocessable('BACKFILL_WINDOW', `只能补录 ${BACKFILL_WINDOW_HOURS} 小时以内的纸质单；更早的请联系店主处理`);
  }
  return at;
}

/** 核对权限与时间范围，返回这次补录的纸质单号与实际时间；平时（不带补录信息）返回 null */
export function resolveBackfill(data: BackfillData, actor: Actor, now = new Date()): Backfill | null {
  if (!data) return null;
  return { slipNo: data.slipNo, at: checkBackfillAt(new Date(data.at), actor, now) };
}

/**
 * 手牌的占用时段：每位客人从接待（或换到这张牌）起，到换走、结账或撤销为止；在店的客人没有终点（until 为 null）。
 * 返回与 [from, to) 重叠的第一段（不含 exclude 里的来访）。
 */
async function tagOverlap(tx: Tx, tagIds: number[], from: Date, to: Date, exclude: number[]) {
  const [hit] = await tx<{ code: string; visitNo: string; since: string; until: string | null }[]>`
    WITH touched AS (
      SELECT id FROM visits WHERE tag_id IN ${tx(tagIds)}
      UNION SELECT visit_id FROM visit_tag_changes WHERE from_tag_id IN ${tx(tagIds)} OR to_tag_id IN ${tx(tagIds)}
    ), segs AS (
      SELECT v.id AS visit_id, v.visit_no, c.from_tag_id AS tag_id,
             coalesce(lag(c.created_at) OVER (PARTITION BY v.id ORDER BY c.id), v.checked_in_at) AS since, c.created_at AS until
      FROM visits v JOIN visit_tag_changes c ON c.visit_id = v.id
      WHERE v.id IN (SELECT id FROM touched) AND v.status <> 'cancelled'
      UNION ALL
      SELECT v.id, v.visit_no, v.tag_id,
             coalesce((SELECT max(c.created_at) FROM visit_tag_changes c WHERE c.visit_id = v.id), v.checked_in_at), v.closed_at
      FROM visits v WHERE v.id IN (SELECT id FROM touched) AND v.status <> 'cancelled'
    )
    SELECT t.code, s.visit_no, s.since, s.until FROM segs s JOIN hand_tags t ON t.id = s.tag_id
    WHERE s.tag_id IN ${tx(tagIds)} AND s.visit_id NOT IN ${tx(exclude.length ? exclude : [0])}
      AND s.since < ${to} AND (s.until IS NULL OR s.until > ${from})
    ORDER BY s.since LIMIT 1`;
  return hit;
}

/** 会员的来访与 [from, to) 重叠的第一笔（不含 exclude 里的来访） */
async function memberOverlap(tx: Tx, memberIds: number[], from: Date, to: Date, exclude: number[]) {
  const [hit] = await tx<{ name: string; visitNo: string; since: string; until: string | null }[]>`
    SELECT m.name, v.visit_no, v.checked_in_at AS since, v.closed_at AS until FROM visits v JOIN members m ON m.id = v.member_id
    WHERE v.member_id IN ${tx(memberIds)} AND v.status <> 'cancelled' AND v.id NOT IN ${tx(exclude.length ? exclude : [0])}
      AND v.checked_in_at < ${to} AND (v.closed_at IS NULL OR v.closed_at > ${from})
    ORDER BY v.checked_in_at LIMIT 1`;
  return hit;
}

const period = (h: { since: string; until: string | null }, timeZone: string) =>
  `${fmt(h.since, timeZone)}${h.until ? ` 至 ${fmt(h.until, timeZone)}` : ' 起（仍在店）'}`;

/**
 * 补录的接待：实际时间那一刻，手牌或会员已被别的来访占用时拒绝（时间重叠）。
 * 恢复后手牌可能已经发给别的客人又还回来：那位客人的时段不含实际时间，不拦；之后结账时再核对（assertNotReused）。
 * 调用前手牌已加锁；在店的占用另由 TAG_OCCUPIED、MEMBER_IN_STORE 拦下。
 */
export async function assertFreeAt(tx: Tx, at: Date, tagIds: number[], memberIds: number[], timeZone: string) {
  const moment = new Date(at.getTime() + 1);
  const tag = tagIds.length ? await tagOverlap(tx, tagIds, at, moment, []) : undefined;
  if (tag) {
    throw conflict('BACKFILL_TAG_BUSY', `手牌 ${tag.code} 在 ${period(tag, timeZone)}有客人（来访 ${tag.visitNo}），与补录的时间重叠，请核对纸质单`, {
      code: tag.code,
      visitNo: tag.visitNo,
    });
  }
  const member = memberIds.length ? await memberOverlap(tx, memberIds, at, moment, []) : undefined;
  if (member) {
    throw conflict('BACKFILL_MEMBER_BUSY', `会员「${member.name}」在 ${period(member, timeZone)}有来访（${member.visitNo}），与补录的时间重叠，请核对纸质单`, {
      visitNo: member.visitNo,
    });
  }
}

/**
 * 结账（平时或补录）：补录接待的客人，在店时段（接待到离店）里手牌或会员不能已有别的来访——
 * 恢复后手牌又发给了别人，说明这位客人在那之前已离店，要按纸质单补录结账时间。平时开的牌一直占着手牌，不受影响。
 * 反结账后重结的，离店时间按第一次结账的时刻（ticket_end_at）。
 */
export async function assertNotReused(tx: Tx, at: Date, visitIds: number[], timeZone: string) {
  const rows = await tx<{ id: number; tagId: number; memberId: number | null; checkedInAt: string; tagSince: string; endAt: string | null }[]>`
    SELECT v.id, v.tag_id, v.member_id, v.checked_in_at, v.ticket_end_at AS end_at,
           coalesce((SELECT max(c.created_at) FROM visit_tag_changes c WHERE c.visit_id = v.id), v.checked_in_at) AS tag_since
    FROM visits v
    WHERE v.id IN ${tx(visitIds)} AND EXISTS (SELECT 1 FROM backfill_entries b WHERE b.visit_id = v.id AND b.kind = 'checkin')`;
  for (const r of rows) {
    const end = r.endAt ? new Date(r.endAt) : at;
    const tag = await tagOverlap(tx, [r.tagId], new Date(r.tagSince), end, [r.id]);
    if (tag) {
      throw conflict(
        'BACKFILL_TAG_REUSED',
        `手牌 ${tag.code} 在 ${period(tag, timeZone)}已由别的客人使用（来访 ${tag.visitNo}）：补录接待的这位客人应在此之前离店，请按纸质单补录结账时间`,
        { code: tag.code, visitNo: tag.visitNo },
      );
    }
    const member = r.memberId ? await memberOverlap(tx, [r.memberId], new Date(r.checkedInAt), end, [r.id]) : undefined;
    if (member) {
      throw conflict(
        'BACKFILL_TAG_REUSED',
        `会员「${member.name}」在 ${period(member, timeZone)}另有来访（${member.visitNo}）：补录接待的这次应在此之前离店，请按纸质单补录结账时间`,
        { visitNo: member.visitNo },
      );
    }
  }
}

const ORDER_TEXT: Record<BackfillKind, string> = { checkin: '接待时间早于同行客人的接待', charges: '挂账时间早于接待', checkout: '结账时间早于接待' };

/** 补录的同行接待、挂账、结账不能早于这几位客人的接待；结账不能早于已挂的明细（来访已加锁） */
export async function assertAfterVisits(tx: Tx, at: Date, visitIds: number[], kind: BackfillKind, timeZone: string) {
  const [row] = await tx<{ checkedInAt: string | null; postedAt: string | null }[]>`
    SELECT max(v.checked_in_at) AS checked_in_at,
           (SELECT max(l.posted_at) FROM bill_lines l JOIN visits v2 ON v2.bill_id = l.bill_id
            WHERE v2.id IN ${tx(visitIds)} AND l.status = 'active') AS posted_at
    FROM visits v WHERE v.id IN ${tx(visitIds)}`;
  if (row?.checkedInAt && at < new Date(row.checkedInAt)) {
    throw unprocessable('BACKFILL_ORDER', `补录的${ORDER_TEXT[kind]}（${fmt(row.checkedInAt, timeZone)}），请核对纸质单`);
  }
  if (kind === 'checkout' && row?.postedAt && at < new Date(row.postedAt)) {
    throw unprocessable('BACKFILL_ORDER', `补录的结账时间早于最后一项挂账（${fmt(row.postedAt, timeZone)}），请核对纸质单`);
  }
}

/** 记下一步补录（与单据同一事务） */
export async function recordBackfill(
  tx: Tx,
  b: Backfill,
  e: { kind: BackfillKind; opKey: string; visitId?: number | null; checkoutId?: number | null; businessDate: string; actor: Actor },
) {
  await tx`
    INSERT INTO backfill_entries (slip_no, kind, op_key, visit_id, checkout_id, actual_at, business_date, entered_by)
    VALUES (${b.slipNo}, ${e.kind}, ${e.opKey}, ${e.visitId ?? null}, ${e.checkoutId ?? null}, ${b.at}, ${e.businessDate}, ${e.actor.id})`;
}

/** 审计里记下的补录信息 */
export const backfillDetail = (b: Backfill | null) => (b ? { backfill: { slipNo: b.slipNo, actualAt: b.at.toISOString() } } : {});

/** SQL 片段：按操作编号取补录标记（json，没有补录为 null） */
export const backfillMarkSql = (db: Db, opKeyCol: string) => db`
  (SELECT json_build_object('slipNo', bf.slip_no, 'actualAt', bf.actual_at, 'enteredByName', bs.display_name, 'enteredAt', bf.entered_at)
   FROM backfill_entries bf JOIN staff bs ON bs.id = bf.entered_by WHERE bf.op_key = ${db(opKeyCol)}
   ORDER BY bf.id LIMIT 1)`;

/** 补录标记里的时间统一成 ISO 字符串（json_build_object 里的 timestamptz 是数据库格式） */
export const normalizeMark = (m: BackfillMark | null): BackfillMark | null =>
  m ? { ...m, actualAt: new Date(m.actualAt).toISOString(), enteredAt: new Date(m.enteredAt).toISOString() } : null;
