// 会员权益按档阶分级（8.0.4 需求表 01，docs/MEMBERSHIP_V804.md 第 1 节）的排法：每张券模板都要出现在某一阶里（没有「未分级」）。
// Codex 自动审查 e726bc0：还没设起点的草稿权益挂着的券模板，原来既不随权益放、也不在「其余券模板」里单放，哪一阶都看不到。

import { describe, expect, it } from 'vitest';
import type { Benefit } from '../src/shared/benefits';
import { buildBenefitTiers, type BenefitTiers, type TierRule, type TierTemplate } from '../src/shared/benefit-tiers';
import { DEFAULT_MEMBERSHIP_RULES } from '../src/shared/membership';

const tpl = (id: number, levels: number[] = []): TierTemplate => ({ id, name: `券${id}`, summary: `代金券 ¥${id}`, faceValue: id * 100, levels, active: true });

/** 只填排档阶用得到的几项（没设起点的草稿：第 1 步直接跳过） */
const draftCoupon = (id: number, templateId: number | null): Benefit =>
  ({
    id,
    code: `QY-T${id}`,
    name: `草稿权益${id}`,
    category: 'coupon',
    templateId,
    startGrade: null,
    startTier: null,
    status: 'draft',
    tierQuantities: [],
    companionCounts: [],
    parkingHoursByTier: [],
  }) as unknown as Benefit;

const templateRanks = (tiers: BenefitTiers, templateId: number) =>
  tiers.grades.flatMap((g) => g.stages.filter((s) => s.coupons.some((e) => e.templateId === templateId)).map((s) => s.label));

describe('按档阶排：每张券模板都在某一阶', () => {
  it('还没设起点的草稿权益挂着的券模板，照样按限定的档级单放', () => {
    const tiers = buildBenefitTiers({
      rules: { grades: DEFAULT_MEMBERSHIP_RULES.grades },
      benefits: [draftCoupon(1, 11)],
      templates: [tpl(11), tpl(12, [3, 4])],
      couponRules: [],
    });
    expect(tiers.unplaced.map((b) => b.code)).toEqual(['QY-T1']);
    expect(templateRanks(tiers, 11)).toEqual(['L0·会员']);
    expect(templateRanks(tiers, 12)).toEqual(['L3·初']);
    expect(tiers.templates).toEqual({ total: 2, placed: 2 });
  });

  it('发券规则没放进任何一阶（升级礼没填档级）时，挂着的券模板也照样单放', () => {
    const rule: TierRule = { id: 1, kind: 'level_up', level: null, templateId: 21, quantity: 1, planName: null, planAmount: null };
    const tiers = buildBenefitTiers({ rules: { grades: DEFAULT_MEMBERSHIP_RULES.grades }, benefits: [], templates: [tpl(21)], couponRules: [rule] });
    expect(templateRanks(tiers, 21)).toEqual(['L0·会员']);
    expect(tiers.templates).toEqual({ total: 1, placed: 1 });
  });

  it('权益设好起点以后，券模板随权益放，不再单放一份', () => {
    const placedBenefit = { ...draftCoupon(2, 31), startGrade: 2, startTier: 0, quantity: 1, period: 'month' } as unknown as Benefit;
    const tiers = buildBenefitTiers({ rules: { grades: DEFAULT_MEMBERSHIP_RULES.grades }, benefits: [placedBenefit], templates: [tpl(31)], couponRules: [] });
    const fallback = tiers.grades.flatMap((g) => g.stages.flatMap((s) => s.coupons)).filter((e) => e.source === 'template');
    expect(fallback).toEqual([]);
    expect(templateRanks(tiers, 31)[0]).toBe('L2·初');
    expect(tiers.templates).toEqual({ total: 1, placed: 1 });
  });
});
