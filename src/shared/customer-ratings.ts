/** Latest locally checked source: 2026-11-13 unified submission draft, table 5.
 * Trial amount bands only. They do not assert approval or calculate payroll.
 */
export type CustomerAmountGrade = 'S' | 'A' | 'B' | '未达B';
export const CUSTOMER_RATING_RULES = {
  individual: { B: 25_000_000, A: 35_000_000, S: 50_000_000 },
  department: { B: 500_000_000, A: 600_000_000, S: 750_000_000 },
  source: '2026-11-13《客户部薪酬绩效调整方案_统一报批版》表5，本地试跑参考',
  scoringNote: '金额档级不等于综合考评：普通经理业绩80%＋履职20%；组长个人50%＋组员20%＋履职30%；负责人团队70%＋履职30%。未录履职时不生成综合分或奖金。',
  awardNote: '达到金额线只取得参评资格，不代表获奖；15人共享S最多3名、A最多5名，先S后A按目标完成率评选，同月只领一档。负责人还需管理交付≥80分及正式销售至少50%达个人A线，未核验不判奖。',
  basisNote: '本页按已确认的客户部充值实收本金过程口径；报批稿最终考评还含达标包厢、退款与日期归属核验，本地看板不替代最终考评。',
  groupNote: 'A/B组按当月目标分组，展示目标达成率；资料未给出两小组独立S/A/B金额线，不按部门门槛或比例编造。',
} as const;

export function customerAmountGrade(amountCents: number, scope: 'individual' | 'department'): CustomerAmountGrade {
  const t = CUSTOMER_RATING_RULES[scope];
  if (amountCents >= t.S) return 'S';
  if (amountCents >= t.A) return 'A';
  if (amountCents >= t.B) return 'B';
  return '未达B';
}
