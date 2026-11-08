// 急采按金额分级审批（8.0.1 采购组整改 05，CG05，docs/PURCHASING_V801.md）：
// 急采由采购（「编制与提交采购单」）或店主登记，提交时进审批中心「急采」；没有审批规则命中时按「采购规则」里的分级：
// 合计 ≤ 第一档由这一档指定的人审（或签），≤ 第二档由第二档的人审……没指定（或指定的人都停用了）的由负责人审；
// 超过最高一档不能走急采。登记的人不能审自己的急采。批了以后照旧仓库到部门验收（verifyUrgent）才进部门小仓。

import { formatAmount } from '@shared/money';
import { urgentCapOf, urgentTierIndex } from '@shared/purchasing';
import type { Db } from '../../db';
import { unprocessable } from '../../lib/errors';
import { usableApprovers } from '../approvals/approvers';
import type { ApprovalPlan } from '../approvals/engine';
import { loadPurchaseRules } from './purchase-rules';

export async function urgentPlan(db: Db, amountCents: number): Promise<ApprovalPlan> {
  const rules = await loadPurchaseRules(db);
  const i = urgentTierIndex(rules, amountCents);
  if (i < 0) {
    const cap = urgentCapOf(rules);
    throw unprocessable('URGENT_OVER_CAP', `急采合计 ¥${formatAmount(amountCents)} 超过急采上限 ¥${formatAmount(cap)}，请开采购单`, { capCents: cap });
  }
  const ids = await usableApprovers(db, rules.urgentTiers[i]!.approverIds);
  return {
    ruleId: null,
    ruleVersion: null,
    steps: ids.length > 0 ? [{ staffIds: ids, mode: 'any' }] : [{ group: 'manager', mode: 'any' }],
    allowSelf: false,
  };
}
