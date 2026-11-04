// 前后端共用的接口数据结构。金额字段均为整数「分」。

import type { BusinessHours } from './business-date';
import type { PriceTier, Strength, TierPrice } from './catalog';
import type { CheckoutMethod, CouponPlatform } from './checkout';
import type { DeductionRule, WalletBalance } from './deduction';
import type { InstanceKind } from './instance';
import type { EntryType, PaymentMethod } from './labels';
import type { MemberCustomValues, MemberFieldDef } from './member-fields';
import type { BonusLotRow, MemberChannel } from './members';
import type { MemberGradeFields, MemberGradeInfo } from './membership';
import type { Duty, Permission, Role } from './permissions';

export type AppEnv = 'development' | 'trial' | 'production' | 'test';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export interface StaffBrief {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  duties: Duty[];
  mustChangePassword: boolean;
}

export interface StoreRules {
  deductionRule: DeductionRule;
  businessDayStartHour: number;
  /** 单笔充值上限（店主 #9 默认 50 万元）；超过需要店主或店总当场授权 */
  maxRechargeCents: number;
  /** 单笔消费上限（默认 50 万元）；超过需要店主或店总当场授权 */
  maxConsumeCents: number;
  /** 撤销与反结账时限（#10，2026-10-29 签认默认 48 小时）：消费 / 结账后多少小时内可以撤销、反结账，超过后只有店主可以；null 为不限 */
  reversalWindowHours: number | null;
  /** 充值、结账、反结账前必须先开班（2026-10-29 签认，默认开）；关闭后没开班的收款不属于任何班次 */
  requireOpenShift: boolean;
  /** 隐藏页面上的「待确认」标记（店主签认经营规则后打开，R1.3）；只影响显示，不改任何规则 */
  hidePendingMarks: boolean;
  /** 营业时间（#4，待确认）；null 为全天 24 小时营业。只用于显示与提醒 */
  businessHours: BusinessHours | null;
  /** 会员自定义字段（#12）；固定字段之外由店主配置 */
  memberFields: MemberFieldDef[];
  /** 自定义赠金（不按套餐）的有效期天数（#2）；null 为长期有效。套餐的有效期在套餐上设置 */
  customBonusValidDays: number | null;
  /** 会员渠道来源的可选项（v0.6.0，后台「会员与渠道」维护） */
  memberChannels: MemberChannel[];
}

export interface SessionInfo {
  staff: StaffBrief;
  permissions: Permission[];
  storeName: string;
  rules: StoreRules;
  /** 当前营业日 YYYY-MM-DD（会员业务，按营业日切换时间） */
  today: string;
  /** 门店时区的自然日（库存与采购按自然日） */
  calendarToday: string;
  timezone: string;
  env: AppEnv;
  version: string;
  /** 构建时写入的提交 SHA（可能为空） */
  commit: string;
  instance: InstanceKind;
  /** 库里存在合成演示数据 */
  hasSyntheticData: boolean;
  /** 技师功能已开启（v0.7.1：主导航的「钟房」只在开启后显示） */
  technicians: boolean;
  /** 餐饮功能已开启（主导航的「餐饮」只在开启后显示） */
  dining: boolean;
  /** 客房功能已开启（S7，v0.7.4：主导航的「客房」只在开启后显示） */
  rooms: boolean;
  /** ERP 里能用的模块（v0.7.3：店主的模块开关与依赖算好的结果） */
  erpModules: import('./erp').ErpModuleKey[];
}

export interface MemberSummary extends MemberGradeFields {
  id: number;
  memberNo: string;
  name: string;
  phone: string;
  gender: 'female' | 'male' | null;
  birthday: string | null;
  note: string;
  principalBalance: number;
  bonusBalance: number;
  status: 'active' | 'frozen';
  isSynthetic: boolean;
  createdAt: string;
  lastActivityAt: string | null;
  /** 自定义字段的值，键为字段编号（见 StoreRules.memberFields） */
  customFields: MemberCustomValues;
  /** 渠道来源的编号（见 StoreRules.memberChannels）；没登记为 null */
  channel: string | null;
  /** 已合并到的会员（v0.7.26）：这份档案停用、余额已转过去；没合并为 null */
  mergedIntoId: number | null;
}

export interface MemberDetail extends MemberSummary {
  createdByName: string | null;
  /** 会员体系 v2 的等级卡：档阶、周期消费与保级、下一档、状态变化记录（v0.7.23） */
  gradeInfo: MemberGradeInfo;
  /** 全部赠金批次（可用、已用完、已过期），最近的在前（v0.6.0） */
  bonusLotHistory: BonusLotRow[];
  /** 有剩余的赠金批次，先到期的在前（expiresAt 为 null 表示长期有效） */
  bonusLots: { remaining: number; expiresAt: string | null }[];
  /** 从旧系统导入的期初（有效的那一笔） */
  opening: { importNo: string; docNo: string; source: string; legacyNo: string; principal: number; bonus: number; legacyRecharged: number; importedAt: string } | null;
  /** 被合并到的会员（v0.7.26，M79）：这份档案停用，余额已转过去；没合并为空 */
  mergedInto: { id: number; memberNo: string; name: string } | null;
  stats: {
    totalPaid: number;
    totalBonusGranted: number;
    rechargeCount: number;
    totalConsumed: number;
    consumeCount: number;
    reversedCount: number;
  };
}

export interface RechargePlan {
  id: number;
  name: string;
  payAmount: number;
  bonusAmount: number;
  /** 赠金有效期（天）；null 为长期有效 */
  bonusValidDays: number | null;
  note: string;
  active: boolean;
  sortOrder: number;
}

export interface ServiceItem {
  id: number;
  name: string;
  category: string;
  /** 默认档价格（标准 → 专业 → 优选中第一个提供的）；不带档位的请求按它计价 */
  price: number;
  /** 各档价格，按标准、专业、优选排序；只提供一档时只有一项 */
  prices: TierPrice[];
  durationMinutes: number | null;
  /** 只限某一性别（如私汤木桶浴仅女宾）；null 为不限 */
  gender: 'male' | 'female' | null;
  strength: Strength | null;
  essentialOil: boolean;
  heatTherapy: boolean;
  popular: boolean;
  /** 需要技师（v0.7.0）：技师功能开启时，挂这个项目要选技师与点钟 / 轮钟 */
  technicianRequired: boolean;
  note: string;
  active: boolean;
  sortOrder: number;
}

export interface Catalog {
  plans: RechargePlan[];
  items: ServiceItem[];
}

export interface RechargeDoc {
  id: number;
  docNo: string;
  memberId: number;
  planId: number | null;
  planName: string | null;
  paidAmount: number;
  bonusAmount: number;
  paymentMethod: PaymentMethod;
  paymentRef: string;
  note: string;
  businessDate: string;
  operatorName: string;
  createdAt: string;
  /** 超过单笔上限时当场授权的店主或店总 */
  overLimitApproverName: string | null;
  /** 赠金到期时刻（那个营业日开始时作废）；没有赠金或长期有效时为 null */
  bonusExpiresAt: string | null;
  /** 渠道（v0.7.26）：前台 / 小程序线上充值（微信支付到账，不进交班） */
  channel: 'counter' | 'mp';
}

export interface ConsumptionLine {
  id: number;
  itemId: number | null;
  /** 所选价格档；手动输入金额的明细为 null */
  tier: PriceTier | null;
  name: string;
  unitPrice: number;
  quantity: number;
  amount: number;
}

export interface ReversalBrief {
  id: number;
  docNo: string;
  reason: string;
  businessDate: string;
  operatorName: string;
  createdAt: string;
}

export interface ConsumptionDoc {
  id: number;
  docNo: string;
  memberId: number;
  totalAmount: number;
  principalAmount: number;
  bonusAmount: number;
  deductionRule: DeductionRule;
  note: string;
  status: 'completed' | 'reversed';
  businessDate: string;
  operatorName: string;
  createdAt: string;
  /** 超过单笔上限时当场授权的店主或店总 */
  overLimitApproverName: string | null;
  lines: ConsumptionLine[];
  reversal: ReversalBrief | null;
  /** 前台结账用储值支付生成的消费单：只能随结账单一起反结账，不能在会员这里单独撤销 */
  checkout: { id: number; checkoutNo: string; status: 'completed' | 'voided' } | null;
}

export interface ReversalDoc {
  id: number;
  docNo: string;
  consumptionId: number;
  consumptionDocNo: string;
  memberId: number;
  principalAmount: number;
  bonusAmount: number;
  reason: string;
  businessDate: string;
  operatorName: string;
  createdAt: string;
  /** 恢复的赠金回到了已到期的批次、随即作废时的赠金过期单 */
  expiredBonus: { docNo: string; amount: number } | null;
}

interface OperationBase {
  /** true 表示这是一次重复提交，返回的是第一次已入账的结果 */
  replayed: boolean;
  balanceBefore: WalletBalance;
  balanceAfter: WalletBalance;
  member: MemberSummary;
}

export type OperationResult =
  | (OperationBase & { type: 'recharge'; recharge: RechargeDoc })
  | (OperationBase & { type: 'consume'; consumption: ConsumptionDoc })
  | (OperationBase & { type: 'reversal'; reversal: ReversalDoc; consumption: ConsumptionDoc });

/** 查回结果：abandoned 表示该编号已确认作废，原操作永远不会入账 */
export type OperationLookup = { found: false; abandoned: boolean } | ({ found: true } & OperationResult);

export interface LedgerRow {
  id: number;
  entryType: EntryType;
  docNo: string;
  memberId: number;
  memberNo: string;
  memberName: string;
  memberPhone: string;
  principalDelta: number;
  bonusDelta: number;
  principalAfter: number;
  bonusAfter: number;
  businessDate: string;
  createdAt: string;
  operatorName: string;
  rechargeId: number | null;
  consumptionId: number | null;
  reversalId: number | null;
  /** 赠金过期单 */
  expiryId: number | null;
  /** 期初明细（期初导入 / 期初作废） */
  openingId: number | null;
  /** 充值实收 */
  paidAmount: number | null;
  paymentMethod: PaymentMethod | null;
  /** 消费单当前状态 */
  consumptionStatus: 'completed' | 'reversed' | null;
  /** 前台结账储值支付的消费单所属结账单号（只能反结账，不能单独撤销） */
  checkoutNo: string | null;
  /** 消费单对应的撤销单号 / 撤销单对应的原消费单号 */
  relatedDocNo: string | null;
  /** 撤销单的原消费营业日，跨日撤销时与本行营业日不同 */
  relatedBusinessDate: string | null;
  /** 消费项目摘要 / 撤销原因 / 充值套餐 */
  summary: string;
}

export interface SettlementCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface SettlementAnomaly {
  kind:
    | 'reversal'
    | 'cross_day_reversal'
    | 'duplicate_blocked'
    | 'rejected'
    | 'abandoned'
    | 'balance_mismatch'
    | 'chain_break'
    | 'checkout_void'
    // R1.2：前台少收与更正（优惠 / 免单、降低票种或免票、撤销误开的牌、作废明细）
    | 'discount'
    | 'ticket_override'
    | 'visit_cancel'
    | 'line_void'
    // R1.9：按实际时间补录纸质单
    | 'backfill'
    // v0.7.20：退款单（离店后部分退款）与当天作废的退款单
    | 'refund'
    | 'refund_void'
    // 储值退回（v0.7.26）
    | 'member_refund';
  at: string | null;
  docNo: string | null;
  memberName: string | null;
  description: string;
  amount: number | null;
}

export interface SettlementTotals {
  recharge: {
    count: number;
    paid: number;
    bonus: number;
    byMethod: { method: PaymentMethod; count: number; amount: number }[];
    /** 其中线上（小程序，v0.7.26）：微信支付到账，不进交班；之前确认的快照没有 */
    online?: { count: number; paid: number; bonus: number };
  };
  consume: { count: number; total: number; principal: number; bonus: number; reversedCount: number };
  reversal: { count: number; principal: number; bonus: number; crossDayCount: number };
  /** 赠金到期作废（Batch 2.4c）：不是收款，也不是退款 */
  expiry: { count: number; bonus: number };
  /** 旧系统余额期初导入（Batch 2.4d，扣除当天作废的）：不是收款 */
  opening: { count: number; voidCount: number; principal: number; bonus: number };
  /**
   * 储值退回（v0.7.26，M69–M74）：退的本金（按退款方式）与扣回的赠金。不是营业额，是储值减少、钱退回去；
   * 升级之前确认的日结快照没有这一项，按 0 补齐
   */
  memberRefund: {
    count: number;
    principal: number;
    bonus: number;
    byMethod: { method: PaymentMethod; count: number; amount: number }[];
    /**
     * 其中退线上充值（小程序）的（v0.7.27）：钱从小程序的微信支付商户号退出去；auto 是交给门店系统原路退回的部分。
     * 之前确认的快照没有，按 0 补齐
     */
    online?: { count: number; amount: number; auto: number };
  };
  /** 本营业日流水的余额净变动 */
  net: WalletBalance;
  /**
   * 营业口径（Batch 3）：前台结账。当天结的计入当天，反结账计入反结账当天（负数），已确认的日结不受之后反结账影响。
   * 会员储值支付在会员口径里同时是一笔储值消费，两边由「结账储值支付 = 储值消费」核对。
   */
  business: BusinessTotals;
  /**
   * 按实际时间补录进本营业日的步骤数（R1.9：接待、挂账、结账各算一步）。不是金额口径：只补录了接待、挂账时金额不变，
   * 靠它让已确认的日结提示「有变动」
   */
  backfill: { count: number };
  /**
   * 客房押金（S7，v0.7.4）：押金是负债，不算营业额。received / refunded 是当天收、退的押金（按收款方式，现金进出钱箱）；
   * held 是当天结束时的在住押金余额。升级之前确认的日结快照没有这一项，按 0 补齐
   */
  deposits: SettlementDeposits;
  /**
   * 次卡（v0.7.28）：售卡、退卡（按方式，现金进出钱箱）、结账使用、过期作废、期初导入与当天结束时还剩的次数。
   * 升级之前确认的日结快照没有这一项，按 0 补齐
   */
  countCards: import('./count-cards').CountCardDayTotals;
}

export interface SettlementDeposits {
  received: { method: PaymentMethod; count: number; amount: number }[];
  refunded: { method: PaymentMethod; count: number; amount: number }[];
  held: number;
}

export interface BusinessTotals {
  /** 当天结账（含之后反结账的） */
  checkouts: { count: number; total: number };
  /** 当天反结账（原单可能在之前的营业日） */
  voids: { count: number; total: number };
  /** 营业额（净额）= 结账合计 − 反结账合计 */
  net: number;
  /** 消费构成（净额）：门票 / 项目与其他 */
  ticket: number;
  items: number;
  /** 结账收款按方式（净额；会员储值、团购券不是本次实收） */
  byMethod: { method: CheckoutMethod; amount: number; count: number; voidCount: number }[];
  /** 平台团购核销（净额） */
  coupons: { platform: CouponPlatform; amount: number; count: number; voidCount: number }[];
  /**
   * 当天开的退款单（v0.7.20，离店后部分退款，不含当天作废的）：合计与按退款方式。净营业额与实收都要减去它；
   * 应收、门票与项目的构成不变。升级之前确认的日结快照没有这一项，按 0 补齐
   */
  refunds: { count: number; total: number; byMethod: { method: PaymentMethod; count: number; amount: number }[] };
}

export interface SettlementSummary extends SettlementTotals {
  businessDate: string;
  isToday: boolean;
  isFuture: boolean;
  balances: { opening: WalletBalance; closing: WalletBalance; membersNow: WalletBalance; ledgerNow: WalletBalance };
  checks: SettlementCheck[];
  anomalies: SettlementAnomaly[];
  byStaff: {
    staffId: number;
    name: string;
    rechargeCount: number;
    rechargePaid: number;
    consumeCount: number;
    consumeTotal: number;
    reversalCount: number;
  }[];
  closed: {
    closedAt: string;
    closedByName: string;
    note: string;
    revision: number;
    /** 日结确认后数据是否又有变动 */
    changedSinceClose: boolean;
  } | null;
}

export interface StaffRecord {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  duties: Duty[];
  /** 所属部门（v0.7.8） */
  departmentId: number | null;
  departmentName: string | null;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AuditRecord {
  id: number;
  action: string;
  staffName: string | null;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}
