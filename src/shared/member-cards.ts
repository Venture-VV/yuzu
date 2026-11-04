// 会员实体卡（v0.7.28 ⑦，docs/SCHEDULE_FINISH.md 第 8 节，N8 待确认）：发卡、刷卡找会员、挂失、补卡。
// 卡只是认人：钱照旧在会员钱包里。读卡器（RC300、商米 NFC）按「模拟键盘」把卡号打进查找框，或经终端设备服务（桥）报上来；也可以手输。

import { MP_CODE } from './mp';
import type { MemberSummary } from './types';

/** 卡号：读到的号去掉空格、横线，转大写；4–32 位数字字母 */
export const MEMBER_CARD_RE = /^[0-9A-Z]{4,32}$/;
export const normalizeCardNo = (raw: string): string => raw.replace(/[\s-]/g, '').toUpperCase();
/** 像卡号（查找框里刷卡时用）：会员码（16 或 19 位、以 8 或 9 开头）不算 */
export const looksLikeCardNo = (raw: string): boolean => {
  const s = normalizeCardNo(raw);
  return MEMBER_CARD_RE.test(s) && !MP_CODE.test(s);
};

export const MEMBER_CARD_STATUSES = ['active', 'lost', 'canceled'] as const;
export type MemberCardStatus = (typeof MEMBER_CARD_STATUSES)[number];
export const MEMBER_CARD_STATUS_LABELS: Record<MemberCardStatus, string> = { active: '在用', lost: '已挂失', canceled: '已换下' };

export interface MemberCard {
  id: number;
  cardNo: string;
  memberId: number;
  status: MemberCardStatus;
  issuedAt: string;
  issuedByName: string;
  /** 补卡时换下的那一张 */
  replacesId: number | null;
  note: string;
  endedAt: string | null;
  endedByName: string | null;
  endReason: string | null;
}

/** 刷卡找会员：在用的卡给出会员（合并过的找到合并到的那位）；挂失的卡给出卡主（提醒扣下卡、核对身份）；没发过的 unknown */
export interface MemberCardLookup {
  cardNo: string;
  status: MemberCardStatus | 'unknown';
  member: MemberSummary | null;
}
