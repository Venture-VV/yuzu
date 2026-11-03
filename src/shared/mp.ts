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
}
export const DEFAULT_MP_RULES: MpRules = { enabled: false };
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
