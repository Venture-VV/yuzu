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
        /** 邀请好友开着（第三期 3b）：「我的」页显示「邀请好友」 */
        inviteOpen: boolean;
        /** 扫码点餐开着（第三期 3c：后台开了、餐饮功能开着）：「我的」页显示「点餐」「我的账单」 */
        foodOpen: boolean;
        /** 小程序预约开着、有可约的项目或房间（第三期 3d）：「我的」页显示「预约」 */
        bookingOpen: boolean;
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
  /** cash 代金券、discount 折扣券、exchange 兑换券、bogo 买一赠一券（8.0.4）；以后再加的种类小程序认不得时照 summary 整句显示 */
  kind: string;
  /** 门店系统给的一句话说明：「代金券 ¥30.00 · 满 ¥50.00 可用」「买一赠一 · 买 拿铁 送 拿铁 1 份 · 最多抵 ¥30.00」 */
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

/**
 * 会员端提醒（RQ-014，接主线 8.0.4 批量发券的「会员端弹窗」：member-notices.ts 的 listMemberNotices、markMemberNoticeRead；
 * docs/MEMBERSHIP_V804.md 第 6 节，弹的时机按 HY16，待确认）：小程序首页打开时弹出，看过记已读。
 * 只给顾客该看的：标题、正文；没有发券单、券模板与内部的日子。
 */
export interface MpNotice {
  id: number;
  /** coupon_issued 收到券、coupon_expiring 券快到期；主线以后再加的种类照标题、正文显示 */
  kind: string;
  /** 「收到 2 张券」「券快到期了」 */
  title: string;
  /** 「「50 元代金券」×2，有效期至 2026-12-31。到店出示会员码即可使用。」 */
  body: string;
}
export interface MpNotices {
  /** 这位会员今天要看的（门店营业日；没读过、在显示的日子里、券还能用的），新的在前，最多 20 条 */
  notices: MpNotice[];
}
/** 一次最多记几条已读（与一次最多弹 20 条一样） */
export const MP_NOTICE_READ_MAX = 20;
export interface MpNoticeRead {
  /** 这次记成已读的；之前已经读过的、不是这位会员的不在里面（重提不报错） */
  read: number[];
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
  /** 解绑满 3 年清除以后为空（MP16） */
  openidTail: string | null;
  phone: string | null;
  mock: boolean;
  boundAt: string;
  unboundAt: string | null;
  unboundByName: string | null;
  unbindReason: string | null;
  /** 解绑满 3 年、清除了手机号与微信标识的时间 */
  purgedAt: string | null;
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
  /** 到期提醒的设置（第三期 3a）：同上 */
  reminderRules: MpReminderRules;
  /** 邀请好友的设置（第三期 3b）：同上 */
  inviteRules: MpInviteRules;
  /** 扫码点餐的设置（第三期 3c） */
  foodRules: MpFoodRules;
  /** 小程序预约的设置（第三期 3d） */
  bookingRules: MpBookingRules;
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
  /**
   * 原路退回（2d）：开着、门店系统的微信支付也配好时，主线退储值里线上充值那一行可以交给门店系统原路退回到顾客的微信。
   * 关掉只影响以后的退储值，已经交给门店系统的照样退完。默认开
   */
  refundAuto: boolean;
  /** 每保存一次加一；后台保存时带上看到的版本号 */
  version: number;
}
export const DEFAULT_MP_RECHARGE_RULES: MpRechargeRules = {
  enabled: false,
  planIds: [],
  customEnabled: true,
  maxCents: 1_000_000,
  dailyLimit: 3,
  refundAuto: true,
  version: 0,
};
export const MP_RECHARGE_RULES_KEY = 'mp_recharge_rules';
/** 一张单从下单到微信支付过期：15 分钟（MP19） */
export const MP_RECHARGE_EXPIRE_MINUTES = 15;
/** 商户单号：MPR + 下单的营业日 + 10 位随机 */
export const MP_RECHARGE_ORDER_NO = /^MPR[0-9]{8}[0-9A-Z]{10}$/;
/** 原路退回（2d）的商户退款单号：MPRF + 北京时间的日期 + 10 位随机 */
export const MP_REFUND_NO = /^MPRF[0-9]{8}[0-9A-Z]{10}$/;

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
  /** 原路退回（2d）：没退成的、处理中的全部，加最近 30 张退到了的 */
  refunds: MpRefundOrderAdmin[];
}

// ── 2d 原路退回（docs/MP_RECHARGE.md 第 9 节）──

/**
 * new 待申请（连不上、余额不够时隔一会儿再试）、processing 微信处理中、success 已退到、abnormal 退款异常（要到商户平台处理）、
 * closed 退款关闭、failed 没能退（微信拒绝、找不到原单）、handled 店主已另行处理
 */
export type MpRefundStatus = 'new' | 'processing' | 'success' | 'abnormal' | 'closed' | 'failed' | 'handled';

export interface MpRefundOrderAdmin {
  id: number;
  createdAt: string;
  status: MpRefundStatus;
  memberId: number;
  memberName: string;
  memberNo: string;
  /** 主线的退储值单号 */
  memberRefundNo: string;
  rechargeDocNo: string;
  outTradeNo: string | null;
  transactionId: string;
  outRefundNo: string;
  /** 这一行退多少（分） */
  amount: number;
  wxRefundId: string | null;
  /** 退到哪（「支付用户零钱」「招商银行信用卡0403」） */
  receivedAccount: string | null;
  succeededAt: string | null;
  failCode: string | null;
  failMessage: string | null;
  attempts: number;
  nextTryAt: string | null;
  handledNote: string | null;
  handledByName: string | null;
  handledAt: string | null;
}

// ── 2b 对账（docs/MP_RECHARGE.md 第 8 节）──

/**
 * 没对上的一笔：NOT_BOOKED 微信有、门店没入账（查单也没补上）；UNKNOWN_ORDER 微信有、门店系统里没有这张单；
 * NOT_IN_BILL 门店入了账、微信那天的账单里没有；AMOUNT_MISMATCH 金额对不上；TX_MISMATCH 交易单号对不上
 */
export type MpReconIssueKind =
  | 'NOT_BOOKED'
  | 'UNKNOWN_ORDER'
  | 'NOT_IN_BILL'
  | 'AMOUNT_MISMATCH'
  | 'TX_MISMATCH'
  // 2d 原路退回（账单里商户退款单号是 MPRF 开头的退款行）：门店系统里没有这张原路退回单、微信退了门店还没记已退到、
  // 门店记了已退到微信那天的账单里没有、退款金额对不上
  | 'REFUND_UNKNOWN'
  | 'REFUND_NOT_RECORDED'
  | 'REFUND_NOT_IN_BILL'
  | 'REFUND_AMOUNT_MISMATCH';

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
  /** cash 代金券、discount 折扣券、exchange 兑换券、bogo 买一赠一券（8.0.4） */
  kind: string;
  /** 「代金券 ¥30.00 · 满 ¥50.00 可用」「买一赠一 · 买 拿铁 送 拿铁 1 份 · 最多抵 ¥30.00」 */
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

// ── 到期提醒（第三期 3a，docs/MP_PHASE3.md 第 1 节，MP28、MP29）──

/** coupon 券快到期、membership 会籍快到期、grace 进补充期当天、bonus 赠金快到期、booking 预约到店（第三期 3d） */
export type MpReminderKind = 'coupon' | 'membership' | 'grace' | 'bonus' | 'booking';
/** 模板分四种：会籍与补充期用同一个模板（会籍的模板） */
export type MpReminderTemplateKind = 'coupon' | 'membership' | 'bonus' | 'booking';
export const MP_REMINDER_TEMPLATE_KINDS: MpReminderTemplateKind[] = ['coupon', 'membership', 'bonus', 'booking'];
export const mpReminderTemplateKind = (k: MpReminderKind): MpReminderTemplateKind => (k === 'grace' ? 'membership' : k);

/**
 * 模板的一个字段填什么：name 券名 / 档阶 / 「赠金」 / 预约的项目或房间，date 到期日（预约是开始的日子，time 字段带上几点），
 * amount 赠金金额 / 保级还差的储值消费，tip 一句提示（「到前台结账时可用」等），store 门店名
 */
export type MpReminderSource = 'name' | 'date' | 'amount' | 'tip' | 'store';
export const MP_REMINDER_SOURCES: MpReminderSource[] = ['name', 'date', 'amount', 'tip', 'store'];

/** 一个订阅消息模板：店主在微信公众平台「订阅消息」从公共模板库选好，把模板编号与每个字段（thing1、date2…）填进后台 */
export interface MpReminderTemplate {
  templateId: string;
  /** 模板详情里的 {{thing1.DATA}} 填 thing1：按字段名的前缀排成微信要的格式（thing 最多 20 个字、date 写成「2026年11月20日」…） */
  fields: { key: string; source: MpReminderSource }[];
}

/**
 * 到期提醒的设置（settings 的 mp_reminder_rules，后台「微信小程序」→「到期提醒」，权限 mp.reminder）。
 * 默认关、没有模板；没填模板的那种提醒，小程序里不出现「提醒我」。
 */
export interface MpReminderRules {
  enabled: boolean;
  coupon: MpReminderTemplate | null;
  membership: MpReminderTemplate | null;
  bonus: MpReminderTemplate | null;
  /** 预约到店（第三期 3d）：门店确认了的预约，开始那天 10:00–20:00 提醒一次 */
  booking: MpReminderTemplate | null;
  /** 每保存一次加一；后台保存时带上看到的版本号 */
  version: number;
}
export const DEFAULT_MP_REMINDER_RULES: MpReminderRules = { enabled: false, coupon: null, membership: null, bonus: null, booking: null, version: 0 };
export const MP_REMINDER_RULES_KEY = 'mp_reminder_rules';
/** 提前几天提醒（MP28 默认）：券 3 天，会籍、赠金 7 天；补充期在进补充期当天 */
export const MP_REMINDER_LEAD_DAYS: Record<'coupon' | 'membership' | 'bonus', number> = { coupon: 3, membership: 7, bonus: 7 };
/** 几点之间发（MP29 默认，北京时间）：10:00 起、20:00 前；晚上到点的推到第二天上午 */
export const MP_REMINDER_SEND_HOURS = { from: 10, to: 20 } as const;
/** 模板的字段名：微信的几种格式加编号 */
export const MP_REMINDER_FIELD_KEY = /^(thing|short_thing|date|time|amount|number|phrase|character_string|letter|symbol|name)([1-9][0-9]?)$/;
export const MP_REMINDER_FIELDS_MAX = 5;
/** 模板编号：微信给的是 40 多位字母、数字、- 与 _ */
export const MP_REMINDER_TEMPLATE_ID = /^[A-Za-z0-9_-]{10,64}$/;

/** 这条绑定已经设好的一条提醒（「已设提醒」） */
export interface MpReminderSet {
  kind: MpReminderKind;
  /** 券快到期：哪张券（券码） */
  couponCode: string | null;
  /** 预约到店：哪张预约单 */
  bookingId: number | null;
  targetDate: string;
  dueDate: string;
  /** waiting 还没到发的时候、sent 已发、done 不用发了或没发出 */
  state: 'waiting' | 'sent' | 'done';
}

/** 小程序打开券、会员卡、余额页时取：能设哪几种提醒、已经设了哪些、提醒要带的到期日 */
export interface MpReminderOptions {
  /** 到期提醒开着、这个微信绑定了会员 */
  open: boolean;
  /** 这个微信此刻的绑定状态版本号：设提醒时带上（之后解绑、换绑过的请求门店系统拒绝，BIND_STALE） */
  bindVersion: number;
  /** 每种提醒用的模板编号：小程序拿它请顾客同意（wx.requestSubscribeMessage）；没配的为空，不显示「提醒我」 */
  templates: Record<MpReminderTemplateKind, string | null>;
  /** 提前几天提醒、几点之间发（给顾客看的说明用） */
  leadDays: Record<'coupon' | 'membership' | 'bonus', number>;
  sendHours: { from: number; to: number };
  set: MpReminderSet[];
  /** 会籍：周期最后一天（L0 没有）、在不在补充期；设会籍、补充期提醒时带上周期最后一天 */
  membership: { cycleEnd: string | null; inGrace: boolean; label: string } | null;
  /**
   * 最早到期的赠金（没有会到期的赠金为空）：lastDay 是最后能用的那个营业日（到期那天营业日开始时作废），
   * 与券的有效期到、会籍周期的最后一天同一个口径；设赠金提醒时带上这一天
   */
  bonus: { amount: number; lastDay: string } | null;
}

/** 设一条提醒：顾客在微信的弹窗里同意以后发；同一个编号重提返回同一条（结果不确定时原样重提） */
export interface MpReminderConsentInput {
  clientKey: string;
  kind: MpReminderKind;
  /** 券快到期：哪张券 */
  couponCode?: string;
  /** 预约到店：哪张预约单 */
  bookingId?: number;
  /** 会籍、补充期、赠金：页面上显示的到期日（对不上说明刚变过，请顾客刷新） */
  targetDate?: string;
  templateId: string;
  bindVersion: number;
}

export interface MpReminderConsented {
  consentId: number;
  kind: MpReminderKind;
  targetDate: string;
  dueDate: string;
  /** 同一个编号重提，或这样东西之前已经设过这种提醒：返回原来那条，没有再记 */
  replayed: boolean;
}

// ── 网关取待发的提醒、回报结果（第三期 3a；只认网关密钥，不带 openid）──

export interface MpReminderLeased {
  id: number;
  leaseToken: string;
  openid: string;
  templateId: string;
  page: string;
  data: Record<string, { value: string }>;
}

/** 网关取一批的回答：leasedUntil 是这一批的期限，过了它网关不再开始发（剩下的报「再试」）；没有要发的为空 */
export interface MpReminderLease {
  messages: MpReminderLeased[];
  leasedUntil: string | null;
}

/** 网关发完一条的结果：sent 发出；failed 微信明确拒绝（顾客拒收、模板或字段不对）；retry 没发出去、可以再试；unknown 发了没收到回音 */
export interface MpReminderReport {
  id: number;
  leaseToken: string;
  outcome: 'sent' | 'failed' | 'retry' | 'unknown';
  errcode?: number | null;
  errmsg?: string | null;
}

// ── 后台：到期提醒（权限 mp.reminder）──

export type MpReminderStatus = 'queued' | 'leased' | 'sent' | 'failed' | 'unknown' | 'skipped';

export interface MpReminderMessageAdmin {
  id: number;
  kind: MpReminderKind;
  memberId: number;
  memberName: string;
  targetDate: string;
  dueDate: string;
  status: MpReminderStatus;
  reason: string | null;
  errcode: number | null;
  attempts: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface MpReminderAdminData {
  rules: MpReminderRules;
  /** 最近 30 天：同意了多少、各状态的消息多少 */
  /** waiting：还没到发的那一天的同意；overdue：到了那天还没排成消息的（提醒关着、不在 10:00–20:00、或排期出错） */
  stats: { consents: number; byStatus: Partial<Record<MpReminderStatus, number>>; waiting: number; overdue: number };
  /** 网关最近一次来取消息的时间（没来过为空）：太久没来说明网关没开或连不上门店 */
  lastLeaseAt: string | null;
  /** 最近 50 条消息 */
  recent: MpReminderMessageAdmin[];
}

// ── 邀请好友（第三期 3b，docs/MP_PHASE3.md 第 2 节，MP30、MP31；接主线 v0.7.28 的 createTrialInviteFromMp）──

/** 邀请好友的设置（settings 的 mp_invite_rules，后台「微信小程序」→「邀请好友」，权限 mp.invite）：默认关 */
export interface MpInviteRules {
  enabled: boolean;
  version: number;
}
export const DEFAULT_MP_INVITE_RULES: MpInviteRules = { enabled: false, version: 0 };
export const MP_INVITE_RULES_KEY = 'mp_invite_rules';
/** 邀请码几天内有效（MP30） */
export const MP_INVITE_VALID_DAYS = 7;
export const MP_INVITE_CODE = /^[2-9A-HJ-NP-Z]{10}$/;

/** open 待领取、used 已领取、revoked 已收回、expired 过期了（7 天没人领） */
export type MpInviteState = 'open' | 'used' | 'revoked' | 'expired';

/** 好友领到的临时身份（与主线的临时身份一致） */
export interface MpInviteTrial {
  label: string;
  startsOn: string;
  endsOn: string;
  /** active 体验中、expired 到期了、converted 转正了、cancelled 撤销了 */
  status: string;
}

/** 邀请人看的一份邀请 */
export interface MpInviteItem {
  code: string;
  state: MpInviteState;
  /** 发起时好友能体验的档阶 */
  label: string;
  createdAt: string;
  expiresAt: string;
  /** 领了的：好友的名字只露第一个字（「王*」）与体验的情况 */
  friend: { name: string; trial: MpInviteTrial } | null;
}

/** 「我的 → 邀请好友」：能不能邀请、好友能体验什么、发出去的邀请 */
export interface MpInviteHome {
  open: boolean;
  /** 没开放、没绑定、会员卡合并或停用时的说明 */
  notice: string | null;
  bindVersion: number;
  option: {
    allowed: boolean;
    /** 不能邀请的原因：档级不够、本月次数用完、邀请已经发出去还没人领… */
    reason: string | null;
    /** 好友能体验的档阶（「L2 云涧 · 初」）与今天领的话到哪天 */
    label: string | null;
    endsOn: string | null;
    /** 本月已邀请几次、每月几次（不限次数为空）、怎么算（「本月」） */
    used: number;
    limit: number | null;
    limitText: string;
    /** 发出去还没人领、还在有效期里的（占着本月的次数） */
    pending: number;
  } | null;
  invites: MpInviteItem[];
}

export interface MpInviteCreated {
  code: string;
  label: string;
  expiresAt: string;
  /** 同一个编号重提：返回原来那个码 */
  replayed: boolean;
}

/** 好友打开分享卡片看到的 */
export interface MpInviteView {
  code: string;
  state: MpInviteState;
  /** 邀请人的名字只露第一个字 */
  inviterName: string;
  label: string;
  expiresAt: string;
  /** 打开的是邀请人自己的微信 */
  mine: boolean;
  /** 这个微信已经绑定了会员（领的时候验证的手机号要是这位会员的） */
  bound: boolean;
  /** 这个微信此刻的绑定状态版本号：领取时带上 */
  bindVersion: number;
}

/** 好友领到了 */
export interface MpInviteClaimed {
  code: string;
  trial: MpInviteTrial;
  /** 这个微信绑上了这位会员（之前绑着的也算）；会员已经绑了别的微信时没绑上 */
  bound: boolean;
  /** 没绑上等情况的说明 */
  notice: string | null;
  /** 同一个编号重提：返回第一次的结果 */
  replayed: boolean;
}

/** 领取结果不确定时确认作废：已经领到了返回那一次，否则登记作废（原请求之后到达也不会生效） */
export type MpInviteAbandonResult = { status: 'claimed'; claimed: MpInviteClaimed } | { status: 'abandoned' };

// ── 后台：邀请好友（权限 mp.invite）──

export interface MpInviteAdmin {
  id: number;
  code: string;
  state: MpInviteState;
  createdAt: string;
  expiresAt: string;
  inviterId: number;
  inviterName: string;
  inviteeId: number | null;
  inviteeName: string | null;
  trial: MpInviteTrial | null;
  usedAt: string | null;
}

export interface MpInviteAdminData {
  rules: MpInviteRules;
  /** 最近 30 天发起的：各状态多少 */
  stats: Record<MpInviteState, number>;
  /** 最近 50 份 */
  recent: MpInviteAdmin[];
}

// ── 扫码点餐（第三期 3c，docs/MP_PHASE3.md 第 3 节，MP32、MP33；接主线 v0.7.28 的 orderFoodFromMp）──

/** 扫码点餐的设置（settings 的 mp_food_rules，后台「微信小程序」→「扫码点餐」，权限 mp.food）：默认关、没有可点的菜 */
export interface MpFoodRules {
  enabled: boolean;
  /** 小程序可点的菜（进厨房的菜品编号）；不在这里的请服务员点 */
  itemIds: number[];
  version: number;
}
export const DEFAULT_MP_FOOD_RULES: MpFoodRules = { enabled: false, itemIds: [], version: 0 };
export const MP_FOOD_RULES_KEY = 'mp_food_rules';
/** 最多勾多少道菜 */
export const MP_FOOD_MAX_ITEMS = 300;
/** 桌码：71 + 桌台编号（6 位）+ 签名（10 位），共 18 位数字；与会员码（8、9 开头，16、19 位）、手机号（11 位）不会混 */
export const MP_TABLE_CODE = /^71\d{16}$/;
/** 一道菜的口味备注最多几个字（与主线的点单一样） */
export const MP_FOOD_NOTE_MAX = 40;

/** 小程序菜单上的一道菜 */
export interface MpFoodDish {
  id: number;
  name: string;
  /** 分组：出品档口的名字（热菜、凉菜、水吧……），按档口的顺序 */
  group: string;
  /** 单价（分） */
  price: number;
  /** null 不限量；0 今天没有了；其他为今天还剩几份 */
  remaining: number | null;
}

/** 点餐页：能不能点、在店手牌、扫到的桌、菜单 */
export interface MpFoodMenu {
  /** 扫码点餐开着（后台开了、餐饮功能开着） */
  open: boolean;
  /** 现在能不能下单；不能时 notice 写原因（没开放、没绑定、没有在店手牌、会员卡停用……） */
  canOrder: boolean;
  notice: string | null;
  /** 这个微信此刻的绑定状态版本号：下单时带上 */
  bindVersion: number;
  /** 这个微信绑定了会员（没绑定的显示「去绑定会员」） */
  bound: boolean;
  /** 在店手牌的牌号（没有为空） */
  tagCode: string | null;
  /** 扫到的桌（桌码对、桌台启用中）；扫了但不对时 tableNotice 写原因 */
  table: { code: string; name: string } | null;
  tableNotice: string | null;
  dishes: MpFoodDish[];
  /** 一单的上限：份数、金额（分），MP33 */
  limits: { maxQuantity: number; maxTotal: number };
}

export interface MpFoodLine {
  name: string;
  quantity: number;
  /** 这一行的金额（分） */
  amount: number;
  note: string;
}

/** 下单的结果 */
export interface MpFoodOrdered {
  /** 厨房出品单号 */
  orderNo: string | null;
  /** 挂在哪个手牌的账单上 */
  tagCode: string;
  /** 送到哪张桌（没扫桌码为空：服务员按手牌送） */
  deliverTo: string;
  total: number;
  lines: MpFoodLine[];
  createdAt: string;
  /** 同一个编号重提：返回第一次那一单 */
  replayed: boolean;
}

/** 下单结果不确定时确认作废：已经下了返回那一单；还没有就登记作废（原请求之后到达也不会生效），可以重新下 */
export type MpFoodAbandonResult = { status: 'ordered'; ordered: MpFoodOrdered } | { status: 'abandoned' };

/** 「我的账单」：在店手牌的账单（结账照旧在前台） */
export interface MpFoodBill {
  /** 有在店手牌 */
  open: boolean;
  /** 没绑定、没有在店手牌时的说明 */
  notice: string | null;
  tagCode: string | null;
  checkedInAt: string | null;
  /** 还有效的明细（退了的不列）；status：进厨房的菜现在的出品状态（queued 待做、cooking 制作中、done 已出餐、served 已上菜） */
  lines: { name: string; quantity: number; amount: number; postedAt: string; status: string | null }[];
  /** 明细合计（分）：会员折扣、券在前台结账时算，以前台结账为准 */
  total: number;
}

// ── 后台：扫码点餐（权限 mp.food）──

export interface MpFoodAdminDish {
  id: number;
  name: string;
  group: string;
  price: number;
  remaining: number | null;
  /** 小程序可点 */
  open: boolean;
}

export interface MpFoodAdminTable {
  id: number;
  name: string;
  area: string;
  /** 桌码（门店系统没配签名密钥 MP_CODE_SECRET 时为空） */
  code: string | null;
}

export interface MpFoodAdminOrder {
  id: number;
  createdAt: string;
  memberId: number;
  memberName: string;
  tagCode: string;
  orderNo: string | null;
  deliverTo: string;
  total: number;
  lines: MpFoodLine[];
}

export interface MpFoodAdminData {
  rules: MpFoodRules;
  /** 餐饮功能开着（后台「餐饮」里开；关着时小程序点不了） */
  diningEnabled: boolean;
  /** 门店系统配了签名密钥（MP_CODE_SECRET）才能生成桌码 */
  tableCodeReady: boolean;
  /** 进厨房的菜（餐饮里挂了档口的） */
  dishes: MpFoodAdminDish[];
  /** 启用的桌台与桌码 */
  tables: MpFoodAdminTable[];
  /** 今天（营业日）小程序下了几单、合计（分） */
  today: { orders: number; total: number };
  /** 最近 50 单 */
  recent: MpFoodAdminOrder[];
}

// ── 预约技师与派对房（第三期 3d，docs/MP_PHASE3.md 第 4 节，MP34–MP37；接主线 v0.7.28 的 bookings）──

/** 小程序预约的设置（settings 的 mp_booking_rules，后台「微信小程序」→「预约」，权限 mp.booking）：默认关、没有可约的 */
export interface MpBookingRules {
  enabled: boolean;
  /** 小程序可约的技师项目（需要技师的项目） */
  itemIds: number[];
  /** 小程序可约的房间（开单即占用的：派对房、宠物轰趴房、娱乐室……） */
  spaceIds: number[];
  version: number;
}
export const DEFAULT_MP_BOOKING_RULES: MpBookingRules = { enabled: false, itemIds: [], spaceIds: [], version: 0 };
export const MP_BOOKING_RULES_KEY = 'mp_booking_rules';
/** 项目、房间各最多勾多少 */
export const MP_BOOKING_MAX_OPTIONS = 100;
/** 小程序预约最多几位（同去的人数，派对房用） */
export const MP_BOOKING_MAX_GUESTS = 30;
/** 备注最多几个字（与主线的预约一样） */
export const MP_BOOKING_NOTE_MAX = 100;
/**
 * 小程序只给、只收开始时间离现在至少「确认的提前分钟 + 这么多分钟」的时段（独立审查 3d 的 P2）：开始前 confirmLeadMinutes
 * 还没确认的会被自动取消（MP35），再留这么久给前台确认；更近的请打电话给门店。默认 30 分钟，待确认（MP35）
 */
export const MP_BOOKING_CONFIRM_WINDOW_MINUTES = 30;

/** technician 预约技师、space 预约派对房等；room 客房（只能电话预订，「我的预约」里看得到） */
export type MpBookingKind = 'technician' | 'space' | 'room';
/** pending 待门店确认、confirmed 已预约、arrived 已到店、cancelled 已取消、no_show 爽约 */
export type MpBookingStatus = 'pending' | 'confirmed' | 'arrived' | 'cancelled' | 'no_show';

/** 「我的预约」的一张（不带门店内部信息） */
export interface MpBookingView {
  id: number;
  bookingNo: string;
  kind: MpBookingKind;
  status: MpBookingStatus;
  /** 「肩颈按摩 · 12 号技师」「派对房 A」 */
  title: string;
  startsAt: string;
  endsAt: string;
  guests: number;
  cancelReason: string | null;
  /** 现在还能在小程序自己取消（开始前 2 小时以前） */
  cancellable: boolean;
}

/** 预约页与「我的预约」：能不能约、可约的项目与房间、能约哪几天、规则、自己的预约 */
export interface MpBookingHome {
  /** 小程序预约开着、有可约的 */
  open: boolean;
  /** 没开放、没绑定、会员卡合并或停用时的说明 */
  notice: string | null;
  bindVersion: number;
  bound: boolean;
  /** 现在能不能新约；不能时 bookNotice 写原因（爽约限制、同时预约数满了） */
  canBook: boolean;
  bookNotice: string | null;
  items: { id: number; name: string; minutes: number }[];
  spaces: { id: number; name: string }[];
  /** 派对房等能约的时长（分钟） */
  durations: number[];
  /** 能约的营业日：今天到最远几天后 */
  dates: string[];
  rules: {
    /** 每人同时最多几个没到店的（MP34） */
    maxOpen: number;
    /** 开始前多少分钟以前可以自己取消 */
    cancelLeadMinutes: number;
    /** 开始前多少分钟还没确认的自动取消（MP35） */
    confirmLeadMinutes: number;
    /** 过了开始多少分钟没到店记爽约（MP37） */
    noShowMinutes: number;
    /** 开始前多少分钟以内的时段小程序不给约（确认的提前分钟 + 留给前台确认的时间），请打电话给门店 */
    minLeadMinutes: number;
  };
  bookings: MpBookingView[];
}

/** 一个可约的时段 */
export interface MpBookingSlot {
  startsAt: string;
  endsAt: string;
  /** 能约几位（预约技师「不指定」时空着的人数；房间 0 或 1） */
  free: number;
  /** 预约技师：这个时段空着的技师（只给技师号，不给名字） */
  technicians: { id: number; techNo: string }[];
}

/** 预约、取消的结果 */
export interface MpBookingDone {
  booking: MpBookingView;
  /** 同一个编号重提：返回第一次的结果 */
  replayed: boolean;
}

/** 预约、取消的结果不确定时确认作废：已经办了返回那一张；还没有就登记作废（原请求之后到达也不办） */
export type MpBookingAbandonResult = { status: 'done'; action: 'create' | 'cancel'; booking: MpBookingView } | { status: 'abandoned' };

// ── 后台：小程序预约（权限 mp.booking）──

export interface MpBookingAdminOp {
  id: number;
  createdAt: string;
  action: 'create' | 'cancel';
  memberId: number;
  memberName: string;
  bookingId: number;
  bookingNo: string;
  title: string;
  startsAt: string;
  status: MpBookingStatus;
}

export interface MpBookingAdminData {
  rules: MpBookingRules;
  /** 需要技师的项目（启用的） */
  items: { id: number; name: string; minutes: number; open: boolean }[];
  /** 开单即占用的房间（启用、可售的） */
  spaces: { id: number; name: string; code: string; open: boolean }[];
  /** 主线「预约」的规则（在后台「预约」里改）：给店主看一眼 */
  bookingRules: { openTime: string; closeTime: string; slotMinutes: number; maxDaysAhead: number; mpMaxOpen: number; confirmLeadMinutes: number; mpCancelLeadMinutes: number };
  /** 小程序来的、还待门店确认的 */
  pending: number;
  /** 最近 50 次小程序的预约、取消 */
  recent: MpBookingAdminOp[];
}
