// 按实际时间补录纸质单（R1.9，店主 2026-10-29 决定要做；细则待确认，见 docs/PENDING_DECISIONS.md）

/** 只能补录这么多小时以内的业务 */
export const BACKFILL_WINDOW_HOURS = 48;

/** 预编号纸质应急单的单号：字母、数字、短横线，最多 32 位 */
export const SLIP_NO_PATTERN = /^[0-9A-Za-z-]{1,32}$/;

/** 业务请求里带的补录信息：纸质单号与纸质单上的实际时间（ISO 字符串） */
export interface BackfillRequest {
  slipNo: string;
  at: string;
}

export type BackfillKind = 'checkin' | 'charges' | 'checkout';
export const BACKFILL_KIND_LABELS: Record<BackfillKind, string> = { checkin: '接待', charges: '挂账', checkout: '结账' };

/** 单据上的补录标记：纸质单号、实际时间、补录人与录入时间 */
export interface BackfillMark {
  slipNo: string;
  actualAt: string;
  enteredByName: string;
  enteredAt: string;
}

/** 单据、历史里的一句补录说明：补录 · 纸质单 P0012（补录人 林岚） */
export const backfillText = (m: BackfillMark) => `补录 · 纸质单 ${m.slipNo}，${m.enteredByName}补录`;
