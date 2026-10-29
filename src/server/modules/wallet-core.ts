// 会员钱包的底层记账：锁会员、单号、写余额与流水。充值、消费、撤销（wallet.ts）与赠金到期作废（bonus.ts）共用。
// members.principal_balance / bonus_balance 与 ledger_entries 在同一事务里一起写，流水是唯一的记账来源。

import type { WalletBalance } from '@shared/deduction';
import type { Tx } from '../db';
import { AppError, notFound } from '../lib/errors';

export type WalletDocType = 'recharge' | 'consume' | 'reversal' | 'expire' | 'opening';
/** 流水类型：单据类型之外还有「期初作废」（沿用期初明细的单号） */
export type WalletEntryType = WalletDocType | 'opening_void';

/** 单号前缀：充值 CZ、消费 XF、撤销 CX、赠金过期 GQ、期初导入批次 QC */
const DOC_PREFIX: Record<WalletDocType, string> = { recharge: 'CZ', consume: 'XF', reversal: 'CX', expire: 'GQ', opening: 'QC' };

export interface LockedMember {
  id: number;
  name: string;
  principalBalance: number;
  bonusBalance: number;
  status: 'active' | 'frozen';
}

export async function lockMember(tx: Tx, id: number): Promise<LockedMember> {
  const [m] = await tx<LockedMember[]>`
    SELECT id, name, principal_balance, bonus_balance, status FROM members WHERE id = ${id} FOR UPDATE`;
  if (!m) throw notFound('会员不存在');
  return m;
}

export async function nextDocNo(tx: Tx, type: WalletDocType, businessDate: string): Promise<string> {
  const [row] = await tx<{ lastNo: number }[]>`
    INSERT INTO doc_counters (doc_type, business_date, last_no) VALUES (${type}, ${businessDate}, 1)
    ON CONFLICT (doc_type, business_date) DO UPDATE SET last_no = doc_counters.last_no + 1
    RETURNING last_no`;
  return `${DOC_PREFIX[type]}${businessDate.replaceAll('-', '')}-${String(row!.lastNo).padStart(4, '0')}`;
}

/** 写一笔余额变动：更新会员余额并追加一条流水，返回变动后的余额 */
export async function applyBalance(
  tx: Tx,
  member: LockedMember,
  delta: WalletBalance,
  entry: {
    entryType: WalletEntryType;
    docNo: string;
    rechargeId?: number;
    consumptionId?: number;
    reversalId?: number;
    expiryId?: number;
    openingId?: number;
    businessDate: string;
    /** 赠金到期作废由系统处理，没有经办员工 */
    operatorId: number | null;
    at: Date;
  },
): Promise<LockedMember> {
  const after = { principal: member.principalBalance + delta.principal, bonus: member.bonusBalance + delta.bonus };
  if (after.principal < 0 || after.bonus < 0) {
    throw new AppError(500, 'BALANCE_INVARIANT', '余额计算异常，已阻止本次记账');
  }
  await tx`
    UPDATE members SET principal_balance = ${after.principal}, bonus_balance = ${after.bonus}, updated_at = now()
    WHERE id = ${member.id}`;
  await tx`
    INSERT INTO ledger_entries (member_id, entry_type, recharge_id, consumption_id, reversal_id, expiry_id, opening_id, doc_no,
                                principal_delta, bonus_delta, principal_after, bonus_after,
                                business_date, operator_id, created_at)
    VALUES (${member.id}, ${entry.entryType}, ${entry.rechargeId ?? null}, ${entry.consumptionId ?? null},
            ${entry.reversalId ?? null}, ${entry.expiryId ?? null}, ${entry.openingId ?? null}, ${entry.docNo}, ${delta.principal}, ${delta.bonus},
            ${after.principal}, ${after.bonus}, ${entry.businessDate}, ${entry.operatorId}, ${entry.at})`;
  return { ...member, principalBalance: after.principal, bonusBalance: after.bonus };
}
