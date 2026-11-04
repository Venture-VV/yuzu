// 微信小程序（小程序线，docs/MINIPROGRAM.md）：yuzu 的小程序端口、网关、小程序前端共用的类型与常量。
// 金额一律整数「分」。小程序端口只认网关：请求头带网关密钥，会员相关的接口另带网关验证过的 openid。

import type { PriceTier } from './catalog';

/** 网关的服务密钥（yuzu 比对摘要） */
export const MP_GATEWAY_HEADER = 'x-mp-gateway-key';
/** 网关验证过的小程序用户 */
export const MP_OPENID_HEADER = 'x-mp-openid';
export const MP_OPENID = /^[A-Za-z0-9_-]{6,64}$/;

/** 小程序的开关与规则（settings 的 mp_rules）：默认关闭，店主在后台「小程序」里开 */
export interface MpRules {
  enabled: boolean;
  /**
   * 每保存一次加一。后台改开关时带上看到的版本号：没收到结果再提交、晚到的原请求，都不会盖掉之后的改动
   * （与门店信息、轮播、项目介绍的版本号一样）
   */
  version: number;
}
export const DEFAULT_MP_RULES: MpRules = { enabled: false, version: 0 };
export const MP_RULES_KEY = 'mp_rules';

export type MpBannerLink = 'none' | 'prices' | 'guide' | 'store';

export interface MpStore {
  code: string;
  name: string;
  /** 本系统所在的门店：会员、余额、券只来自这一家（MP5） */
  isHome: boolean;
  hours: string;
  address: string;
  phone: string;
  latitude: number | null;
  longitude: number | null;
  notice: string;
  imageId: number | null;
}

export interface MpBanner {
  id: number;
  title: string;
  link: MpBannerLink;
  imageId: number;
}

/** 首页：门店信息与当天的轮播 */
export interface MpHome {
  stores: MpStore[];
  banners: MpBanner[];
}

export interface MpTicket {
  name: string;
  /** 12 小时档、24 小时档（分） */
  price12h: number;
  price24h: number;
  note: string;
}

export interface MpPriceItem {
  id: number;
  name: string;
  category: string;
  durationMinutes: number | null;
  gender: 'male' | 'female' | null;
  /** 各档价格（分），按标准、专业、优选排序 */
  prices: { tier: PriceTier; price: number }[];
  /** 对外介绍与图片（后台「小程序 → 项目介绍」） */
  intro: string;
  imageId: number | null;
}

/** 价目：门票与价目表项目（价格读价目表，小程序不另存） */
export interface MpPrices {
  tickets: MpTicket[];
  items: MpPriceItem[];
}

/** 小程序端口的错误码（网关原样转给小程序，文字面向顾客） */
export type MpErrorCode =
  | 'MP_GATEWAY_REJECTED'
  | 'MP_DISABLED'
  | 'MP_OPENID_REQUIRED'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'INTERNAL';

// ── 会员（要先绑定；网关带 openid）──

export interface MpMemberBrief {
  memberNo: string;
  name: string;
  /** 冻结的会员能看不能用：会员码不可用（MP6） */
  frozen: boolean;
}

export interface MpBindResult {
  status: 'bound';
  member: MpMemberBrief;
  /** 同一个操作编号重提、或这个微信已经绑定了同一位会员 */
  replayed: boolean;
}

/** 绑定结果不确定时确认作废：已经绑上了返回绑定的结果，否则登记作废（原请求之后到达也不会绑定） */
export type MpBindAbandonResult = MpBindResult | { status: 'abandoned' };

/** 后台新建轮播结果不确定时确认作废：已经建了返回那一条，否则登记作废 */
export type MpBannerAbandonResult = { state: 'done'; banner: MpBannerAdmin } | { state: 'abandoned' };

/** 后台按操作编号查回新建轮播（只读）：查不到不能断定没新建，要重新提交或确认作废 */
export interface MpBannerOpLookup {
  found: boolean;
  abandoned: boolean;
  banner: MpBannerAdmin | null;
}

/** 会员卡上的档阶（会员体系 v2，数字全由 yuzu 算好，小程序只显示） */
export interface MpGrade {
  /** 「L3 观澜 · 享」 */
  label: string;
  grade: number;
  gradeName: string;
  /** 0 初、1 享、2 尊；L0 没有 */
  tier: number | null;
  tierName: string | null;
  cycleEnd: string | null;
  daysLeft: number | null;
  inGrace: boolean;
  /** 周期内的净储值消费（分）与升享阶、尊阶（也是保级）要的数 */
  cycleSpendCents: number;
  targets: { enjoy: number; honor: number } | null;
  /** 下一档：按滚动累计还差多少、赠送比例（万分比）；已是最高档为空 */
  next: { grade: number; name: string; needCents: number; bonusBp: number } | null;
  /** 各档的名字，下标 0–6 对应 L0–L6（会员卡上的档级阶梯） */
  ladder: string[];
}

export interface MpMe {
  bound: boolean;
  /**
   * 这个微信的绑定状态版本号：绑定、解绑各加一，只增不减（绑定记录只追加）。点绑定时带上看到的这个数，
   * 门店系统对不上就拒绝（BIND_STALE）：解绑之后，之前没确认的旧请求晚到也不会再绑上（小程序线测试预检 #44 的 P1）
   */
  bindVersion: number;
  member:
    | (MpMemberBrief & {
        principalBalance: number;
        bonusBalance: number;
        /** 门店的扣款规则：「先本金，后赠金」等 */
        deductionRule: string;
        grade: MpGrade;
        availableCoupons: number;
        /** 线上充值开着（第二期 2a）：「我的」页显示「充值」 */
        rechargeOpen: boolean;
        /** 这张会员卡已合并到另一张（主线 v0.7.26）：请到前台换绑，不显示目标会员（MP25） */
        merged: boolean;
        /** 领券中心开着、有可领的券（第二期 2c）：「我的」页显示「领券中心」 */
        couponCenterOpen: boolean;
      })
    | null;
}

export interface MpLedgerRow {
  id: number;
  /** 充值、消费、撤销、赠金过期、期初导入、期初作废 */
  kind: string;
  kindLabel: string;
  principalDelta: number;
  bonusDelta: number;
  principalAfter: number;
  bonusAfter: number;
  businessDate: string;
  createdAt: string;
  /** 消费项目摘要、充值套餐 */
  summary: string;
}

export interface MpCoupon {
  code: string;
  name: string;
  kind: string;
  summary: string;
  validFrom: string;
  validTo: string;
  /** available 可用、pending 还没生效、expired、used、voided */
  state: string;
}

/**
 * 本月可享（第一期 ⑥，接主线 v0.7.24 的 memberBenefits）：按会员推算到今天的档阶，列出已发布、够格的本店权益。
 * 只给顾客该看的：不带发放与使用的记录（里面有经办人、单号、备注）、内部编号与券模板。
 */
export interface MpBenefitItem {
  code: string;
  name: string;
  /** coupon 券类、event 事件礼、service 服务与资格、discount 折扣（第三期）、info 制度说明 */
  /** 与本店权益的类别一一对应（`@shared/benefits` 的 BENEFIT_CATEGORIES）；extension 是浴票延迟（主线 v0.7.25） */
  category: 'coupon' | 'event' | 'service' | 'discount' | 'extension' | 'info';
  /** 次数、张数按什么算：none 不计次、day 每天、month 每月、year 每年 */
  period: 'none' | 'day' | 'month' | 'year';
  /** 「每月 2 次」「每月 1 张」「每次 1 张」「不限次」；折扣、制度说明为空 */
  allowance: string;
  content: string;
  conditions: string;
  /** 服务类：这一期已登记的次数（不计次的是本月登记了几次）；其余为 null */
  used: number | null;
  /** 服务类：这一期的上限，不限次为 null；其余为 null */
  limit: number | null;
  /** 券类、事件礼：这一项发的券里现在能用的张数 */
  available: number;
}

export interface MpBenefits {
  /** 营业日所在的月份 YYYY-MM */
  month: string;
  /** 现在的档阶，例如「L2 潭影 · 初」 */
  label: string;
  items: MpBenefitItem[];
  /** 升档以后能享的（按起点从低到高，最多 8 项）：只给名字与起点 */
  upcoming: { name: string; startLabel: string }[];
}

/** 会员码（MP9）：由 yuzu 签发，每 60 秒换一次；前台扫码盒扫进会员查找框，yuzu 在本机校验 */
export interface MpMemberCode {
  code: string;
  expiresAt: string;
  refreshSeconds: number;
}
export const MP_CODE = /^(8\d{6}|9\d{9})\d{9}$/;
export const MP_CODE_SECONDS = 60;

/** 前台扫到会员码后查到的会员 */
export interface MpCodeLookup {
  memberId: number;
  memberNo: string;
  name: string;
}

/** 后台看某位会员的绑定记录（openid 只显示后 6 位） */
export interface MpBindingRow {
  id: number;
  openidTail: string;
  phone: string;
  mock: boolean;
  boundAt: string;
  unboundAt: string | null;
  unboundByName: string | null;
  unbindReason: string | null;
}

// ── 后台「小程序」模块（员工端口，权限 mp.content；绑定记录另要 mp.unbind）──

export interface MpStoreAdmin extends MpStore {
  id: number;
  visible: boolean;
  sortOrder: number;
  version: number;
  updatedAt: string;
}

export interface MpBannerAdmin extends MpBanner {
  startsOn: string | null;
  endsOn: string | null;
  sortOrder: number;
  active: boolean;
  version: number;
}

export interface MpItemIntroAdmin {
  itemId: number;
  name: string;
  category: string;
  active: boolean;
  intro: string;
  imageId: number | null;
  /** 还没写过介绍时为 0 */
  version: number;
}

export interface MpAdminData {
  rules: MpRules;
  /** 线上充值的设置（第二期 2a）：放在这里，「结果待确认」查回修改结论时与其他开关同一份数据 */
  rechargeRules: MpRechargeRules;
  /** 领券中心的设置（第二期 2c）：同上 */
  couponRules: MpCouponRules;
  stores: MpStoreAdmin[];
  banners: MpBannerAdmin[];
  items: MpItemIntroAdmin[];
}

export const MP_BANNER_LINKS: { value: MpBannerLink; label: string }[] = [
  { value: 'none', label: '不跳转' },
  { value: 'prices', label: '价目表' },
  { value: 'guide', label: '楼层导览' },
  { value: 'store', label: '门店信息' },
];

// ── 线上充值（第二期 2a，docs/MP_RECHARGE.md）──

/**
 * 线上充值的设置（settings 的 mp_recharge_rules，后台「微信小程序」→「线上充值」，权限 mp.recharge）：
 * 开关默认关（小程序本身也要开着）；线上可充的套餐由店主勾选；自定义金额的框默认开（MP18）；
 * 线上单笔上限默认 1 万元、每人每天最多 3 笔（MP20），线上单笔上限不超过前台的单笔上限。
 */
export interface MpRechargeRules {
  enabled: boolean;
  planIds: number[];
  customEnabled: boolean;
  /** 线上单笔上限（分） */
  maxCents: number;
  /** 每人每天最多几笔（按下单的营业日，没付关掉的不算） */
  dailyLimit: number;
  /** 每保存一次加一；后台保存时带上看到的版本号 */
  version: number;
}
export const DEFAULT_MP_RECHARGE_RULES: MpRechargeRules = { enabled: false, planIds: [], customEnabled: true, maxCents: 1_000_000, dailyLimit: 3, version: 0 };
export const MP_RECHARGE_RULES_KEY = 'mp_recharge_rules';
/** 一张单从下单到微信支付过期：15 分钟（MP19） */
export const MP_RECHARGE_EXPIRE_MINUTES = 15;
/** 商户单号：MPR + 下单的营业日 + 10 位随机 */
export const MP_RECHARGE_ORDER_NO = /^MPR[0-9]{8}[0-9A-Z]{10}$/;

/** pending 待支付、paid 已入账、closed 已关闭、held 已付款待处理（门店没能自动入账）、handled 已处理（店主另行处理了） */
export type MpRechargeStatus = 'pending' | 'paid' | 'closed' | 'held' | 'handled';

/** 按这位会员此刻的规则预估（以到账时为准） */
export interface MpRechargeEstimate {
  /** 实付（分） */
  amount: number;
  /** 预估赠金（分） */
  bonus: number;
  /** 充完以后的档阶，例如「L2 潭影 · 初」 */
  label: string;
  upgraded: boolean;
}

/** 一项可充的套餐 */
export interface MpRechargePlan extends MpRechargeEstimate {
  planId: number;
  name: string;
  /** 套餐上挂的券（按充完的档能领的）：「名称 × 张数」 */
  coupons: string[];
  /** 不能充时的原因（不够首充 / 续充最低、超过线上单笔上限）；能充为 null */
  blocked: string | null;
}

export interface MpRechargeOrder {
  orderNo: string;
  status: MpRechargeStatus;
  amount: number;
  /** 选的套餐；自定义金额为空 */
  planName: string | null;
  estBonus: number;
  estLabel: string;
  expiresAt: string;
  createdAt: string;
  /** 已入账：实际入账的本金、赠金与入账后的档阶 */
  result: { principal: number; bonus: number; label: string } | null;
  /** 已付款待处理、已处理、已关闭时写给顾客的 */
  notice: string | null;
}

export interface MpRechargeOptions {
  /** 现在能不能在线充：线上充值开着、微信支付配好了、会员没冻结、今天的笔数没用完；不能时 notice 写原因 */
  open: boolean;
  notice: string | null;
  plans: MpRechargePlan[];
  /** 自定义金额的框（后台开着才有）：整元，最少、最多（分） */
  custom: { minCents: number; maxCents: number } | null;
  /** 首充还是续充、单笔最低（分，0 = 不限） */
  first: boolean;
  minimum: number;
  dailyLimit: number;
  usedToday: number;
  /** 还没付完的单（同一位会员同时只有一张） */
  pending: MpRechargeOrder | null;
  /** 模拟微信支付（只在演示库）：小程序点「模拟支付」，不调 wx.requestPayment */
  mock: boolean;
  /**
   * 这个微信此刻的绑定状态版本号（与 MpMe.bindVersion 同一个数）：建单时带上。顾客在这一页看到、确认的是这一条绑定下的会员；
   * 之后解绑、换绑过（版本号变了），晚到的建单请求门店系统拒绝（BIND_STALE），不会记到换绑以后的会员上（小程序线测试 #52 的 P1）
   */
  bindVersion: number;
}

/** wx.requestPayment 的参数 */
export interface MpPayParams {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

export interface MpRechargeCreated {
  order: MpRechargeOrder;
  /** 微信支付下单没成功（连不上）时为空：之后「继续支付」再下单 */
  payment: MpPayParams | null;
  mock: boolean;
  /** 同一个操作编号重提：返回原来那张单 */
  replayed: boolean;
}

/** 建单结果不确定时确认作废：已经建了就返回那张单 */
export type MpRechargeAbandonResult = { status: 'abandoned' } | { status: 'created'; order: MpRechargeOrder };

// ── 后台：线上充值单（权限 mp.recharge）──

export type MpRechargeFlag = 'frozen' | 'merged' | 'after_close';
export type MpRechargeResolution = 'rebook' | 'rebook_amount' | 'handled';

export interface MpRechargeOrderAdmin {
  id: number;
  orderNo: string;
  status: MpRechargeStatus;
  memberId: number;
  memberNo: string;
  memberName: string;
  creditedMemberId: number | null;
  planId: number | null;
  planName: string | null;
  amount: number;
  estBonus: number;
  estLabel: string;
  /** 入账的充值单与实际赠金（已入账） */
  rechargeId: number | null;
  rechargeDocNo: string | null;
  bookedBonus: number | null;
  bookedLabel: string | null;
  transactionId: string | null;
  paidAt: string | null;
  bookedAt: string | null;
  flags: MpRechargeFlag[];
  closedAt: string | null;
  closeReason: string | null;
  holdCode: string | null;
  holdMessage: string | null;
  heldAt: string | null;
  resolution: MpRechargeResolution | null;
  resolutionNote: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  mock: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface MpRechargeAdminData {
  rules: MpRechargeRules;
  /** 门店系统里的微信支付：real 已配好、mock 模拟（演示库）、null 没配好或小程序端口没开 */
  payMode: 'real' | 'mock' | null;
  /** 微信支付配错了的原因（只配了一部分、文件读不了、模拟开在别的环境）；没配或配好了为 null */
  payProblem: string | null;
  /** 启用的充值套餐（勾选用） */
  plans: { id: number; name: string; payAmount: number }[];
  /** 前台的单笔上限（分）：线上单笔上限不超过它 */
  counterMaxCents: number;
  /** 已付款待处理的（全部）与最近的单子 */
  held: MpRechargeOrderAdmin[];
  recent: MpRechargeOrderAdmin[];
  /** 验过签、但门店系统里找不到单子的到账通知（例如从备份恢复过） */
  orphans: { id: number; createdAt: string; outTradeNo: string; transactionId: string | null; amount: number | null }[];
  /** 对账（2b）：最近 30 个账单日，每天取最后一次核对 */
  recons: MpRechargeRecon[];
}

// ── 2b 对账（docs/MP_RECHARGE.md 第 8 节）──

/**
 * 没对上的一笔：NOT_BOOKED 微信有、门店没入账（查单也没补上）；UNKNOWN_ORDER 微信有、门店系统里没有这张单；
 * NOT_IN_BILL 门店入了账、微信那天的账单里没有；AMOUNT_MISMATCH 金额对不上；TX_MISMATCH 交易单号对不上
 */
export type MpReconIssueKind = 'NOT_BOOKED' | 'UNKNOWN_ORDER' | 'NOT_IN_BILL' | 'AMOUNT_MISMATCH' | 'TX_MISMATCH';

export interface MpReconIssue {
  kind: MpReconIssueKind;
  outTradeNo: string | null;
  transactionId: string | null;
  /** 两边的金额（分）；没有的一边为 null */
  wxAmount: number | null;
  storeAmount: number | null;
  note: string;
}

export interface MpRechargeRecon {
  id: number;
  billDate: string;
  ok: boolean;
  wxCount: number;
  wxAmount: number;
  storeCount: number;
  storeAmount: number;
  issues: MpReconIssue[];
  /** 账单里的退款（商户平台手动退的；2d 以后自动退的）：交易单号、退款单号、金额、状态 */
  refunds: { transactionId: string; refundId: string | null; amount: number | null; status: string | null }[];
  source: 'auto' | 'manual';
  staffName: string | null;
  createdAt: string;
}

// ── 线上领券（第二期 2c，docs/MP_COUPONS.md，MP22、MP27）──

/** 一张可领的券：哪个券模板、领取限制（不限领 / 每人限领 N 张）、可领还是停领 */
export interface MpCouponOffer {
  templateId: number;
  limit: 'unlimited' | 'per_member';
  /** 每人限领几张（1–99）；不限领时不看 */
  perMember: number;
  /** false = 停领：小程序不再列出、不能领，已经领到的不受影响 */
  active: boolean;
}

/**
 * 领券中心的设置（settings 的 mp_coupon_rules，后台「微信小程序」→「领券中心」，权限 mp.coupon）：
 * 开关、可领的券（按列表的先后显示）。默认关、没有可领的券；新加的券默认每人限领 1 张（MP22）。
 */
export interface MpCouponRules {
  enabled: boolean;
  offers: MpCouponOffer[];
  /** 每保存一次加一；后台保存时带上看到的版本号 */
  version: number;
}
export const DEFAULT_MP_COUPON_RULES: MpCouponRules = { enabled: false, offers: [], version: 0 };
export const MP_COUPON_RULES_KEY = 'mp_coupon_rules';
export const MP_COUPON_PER_MEMBER_DEFAULT = 1;
export const MP_COUPON_PER_MEMBER_MAX = 99;
/** 领券中心最多放几张可领的券 */
export const MP_COUPON_OFFERS_MAX = 30;

/** 领券中心的一张券（按这位会员此刻算好：领过几张、能不能领、为什么不能） */
export interface MpCouponCenterItem {
  templateId: number;
  name: string;
  /** cash 代金券、discount 折扣券、exchange 兑换券 */
  kind: string;
  /** 「代金券 ¥30.00 · 满 ¥50.00 可用」 */
  summary: string;
  /** 「领取后 30 天内有效」「2026-11-01 至 2026-12-31 有效」 */
  validity: string;
  /** 「每人限领 1 张」「不限领」 */
  limitText: string;
  /** 这位会员已经领了几张（换绑过微信、合并进来的会员卡领的也算） */
  claimed: number;
  canClaim: boolean;
  /** 不能领的原因：已经领满、会员已停用、档级不够、券停了或过了期 */
  reason: string | null;
}

export interface MpCouponCenter {
  open: boolean;
  /** 领券中心没开、会员卡合并或停用时的说明 */
  notice: string | null;
  items: MpCouponCenterItem[];
  /** 这个微信此刻的绑定状态版本号：领取时带上，之后解绑、换绑过的领取请求门店系统拒绝（BIND_STALE），与充值建单一样 */
  bindVersion: number;
}

/** 领到的一张券（券码、有效期），去「我的券」能看到 */
export interface MpCouponClaimed {
  claimId: number;
  templateId: number;
  /** 同一个操作编号重提：返回第一次领到的那张，这次没有再发 */
  replayed: boolean;
  coupon: { code: string; name: string; summary: string; validFrom: string; validTo: string };
}

/** 领取结果不确定时确认作废：已经领到了返回那一张，否则登记作废（原请求之后到达也不会发券） */
export type MpCouponAbandonResult = { status: 'claimed'; claimed: MpCouponClaimed } | { status: 'abandoned' };

// ── 后台：领券中心（权限 mp.coupon）──

/** 启用的券模板（勾选用） */
export interface MpCouponTemplateOption {
  id: number;
  name: string;
  summary: string;
  validity: string;
  /** 限定发放的档级（空 = 不限） */
  levels: number[];
}

export interface MpCouponClaimAdmin {
  id: number;
  createdAt: string;
  memberId: number;
  memberName: string;
  templateId: number;
  templateName: string;
  couponCode: string;
  issueNo: string;
  /** 这位会员领这张券的第几张 */
  seq: number;
}

export interface MpCouponAdminData {
  rules: MpCouponRules;
  templates: MpCouponTemplateOption[];
  /** 每张可领的券一共领了多少、最近 7 天领了多少（按券模板） */
  stats: { templateId: number; total: number; last7Days: number }[];
  /** 最近 50 条领取记录 */
  recent: MpCouponClaimAdmin[];
}
