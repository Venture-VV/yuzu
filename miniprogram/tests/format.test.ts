import { describe, expect, it } from 'vitest';
import { groupCode, minutes, percentOfBp, price, shopDateTime, shopTime, yuan } from '../src/utils/format';

describe('金额与日期', () => {
  it('金额：分 → ¥，千分位，正负号', () => {
    expect(yuan(0)).toBe('¥0.00');
    expect(yuan(5)).toBe('¥0.05');
    expect(yuan(123456789)).toBe('¥1,234,567.89');
    expect(yuan(-254900)).toBe('−¥2,549.00');
    expect(yuan(3000000, true)).toBe('+¥30,000.00');
    expect(yuan(0, true)).toBe('¥0.00');
  });
  it('价目：整元不写小数', () => {
    expect(price(18900)).toBe('¥189');
    expect(price(18950)).toBe('¥189.50');
    expect(price(1489000)).toBe('¥14,890');
  });
  it('赠送比例（万分比）', () => {
    expect(percentOfBp(1000)).toBe('10%');
    expect(percentOfBp(850)).toBe('8.5%');
    expect(percentOfBp(805)).toBe('8.05%');
    expect(percentOfBp(1234)).toBe('12.34%');
    expect(percentOfBp(0)).toBe('0%');
  });
  it('门店时间按北京时间，不看手机时区', () => {
    expect(shopDateTime('2026-10-28T06:05:00.000Z')).toBe('2026-10-28 14:05');
    expect(shopDateTime('2026-10-28T17:30:00Z')).toBe('2026-10-29 01:30');
    expect(shopTime('2026-10-28T06:05:00.000Z')).toBe('14:05');
    expect(shopDateTime('不是时间')).toBe('');
  });
  it('会员码每 4 位空一格；时长', () => {
    expect(groupCode('8000123456789012')).toBe('8000 1234 5678 9012');
    expect(groupCode('9000001234567123456')).toBe('9000 0012 3456 7123 456');
    expect(minutes(90)).toBe('90 分钟');
    expect(minutes(null)).toBe('');
  });
});
