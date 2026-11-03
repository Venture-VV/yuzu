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
  member:
    | (MpMemberBrief & {
        principalBalance: number;
        bonusBalance: number;
        /** 门店的扣款规则：「先本金，后赠金」等 */
        deductionRule: string;
        grade: MpGrade;
        availableCoupons: number;
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
  category: 'coupon' | 'event' | 'service' | 'discount' | 'info';
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
