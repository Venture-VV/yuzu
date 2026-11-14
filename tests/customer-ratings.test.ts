import { describe, expect, it } from 'vitest';
import { customerAmountGrade, CUSTOMER_RATING_RULES } from '../src/shared/customer-ratings';

describe('客户部金额SAB参考：个人与部门分别取最新门槛，金额使用分', () => {
  it.each([
    [24_999_999, '未达B'], [25_000_000, 'B'], [34_999_999, 'B'],
    [35_000_000, 'A'], [49_999_999, 'A'], [50_000_000, 'S'], [90_000_000, 'S'],
  ] as const)('个人金额%s分为%s', (amount, grade) => expect(customerAmountGrade(amount, 'individual')).toBe(grade));
  it.each([
    [499_999_999, '未达B'], [500_000_000, 'B'], [599_999_999, 'B'],
    [600_000_000, 'A'], [640_000_000, 'A'], [700_000_000, 'A'], [750_000_000, 'S'],
  ] as const)('部门金额%s分为%s（640万任务和旧700万不替代750万S线）', (amount, grade) => expect(customerAmountGrade(amount, 'department')).toBe(grade));
  it('冲减到负数仍未达B，资料来源和综合评分缺项明确', () => {
    expect(customerAmountGrade(-100, 'individual')).toBe('未达B');
    expect(CUSTOMER_RATING_RULES.source).toContain('统一报批版');
    expect(CUSTOMER_RATING_RULES.scoringNote).toContain('未录履职');
  });
});
