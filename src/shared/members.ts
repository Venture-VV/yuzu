// 会员渠道来源与会员等级（v0.6.0，同事在测试服的反馈：会员要能看到渠道来源、等级、升级时间、差多少到下一级）。
//   · 渠道的名称与可选项由店主在管理后台「会员与渠道」维护；会员档案存渠道编号（c1、c2…），改名不影响已登记的会员，
//     渠道不能删除、只能停用（停用后新建会员不能再选，已登记的照常显示）；
//   · 会员等级沿用前台规则里的口径与门槛（累计充值实收或当前余额，VIP 柜也按它核对），v0.6.0 加上各级名称；
//     等级有效期：累计充值口径不降级，长期有效；余额口径随余额升降（待确认，见 docs/PENDING_DECISIONS.md）。

import type { VipLevelBasis } from './frontdesk';

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

/** 各级会员的默认名称（待确认）：第 1 级起；没起名的级别显示「第 N 级」 */
export const DEFAULT_LEVEL_NAMES = ['普通会员', '银卡会员', '金卡会员', '铂金会员', '钻石会员'];
export const MAX_LEVEL_NAME_LENGTH = 8;

export function levelName(level: number, names: readonly string[]): string {
  if (level <= 0) return '未达第 1 级';
  return names[level - 1]?.trim() || `第 ${level} 级`;
}

export interface LevelChange {
  at: string;
  from: number;
  to: number;
  fromName: string;
  toName: string;
}

/** 会员详情里的等级：当前等级、达到时间、到下一级还差多少、升降级记录 */
export interface MemberLevelInfo {
  basis: VipLevelBasis;
  /** 口径金额：累计充值实收（含期初导入的旧系统累计充值）或当前余额（分） */
  amountCents: number;
  level: number;
  name: string;
  /** 达到当前等级的时间；0 级或没有记录时为空 */
  since: string | null;
  next: { level: number; name: string; thresholdCents: number; gapCents: number } | null;
  /** 升降级记录，最近的在前（最多 20 条） */
  history: LevelChange[];
  /** 等级有效期的说明 */
  validity: string;
}

export const LEVEL_VALIDITY: Record<VipLevelBasis, string> = {
  recharge: '长期有效（按累计充值计算，不降级）',
  balance: '随余额升降（余额减少到门槛以下即降级）',
};

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
