// 券与会员权益（v0.7.20，飞书 RQ-006 后半；docs/COUPONS.md）的查询：后台的券模板、发券规则、无记名券、统计，
// 会员的券，充值套餐挂的券（充值页的「另赠」）。

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CouponBatch, CouponKind, CouponMeta, CouponRule, CouponState, CouponStats, CouponTemplate, MemberCoupons } from '@shared/coupons';
import { api } from '../../lib/api';

export const couponKeys = {
  all: ['coupons'] as const,
  templates: ['coupons', 'templates'] as const,
  meta: ['coupons', 'meta'] as const,
  rules: ['coupons', 'rules'] as const,
  batches: ['coupons', 'batches'] as const,
  stats: (from: string, to: string) => ['coupons', 'stats', from, to] as const,
  planGifts: ['coupons', 'plan-gifts'] as const,
  /** 挂在 ['member', id] 下面：充值、结账、建档后刷新会员时，会员的券一起刷新 */
  member: (memberId: number) => ['member', memberId, 'coupons'] as const,
};

/** 充值套餐挂的券（只列启用的规则与启用的模板，固定有效期已过的不列） */
export interface PlanGift {
  planId: number;
  templateId: number;
  templateName: string;
  quantity: number;
  /** 模板限定的会员等级（空 = 不限）：入账时按充值后的等级发 */
  levels: number[];
}

/** 「演示券 × 1（限第 2、3 级会员）」 */
export const planGiftText = (g: PlanGift) => `${g.templateName} × ${g.quantity}${g.levels.length ? `（限第 ${g.levels.join('、')} 级会员）` : ''}`;

/** 券模板：维护（coupon.manage）或发券（coupon.issue）的岗位能看 */
export const useCouponTemplates = (enabled = true) =>
  useQuery({ queryKey: couponKeys.templates, queryFn: () => api.get<CouponTemplate[]>('/api/coupons/templates'), enabled });

export const useCouponMeta = () => useQuery({ queryKey: couponKeys.meta, queryFn: () => api.get<CouponMeta>('/api/coupons/meta'), staleTime: 60_000 });

export const useCouponRules = () => useQuery({ queryKey: couponKeys.rules, queryFn: () => api.get<CouponRule[]>('/api/coupons/rules') });

export const useCouponBatches = () => useQuery({ queryKey: couponKeys.batches, queryFn: () => api.get<CouponBatch[]>('/api/coupons/batches') });

export const useCouponStats = (from: string, to: string, enabled: boolean) =>
  useQuery({
    queryKey: couponKeys.stats(from, to),
    queryFn: () => api.get<CouponStats>(`/api/coupons/stats?from=${from}&to=${to}`),
    enabled,
    placeholderData: keepPreviousData,
  });

/** 充值页的「另赠」：接口要「会员充值」权限，没有时不查 */
export const usePlanGifts = (enabled: boolean) =>
  useQuery({ queryKey: couponKeys.planGifts, queryFn: () => api.get<PlanGift[]>('/api/coupons/plan-gifts'), enabled, staleTime: 60_000 });

export const useMemberCoupons = (memberId: number, enabled: boolean) =>
  useQuery({ queryKey: couponKeys.member(memberId), queryFn: () => api.get<MemberCoupons>(`/api/members/${memberId}/coupons`), enabled });

/** 发券、作废、改模板与规则之后：模板（已发张数）、规则、无记名券、统计、充值页的另赠一起刷新 */
export function useInvalidateCoupons() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: couponKeys.all });
}

export const COUPON_STATE_ORDER: readonly CouponState[] = ['available', 'pending', 'expired', 'used', 'voided'];
export const COUPON_STATE_TONES = { available: 'pine', pending: 'lake', expired: 'ember', used: 'neutral', voided: 'clay' } as const satisfies Record<CouponState, string>;
export const COUPON_KIND_TONES = { cash: 'yuzu', discount: 'lake', exchange: 'moss' } as const satisfies Record<CouponKind, string>;

/** 券的有效期：「2026-11-02 至 2026-12-01」，只有一天时「仅 2026-11-02」 */
export const couponRangeText = (from: string, to: string) => (from === to ? `仅 ${from}` : `${from} 至 ${to}`);

/** 模板的有效期：「有效期 2026-11-01 至 2026-12-31」，或「发券后 30 天有效」（发券当天算第 1 天） */
export const templateValidityText = (t: Pick<CouponTemplate, 'validity' | 'validFrom' | 'validTo' | 'validDays'>) =>
  t.validity === 'fixed' ? `有效期 ${couponRangeText(t.validFrom ?? '', t.validTo ?? '')}` : `发券后 ${t.validDays ?? 0} 天有效`;

/** 固定有效期已过（按营业日）：这个模板发不出券 */
export const templateExpired = (t: Pick<CouponTemplate, 'validity' | 'validTo'>, today: string) => t.validity === 'fixed' && !!t.validTo && t.validTo < today;
