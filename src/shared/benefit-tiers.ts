// 会员权益按档阶分级（8.0.4，需求表 01，docs/MEMBERSHIP_V804.md 第 1 节）：L0–L6 × 初 / 享 / 尊，每一阶分「券」与「福利」。
// 前后端共用的纯计算：服务端把权益清单、券模板、发券规则交进来，排好每一阶的内容。
//
//   · 权益清单：起点不高于这一阶的都在（数量按这一阶取，与会员详情「本月可享」同一算法）；起点就在这一阶、
//     或数量在这一阶变了的标「本阶起享」，其余是从低档阶带上来的；
//   · 发券规则（券与会员权益）：开卡礼 → L0；升级礼 → 升到的那一档·初阶；生日礼 → 那一档的三阶（初阶起享）；
//     充值赠券 → 套餐金额够得上的那一档·初阶；只放在这些位置，不往更高的档阶带；
//   · 其余券模板（只用于手动、批量、领券中心、无记名券的）：限定了档级的放最低那一档·初阶，不限的放 L0——
//     每一张券都有档阶，没有「未分级」（需求表 01 的验收要点）；
//   · 排序：券按面值从高到低（没有面值的排后面），福利按类别、编号（HY17）。

import {
  benefitQuantity,
  companionText,
  isCompanionTarget,
  minutesText,
  quantityText,
  rateText,
  startLabel,
  stateRank,
  BENEFIT_CATEGORIES,
  BENEFIT_EVENT_LABELS,
  type Benefit,
  type BenefitCategory,
  type BenefitStatus,
} from './benefits';
import type { CouponRuleKind } from './coupons';
import { GRADE_STATES, gradeForAmount, TIER_LABELS, type Grade, type MembershipRules, type Tier } from './membership';

/** 券模板（算面值用）：代金券的面额；兑换券、买一赠一按「最多抵」，没设按项目单价；折扣券按「最多减」，没设为空 */
export interface TierTemplate {
  id: number;
  name: string;
  summary: string;
  faceValue: number | null;
  levels: number[];
  active: boolean;
}

export interface TierRule {
  id: number;
  kind: CouponRuleKind;
  level: number | null;
  templateId: number;
  quantity: number;
  planName: string | null;
  planAmount: number | null;
}

export type TierEntrySource = 'benefit' | 'rule' | 'template';

export interface TierEntry {
  /** 'b12'（权益）、'r3'（发券规则）、't5'（券模板） */
  key: string;
  source: TierEntrySource;
  /** 权益编号（QY-019）；规则、模板为空 */
  code: string | null;
  name: string;
  /** 权益的类别；规则、模板为空 */
  category: BenefitCategory | null;
  /** 这一阶的数量：「每月 1 张」「每次 2 张」「6.5 折」「不限次」 */
  quantityText: string;
  /** 券：一句话说明（模板的条件）；福利为空 */
  couponSummary: string | null;
  couponName: string | null;
  /** 排序用的面值（分）；没有为空 */
  faceValue: number | null;
  /** 权益的状态（草稿、已发布、暂缓）；规则都是启用的；模板：启用 / 停用 */
  status: BenefitStatus | 'active' | 'inactive';
  /** 起点就在这一阶，或数量在这一阶变了 */
  fresh: boolean;
  /** 补充说明：「升档时发」「手动、批量、领券中心发的券」「按充值套餐「1 万元」」 */
  note: string | null;
  benefitId: number | null;
  templateId: number | null;
}

export interface TierStage {
  /** L0 为空 */
  tier: Tier | null;
  /** 「L2·享」「L0·会员」 */
  label: string;
  rank: number;
  coupons: TierEntry[];
  perks: TierEntry[];
}

export interface TierGrade {
  grade: Grade;
  name: string;
  /** 「L2 潭影」 */
  label: string;
  thresholdCents: number;
  stages: TierStage[];
}

export interface BenefitTiers {
  grades: TierGrade[];
  /** 还没设起点的权益（设好起点才出现在档阶里，也才能发布） */
  unplaced: { benefitId: number; code: string; name: string; category: BenefitCategory; status: BenefitStatus }[];
  /** 券模板总数与已经放进档阶的张数（应当相等：没有「未分级」） */
  templates: { total: number; placed: number };
}

const isCouponCategory = (c: BenefitCategory) => c === 'coupon' || c === 'event';
const PERK_ORDER: BenefitCategory[] = BENEFIT_CATEGORIES.filter((c) => !isCouponCategory(c));

/** 这一项权益在这一阶的数量说明 */
function benefitText(b: Benefit, grade: number, tier: number | null): string {
  if (b.parking) {
    const hours = benefitQuantity({ quantity: b.parkingHours, tierQuantities: b.parkingHoursByTier }, grade, tier);
    return hours === null ? '还没填免费几小时' : `每天 1 次 · 免 ${hours} 小时`;
  }
  const q = benefitQuantity(b, grade, tier);
  if (b.category === 'discount') {
    const rate = q === null ? '未填折扣' : rateText(q);
    if (b.discountTarget && isCompanionTarget(b.discountTarget)) {
      const n = benefitQuantity({ quantity: b.companionCount, tierQuantities: b.companionCounts }, grade, tier);
      return `${rate} · ${n === null ? companionText(b) : `带 ${n} 位`}`;
    }
    return rate;
  }
  if (b.category === 'extension') return q === null ? '未填分钟数' : `多 ${minutesText(q)}不跳档`;
  if (b.category === 'event') {
    const when = b.events.map((e) => (e === 'monthly_visits' ? `每月到店满 ${b.visitTarget ?? '?'} 次` : BENEFIT_EVENT_LABELS[e])).join('、');
    return `${when || '事件'}时 · ${quantityText('event', b.period, q)}`;
  }
  return quantityText(b.category, b.period, q);
}

/** 这一阶的数量是不是在这里变的（各档阶表里正好有这一阶的一行） */
function changesAt(b: Benefit, grade: number, tier: number | null): boolean {
  const rank = stateRank(grade, tier);
  const rows = [...b.tierQuantities, ...b.companionCounts, ...b.parkingHoursByTier];
  return rows.some((r) => stateRank(r.grade, r.tier) === rank);
}

const byFace = (a: TierEntry, b: TierEntry) =>
  (b.faceValue ?? -1) - (a.faceValue ?? -1) || (a.code ?? '￿').localeCompare(b.code ?? '￿') || a.name.localeCompare(b.name, 'zh') || a.key.localeCompare(b.key);
const byPerk = (a: TierEntry, b: TierEntry) =>
  PERK_ORDER.indexOf(a.category ?? 'info') - PERK_ORDER.indexOf(b.category ?? 'info') || (a.code ?? '').localeCompare(b.code ?? '') || a.key.localeCompare(b.key);

const RULE_NAMES: Record<CouponRuleKind, string> = { open_card: '开卡礼', level_up: '升级礼', birthday: '生日礼', recharge: '充值赠券' };

export function buildBenefitTiers(input: {
  rules: Pick<MembershipRules, 'grades'>;
  benefits: readonly Benefit[];
  templates: readonly TierTemplate[];
  couponRules: readonly TierRule[];
}): BenefitTiers {
  const templates = new Map(input.templates.map((t) => [t.id, t]));
  // 已经随权益、发券规则放进某一阶的券模板（第 3 步不再单放）。只在真的放进去时记：还没设起点的草稿权益、
  // 没放进任何一阶的规则挂着的模板，照样在第 3 步按限定的档级单放，不会哪一阶都看不到（Codex 自动审查 e726bc0）
  const used = new Set<number>();

  // 每个档阶（19 个，按 rank）要放的条目
  const at = new Map<number, TierEntry[]>(GRADE_STATES.map((s) => [stateRank(s.grade, s.tier), []]));
  const put = (rank: number, e: TierEntry) => {
    at.get(rank)!.push(e);
    if (e.templateId !== null) used.add(e.templateId);
  };
  const couponOf = (templateId: number | null) => (templateId === null ? undefined : templates.get(templateId));

  // 1. 权益清单：起点不高于这一阶的都在
  for (const b of input.benefits) {
    if (b.startGrade === null) continue;
    const startRank = stateRank(b.startGrade, b.startTier);
    const coupon = isCouponCategory(b.category);
    const t = couponOf(b.templateId);
    for (const s of GRADE_STATES) {
      const rank = stateRank(s.grade, s.tier);
      if (rank < startRank) continue;
      put(rank, {
        key: `b${b.id}`,
        source: 'benefit',
        code: b.code,
        name: b.name,
        category: b.category,
        quantityText: benefitText(b, s.grade, s.tier),
        couponSummary: coupon ? (t?.summary ?? null) : null,
        couponName: coupon ? (t?.name ?? null) : null,
        faceValue: coupon ? (t?.faceValue ?? null) : null,
        status: b.status,
        fresh: rank === startRank || changesAt(b, s.grade, s.tier),
        note: coupon && !t ? '还没选券' : null,
        benefitId: b.id,
        templateId: b.templateId,
      });
    }
  }

  // 2. 发券规则：只放在发的那一阶（生日礼放在那一档的三阶）
  const ruleEntry = (r: TierRule, fresh: boolean, note: string): TierEntry => {
    const t = couponOf(r.templateId);
    return {
      key: `r${r.id}`,
      source: 'rule',
      code: null,
      name: RULE_NAMES[r.kind] + (r.kind === 'level_up' ? `（升到 L${r.level}）` : r.kind === 'birthday' ? `（L${r.level}）` : ''),
      category: null,
      quantityText: `每次 ${r.quantity} 张`,
      couponSummary: t?.summary ?? null,
      couponName: t?.name ?? null,
      faceValue: t?.faceValue ?? null,
      status: 'active',
      fresh,
      note,
      benefitId: null,
      templateId: r.templateId,
    };
  };
  for (const r of input.couponRules) {
    if (r.kind === 'open_card') put(0, ruleEntry(r, true, '新会员建档时发'));
    else if (r.kind === 'level_up' && r.level) put(stateRank(r.level, 0), ruleEntry(r, true, '升到这一档时发'));
    else if (r.kind === 'birthday' && r.level !== null) {
      if (r.level === 0) put(0, ruleEntry(r, true, '生日前到账（按当时的档级）'));
      else for (const tier of [0, 1, 2] as Tier[]) put(stateRank(r.level, tier), ruleEntry(r, tier === 0, '生日前到账（按当时的档级）'));
    } else if (r.kind === 'recharge') {
      const g = gradeForAmount(input.rules as MembershipRules, r.planAmount ?? 0);
      put(g === 0 ? 0 : stateRank(g, 0), ruleEntry(r, true, `按充值套餐「${r.planName ?? ''}」，用这个套餐充值时发`));
    }
  }

  // 3. 其余券模板：限定了档级的放最低那一档·初阶，不限的放 L0
  for (const t of input.templates) {
    if (used.has(t.id)) continue;
    const low = t.levels.length ? Math.min(...t.levels) : 0;
    put(low === 0 ? 0 : stateRank(low, 0), {
      key: `t${t.id}`,
      source: 'template',
      code: null,
      name: t.name,
      category: null,
      quantityText: t.levels.length ? `限 ${t.levels.map((l) => `L${l}`).join('、')}` : '不限档级',
      couponSummary: t.summary,
      couponName: t.name,
      faceValue: t.faceValue,
      status: t.active ? 'active' : 'inactive',
      fresh: true,
      note: '手动、批量、领券中心、无记名券用的券',
      benefitId: null,
      templateId: t.id,
    });
  }
  // 真的出现在某一阶里的券模板（按条目数，不按「挂没挂在权益上」算）
  const placed = input.templates.filter((t) => used.has(t.id)).length;

  const grades: TierGrade[] = ([0, 1, 2, 3, 4, 5, 6] as Grade[]).map((grade) => {
    const rule = input.rules.grades[grade];
    const tiers: (Tier | null)[] = grade === 0 ? [null] : [0, 1, 2];
    return {
      grade,
      name: rule?.name ?? '',
      label: `L${grade} ${rule?.name ?? ''}`,
      thresholdCents: rule?.thresholdCents ?? 0,
      stages: tiers.map((tier) => {
        const rank = stateRank(grade, tier);
        const entries = at.get(rank)!;
        return {
          tier,
          label: grade === 0 ? startLabel(0, null) : `L${grade}·${TIER_LABELS[tier as Tier]}`,
          rank,
          coupons: entries.filter((e) => e.source !== 'benefit' || isCouponCategory(e.category!)).sort(byFace),
          perks: entries.filter((e) => e.source === 'benefit' && !isCouponCategory(e.category!)).sort(byPerk),
        };
      }),
    };
  });

  return {
    grades,
    unplaced: input.benefits
      .filter((b) => b.startGrade === null)
      .map((b) => ({ benefitId: b.id, code: b.code, name: b.name, category: b.category, status: b.status })),
    templates: { total: input.templates.length, placed },
  };
}
