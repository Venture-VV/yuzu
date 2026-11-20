// 超时提醒（8.1.17 BW-1，docs/FRONTDESK_V8117.md 第 4 节）：在店到了 12 / 24 / 72 小时（超时在店的三级），
// 每分钟的任务在「异常待办」里记一条「超时提醒」，经办人是系统账号「系统」。
//   · 同一次来访每一级只记一次（部分唯一索引 visit_incidents_overtime_uq 兜底，几个进程同时跑也只记一次）；
//   · 停机后才跑到、一下子跨了几级的只记到了的最高一级（低的几级算被它盖过，不补记）；
//   · 记的就是一条异常（只追加），进这次来访的经办记录；客人离店、有了更高一级的提醒以后不再算待办（incident-read.ts 的 openTodoWhere）。
// 锁：与登记异常同一个顺序——来访（FOR UPDATE，一次来访一个事务）→ 写异常；候选是只读地挑的，锁住以后按最新的状态再核对一次。

import { createHash } from 'node:crypto';
import { overtimeReminderLevel, overtimeReminderNote, OVERTIME_REMINDER_HOURS } from '@shared/frontdesk-v8117';
import type { Sql } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { currentStoreId, forEachStore } from '../../lib/store-context';
import { systemAutoStaffId } from '../system-staff';
import { businessDate, lockVisits, setTxTimeouts } from './common';

/** 一次来访一级提醒的操作编号：按「来访 + 级别」算出来（同一条只有一个编号，查得到是哪一笔） */
export function overtimeOpKey(visitId: number, hours: number): string {
  const h = createHash('sha256').update(`overtime:${visitId}:${hours}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** 每分钟：各家店在店的客人到了哪一级、还没记的记一条；返回这一次记了几条 */
export async function sweepOvertimeReminders(deps: Deps, now = new Date()): Promise<number> {
  let n = 0;
  await forEachStore(deps.sql, async () => {
    n += await sweepStore(deps, now);
  });
  return n;
}

async function sweepStore(deps: Deps, now: Date): Promise<number> {
  const { sql } = deps;
  // 候选（只读、不加锁）：本店在店的来访，到了的最高一级还没记过的
  const due = await sql<{ id: number }[]>`
    SELECT v.id FROM visits v
    CROSS JOIN LATERAL (
      SELECT max(h) AS hours FROM unnest(${`{${OVERTIME_REMINDER_HOURS.join(',')}}`}::int[]) AS h WHERE v.checked_in_at <= ${now}::timestamptz - make_interval(hours => h)
    ) lv
    WHERE v.status = 'open' AND v.store_id = ${currentStoreId()} AND lv.hours IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM visit_incidents i WHERE i.visit_id = v.id AND i.kind = 'overtime' AND i.overtime_hours >= lv.hours)
    ORDER BY v.id LIMIT 500`;
  let n = 0;
  for (const d of due) {
    if (await remindOne(sql, deps, Number(d.id), now)) n += 1;
  }
  return n;
}

/** 给一次来访记这一级的提醒（一个事务）：锁住来访以后按最新的状态核对；已经记过（别的进程刚记）的不再记 */
async function remindOne(sql: Sql, deps: Deps, visitId: number, now: Date): Promise<boolean> {
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
    if (visit.status !== 'open') return false;
    const level = overtimeReminderLevel(Math.floor((now.getTime() - new Date(visit.checkedInAt).getTime()) / 60_000));
    if (level === null) return false;
    const [higher] = await tx<{ id: number }[]>`SELECT id FROM visit_incidents WHERE visit_id = ${visit.id} AND kind = 'overtime' AND overtime_hours >= ${level} LIMIT 1`;
    if (higher) return false;
    const staffId = await systemAutoStaffId(tx);
    const date = await businessDate(tx, deps, now);
    const note = overtimeReminderNote(level);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO visit_incidents (visit_id, member_id, kind, note, overtime_hours, op_key, business_date, created_by, created_at)
      VALUES (${visit.id}, ${visit.memberId}, 'overtime', ${note}, ${level}, ${overtimeOpKey(visit.id, level)}, ${date}, ${staffId}, ${now})
      ON CONFLICT (visit_id, overtime_hours) WHERE kind = 'overtime' DO NOTHING
      RETURNING id`;
    if (!row) return false;
    const [tag] = await tx<{ code: string }[]>`SELECT code FROM hand_tags WHERE id = ${visit.tagId}`;
    await writeAudit(tx, {
      staffId,
      action: 'visit_incident',
      targetType: 'visit',
      targetId: visit.id,
      detail: { visitNo: visit.visitNo, tagCode: tag?.code ?? '', incidentId: Number(row.id), kind: 'overtime', hours: level, note, auto: true },
      businessDate: date,
    });
    return true;
  });
}
