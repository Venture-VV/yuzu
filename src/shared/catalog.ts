// 消费项目的多档价格与属性（店主 2026-10-27 #8）。前后端共用。
//
// 同一项目可设「标准 / 专业 / 优选」多档价格，某一档不提供时不设；力道、精油、热疗、「超人气」是项目属性，不影响计价。
// 不带档位的请求（升级前留下的待确认请求、旧页面）按默认档计价：标准 → 专业 → 优选中第一个提供的。

export const PRICE_TIERS = ['standard', 'professional', 'premium'] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];
export const PRICE_TIER_LABELS: Record<PriceTier, string> = { standard: '标准', professional: '专业', premium: '优选' };

export const STRENGTHS = ['light', 'medium', 'strong'] as const;
export type Strength = (typeof STRENGTHS)[number];
export const STRENGTH_LABELS: Record<Strength, string> = { light: '轻柔', medium: '适中', strong: '强劲' };

export interface TierPrice {
  tier: PriceTier;
  price: number;
}

/** 默认档：标准 → 专业 → 优选中第一个提供的 */
export function defaultTier(prices: readonly TierPrice[]): PriceTier | null {
  for (const t of PRICE_TIERS) if (prices.some((p) => p.tier === t)) return t;
  return null;
}

export function tierPrice(prices: readonly TierPrice[], tier: PriceTier): number | null {
  return prices.find((p) => p.tier === tier)?.price ?? null;
}

/** 按「标准、专业、优选」排序 */
export function sortTiers<T extends { tier: PriceTier }>(prices: readonly T[]): T[] {
  return [...prices].sort((a, b) => PRICE_TIERS.indexOf(a.tier) - PRICE_TIERS.indexOf(b.tier));
}

/** 明细名称（随明细留存）：多档项目带上档位，例如「日式指压（专业）」；只有一档的项目只写名称 */
export function lineName(name: string, prices: readonly TierPrice[], tier: PriceTier): string {
  return prices.length > 1 ? `${name}（${PRICE_TIER_LABELS[tier]}）` : name;
}

/** 项目属性的简短标签，例如「力道适中」「精油」「热疗」「超人气」 */
export function itemTags(item: { strength: Strength | null; essentialOil: boolean; heatTherapy: boolean; popular: boolean }): string[] {
  return [
    ...(item.strength ? [`力道${STRENGTH_LABELS[item.strength]}`] : []),
    ...(item.essentialOil ? ['精油'] : []),
    ...(item.heatTherapy ? ['热疗'] : []),
    ...(item.popular ? ['超人气'] : []),
  ];
}
