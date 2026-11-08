// 会员端提醒（8.0.4 批量发券的「会员端弹窗」，docs/MEMBERSHIP_V804.md 第 6 节，HY16）：批量发券时给会员写两条——
// 到账当天起显示「您收到 N 张券」，到期前 N 天起显示「券 N 天后到期」；券都用掉、作废、过期的不再显示，看过记已读不再显示。
//
// 给小程序线用的两个函数（小程序的接口与弹窗页面在小程序线的目录里接）：
//   · listMemberNotices(db, memberId, today)：这位会员今天要弹的提醒（没读过、在显示的日子里、券还能用）；
//   · markMemberNoticeRead(db, memberId, noticeId)：会员看过了，记已读（只锁那一条，只记一次）。
// 会员合并（v0.7.26）以后，来源会员的提醒不搬：券已经都搬不过去（合并前要先用掉或作废），提醒自然不再显示。

import type { MemberNotice } from '@shared/coupon-campaigns';
import type { Db } from '../db';

export async function listMemberNotices(db: Db, memberId: number, today: string): Promise<MemberNotice[]> {
  const rows = await db<MemberNotice[]>`
    SELECT n.id, n.kind, n.title, n.body, n.show_from::text AS show_from, n.show_until::text AS show_until, n.created_at, n.read_at
    FROM member_notices n
    WHERE n.member_id = ${memberId} AND n.read_at IS NULL AND n.show_from <= ${today} AND n.show_until >= ${today}
      -- 券的提醒：这一次发的券里还有能用的才弹
      AND (n.issue_id IS NULL OR EXISTS (
        SELECT 1 FROM coupons c WHERE c.issue_id = n.issue_id AND c.status = 'available' AND c.valid_to >= ${today}))
    ORDER BY n.show_from DESC, n.id DESC
    LIMIT 20`;
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    createdAt: new Date(r.createdAt).toISOString(),
    readAt: r.readAt ? new Date(r.readAt).toISOString() : null,
  }));
}

/** 记已读；不是这位会员的、已经读过的返回 false */
export async function markMemberNoticeRead(db: Db, memberId: number, noticeId: number): Promise<boolean> {
  const rows = await db`UPDATE member_notices SET read_at = now() WHERE id = ${noticeId} AND member_id = ${memberId} AND read_at IS NULL RETURNING id`;
  return rows.length > 0;
}
