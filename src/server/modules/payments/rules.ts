// 付款规则（8.0.6，店主 2026-11-10：付款流 P1–P12 照默认，有争议的数值与开关不写死）：存在 settings 的 `payment_rules`，
// 在 ERP「付款 → 付款规则」里改。读的地方：三单比对（P8）、质保金台账与待办（P9）、本周应付（P11）、付款申请的默认审批链（P5）、
// 付款登记拦「挂合同的货款没走付款申请」（P7）。
// 8.0.17 加「固定付款日」（LC7）：新建付款申请的默认期望付款日、采购流程图的付款环节读它。
//
// 锁：保存走规则锁（saveRuleSetting：先取规则锁、在锁里读当前值、只合并提交的字段，同时保存的两个人不会互相覆盖）；读不加锁。
// 改了立即生效：已经算出来的结果（例如已经提交的付款申请的审批链、已经记下的放行）不回头改。

import { z } from 'zod';
import { DEFAULT_PAYMENT_RULES, normalizePayDays, PAY_DAYS_MAX, PAYMENT_RULE_LIMITS, type PaymentRules } from '@shared/payments';
import type { Db } from '../../db';
import type { OpContext } from '../../lib/context';
import { saveRuleSetting } from '../../lib/rule-settings';
import { parse } from '../../lib/validate';

export const PAYMENT_RULES_KEY = 'payment_rules';

export async function loadPaymentRules(db: Db): Promise<PaymentRules> {
  const [row] = await db<{ value: Partial<PaymentRules> }[]>`SELECT value FROM settings WHERE key = ${PAYMENT_RULES_KEY}`;
  return { ...DEFAULT_PAYMENT_RULES, ...(row?.value ?? {}) };
}

const int = (limits: { min: number; max: number }, label: string) =>
  z
    .number({ message: `${label}要填数字` })
    .int(`${label}要是整数`)
    .min(limits.min, `${label}不能小于 ${limits.min}`)
    .max(limits.max, `${label}不能大于 ${limits.max}`);

const RulesInput = z.object({
  ownerLevelCents: int(PAYMENT_RULE_LIMITS.ownerLevelCents, '加店主一级的金额').nullable(),
  requireRequestForContractGoods: z.boolean(),
  threeWayPctBp: int(PAYMENT_RULE_LIMITS.threeWayPctBp, '三单差额比例'),
  threeWayCapCents: int(PAYMENT_RULE_LIMITS.threeWayCapCents, '三单差额上限'),
  warrantyRemindDays: int(PAYMENT_RULE_LIMITS.warrantyRemindDays, '质保金提前提醒天数'),
  weeklyWeeks: int(PAYMENT_RULE_LIMITS.weeklyWeeks, '本周应付的周数'),
  // 固定付款日（8.0.17，LC7）：每月几号，最多 4 个；存成去重、从小到大的
  payDays: z
    .array(z.number({ message: '付款日要填数字' }).int('付款日要是整数').min(1, '付款日是 1–31 号').max(31, '付款日是 1–31 号'))
    .max(PAY_DAYS_MAX, `固定付款日最多 ${PAY_DAYS_MAX} 个`)
    .transform((days) => normalizePayDays(days)),
});

/** 只改提交的字段，其余沿用当前规则（与技师规则、前台规则相同的做法） */
export function savePaymentRules(sql: Parameters<typeof saveRuleSetting>[0], raw: unknown, ctx: OpContext): Promise<PaymentRules> {
  return saveRuleSetting(sql, PAYMENT_RULES_KEY, loadPaymentRules, (before) => parse(RulesInput, { ...before, ...parse(RulesInput.partial(), raw) }), ctx);
}
