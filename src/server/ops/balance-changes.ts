// 余额变动清单（R1.5，只读）：某个时刻之后储值余额有变动的会员，切换后退回旧系统时按它回写 EBC。
// 每位会员一行：起点余额（那一刻之前最后一笔流水之后）、现在的余额与变动；期初导入、期初作废默认不算变动。

import { businessDayStart } from '@shared/business-date';
import type { Sql } from '../db';
import { toCsv } from '../lib/csv';

export interface BalanceChangeRow {
  memberNo: string;
  name: string;
  phone: string;
  legacyNo: string | null;
  principalBefore: number;
  bonusBefore: number;
  principalAfter: number;
  bonusAfter: number;
  entries: number;
  lastAt: string;
  /** 起点之后才导入期初（变动里含期初金额） */
  openingAfterSince: boolean;
}

/** 「2026-11-05 06:00」按门店时区换成时刻；也接受带时区的 ISO 时间 */
export function parseLocalTime(text: string, timeZone: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text.trim());
  if (m) {
    const [hour, minute] = [Number(m[2]), Number(m[3])];
    if (hour > 23 || minute > 59) return null;
    return new Date(businessDayStart(m[1]!, timeZone, 0).getTime() + (hour * 60 + minute) * 60_000);
  }
  const d = /[zZ]|[+-]\d{2}:?\d{2}$/.test(text.trim()) ? new Date(text.trim()) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

export async function balanceChanges(sql: Sql, since: Date, includeOpening = false): Promise<BalanceChangeRow[]> {
  return sql.begin('isolation level repeatable read read only', (tx) => tx<BalanceChangeRow[]>`
    WITH changed AS (
      SELECT member_id, count(*)::int AS entries, max(created_at) AS last_at
      FROM ledger_entries
      WHERE created_at >= ${since} AND (${includeOpening}::boolean OR entry_type NOT IN ('opening', 'opening_void'))
      GROUP BY member_id
    )
    SELECT m.member_no, m.name, m.phone,
           (SELECT b.legacy_no FROM opening_balances b WHERE b.member_id = m.id ORDER BY b.id DESC LIMIT 1) AS legacy_no,
           coalesce(prev.principal_after, 0) AS principal_before, coalesce(prev.bonus_after, 0) AS bonus_before,
           m.principal_balance AS principal_after, m.bonus_balance AS bonus_after, c.entries, c.last_at,
           EXISTS (SELECT 1 FROM ledger_entries e WHERE e.member_id = m.id AND e.created_at >= ${since}
                   AND e.entry_type IN ('opening', 'opening_void')) AS opening_after_since
    FROM changed c JOIN members m ON m.id = c.member_id
    LEFT JOIN LATERAL (
      SELECT e.principal_after, e.bonus_after FROM ledger_entries e
      WHERE e.member_id = m.id AND e.created_at < ${since} ORDER BY e.created_at DESC, e.id DESC LIMIT 1
    ) prev ON true
    ORDER BY m.member_no`) as Promise<BalanceChangeRow[]>;
}

export function balanceChangesCsv(rows: BalanceChangeRow[], stampOf: (iso: string) => string): string {
  const yuan = (cents: number) => `${cents < 0 ? '-' : ''}${Math.trunc(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
  return toCsv([
    ['会员号', '姓名', '手机号', '旧卡号', '起点本金', '起点赠金', '现在本金', '现在赠金', '本金变动', '赠金变动', '变动笔数', '最后变动时间', '说明'],
    ...rows.map((r) => [
      r.memberNo,
      r.name,
      r.phone,
      r.legacyNo ?? '',
      yuan(r.principalBefore),
      yuan(r.bonusBefore),
      yuan(r.principalAfter),
      yuan(r.bonusAfter),
      yuan(r.principalAfter - r.principalBefore),
      yuan(r.bonusAfter - r.bonusBefore),
      r.entries,
      stampOf(r.lastAt),
      r.openingAfterSince ? '起点之后导入过期初，变动里含期初金额' : '',
    ]),
  ]);
}
