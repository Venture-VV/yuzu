import type { Cents } from './money';

// 本金与赠金的扣款顺序属于待确认的经营规则。
// 三种候选规则都已实现，店主在「规则设置」里选定；每张消费单会记下当时使用的规则，
// 撤销时按原单记录的本金/赠金构成恢复，不受之后规则调整影响。

export const DEDUCTION_RULES = ['principal_first', 'bonus_first', 'proportional'] as const;
export type DeductionRule = (typeof DEDUCTION_RULES)[number];

export interface WalletBalance {
  principal: Cents;
  bonus: Cents;
}

export type DeductionResult =
  | { ok: true; principal: Cents; bonus: Cents }
  | { ok: false; reason: 'insufficient'; available: Cents; shortfall: Cents };

export function splitDeduction(amount: Cents, balance: WalletBalance, rule: DeductionRule): DeductionResult {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('扣款金额必须为正整数（分）');
  }
  const available = balance.principal + balance.bonus;
  if (amount > available) {
    return { ok: false, reason: 'insufficient', available, shortfall: amount - available };
  }

  switch (rule) {
    case 'principal_first': {
      const principal = Math.min(amount, balance.principal);
      return { ok: true, principal, bonus: amount - principal };
    }
    case 'bonus_first': {
      const bonus = Math.min(amount, balance.bonus);
      return { ok: true, principal: amount - bonus, bonus };
    }
    case 'proportional': {
      // 按当前本金:赠金比例拆分，赠金部分向下取整，零头计入本金。
      // 因 amount ≤ 本金+赠金，拆分结果天然不会超过各自余额。
      const bonus = Number((BigInt(amount) * BigInt(balance.bonus)) / BigInt(available));
      return { ok: true, principal: amount - bonus, bonus };
    }
  }
}
