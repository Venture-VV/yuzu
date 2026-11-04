// 前台派钟、挂技师项目、加钟与技师预约不重叠（v0.7.28，测试会话预检 ded1958 的 P2）。
//
// 预约新建、改时间时在「技师预约」这把咨询锁里核对技师没结束的钟单；这里反过来：建钟单、加钟前取同一把锁，
// 核对这位技师在这一钟计划的时段里有没有还占着时段的预约（待确认、已确认，指定了这位技师的）。两边串行，先提交的那边算数，
// 后到的看得到、拒绝。预约的客人到了要先在「预约」里点到店（预约就不再占时段）；这位客人自己约的这位技师不拦。
// 锁：技师队列锁（调用方已取）之后取这把咨询锁；预约新建、改时间只取这把锁、不取技师队列锁，不会互相等成环。

import { ACTIVE_BOOKING_STATUSES } from '@shared/bookings';
import type { Tx } from '../db';
import { conflict } from '../lib/errors';
import { lockOpKey } from '../lib/fences';

/** 技师预约全部串行的那把咨询锁（预约新建、改时间与建钟单、加钟共用） */
export const lockTechnicianBookings = (tx: Tx) => lockOpKey(tx, 'booking:technicians');

const hm = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

/**
 * 这位技师在 [from, to) 里有还占着时段的预约就拒绝（TECHNICIAN_BOOKED）。memberId：这一钟的客人是会员时，
 * 这位会员自己约的预约不算冲突（同一位客人）
 */
export async function assertTechnicianNotBooked(
  tx: Tx,
  a: { technicianId: number; techLabel: string; from: number; to: number; memberId: number | null; timeZone: string },
): Promise<void> {
  if (a.to <= a.from) return;
  await lockTechnicianBookings(tx);
  const [b] = await tx<{ bookingNo: string; startsAt: Date; endsAt: Date; who: string }[]>`
    SELECT b.booking_no, b.starts_at, b.ends_at, coalesce(m.name, nullif(b.guest_name, ''), '客人') AS who
    FROM bookings b LEFT JOIN members m ON m.id = b.member_id
    WHERE b.technician_id = ${a.technicianId} AND b.status IN ${tx(ACTIVE_BOOKING_STATUSES)}
      AND b.starts_at < ${new Date(a.to)} AND b.ends_at > ${new Date(a.from)}
      AND (b.member_id IS NULL OR b.member_id IS DISTINCT FROM ${a.memberId})
    ORDER BY b.starts_at LIMIT 1`;
  if (!b) return;
  throw conflict(
    'TECHNICIAN_BOOKED',
    `${a.techLabel} ${hm(new Date(b.startsAt), a.timeZone)}–${hm(new Date(b.endsAt), a.timeZone)} 有预约（${b.bookingNo}，${b.who}），这一钟会和预约冲突：` +
      '是预约的客人到了，请先在「预约」里点到店；否则请换一位技师或等预约之后',
    { bookingNo: b.bookingNo },
  );
}
