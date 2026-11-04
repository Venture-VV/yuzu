// 浴票延迟（v0.7.25 续，docs/MEMBERSHIP_P3.md 第 4 节；PENDING_DECISIONS M50、M63–M66；迁移 045）：
//   结账时会员的门票在「门票跳档宽限」之上再多给几分钟不跳档（每个 12 小时的分界点都多给）。
//   · 按手牌上登记的会员此刻的档阶：自己的与临时身份取高的（M51），到期没处理的先推算（与会员折扣的核对一样）；
//   · 几项浴票延迟都能享时取分钟数多的，不相加（M64）；没有会员、会员停用、没有发布的浴票延迟都是 0；
//   · 只读、不加锁（读已提交的）：结账事务里读到的就是这一刻的；会员一行仍在之后的会员折扣里按 id 升序锁（加锁顺序不变）。
//     结账核对与结账之间档阶变了，门票金额跟着变，按「应收合计变了」（PRICE_CHANGED）请员工重新核对。

import { ticketExtensionFor, type TierQuantity } from '@shared/benefits';
import type { TicketExtension } from '@shared/checkout';
import type { Db } from '../db';
import { projectedGrade } from './membership';
import { benefitState } from './member-trials';

interface ExtensionDef {
  id: number;
  code: string;
  name: string;
  version: number;
  startGrade: number | null;
  startTier: number | null;
  quantity: number | null;
  tierQuantities: TierQuantity[];
  sortOrder: number;
}

/** 已发布的浴票延迟（不加锁） */
async function publishedExtensions(db: Db): Promise<ExtensionDef[]> {
  const rows = await db<ExtensionDef[]>`
    SELECT id, code, name, version, start_grade, start_tier, quantity, tier_quantities, sort_order
    FROM benefits WHERE status = 'published' AND category = 'extension' ORDER BY sort_order, id`;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** 这几位会员此刻（营业日 date）的浴票延迟；不享的不在结果里 */
export async function memberTicketExtensions(db: Db, memberIds: readonly (number | null)[], date: string): Promise<Map<number, TicketExtension>> {
  const out = new Map<number, TicketExtension>();
  const ids = [...new Set(memberIds.filter((m): m is number => m !== null).map(Number))];
  if (ids.length === 0) return out;
  const defs = await publishedExtensions(db);
  if (defs.length === 0) return out;
  const active = await db<{ id: number }[]>`SELECT id FROM members WHERE id IN ${db(ids)} AND status = 'active' ORDER BY id`;
  for (const row of active) {
    const memberId = Number(row.id);
    const own = await projectedGrade(db, memberId, date);
    if (!own) continue;
    const s = await benefitState(db, memberId, own, date);
    const best = ticketExtensionFor(defs, s.grade, s.tier);
    if (best) out.set(memberId, { minutes: best.minutes, benefitId: best.benefit.id, code: best.benefit.code, name: best.benefit.name, version: best.benefit.version });
  }
  return out;
}
