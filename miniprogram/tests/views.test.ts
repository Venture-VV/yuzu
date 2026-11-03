import { describe, expect, it } from 'vitest';
import type { MpCoupon, MpLedgerRow } from '../../src/shared/mp';
import { couponCode, couponView, ledgerRow } from '../src/utils/views';

const row = (over: Partial<MpLedgerRow>): MpLedgerRow => ({
  id: 1,
  kind: 'consume',
  kindLabel: '消费',
  principalDelta: -254900,
  bonusDelta: 0,
  principalAfter: 1000000,
  bonusAfter: 50000,
  businessDate: '2026-10-28',
  createdAt: '2026-10-28T06:05:00.000Z',
  summary: '全身按摩 · 日式指压',
  ...over,
});
const coupon = (over: Partial<MpCoupon>): MpCoupon => ({
  code: 'K7M42QXH8RTP',
  name: '满 200 减 30',
  kind: 'cash',
  summary: '代金券 ¥30.00 · 满 ¥200.00 可用',
  validFrom: '2026-11-01',
  validTo: '2026-12-31',
  state: 'available',
  ...over,
});

describe('流水', () => {
  it('消费、充值（本金加赠金）、赠金过期', () => {
    expect(ledgerRow(row({}))).toMatchObject({ title: '消费', when: '2026-10-28 14:05', amount: '−¥2,549.00', pos: false, split: '', after: '余额 ¥10,500.00' });
    expect(ledgerRow(row({ kind: 'recharge', kindLabel: '充值', principalDelta: 3000000, bonusDelta: 240000 }))).toMatchObject({
      amount: '+¥32,400.00',
      pos: true,
      split: '本金 +¥30,000.00 · 赠金 +¥2,400.00',
    });
    expect(ledgerRow(row({ kind: 'expire', kindLabel: '赠金过期', principalDelta: 0, bonusDelta: -5000 }))).toMatchObject({ amount: '−¥50.00', split: '赠金' });
  });

  it('营业日切换之前记的：日期按记账时刻，营业日另外写（不会早显示一天）', () => {
    // 北京时间 2026-11-03 02:00 记的，营业日是 11-02
    expect(ledgerRow(row({ businessDate: '2026-11-02', createdAt: '2026-11-02T18:00:00.000Z' })).when).toBe('2026-11-03 02:00（营业日 11-02）');
    expect(ledgerRow(row({ businessDate: '2026-11-03', createdAt: '2026-11-03T06:30:00.000Z' })).when).toBe('2026-11-03 14:30');
  });
});

describe('券', () => {
  it('代金券、折扣券、兑换券的券面', () => {
    expect(couponView(coupon({}))).toMatchObject({ code: 'K7M4-2QXH-8RTP', big: '¥30', kind: '代金券', terms: '满 ¥200 可用', valid: '2026-11-01 至 2026-12-31', usable: true, stateLabel: '可用' });
    expect(couponView(coupon({ kind: 'discount', summary: '8.8 折 · 最多减 ¥30.00 · 限门票' }))).toMatchObject({ big: '8.8 折', kind: '折扣券', terms: '最多减 ¥30 · 限门票' });
    expect(couponView(coupon({ kind: 'exchange', summary: '兑换 扬州搓澡 1 份 · 最多抵 ¥189.00' }))).toMatchObject({ big: '兑换', kind: '兑换券', terms: '兑换 扬州搓澡 1 份 · 最多抵 ¥189' });
    expect(couponView(coupon({ state: 'used', validFrom: '2026-11-05', validTo: '2026-11-05' }))).toMatchObject({ usable: false, stateLabel: '已使用', valid: '2026-11-05 当天有效' });
  });
  it('有角分的金额照写', () => {
    expect(couponView(coupon({ summary: '代金券 ¥30.50 · 满 ¥200.00 可用' })).big).toBe('¥30.50');
    expect(couponCode('ABCD1234')).toBe('ABCD-1234');
  });
});
