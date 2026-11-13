// 企业微信每周一推（8.0.7 A4，docs/ERP_V807.md 第 4 节，V19、V20）：经营规则页上看推送状态、「发一条试试」。

/** 推送时间（V19）：每周一这个钟点以后（门店时区） */
export const WECOM_WEEKLY_AT = '09:00';
/** 发不出去最多试几次（每次隔 5 分钟） */
export const WECOM_MAX_ATTEMPTS = 3;

export type WecomPushKind = 'weekly' | 'test';
export type WecomPushStatus = 'sending' | 'sent' | 'failed';

export interface WecomPushView {
  id: number;
  kind: WecomPushKind;
  /** 每周一推：那一周的周一 */
  periodKey: string | null;
  status: WecomPushStatus;
  content: string;
  error: string | null;
  attempts: number;
  createdAt: string;
  finishedAt: string | null;
  createdByName: string | null;
}

export interface WecomStatus {
  /** 服务器 .env 配了 ERP_WECOM_WEBHOOK（格式对） */
  configured: boolean;
  /** 配了但格式不对（要 https 的机器人地址） */
  invalid: boolean;
  /** 「门店基本规则 → 可调的数值」里的开关（V20） */
  enabled: boolean;
  /** 最近几次（新的在前） */
  recent: WecomPushView[];
}

export interface WecomTestResult {
  ok: boolean;
  error: string | null;
  push: WecomPushView;
}
