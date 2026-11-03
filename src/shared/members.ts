// 会员渠道来源（v0.6.0，同事在测试服的反馈：会员要能看到渠道来源）。
//   · 渠道的名称与可选项由店主在管理后台「会员与渠道」维护；会员档案存渠道编号（c1、c2…），改名不影响已登记的会员，
//     渠道不能删除、只能停用（停用后新建会员不能再选，已登记的照常显示）；
//   · 会员等级 v0.7.23 起改为会员体系 v2 的档级与阶位（shared/membership.ts）。

export interface MemberChannel {
  /** 渠道编号，例如 c1；保存后不变，会员档案按它存 */
  key: string;
  label: string;
  active: boolean;
}

export const MEMBER_CHANNEL_KEY = /^c\d{1,3}$/;
export const MAX_MEMBER_CHANNELS = 30;

/** 默认渠道（汤泉常见的获客来源，待确认；店主可在后台改名、停用、新增） */
export const DEFAULT_MEMBER_CHANNELS: MemberChannel[] = [
  { key: 'c1', label: '到店自然客', active: true },
  { key: 'c2', label: '美团', active: true },
  { key: 'c3', label: '大众点评', active: true },
  { key: 'c4', label: '抖音', active: true },
  { key: 'c5', label: '老带新', active: true },
  { key: 'c6', label: '企业团购', active: true },
  { key: 'c7', label: '其他', active: true },
];

export function channelLabel(channels: readonly MemberChannel[], key: string | null | undefined): string | null {
  if (!key) return null;
  return channels.find((c) => c.key === key)?.label ?? `已删除的渠道（${key}）`;
}

/** 赠金批次（相当于账户里的赠送额度）：可用 / 已用完 / 已过期 */
export type BonusLotStatus = 'active' | 'used' | 'expired';
export const BONUS_LOT_STATUS_LABELS: Record<BonusLotStatus, string> = { active: '可用', used: '已用完', expired: '已过期' };

export interface BonusLotRow {
  id: number;
  /** recharge：充值赠送；legacy：升级前已有的赠金；restored：撤销升级前的消费恢复 */
  source: 'legacy' | 'recharge' | 'restored';
  docNo: string | null;
  amount: number;
  remaining: number;
  /** 已用（消费扣用减去撤销恢复） */
  used: number;
  /** 到期作废的金额 */
  expired: number;
  expiresAt: string | null;
  createdAt: string;
  status: BonusLotStatus;
}
