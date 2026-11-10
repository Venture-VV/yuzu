// 批量发券（8.0.4 需求表 06，docs/MEMBERSHIP_V804.md 第 6 节）：按档级、标签圈一批会员发券；通知两个开关——短信、会员端弹窗
// （到账当天起弹，到期前 N 天再弹一次）。前后端共用。

import type { TagMatchMode } from './member-tags';

/** 一次最多发给多少位会员（HY07）；每批几位一个事务 */
export const MAX_CAMPAIGN_MEMBERS = 2000;
export const CAMPAIGN_CHUNK = 200;
/** 会员端弹窗：到期前几天再提醒（默认 7，1–30） */
export const DEFAULT_REMIND_DAYS = 7;
export const MAX_REMIND_DAYS = 30;
/** 到账的弹窗最多显示几天 */
export const ISSUED_NOTICE_DAYS = 30;

/** 圈选条件：档级（空 = 全部）、标签（空 = 不按标签；mode 任一 / 同时有） */
export interface CampaignAudience {
  grades: number[];
  tagIds: number[];
  tagMode: TagMatchMode;
}

export interface CampaignPreview {
  /** 圈到几位（在用的会员：没停用、没合并） */
  count: number;
  /** 其中档级不在券模板限定里、会跳过的人数 */
  outOfLevel: number;
  /** 前 20 位 */
  sample: { id: number; memberNo: string; name: string; gradeLabel: string }[];
  /** 发出去的券有效期到哪天（固定有效期的模板过期了为空） */
  validTo: string | null;
  tooMany: boolean;
}

export type CampaignStatus = 'issuing' | 'done';
export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = { issuing: '发放中', done: '已发完' };

export type SmsStatus = 'pending' | 'sent' | 'failed' | 'cancelled';
export const SMS_STATUS_LABELS: Record<SmsStatus, string> = { pending: '待发', sent: '已发', failed: '发送失败', cancelled: '已取消' };

export interface CouponCampaign {
  id: number;
  campaignNo: string;
  templateId: number;
  templateName: string;
  templateSummary: string;
  quantity: number;
  audience: CampaignAudience & { tagNames: string[] };
  /** 「L2–L4 · 标签：亲子客、商务客（任一）」 */
  audienceText: string;
  reason: string;
  notifySms: boolean;
  notifyPopup: boolean;
  remindDays: number | null;
  status: CampaignStatus;
  targeted: number;
  issued: number;
  skipped: number;
  pending: number;
  sms: Record<SmsStatus, number>;
  notices: { total: number; read: number };
  businessDate: string;
  createdAt: string;
  createdByName: string;
  finishedAt: string | null;
}

export interface CouponCampaignDetail extends CouponCampaign {
  skippedMembers: { memberId: number; memberNo: string; name: string; reason: string }[];
  /** 短信通道：没配的待发短信只能导出手动发 */
  smsProvider: string | null;
}

/** 会员端提醒（小程序弹窗） */
export type MemberNoticeKind = 'coupon_issued' | 'coupon_expiring';
export interface MemberNotice {
  id: number;
  kind: MemberNoticeKind;
  title: string;
  body: string;
  showFrom: string;
  showUntil: string;
  createdAt: string;
  readAt: string | null;
}

/** 短信全文（没配短信通道时导出手动发也用它）：「【门店名】您收到 2 张「50 元代金券」，有效期至 2026-12-31，到店出示会员码即可使用。」 */
export function smsContent(store: string, count: number, coupon: string, validTo: string): string {
  return `【${store}】您收到 ${count} 张「${coupon}」，有效期至 ${validTo}，到店出示会员码即可使用。`;
}

/** 档级的说明：「全部档级」「L0、L2」「L2–L4」 */
export function gradesText(grades: readonly number[]): string {
  if (!grades.length) return '全部档级';
  const g = [...grades].sort((a, b) => a - b);
  const contiguous = g.every((x, i) => i === 0 || x === g[i - 1]! + 1);
  return contiguous && g.length > 2 ? `L${g[0]}–L${g[g.length - 1]}` : g.map((x) => `L${x}`).join('、');
}
