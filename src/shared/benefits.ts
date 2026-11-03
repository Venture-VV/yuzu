// 会员体系 v2 第二期（v0.7.24，docs/BENEFITS.md）：本店权益清单、谁能用、每期几张 / 几次。前后端共用。
// 档阶按 19 个状态排序（L0 < L1·初 < L1·享 < L1·尊 < L2·初 … < L6·尊），会员现在的状态不低于配置起点就能用；
// 同一项在不同档阶数量不同时按会员现在的档阶取那一行，不相加（PENDING_DECISIONS M30）。日期是营业日 YYYY-MM-DD。

import { shiftDate } from './labels';
import { TIER_LABELS, type Grade, type Tier } from './membership';

export const BENEFIT_CATEGORIES = ['coupon', 'event', 'service', 'discount', 'info'] as const;
export type BenefitCategory = (typeof BENEFIT_CATEGORIES)[number];
export const BENEFIT_CATEGORY_LABELS: Record<BenefitCategory, string> = {
  coupon: '券类',
  event: '事件礼',
  service: '服务与资格',
  discount: '折扣类',
  info: '制度说明',
};
/** 每类系统怎么做（后台、会员详情的说明） */
export const BENEFIT_CATEGORY_HINTS: Record<BenefitCategory, string> = {
  coupon: '每月（每年）第一天给够格的会员发本期的券，有效到本期最后一天；月中入会、升档、升阶当场补发差额',
  event: '首充、升档、升阶、保级、生日月、节日时自动发券，每项去重',
  service: '会员详情列在「本月可享」；设了次数的由服务的同事登记使用，到上限拒绝',
  discount: '第三期（v0.7.25）结账时自动算，这一期只在清单里',
  info: '只在清单里显示，不发放',
};

/** 周期：券类按月、按年发；服务类次数按天、月、年数，「不计次」只列出来 */
export const BENEFIT_PERIODS = ['none', 'day', 'month', 'year'] as const;
export type BenefitPeriod = (typeof BENEFIT_PERIODS)[number];
export const BENEFIT_PERIOD_LABELS: Record<BenefitPeriod, string> = { none: '不计次', day: '每天', month: '每月', year: '每年' };

/** 事件礼的触发事件 */
export const BENEFIT_EVENTS = ['first_recharge', 'grade_up', 'tier_up', 'retain', 'birthday', 'festival'] as const;
export type BenefitEvent = (typeof BENEFIT_EVENTS)[number];
export const BENEFIT_EVENT_LABELS: Record<BenefitEvent, string> = {
  first_recharge: '首笔充值',
  grade_up: '升档',
  tier_up: '升阶',
  retain: '保级',
  birthday: '生日月',
  festival: '节日',
};

export const BENEFIT_STATUSES = ['draft', 'published', 'paused'] as const;
export type BenefitStatus = (typeof BENEFIT_STATUSES)[number];
export const BENEFIT_STATUS_LABELS: Record<BenefitStatus, string> = { draft: '草稿', published: '已发布', paused: '暂缓' };

/** 发放记录的原因：每期发放、当场补发、事件礼 */
export const BENEFIT_GRANT_REASONS = ['monthly', 'top_up', 'event'] as const;
export type BenefitGrantReason = (typeof BENEFIT_GRANT_REASONS)[number];
export const BENEFIT_GRANT_REASON_LABELS: Record<BenefitGrantReason, string> = { monthly: '每期发放', top_up: '当场补发', event: '事件礼' };

/** 券类、事件礼每期（每次）最多几张（与手动发券一样）；服务类每期最多几次 */
export const MAX_BENEFIT_COUPONS = 10;
export const MAX_BENEFIT_LIMIT = 99;
/** 节日关怀最多设几个日期；节日当天起几天内补发（应用停机时不漏） */
export const MAX_FESTIVAL_DATES = 12;
export const FESTIVAL_WINDOW_DAYS = 7;

// ───────────────────────── 档阶顺序与数量 ─────────────────────────

/** 19 个状态的顺序：L0 = 0，L1·初 = 1 … L6·尊 = 18 */
export const stateRank = (grade: number, tier: number | null): number => (grade <= 0 ? 0 : 1 + (grade - 1) * 3 + (tier ?? 0));

/** 配置起点「L2·初」；L0 是「L0·会员」（所有会员）；没配置是「未配置」 */
export function startLabel(grade: number | null, tier: number | null): string {
  if (grade === null) return '未配置';
  if (grade === 0) return 'L0·会员';
  return `L${grade}·${TIER_LABELS[(tier ?? 0) as Tier]}`;
}

/** 某个档阶在不同档阶的数量：从这个状态起（含更高的）是 quantity */
export interface TierQuantity {
  grade: Grade;
  tier: Tier | null;
  quantity: number;
}

export interface BenefitTerms {
  startGrade: number | null;
  startTier: number | null;
  quantity: number | null;
  tierQuantities: TierQuantity[];
}

/** 会员现在的档阶不低于配置起点（没配置起点的谁也不能用） */
export function benefitEligible(b: Pick<BenefitTerms, 'startGrade' | 'startTier'>, grade: number, tier: number | null): boolean {
  if (b.startGrade === null) return false;
  return stateRank(grade, tier) >= stateRank(b.startGrade, b.startTier);
}

/**
 * 这位会员这一项的数量：各档阶数量里不高于会员现在档阶的最高一行，没有就是基本数量（不相加，M30）。
 * 券类、事件礼是张数；服务类是每期上限（空 = 不限次）
 */
export function benefitQuantity(b: Pick<BenefitTerms, 'quantity' | 'tierQuantities'>, grade: number, tier: number | null): number | null {
  const rank = stateRank(grade, tier);
  let best: TierQuantity | null = null;
  for (const t of b.tierQuantities) {
    const r = stateRank(t.grade, t.tier);
    if (r <= rank && (best === null || r > stateRank(best.grade, best.tier))) best = t;
  }
  return best ? best.quantity : b.quantity;
}

/** 这一期的键：每月「2026-11」、每年「2026」、每天「2026-11-03」；不计次为空 */
export function periodKey(period: BenefitPeriod, date: string): string | null {
  if (period === 'month') return date.slice(0, 7);
  if (period === 'year') return date.slice(0, 4);
  if (period === 'day') return date;
  return null;
}

/** 这一期的最后一天（券类的有效期到这天） */
export function periodEnd(period: 'day' | 'month' | 'year', date: string): string {
  if (period === 'day') return date;
  if (period === 'year') return `${date.slice(0, 4)}-12-31`;
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return shiftDate(next, -1);
}

/** 「每月 1 张」「每年 2 张」「每次 1 张」「每月 10 次」「不限次」 */
export function quantityText(category: BenefitCategory, period: BenefitPeriod, quantity: number | null): string {
  if (category === 'coupon') return quantity === null ? '—' : `${BENEFIT_PERIOD_LABELS[period]} ${quantity} 张`;
  if (category === 'event') return quantity === null ? '—' : `每次 ${quantity} 张`;
  if (category === 'service') return period === 'none' || quantity === null ? '不限次' : `${BENEFIT_PERIOD_LABELS[period]} ${quantity} 次`;
  return '—';
}

// ───────────────────────── 本店权益清单（导入用） ─────────────────────────

interface CatalogEntry {
  code: string;
  name: string;
  /** 会员文档的配置起点原文：「L2·初」「L0·会员」「未配置；待公布」 */
  start: string;
  content: string;
  conditions: string;
  category: BenefitCategory;
  period: BenefitPeriod;
  quantity: number | null;
  events: BenefitEvent[];
  status: 'draft' | 'paused';
}

/** 「L2·初」→ { grade: 2, tier: 0 }；「L0·会员」→ { grade: 0, tier: null }；其余（未配置）→ null */
export function parseStart(text: string): { grade: Grade; tier: Tier | null } | null {
  const m = /^L([0-6])\s*[·・.]\s*(初|享|尊|会员)$/.exec(text.trim());
  if (!m) return null;
  const grade = Number(m[1]) as Grade;
  if (grade === 0) return m[2] === '会员' ? { grade: 0, tier: null } : null;
  const tier = TIER_LABELS.indexOf(m[2] as (typeof TIER_LABELS)[number]);
  return tier < 0 ? null : { grade, tier: tier as Tier };
}

const service = (code: string, name: string, start: string, content: string, conditions: string, status: 'draft' | 'paused' = 'draft'): CatalogEntry => ({
  code, name, start, content, conditions, category: 'service', period: 'none', quantity: null, events: [], status,
});
const monthlyCoupon = (code: string, name: string, start: string, content: string, conditions: string, period: 'month' | 'year' = 'month', status: 'draft' | 'paused' = 'draft'): CatalogEntry => ({
  code, name, start, content, conditions, category: 'coupon', period, quantity: 1, events: [], status,
});
const eventGift = (code: string, name: string, start: string, content: string, conditions: string, events: BenefitEvent[]): CatalogEntry => ({
  code, name, start, content, conditions, category: 'event', period: 'none', quantity: 1, events, status: 'draft',
});
const listed = (category: 'discount' | 'info', code: string, name: string, start: string, content: string, conditions: string): CatalogEntry => ({
  code, name, start, content, conditions, category, period: 'none', quantity: null, events: [], status: 'draft',
});

/**
 * 会员文档（2026-11-02）附录三 A「汤崎洗浴与会员服务」57 项与 F 补充 2 项，编号、名称、配置起点、内容与使用条件按原文。
 * 归类与默认数量按 PENDING_DECISIONS M27–M29（待确认，后台可改）；导入后全部是草稿，文档写明暂缓的 4 项导入为暂缓
 */
export const BENEFIT_CATALOG: readonly CatalogEntry[] = [
  service('QY-001', '会员专属通道', 'L2·初', '入场、领手牌及结账会员专属通道。', '实际开放和适用节点待明确。'),
  service('QY-002', '高峰优先入场', 'L3·初', '高峰、节假日优先入场。', '按会员档位及现场可用资源，具体规则待公布。'),
  service('QY-003', '免预约入场', 'L2·初', '入场及部分服务优先排号。', '包房、技师等仍受资源限制，不能推定所有项目免预约。'),
  service('QY-004', '浴票延迟', 'L1·尊', '浴票延迟：初阶30分钟、享阶1小时、尊阶1.5—2小时。', '档位与延迟梯度需最终确认；不能使用福田8小时规则替代。'),
  monthlyCoupon('QY-005', '免费浴资次数', 'L1·初', '年度免费浴资券。', '各档张数、券种、是否含餐及期限待明确。', 'year'),
  service('QY-006', '通用VIP柜（VIP更衣区）', 'L3·初', '通用VIP更衣柜及配套更衣、淋浴、梳妆使用权。', '已决策3万元起；高峰排队，不预约。'),
  service('QY-007', 'VIP固定专属专柜', 'L6·初', '固定编号专属柜及姓名牌。', '资料存在10万元可申请与30万元L6专属冲突；限量，门槛和期限待确认。'),
  service('QY-008', '携友进VIP区', 'L4·初', '会员可携朋友进入VIP更衣区。', '已决策5万元起；同行人数待明确，不能套用同行折扣人数。'),
  service('QY-009', 'VIP专属浴服', 'L4·初', 'VIP专属版型浴服。', '款式、领用次数和适用场景待明确。'),
  service('QY-010', '一次性浴衣拖鞋', 'L2·初', '设计款一次性浴衣、拖鞋。', '须与所有客人基础用品区分；使用次数待明确。'),
  listed('discount', 'QY-011', '派对房及包房折扣', 'L3·初', '包房房费折扣：3万7.5折、5万6.5折、10万5.5折、30万5折。', '不含开台费及其他消费；派对房仅周一至周四。'),
  service('QY-012', '宠物友好轰趴SKU', 'L3·尊', '宠物友好轰趴体验候选。', '独立项目；是否纳入权益及适用条件待明确。'),
  service('QY-013', '房型升级', 'L4·初', '消费客房时免费房型升级。', '视房态；适用房型和日期待明确。'),
  service('QY-014', '客房赠送', 'L4·初', '高卡赠送客房房晚。', '仅周一至周四，节假日禁用；按房态，次日14:00退房；次数待定。'),
  service('QY-015', '专属车位（10个）', 'L5·初', '专属停车位使用资格。', '已决策10万元起，车位有限；不保证随到随有，预留规则待明确。'),
  listed('discount', 'QY-016', '停车折扣', 'L0·会员', '停车优惠。', '其他档位按档优惠；折扣、时长及停车场待明确。'),
  service('QY-017', '欢迎饮品', 'L1·初', '每次到店咖啡、特调或手作糖水1份。', '首份免费，后续付费；可选品类待公布。'),
  service('QY-018', '限定甜品', 'L2·享', '每次入场限定甜品1份。', '具体品类和领取规则待公布。'),
  monthlyCoupon('QY-019', '月度餐饮券', 'L2·初', '月度餐饮消费券。', '面额按档配置，适用餐次和期限待明确。'),
  eventGift('QY-020', '生日餐饮礼遇', 'L1·初', '生日月蛋糕、长寿面及餐饮券。', '实名生日，券面额度和领取规则待明确。', ['birthday']),
  service('QY-021', '餐饮包房私宴', 'L4·享', '高卡私宴、家宴，含每年1次12人内家宴的规划。', '餐标、低消、是否含房费及最终次数待明确，不承诺免费全包。'),
  service('QY-022', '主厨餐桌预约权', 'L5·初', '名厨驻场餐桌预约资格。', '视活动和名额；不等同免费用餐。'),
  service('QY-023', '新菜单优先品鉴', 'L3·尊', '新菜单、新酒单优先品鉴资格。', '按新品活动节奏开放。'),
  service('QY-024', '线上专属客服', 'L2·初', '线上专属客服。', '旧库为工作日在线，最终服务时间待公布。'),
  service('QY-025', '一对一管家', 'L3·初', '基础管家服务，5万元起提供专属管家。', '用户已确认宝安3万元基础、5万元专属；具体服务范围及时段待公布。'),
  service('QY-026', '升级技师', 'L2·享', '免费升级高级技师。', '视排班及适用项目；配置与资源库建议档位不同，待定稿。'),
  service('QY-027', '免收服务费', 'L3·享', '包房、按摩服务费减免。', '适用费种、项目及档阶待明确。'),
  service('QY-028', '代客泊车', 'L3·初', '到店代客泊车及取车。', '已决策3万元起规划资格；正式开通前不能作为可用权益。'),
  service('QY-029', '衣物护理', 'L4·享', '擦鞋、西装护理或浴衣熨烫。', '件数、次数及可护理衣物范围待明确。'),
  service('QY-030', '投诉绿色通道', 'L3·初', '投诉优先受理通道。', '旧库记录2小时响应；正式服务承诺待核，不等同2小时必解决。'),
  service('QY-031', '高阶反馈通道（原名：高管直通车）', 'L6·初', '高阶会员专属反馈与交流通道。', '按公布安排，频次及形式待明确。'),
  monthlyCoupon('QY-032', '电竞区免费时长', 'L1·享', '电竞免费时长或娱乐券。', '具体时长、频次及适用设备待配置，按正常使用规则。'),
  monthlyCoupon('QY-033', 'PS5免费台时', 'L1·享', 'PS5/Switch免费台时。', '按台时核销，1台=1人；与散客同样排队，不优先预约。'),
  monthlyCoupon('QY-034', '棋牌房免费时长', 'L2·尊', '棋牌房免费时长。', '按月规划，具体时长待定；超时自付，适用房型待明确。'),
  service('QY-035', '娱乐设施免费（福田）', '未配置；待公布', '福田娱乐设施优惠候选。', '原库暂缓、属于福田；不作为宝安已开放权益，也不代表宝安全部娱乐免费。', 'paused'),
  monthlyCoupon('QY-036', '助浴/搓澡项目券', 'L1·尊', '助浴/搓澡项目券。', '项目、次数和期限待定，按项目预约及使用规则。'),
  monthlyCoupon('QY-037', '护发项目券', 'L2·尊', '护发护理项目券。', '项目、次数和期限待定，按项目预约及使用规则。'),
  monthlyCoupon('QY-038', 'SPA项目券', 'L3·享', 'SPA项目券或技师礼遇。', '具体项目、次数、时长和加价项待明确。'),
  monthlyCoupon('QY-039', '头疗项目券', 'L2·尊', '头疗项目券。', '具体项目、次数、时长和使用期限待明确。'),
  monthlyCoupon('QY-040', '按摩/足浴项目券', 'L2·初', '按摩、足浴项目券。', '按正常项目规则；具体项目、次数及包房费用待明确。'),
  listed('discount', 'QY-041', '同行优惠', 'L3·初', '高档可带1人、最高档可带2人享同行礼遇的规划。', '具体适用档位及权益范围待确认，不照搬福田同行88折。'),
  service('QY-042', '会籍赠送', 'L3·尊', '赠记名低一档体验会籍。', '单次1个月，仅权益、无升级礼；期内充值达门槛转正，未达即到期失效。'),
  service('QY-043', '会员专属活动', 'L4·初', '品鉴会、沙龙、节日活动邀约。', '按活动排期、资格和名额开放。'),
  service('QY-044', 'VVIP年度晚宴', 'L5·初', '年度答谢晚宴与品牌活动。', '按年度活动安排和名额，不承诺不限次参与。'),
  service('QY-045', '设计共创/内测官', 'L5·享', '新店、新空间、新菜单内测体验资格。', '按项目邀请及名额开放。'),
  service('QY-046', '实体卡定制', 'L5·初', '会员卡面定制与编号选号。', '制作次数、款式及可选号码待明确。'),
  service('QY-047', '代订服务', 'L5·初', '餐厅、演唱会或稀缺商品代订服务。', '服务范围待明确；不保证订到，也不等于门票或商品免费。'),
  service('QY-048', '异业会籍匹配（海雅）', '未配置；待公布', '异业会籍匹配候选。', '暂缓，尚不能承诺海雅或银行会籍互认。', 'paused'),
  service('QY-049', '机场/高铁贵宾厅', 'L3·初', '机场/高铁贵宾厅礼遇。', '城市、服务商、本人/同行范围和各档次数待明确。'),
  monthlyCoupon('QY-050', '免费洗车', 'L4·尊', '洗车券候选。', '暂缓；服务点、次数及恢复开放时间待确认。', 'month', 'paused'),
  eventGift('QY-051', '首充礼', 'L0·会员', '首次充值按档发放礼遇。', '一次性首充事件触发，非免费注册即得；具体内容待配置。', ['first_recharge']),
  eventGift('QY-052', '升级礼', 'L0·会员', '升档或升阶礼遇券包。', '按有效升级事件触发，非注册即得或每月自动发。', ['grade_up', 'tier_up']),
  eventGift('QY-053', '保级礼', 'L0·会员', '保级成功礼遇券包或实物。', '按保级事件触发，非注册即得或每月自动发；内容待定。', ['retain']),
  listed('discount', 'QY-054', '会员日', 'L1·初', '会员日券核销活动。', '旧宝安库为每月8日，无积分；最终活动日期及内容待公布。'),
  eventGift('QY-055', '节日关怀', 'L1·初', '节日礼赠与生日关怀。', '按公布节日和会员档位，不承诺每月必发。', ['festival']),
  listed('info', 'QY-056', '跨店余额通用', 'L0·会员', '福田、宝安会员资金通用。', '制度规则而非券类权益；统一等级与资金，具体权益按到店门店清单。'),
  service('QY-057', '会员挑战活动', 'L0·会员', '限时会员挑战活动候选。', '暂缓，待单独公布活动；非注册即得，不照搬福田月到店4次活动。', 'paused'),
  service('CUS-1790670435981', '专属锁牌号', 'L4·初', '专属锁牌号使用资格。', '号码范围、保留期限和可用规则待明确。'),
  service('P021', '行李优先寄存', '未配置；待公布', '会员行李优先寄存。', '物理资源表记录为会员便利服务，不预约；具体适用资格待公布。'),
];

// ───────────────────────── 接口的数据 ─────────────────────────

/** 后台「会员权益」的一项 */
export interface Benefit {
  id: number;
  code: string;
  name: string;
  category: BenefitCategory;
  startGrade: Grade | null;
  startTier: Tier | null;
  startLabel: string;
  period: BenefitPeriod;
  /** 券类：每期张数；事件礼：每次张数；服务类：每期上限（空 = 不限次） */
  quantity: number | null;
  tierQuantities: TierQuantity[];
  templateId: number | null;
  templateName: string | null;
  templateActive: boolean | null;
  templateSummary: string | null;
  events: BenefitEvent[];
  /** 节日关怀的日期（YYYY-MM-DD，农历节日每年由店主填当年的日期） */
  festivalDates: string[];
  content: string;
  conditions: string;
  status: BenefitStatus;
  version: number;
  updatedAt: string;
  updatedByName: string | null;
  publishedAt: string | null;
  /** 本月发了几张券、发给几位会员、登记了几次使用 */
  month: { coupons: number; members: number; uses: number };
}

export interface BenefitJobRun {
  businessDate: string;
  startedAt: string;
  finishedAt: string | null;
  /** 这次发了券的会员人数、张数 */
  processed: number;
  coupons: number;
  error: string | null;
}

/** 后台「会员权益」整页 */
export interface BenefitCatalog {
  today: string;
  month: { from: string; to: string };
  items: Benefit[];
  /** 本店权益清单里还没导入的项数 */
  importable: number;
  /** 需要店主注意的：发券规则里还有启用的升级礼、生日礼（会各发一份）；已发布的项用的券模板停用了、过期了…… */
  warnings: string[];
  /** 可选的券模板（启用的、没过期的） */
  templates: { id: number; name: string; summary: string; validity: string }[];
  /** 最近一次自动发放 */
  job: BenefitJobRun | null;
}

/** 会员详情「本月可享」的一项 */
export interface MemberBenefitItem {
  benefitId: number;
  code: string;
  name: string;
  category: BenefitCategory;
  period: BenefitPeriod;
  startLabel: string;
  content: string;
  conditions: string;
  /** 券类：本期应得张数；事件礼：每次几张；服务类：本期上限（空 = 不限次） */
  quantity: number | null;
  /** 这一期（券类、服务类有次数时） */
  periodKey: string | null;
  /** 券类：本期已发张数；事件礼：累计收到几次 */
  granted: number;
  /** 这一项发的券里现在能用的张数 */
  available: number;
  /** 服务类：本期已登记次数 */
  used: number;
  lastGrantDate: string | null;
  templateName: string | null;
  events: BenefitEvent[];
}

export interface BenefitGrantRow {
  id: number;
  benefitId: number;
  benefitCode: string;
  benefitName: string;
  reason: BenefitGrantReason;
  periodKey: string | null;
  eventKey: string | null;
  quantity: number;
  issueNo: string;
  businessDate: string;
  createdAt: string;
}

export interface BenefitUseRow {
  id: number;
  benefitId: number;
  benefitCode: string;
  benefitName: string;
  quantity: number;
  periodKey: string | null;
  limitAt: number | null;
  note: string;
  staffId: number;
  staffName: string;
  businessDate: string;
  createdAt: string;
  status: 'active' | 'voided';
  voidReason: string | null;
  voidedByName: string | null;
}

export interface MemberBenefits {
  memberId: number;
  today: string;
  month: string;
  state: { grade: Grade; tier: Tier | null; label: string };
  /** 现在能用的（已发布的券类、事件礼、服务类、制度说明） */
  items: MemberBenefitItem[];
  /** 已发布、还没够格的（升档以后能享），按起点从低到高，最多 8 项 */
  upcoming: { benefitId: number; code: string; name: string; category: BenefitCategory; startLabel: string }[];
  /** 最近的发放记录、使用登记（各 30 条） */
  grants: BenefitGrantRow[];
  uses: BenefitUseRow[];
}

/** 看板「会员体系」：本月权益发放与使用 */
export interface BenefitSummary {
  from: string;
  to: string;
  published: number;
  coupons: number;
  members: number;
  byReason: Record<BenefitGrantReason, number>;
  uses: number;
  useMembers: number;
  rows: { benefitId: number; code: string; name: string; category: BenefitCategory; coupons: number; members: number; uses: number }[];
  job: BenefitJobRun | null;
}
