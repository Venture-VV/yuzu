// 排位播报（8.1.15，docs/TECHNICIANS_V8115.md 第 3 节）：叫号记录与主播报终端。
//   · 叫号记录（technician_calls，只追加）：派钟时在派钟的事务里自动记一条，手动叫号另记一条；念的那一句在记的时候就定好
//     （排位号、工号、花名、房间都按叫的那一刻），各终端取看板时带上最近的几条。
//   · 主播报终端（technician_announcer，一家店一行）：几台终端同时开着钟房，只有登记的那一个浏览器念；别的终端看得到是谁在念、
//     可以明确地接管。那台终端开着钟房每半分钟报到一次，久没报到的在别的终端上提示。
// 不引钟房模块（钟房引它）；不等别的业务锁——叫号只插一行，登记只改自己那一行。

import { z } from 'zod';
import { announceText, CALL_WINDOW_MS, type AnnouncerClaim, type CallKind, type ClockCall } from '@shared/technician-admin';
import type { Db, Tx } from '../db';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { parse } from '../lib/validate';
import { currentStoreId } from '../lib/store-context';

/** 念出来的房间：有名字的念「编码 名字」，没有的念「编码 房」 */
export const spokenRoom = (space: { code: string; displayName: string | null } | null) =>
  space ? (space.displayName && space.displayName !== space.code ? `${space.code} ${space.displayName}` : `${space.code} 房`) : null;

export async function recordCall(
  tx: Tx,
  c: {
    technician: { id: number; techNo: string; name: string; nickname: string };
    sessionId: number | null;
    kind: CallKind;
    /** 叫的那一刻在轮钟队列里排第几（不在队列里为 null） */
    position: number | null;
    room: string | null;
    businessDate: string;
    staffId: number;
    at: Date;
  },
) {
  const text = announceText({ position: c.position, techNo: c.technician.techNo, name: c.technician.name, nickname: c.technician.nickname, room: c.room });
  await tx`
    INSERT INTO technician_calls (technician_id, session_id, kind, queue_position, room, text, business_date, staff_id, created_at)
    VALUES (${c.technician.id}, ${c.sessionId}, ${c.kind}, ${c.position}, ${c.room ?? ''}, ${text}, ${c.businessDate}, ${c.staffId}, ${c.at})`;
}

/** 最近的叫号（旧的在前，最多 30 条）：主播报终端按编号接着念 */
export async function recentCalls(db: Db, at: Date): Promise<ClockCall[]> {
  const rows = await db<ClockCall[]>`
    SELECT c.id, c.created_at AS "at", c.kind, c.technician_id, c.session_id, c.text, st.display_name AS staff_name
    FROM technician_calls c JOIN staff st ON st.id = c.staff_id
    WHERE c.store_id = ${currentStoreId()} AND c.created_at > ${new Date(at.getTime() - CALL_WINDOW_MS)}
    ORDER BY c.id DESC LIMIT 30`;
  return rows.reverse();
}

export async function announcerClaim(db: Db): Promise<AnnouncerClaim | null> {
  const [row] = await db<AnnouncerClaim[]>`
    SELECT a.client_id, a.label, coalesce(st.display_name, '') AS claimed_by_name, a.claimed_at, coalesce(a.seen_at, a.claimed_at) AS seen_at
    FROM technician_announcer a LEFT JOIN staff st ON st.id = a.claimed_by
    WHERE a.store_id = ${currentStoreId()} AND a.client_id IS NOT NULL`;
  return row ?? null;
}

const AnnouncerInput = z.object({
  action: z.enum(['claim', 'release', 'heartbeat'], '操作不正确'),
  /** 这个浏览器自己记的编号（本机保存） */
  clientId: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z-]{8,64}$/, '终端编号不正确，请刷新页面后重试'),
  label: z.string().trim().max(40, '终端名字最多 40 个字').default(''),
});

/**
 * 登记主播报终端。claim：由这个浏览器播报（原来是别的终端的，就是接管）；release：这个浏览器不再播报（只有它自己能放下）；
 * heartbeat：报到（只有登记的那一个浏览器的才算）。接管、放下记审计；报到不记。
 */
export async function setAnnouncer(deps: Deps, raw: unknown, ctx: OpContext): Promise<void> {
  const { action, clientId, label } = parse(AnnouncerInput, raw);
  if (action === 'heartbeat') {
    await deps.sql`UPDATE technician_announcer SET seen_at = now() WHERE store_id = ${currentStoreId()} AND client_id = ${clientId}`;
    return;
  }
  await deps.sql.begin(async (tx) => {
    // 先保证有这一行，再锁住它：两台终端同时点「由本机播报」，后到的那一台生效，谁被接管了审计里都有
    await tx`INSERT INTO technician_announcer (store_id) VALUES (${currentStoreId()}) ON CONFLICT (store_id) DO NOTHING`;
    const [before] = await tx<{ clientId: string | null; label: string }[]>`SELECT client_id, label FROM technician_announcer WHERE store_id = ${currentStoreId()} FOR UPDATE`;
    if (action === 'release') {
      if (before!.clientId !== clientId) return;
      await tx`UPDATE technician_announcer SET client_id = NULL, label = '', claimed_by = NULL, claimed_at = NULL, seen_at = NULL WHERE store_id = ${currentStoreId()}`;
    } else {
      if (before!.clientId === clientId) {
        await tx`UPDATE technician_announcer SET seen_at = now(), label = ${label} WHERE store_id = ${currentStoreId()}`;
        return;
      }
      await tx`
        UPDATE technician_announcer SET client_id = ${clientId}, label = ${label}, claimed_by = ${ctx.actor.id}, claimed_at = now(), seen_at = now()
        WHERE store_id = ${currentStoreId()}`;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'clock_announcer',
      targetType: 'clockroom',
      detail: {
        action,
        label,
        from: before!.clientId ? before!.label || '另一台终端' : null,
        summary: action === 'release' ? `${label || '本机'}不再播报叫号` : `${label || '本机'}负责播报叫号${before!.clientId ? `（从「${before!.label || '另一台终端'}」接管）` : ''}`,
      },
      ip: ctx.ip,
    });
  });
}
