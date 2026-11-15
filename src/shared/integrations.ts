// 对外接口（8.0.21，docs/INTEGRATIONS_V8021.md）：前后端共用的类型与门店开关。
// 模式（off / mock / live）只由运行环境决定（服务端 integrations/config.ts）；门店开关在后台「对外接口」里改，默认开（功能开关默认开，店主 2026-11-14）。

export type IntegrationMode = 'off' | 'mock' | 'live';
export const INTEGRATION_MODE_LABELS: Record<IntegrationMode, string> = { off: '没配置', mock: '模拟（只在开发、测试）', live: '已配置，等联调' };

export interface IntegrationSwitches {
  /** 结账、充值的「扫码收款」 */
  payTerminal: boolean;
  /** 结账登记团购券时向平台验券 */
  platformVoucher: boolean;
  /** 平台验券每天自动对账的时间（HH:MM，营业日切换之后） */
  voucherReconcileAt: string;
}
export const DEFAULT_INTEGRATION_SWITCHES: IntegrationSwitches = { payTerminal: true, platformVoucher: true, voucherReconcileAt: '06:10' };

// ── 扫码收款（CW-G） ──
export type PayProvider = 'wechat' | 'alipay';
export type PayPurpose = 'checkout' | 'recharge';
export type PayTxStatus = 'paying' | 'paid' | 'failed' | 'closed';
export const PAY_TX_STATUS_LABELS: Record<PayTxStatus, string> = { paying: '支付中', paid: '已到账', failed: '没付成', closed: '已撤单' };
export type PayRefundStatus = 'pending' | 'done' | 'failed' | 'offline';
export const PAY_REFUND_STATUS_LABELS: Record<PayRefundStatus, string> = { pending: '退款中', done: '已原路退回', failed: '退款失败', offline: '线下已退' };

export interface PayRefundView {
  id: number;
  txId: number;
  outRefundNo: string;
  amountCents: number;
  reason: string;
  status: PayRefundStatus;
  providerRefundNo: string | null;
  failReason: string | null;
  offlineNote: string | null;
  refundNo: string | null;
  staffName: string;
  createdAt: string;
}

export interface PayTxView {
  id: number;
  outTradeNo: string;
  provider: PayProvider;
  purpose: PayPurpose;
  amountCents: number;
  status: PayTxStatus;
  providerTradeNo: string | null;
  paidAt: string | null;
  failReason: string | null;
  refundCents: number;
  /** 用在哪：结账单号 / 充值单号；没入账为空 */
  consumed: { kind: PayPurpose; id: number; docNo: string } | null;
  staffName: string;
  createdAt: string;
  refunds: PayRefundView[];
}

export interface PayTerminalStatus {
  mode: IntegrationMode;
  enabled: boolean;
}

/** 付款码：微信 18 位（10–15 开头）、支付宝 16–24 位（25–30 开头）；这里只核对是数字、长度合理 */
export const AUTH_CODE_PATTERN = /^\d{16,24}$/;

// ── 平台验券（CW-H） ──
export type VoucherPlatform = 'meituan' | 'douyin';
export const VOUCHER_PLATFORMS: readonly VoucherPlatform[] = ['meituan', 'douyin'];
export type VerificationStatus = 'verifying' | 'verified' | 'failed' | 'cancelled' | 'recorded';
export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = { verifying: '核销中', verified: '已核销', failed: '没核销成', cancelled: '已撤销核销', recorded: '已转补录' };

export interface VoucherPreview {
  platform: VoucherPlatform;
  code: string;
  dealName: string;
  faceCents: number;
  settleCents: number;
  quantity: number;
}

export interface VerificationView {
  id: number;
  platform: VoucherPlatform;
  code: string;
  dealName: string;
  faceCents: number;
  settleCents: number;
  quantity: number;
  status: VerificationStatus;
  verifyNo: string | null;
  failReason: string | null;
  /** 用在哪张结账单；没用为空 */
  checkout: { id: number; checkoutNo: string } | null;
  redemptionNo: string | null;
  staffName: string;
  createdAt: string;
  verifiedAt: string | null;
  /** 撤销核销已经占住、还没有结果（正在问平台，或上一次平台没回应）：不能用、不能转补录，可以再点撤销 */
  cancelling: boolean;
}

export type ReconIssueKind = 'platform_only' | 'system_only' | 'amount_diff';
export const RECON_ISSUE_LABELS: Record<ReconIssueKind, string> = { platform_only: '平台有、系统没有', system_only: '系统有、平台没有', amount_diff: '金额不同' };
export interface PlatformReconIssue {
  id: number;
  platform: VoucherPlatform;
  businessDate: string;
  kind: ReconIssueKind;
  code: string;
  dealName: string;
  platformCents: number | null;
  systemCents: number | null;
  systemRef: string;
  resolvedByName: string | null;
  resolvedAt: string | null;
  resolveNote: string | null;
}
export interface PlatformReconRun {
  id: number;
  platform: VoucherPlatform;
  businessDate: string;
  ok: boolean;
  error: string | null;
  platformLines: number;
  systemLines: number;
  issues: number;
  staffName: string | null;
  createdAt: string;
}
