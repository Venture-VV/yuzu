// 会员体系 v2 的纯计算（v0.7.23，src/shared/membership.ts；docs/MEMBERSHIP.md 第 2 节）
import { describe, expect, it } from 'vitest';
import {
  bonusFor,
  DEFAULT_MEMBERSHIP_RULES as R,
  expiryStep,
  gradeForAmount,
  gradeLabel,
  rechargeOutcome,
  tierForSpend,
  tierTargets,
  type GradeState,
} from '../src/shared/membership';

const yuan = (n: number) => Math.round(n * 100);

describe('档级与赠金', () => {
  it('按滚动累计充值定档：门槛正好到就算；上线定档最高 L5', () => {
    expect(gradeForAmount(R, yuan(4999.99))).toBe(0);
    expect(gradeForAmount(R, yuan(5000))).toBe(1);
    expect(gradeForAmount(R, yuan(29999))).toBe(2);
    expect(gradeForAmount(R, yuan(30000))).toBe(3);
    expect(gradeForAmount(R, yuan(300000))).toBe(6);
    expect(gradeForAmount(R, yuan(300000), R.onboardMaxGrade)).toBe(5);
  });

  it('赠金按充值后所在档的比例，分以下舍去', () => {
    expect(bonusFor(R, 1, yuan(5000))).toBe(0);
    expect(bonusFor(R, 2, yuan(10000))).toBe(yuan(500));
    expect(bonusFor(R, 3, yuan(30000.33))).toBe(Math.floor((3000033 * 800) / 10000));
    expect(bonusFor(R, 6, yuan(300000))).toBe(yuan(54000));
  });

  it('一笔充值可以连跳几档；没到更高档不变；赠金按充完的档；提示下一档还差多少', () => {
    const a = rechargeOutcome(R, 0, 0, yuan(50000));
    expect(a).toMatchObject({ gradeAfter: 4, upgraded: true, bonusCents: yuan(5000), next: { grade: 5, needCents: yuan(50000) } });
    // 分两次各 2.5 万：第一次到 L2（5%），第二次滚动累计 5 万到 L4（10%）
    const b1 = rechargeOutcome(R, 0, 0, yuan(25000));
    const b2 = rechargeOutcome(R, b1.gradeAfter, yuan(25000), yuan(25000));
    expect([b1.gradeAfter, b1.bonusCents, b2.gradeAfter, b2.bonusCents]).toEqual([2, yuan(1250), 4, yuan(2500)]);
    // 已在 L3，再充 1 万（滚动累计不到 5 万）：不变，按 L3 的 8% 赠
    expect(rechargeOutcome(R, 3, yuan(30000), yuan(10000))).toMatchObject({ gradeAfter: 3, upgraded: false, bonusCents: yuan(800) });
    // 档级高于滚动累计（例如上线定档）：不降，赠金按现在的档
    expect(rechargeOutcome(R, 5, 0, yuan(5000))).toMatchObject({ gradeAfter: 5, upgraded: false, bonusCents: yuan(750) });
    expect(rechargeOutcome(R, 6, yuan(300000), yuan(5000)).next).toBeNull();
  });

  it('阶位：周期净储值消费到本档门槛 30% 享、60% 尊；L0 没有阶位', () => {
    expect(tierTargets(R, 3)).toEqual({ enjoy: yuan(9000), honor: yuan(18000) });
    expect(tierForSpend(R, 3, yuan(8999.99))).toBe(0);
    expect(tierForSpend(R, 3, yuan(9000))).toBe(1);
    expect(tierForSpend(R, 3, yuan(18000))).toBe(2);
    expect(tierForSpend(R, 0, yuan(99999))).toBeNull();
    expect(gradeLabel(R, 3, 1)).toBe('L3 观澜 · 享');
    expect(gradeLabel(R, 0, null)).toBe('L0 青溪');
  });
});

describe('到期处理', () => {
  const l3: GradeState = { grade: 3, tier: 1, cycleStart: '2026-01-01', cycleEnd: '2026-12-31', graceUntil: null };

  it('周期没结束、L0：不处理', () => {
    expect(expiryStep(R, l3, 0, '2026-12-31')).toBeNull();
    expect(expiryStep(R, { grade: 0, tier: null, cycleStart: null, cycleEnd: null, graceUntil: null }, 0, '2027-06-01')).toBeNull();
  });

  it('≥ 60% 保级：保持尊阶，新周期从原到期日的下一天起算（哪天跑都一样）', () => {
    const step = expiryStep(R, l3, yuan(18000), '2027-01-05');
    expect(step).toEqual({ kind: 'retain', next: { grade: 3, tier: 2, cycleStart: '2027-01-01', cycleEnd: '2027-12-31', graceUntil: null } });
  });

  it('30%–60% 进 90 天补充期，期内到 60% 保级、新周期仍从原到期日起算；补充期满不够降一档', () => {
    const grace = expiryStep(R, l3, yuan(9000), '2027-01-01')!;
    expect(grace).toEqual({ kind: 'grace_start', next: { ...l3, graceUntil: '2027-03-31' } });
    expect(expiryStep(R, grace.next, yuan(9000), '2027-03-31')).toBeNull();
    expect(expiryStep(R, grace.next, yuan(18000), '2027-04-01')).toEqual({
      kind: 'grace_retain',
      next: { grade: 3, tier: 2, cycleStart: '2027-01-01', cycleEnd: '2027-12-31', graceUntil: null },
    });
    expect(expiryStep(R, grace.next, yuan(17999), '2027-04-01')).toEqual({
      kind: 'downgrade',
      next: { grade: 2, tier: 2, cycleStart: '2027-04-01', cycleEnd: '2028-03-30', graceUntil: null },
    });
  });

  it('< 30% 降一档进尊阶；L1 降到 L0（没有阶位、没有周期）；补充期设成 0 天时 30%–60% 也降档', () => {
    expect(expiryStep(R, l3, yuan(8999), '2027-01-01')).toEqual({
      kind: 'downgrade',
      next: { grade: 2, tier: 2, cycleStart: '2027-01-01', cycleEnd: '2027-12-31', graceUntil: null },
    });
    expect(expiryStep(R, { ...l3, grade: 1, tier: 0 }, 0, '2027-01-01')).toEqual({
      kind: 'downgrade',
      next: { grade: 0, tier: null, cycleStart: null, cycleEnd: null, graceUntil: null },
    });
    expect(expiryStep({ ...R, graceDays: 0 }, l3, yuan(9000), '2027-01-01')?.kind).toBe('downgrade');
  });
});
