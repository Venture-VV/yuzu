import { describe, expect, it } from 'vitest';
import type { MpGrade } from '../../src/shared/mp';
import { cardView, type MeMember } from '../src/utils/member-card';

const LADDER = ['青溪', '云涧', '潭影', '观澜', '望岳', '山海', '归墟'];

const member = (grade: Partial<MpGrade>, over: Partial<MeMember> = {}): MeMember => ({
  memberNo: '1024',
  name: '沈先生',
  frozen: false,
  principalBalance: 1836000,
  bonusBalance: 240000,
  deductionRule: '先本金，后赠金',
  availableCoupons: 2,
  rechargeOpen: false,
  merged: false,
  couponCenterOpen: false,
  grade: {
    label: 'L3 观澜 · 享',
    grade: 3,
    gradeName: '观澜',
    tier: 1,
    tierName: '享',
    cycleEnd: '2027-09-03',
    daysLeft: 304,
    inGrace: false,
    cycleSpendCents: 1164000,
    targets: { enjoy: 900000, honor: 1800000 },
    next: { grade: 4, name: '望岳', needCents: 2000000, bonusBp: 1000 },
    ladder: LADDER,
    ...grade,
  },
  ...over,
});

describe('会员卡', () => {
  it('L3 观澜 · 享：阶梯、进度、到期、下一档、余额', () => {
    const c = cardView(member({}));
    expect(c).toMatchObject({ code: 'L3', gradeName: '观澜', tierName: '享', total: '¥20,760.00', principal: '¥18,360.00', bonus: '¥2,400.00', deduction: '先本金，后赠金', coupons: 2 });
    expect(c.ladder.map((s) => s.state)).toEqual(['done', 'done', 'done', 'cur', '', '', '']);
    expect(c.bar).toEqual({
      fill: 64,
      mark: 50,
      enjoy: '享 ¥9,000',
      honor: '尊 · 保级 ¥18,000',
      text: '本周期储值消费 ¥11,640.00',
      hint: '再储值消费 ¥6,360.00 升尊阶，同时够保级',
    });
    expect(c.cycle).toBe('会籍到期 2027-09-03 · 还有 304 天');
    expect(c.next).toBe('累计充值再 ¥20,000.00 升到 L4 望岳，这一档充值赠送 10%');
  });

  it('初阶：先说升享阶；尊阶：已够保级；补充期：说保级', () => {
    expect(cardView(member({ tier: 0, tierName: '初', cycleSpendCents: 100000 })).bar!.hint).toBe('再储值消费 ¥8,000.00 升享阶');
    expect(cardView(member({ tier: 2, tierName: '尊', cycleSpendCents: 1900000 })).bar).toMatchObject({ fill: 100, hint: '本周期已够保级' });
    const grace = cardView(member({ inGrace: true, daysLeft: 40, cycleSpendCents: 100000 }));
    expect(grace.bar!.hint).toBe('再储值消费 ¥17,000.00 就能保级');
    expect(grace.bar!.text).toBe('补充期内储值消费 ¥1,000.00');
    expect(grace.cycle).toBe('补充期 · 还有 40 天');
  });

  it('L0：没有进度条与到期；下一笔充值就升档；已是最高档没有下一档', () => {
    const l0 = cardView(member({ grade: 0, gradeName: '青溪', tier: null, tierName: null, cycleEnd: null, daysLeft: null, targets: null, cycleSpendCents: 0, next: { grade: 1, name: '云涧', needCents: 0, bonusBp: 0 } }));
    expect(l0.bar).toBeNull();
    expect(l0.cycle).toBe('');
    expect(l0.tierName).toBe('');
    expect(l0.next).toBe('下一笔充值就升到 L1 云涧');
    expect(cardView(member({ grade: 6, gradeName: '归墟', next: null })).next).toBe('');
  });

  it('冻结的会员照样显示，标出来', () => {
    expect(cardView(member({}, { frozen: true })).frozen).toBe(true);
  });

  it('线上充值开着才有「充值」；合并掉的会员卡标出来、不给充值（MP25）', () => {
    expect(cardView(member({})).recharge).toBe(false);
    expect(cardView(member({}, { rechargeOpen: true })).recharge).toBe(true);
    const merged = cardView(member({}, { rechargeOpen: true, frozen: true, merged: true }));
    expect(merged).toMatchObject({ merged: true, frozen: true, recharge: false });
    // 领券中心（第二期 2c）：开着才有入口，合并掉的会员卡没有
    expect(cardView(member({})).couponCenter).toBe(false);
    expect(cardView(member({}, { couponCenterOpen: true })).couponCenter).toBe(true);
    expect(cardView(member({}, { couponCenterOpen: true, frozen: true, merged: true })).couponCenter).toBe(false);
  });
});
