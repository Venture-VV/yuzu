import { describe, expect, it } from 'vitest';
import type { MpBenefitItem, MpBenefits, MpCoupon, MpLedgerRow } from '../../src/shared/mp';
import { benefitMeta, benefitsView, couponCode, couponView, ledgerRow } from '../src/utils/views';

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
  it('买一赠一券（8.0.4，RQ-014）：大字写买一赠一（小一号），买的、送的项目与「最多抵」照写', () => {
    expect(couponView(coupon({ kind: 'bogo', summary: '买一赠一 · 买 拿铁 送 拿铁 1 份' }))).toMatchObject({ big: '买一赠一', bigLong: true, kind: '买一赠一券', terms: '买 拿铁 送 拿铁 1 份' });
    expect(couponView(coupon({ kind: 'bogo', summary: '买一赠一 · 买 扬州搓澡 送 修脚 1 份 · 最多抵 ¥68.00' }))).toMatchObject({
      big: '买一赠一',
      kind: '买一赠一券',
      terms: '买 扬州搓澡 送 修脚 1 份 · 最多抵 ¥68',
    });
    // 门店系统给的第一段不是「买一赠一」时整句照写
    expect(couponView(coupon({ kind: 'bogo', summary: '买 拿铁 送 拿铁 1 份' })).terms).toBe('买 拿铁 送 拿铁 1 份');
  });
  it('认不得的种类与对不上的说明：大字写「券」或种类，说明整句照写、不丢字；短的大字不缩小', () => {
    expect(couponView(coupon({ kind: 'mystery', summary: '神秘券 · 满 ¥100.00 可用' }))).toMatchObject({ big: '券', bigLong: false, kind: '', terms: '神秘券 · 满 ¥100 可用' });
    expect(couponView(coupon({ kind: 'cash', summary: '现金抵用 ¥30.00 · 满 ¥50.00 可用' }))).toMatchObject({ big: '代金券', terms: '现金抵用 ¥30 · 满 ¥50 可用' });
    expect(couponView(coupon({ kind: 'mystery', summary: '' }))).toMatchObject({ big: '券', terms: '' });
    expect(couponView(coupon({})).bigLong).toBe(false);
    expect(couponView(coupon({ kind: 'discount', summary: '8.8 折' })).bigLong).toBe(false);
    expect(couponView(coupon({ summary: '代金券 ¥30.50' })).bigLong).toBe(false);
    expect(couponView(coupon({ summary: '代金券 ¥1000.50' })).bigLong).toBe(true);
  });
});

const benefit = (over: Partial<MpBenefitItem>): MpBenefitItem => ({
  code: 'QY-001',
  name: '会员专属通道',
  category: 'service',
  period: 'month',
  allowance: '每月 2 次',
  content: '入场、领手牌及结账会员专属通道。',
  conditions: '',
  used: 1,
  limit: 2,
  available: 0,
  ...over,
});

describe('本月可享', () => {
  it('次数与张数：设了次数的写这一期已用几次；不限次的写本月用了几次；券写能用几张；说明不写', () => {
    expect(benefitMeta(benefit({}))).toBe('每月 2 次 · 本月已用 1 次');
    expect(benefitMeta(benefit({ period: 'day', allowance: '每天 1 次', used: 0, limit: 1 }))).toBe('每天 1 次 · 今天已用 0 次');
    expect(benefitMeta(benefit({ period: 'year', allowance: '每年 4 次', used: 3, limit: 4 }))).toBe('每年 4 次 · 今年已用 3 次');
    expect(benefitMeta(benefit({ period: 'none', allowance: '不限次', used: 0, limit: null }))).toBe('不限次');
    expect(benefitMeta(benefit({ period: 'none', allowance: '不限次', used: 3, limit: null }))).toBe('不限次 · 本月用了 3 次');
    expect(benefitMeta(benefit({ category: 'coupon', allowance: '每月 1 张', used: null, limit: null, available: 1 }))).toBe('每月 1 张 · 能用 1 张');
    expect(benefitMeta(benefit({ category: 'event', allowance: '每次 1 张', used: null, limit: null, available: 0 }))).toBe('每次 1 张');
    expect(benefitMeta(benefit({ category: 'info', allowance: '', used: null, limit: null }))).toBe('');
  });

  it('按服务、券、礼遇、折扣、说明分组（没有的组不显示）；月份、升档以后、我的券入口', () => {
    const b: MpBenefits = {
      month: '2026-11',
      label: 'L2 潭影 · 初',
      items: [
        benefit({ code: 'QY-060', name: '跨店余额通用', category: 'info', allowance: '', used: null, limit: null }),
        benefit({}),
        benefit({ code: 'QY-051', name: '首充礼', category: 'event', allowance: '每次 1 张', used: null, limit: null, available: 1 }),
      ],
      upcoming: [{ name: '一次性浴衣拖鞋', startLabel: 'L4·初' }],
    };
    const v = benefitsView(b);
    expect(v.month).toBe('11 月');
    expect(v.label).toBe('L2 潭影 · 初');
    expect(v.groups.map((g) => g.title)).toEqual(['服务与资格', '礼遇', '说明']);
    expect(v.groups[0]!.items[0]).toEqual({ code: 'QY-001', name: '会员专属通道', meta: '每月 2 次 · 本月已用 1 次', content: '入场、领手牌及结账会员专属通道。', conditions: '' });
    expect(v.upcoming).toEqual([{ name: '一次性浴衣拖鞋', start: 'L4·初 起' }]);
    expect(v.hasCoupons).toBe(true);
    const empty = benefitsView({ month: '2026-01', label: 'L0 青溪', items: [], upcoming: [] });
    expect(empty).toMatchObject({ month: '1 月', groups: [], hasCoupons: false });
  });

  it('浴票延迟（主线 v0.7.25 的新类别）单独一组，排在折扣之后、说明之前，写多给几分钟', () => {
    const v = benefitsView({
      month: '2026-11',
      label: 'L3 观澜 · 享',
      items: [
        benefit({ code: 'QY-060', name: '跨店余额通用', category: 'info', allowance: '', used: null, limit: null }),
        benefit({ code: 'QY-004', name: '浴票延迟', category: 'extension', allowance: '多 1 小时不跳档', used: null, limit: null }),
        benefit({ code: 'QY-011', name: '包房 9 折', category: 'discount', allowance: '', used: null, limit: null }),
      ],
      upcoming: [],
    });
    expect(v.groups.map((g) => g.title)).toEqual(['折扣', '浴票延迟', '说明']);
    expect(v.groups[1]!.items[0]!.meta).toBe('多 1 小时不跳档');
    expect(v.hasCoupons).toBe(false);
  });
});
