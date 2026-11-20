// 房态中心（8.1.15，docs/ROOM_CENTER_V8115.md）里别的模块要用到的几处，单独放一个文件——钟房、使用单、餐饮引它，它不引它们：
//   · 维修中的房间不能派钟、不能换进来、不能开单：只读房态行、不加锁。设维修时在房态行之后锁空间一行（FOR NO KEY UPDATE），
//     派钟、换房间（共享锁）与开单（FOR NO KEY UPDATE）都先锁同一行再来读，两边排着队，不会一边设了维修、一边刚好派进去；
//   · 客人结账离店、撤销来访时，他在服务房间里的登记单一起结束（房间跟着转待清）：与结束使用单同一个时机，
//     登记单排在使用单之前锁（id 升序），不碰房态行——房态中心的写操作先锁房态行、再锁来访，这里反过来锁会互相等；
//   · 这间房里现在是哪位客人（currentGuestOfSpace）：餐饮「只填房号」点单按它找到手牌，只读、不加锁。

import type { Db, Tx } from '../db';
import { conflict } from '../lib/errors';
import { currentStoreId } from '../lib/store-context';

/** 这间房在维修：拒绝（label 是提示里怎么称呼这间房，如「房间 S301 · 合成 SPA」） */
export async function assertSpaceNotInMaintenance(db: Db, spaceId: number, label: string): Promise<void> {
  const [st] = await db<{ maintenanceReason: string | null }[]>`SELECT maintenance_reason FROM space_room_states WHERE space_id = ${spaceId} AND maintenance`;
  if (st) throw conflict('SPACE_MAINTENANCE', `${label} 在维修（${st.maintenanceReason ?? ''}），恢复以后才能用，请换一间`);
}

/**
 * 这几位客人开着的登记单一起结束（调用方已经锁好来访、账单等；这里只按 id 升序锁登记单）。
 * 结账离店的记「已结清」，撤销来访的记「撤销来访」（没用过房间，不算待清）；各记一条房间事件。
 */
export async function closeRegistrationsOfVisits(tx: Tx, visitIds: number[], kind: 'checkout' | 'visit_cancel', c: { at: Date; staffId: number }): Promise<void> {
  if (visitIds.length === 0) return;
  const open = await tx<{ id: number; spaceId: number; tagCode: string }[]>`
    SELECT r.id, r.space_id, h.code AS tag_code
    FROM room_registrations r JOIN visits v ON v.id = r.visit_id JOIN hand_tags h ON h.id = v.tag_id
    WHERE r.visit_id IN ${tx(visitIds)} AND r.status = 'open' ORDER BY r.id FOR UPDATE OF r`;
  if (open.length === 0) return;
  await tx`
    UPDATE room_registrations SET status = 'closed', closed_at = greatest(opened_at, ${c.at}), closed_by = ${c.staffId},
           close_kind = ${kind === 'checkout' ? 'settled' : 'visit_cancel'}, unpaid_cents = 0
    WHERE id IN ${tx(open.map((r) => r.id))}`;
  for (const r of open) {
    await tx`
      INSERT INTO space_room_events (space_id, kind, registration_id, detail, staff_id, created_at)
      VALUES (${r.spaceId}, 'checkout', ${r.id}, ${tx.json({ tag: r.tagCode, auto: kind })}, ${c.staffId}, ${c.at})`;
  }
}

/**
 * 这间房里现在的客人（餐饮「只填房号」点单按它找到手牌，8.1.16）：有登记单的取先登记的那一位；没有登记单、钟房直接派进来的，
 * 取还没结束的钟里最早那一张的客人；都没有的，取开着的使用单（派对房等）的使用人；都没有（空房、待清、维修、大厅）为 null。
 * 只读、不加锁；传事务或连接都行。别家店的空间按没有算。
 */
export async function currentGuestOfSpace(db: Db, spaceId: number): Promise<{ visitId: number; tagNo: string; memberId: number | null } | null> {
  const [row] = await db<{ visitId: number; tagNo: string; memberId: number | null }[]>`
    SELECT g.visit_id, h.code AS tag_no, v.member_id
    FROM (
      SELECT r.visit_id, 0 AS rank, r.id AS seq FROM room_registrations r
      WHERE r.space_id = ${spaceId} AND r.status = 'open' AND r.store_id = ${currentStoreId()}
      UNION ALL
      SELECT s.visit_id, 1 AS rank, s.id AS seq FROM technician_sessions s
      WHERE s.space_id = ${spaceId} AND s.status IN ('waiting', 'serving') AND s.store_id = ${currentStoreId()}
      UNION ALL
      SELECT u.visit_id, 2 AS rank, u.id AS seq FROM space_usages u
      WHERE u.space_id = ${spaceId} AND u.status = 'open' AND u.store_id = ${currentStoreId()}
    ) g JOIN visits v ON v.id = g.visit_id JOIN hand_tags h ON h.id = v.tag_id
    WHERE v.status = 'open'
    ORDER BY g.rank, g.seq LIMIT 1`;
  return row ? { visitId: Number(row.visitId), tagNo: row.tagNo, memberId: row.memberId === null ? null : Number(row.memberId) } : null;
}
