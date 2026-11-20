// 房态中心（8.1.15，docs/ROOM_CENTER_V8115.md）里别的模块要用到的两处，单独放一个文件——钟房、使用单引它，它不引它们：
//   · 维修中的房间不能派钟、不能换进来、不能开单：只读房态行、不加锁。设维修时在房态行之后锁空间一行（FOR NO KEY UPDATE），
//     派钟、换房间（共享锁）与开单（FOR NO KEY UPDATE）都先锁同一行再来读，两边排着队，不会一边设了维修、一边刚好派进去；
//   · 客人结账离店、撤销来访时，他在服务房间里的登记单一起结束（房间跟着转待清）：与结束使用单同一个时机，
//     登记单排在使用单之前锁（id 升序），不碰房态行——房态中心的写操作先锁房态行、再锁来访，这里反过来锁会互相等。

import type { Db, Tx } from '../db';
import { conflict } from '../lib/errors';

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
