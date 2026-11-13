// 页面上可改的数值（8.0.7 A1，店主 2026-11-10：有争议的规则不要写死）：原来写死在代码里、标「待确认」的数值，
// 存在经营规则设置（settings 表，见 src/server/modules/settings.ts），在后台「门店基本规则 → 可调的数值」里改（店主）。
// 会话里随 rules 带到各页面（只读），服务端在用到的地方读一次。默认值与原来写死的一样，升级后行为不变。

import { APPROVAL_BATCH_MAX, APPROVAL_BATCH_MAX_CENTS, APPROVAL_OVERDUE_HOURS, DELEGATION_MAX_DAYS, URGENT_BACKFILL_ESCALATE_DAYS } from './approvals';
import { MAX_CAMPAIGN_MEMBERS, ISSUED_NOTICE_DAYS } from './coupon-campaigns';
import { CONTRACT_EXPIRY_REMIND_DAYS } from './contracts';
import { MP_FOOD_ORDER_LIMITS } from './dining';
import { PRINT_WAIT_MAX_MS } from './devices';
import { MAX_PDF_BYTES, MAX_RECEIPT_ATTACHMENTS } from './inventory';
import { PLATFORM_BACKFILL_DAYS } from './platform';
import { DEFAULT_CONSUMPTION_PURPOSES } from './supply';

/**
 * 打印方式（店主 2026-11-10：设置打印功能就行，连接打印机让各自的电脑去负责）：
 * local = 本机打印：各台电脑用浏览器打印到自己连的打印机，服务器不连门店的小票机（正式服在云上时用这个）；
 * network = 网口小票机：服务器直接把单据发到登记的网口小票机（v0.7.28 ⑥，服务器和打印机在同一个局域网里才行）。
 */
export const PRINT_MODES = ['local', 'network'] as const;
export type PrintMode = (typeof PRINT_MODES)[number];
export const PRINT_MODE_LABELS: Record<PrintMode, string> = { local: '本机打印（各电脑自己连打印机）', network: '服务器直连网口小票机' };

/** 可调的数值（都在 StoreRules 上） */
export interface Tunables {
  /** A5 批量同意：每张不超过（分） */
  approvalBatchMaxCents: number;
  /** A5 批量同意：一次最多几张 */
  approvalBatchMax: number;
  /** A6 当前这一级等了超过几小时算超时 */
  approvalOverdueHours: number;
  /** A7 代理人最多几天（含首尾） */
  delegationMaxDays: number;
  /** A10 急采收货生效后超过几天没补采购单进负责人待办 */
  urgentEscalateDays: number;
  /** C11 合同结束日前几天进待办 */
  contractRemindDays: number;
  /** CG08 上传的 PDF（签约供应商合同、收货附件、合同扫描件）每份最大（MB） */
  pdfMaxMb: number;
  /** CG11 每张收货单最多几份附件 */
  receiptAttachmentsMax: number;
  /** N1 小程序扫码点餐：一单最多几份 */
  mpFoodMaxQuantity: number;
  /** N1 小程序扫码点餐：一单最多多少钱（分） */
  mpFoodMaxTotalCents: number;
  /** N6 平台核销补录：最早能补到几天前 */
  platformBackfillDays: number;
  /** 打印方式（店主 2026-11-10） */
  printMode: PrintMode;
  /** N7 网口小票机断网时单据最多等几分钟（只在「服务器直连网口小票机」时用） */
  printWaitMinutes: number;
  /** HY07 批量发券一次最多发给几位会员 */
  campaignMaxMembers: number;
  /** HY16 到账的会员端弹窗最多显示几天 */
  campaignNoticeDays: number;
  /** HY08 短信发不出去最多试几次 */
  smsMaxAttempts: number;
  /** HY14 有财务职责（对账付款、成本核算）的账号看不到营销成本测算（默认是；关掉以后按岗位权限给） */
  financeHidesMarketingCost: boolean;
  // ── 8.0.7 供应链收尾与应收（docs/ERP_V807.md 第 6 节，V1–V20）──
  /** V2 采购单只能给已准入的供应商（关着时只提醒） */
  supplierApprovedOnly: boolean;
  /** V3 证照到期前几天进待办 */
  licenseRemindDays: number;
  /** V5 季度评分低于几分进观察名单 */
  supplierWatchScore: number;
  /** V6 部门耗用的用途 */
  consumptionPurposes: string[];
  /** V7 有结存、多少天没出库算呆滞 */
  slowMovingDays: number;
  /** V9 合同最近一次验收不合格时挂起付款 */
  acceptanceHoldsPayment: boolean;
  /** V10 对账确认链接有效几天 */
  reconLinkDays: number;
  /** V14 应收（挂账、平台）超过几天没回进待办 */
  arOverdueDays: number;
  /** V18 批次到期前几天进待办 */
  expiryRemindDays: number;
  /** V20 每周一把本周应付、待审批等推到企业微信群（机器人地址在服务器 .env 的 ERP_WECOM_WEBHOOK） */
  wecomWeeklyPush: boolean;
}

export const DEFAULT_TUNABLES: Tunables = {
  approvalBatchMaxCents: APPROVAL_BATCH_MAX_CENTS,
  approvalBatchMax: APPROVAL_BATCH_MAX,
  approvalOverdueHours: APPROVAL_OVERDUE_HOURS,
  delegationMaxDays: DELEGATION_MAX_DAYS,
  urgentEscalateDays: URGENT_BACKFILL_ESCALATE_DAYS,
  contractRemindDays: CONTRACT_EXPIRY_REMIND_DAYS,
  pdfMaxMb: MAX_PDF_BYTES / (1024 * 1024),
  receiptAttachmentsMax: MAX_RECEIPT_ATTACHMENTS,
  mpFoodMaxQuantity: MP_FOOD_ORDER_LIMITS.maxQuantity,
  mpFoodMaxTotalCents: MP_FOOD_ORDER_LIMITS.maxTotalCents,
  platformBackfillDays: PLATFORM_BACKFILL_DAYS,
  printMode: 'local',
  printWaitMinutes: PRINT_WAIT_MAX_MS / 60_000,
  campaignMaxMembers: MAX_CAMPAIGN_MEMBERS,
  campaignNoticeDays: ISSUED_NOTICE_DAYS,
  smsMaxAttempts: 3,
  financeHidesMarketingCost: true,
  supplierApprovedOnly: false,
  licenseRemindDays: 30,
  supplierWatchScore: 70,
  consumptionPurposes: [...DEFAULT_CONSUMPTION_PURPOSES],
  slowMovingDays: 90,
  acceptanceHoldsPayment: true,
  reconLinkDays: 14,
  arOverdueDays: 60,
  expiryRemindDays: 30,
  wecomWeeklyPush: false,
};

/** 整数项的取值范围（页面与服务端同一份） */
export const TUNABLE_LIMITS = {
  approvalBatchMaxCents: { min: 100, max: 100_000_000, label: '批量同意每张的金额上限' },
  approvalBatchMax: { min: 1, max: 200, label: '批量同意一次最多几张' },
  approvalOverdueHours: { min: 1, max: 720, label: '审批超时的小时数' },
  delegationMaxDays: { min: 1, max: 366, label: '代理最多几天' },
  urgentEscalateDays: { min: 1, max: 60, label: '急采待补单升级的天数' },
  contractRemindDays: { min: 1, max: 365, label: '合同到期提醒的天数' },
  // 文件库（erp_files）里 PDF 最大 10 MB（迁移 083 的约束），这里只能往小调
  pdfMaxMb: { min: 1, max: 10, label: 'PDF 每份最大（MB）' },
  receiptAttachmentsMax: { min: 1, max: 30, label: '每张收货单最多几份附件' },
  mpFoodMaxQuantity: { min: 1, max: 200, label: '扫码点餐一单最多几份' },
  mpFoodMaxTotalCents: { min: 100, max: 10_000_000, label: '扫码点餐一单最多多少钱' },
  platformBackfillDays: { min: 1, max: 366, label: '平台核销最早补到几天前' },
  printWaitMinutes: { min: 1, max: 1440, label: '小票机断网时最多等几分钟' },
  campaignMaxMembers: { min: 1, max: 20_000, label: '批量发券一次最多几位' },
  campaignNoticeDays: { min: 1, max: 90, label: '到账弹窗最多显示几天' },
  smsMaxAttempts: { min: 1, max: 10, label: '短信最多试几次' },
  licenseRemindDays: { min: 1, max: 365, label: '证照到期前几天提醒' },
  supplierWatchScore: { min: 1, max: 100, label: '低于几分进观察名单' },
  slowMovingDays: { min: 7, max: 365, label: '多少天没出库算呆滞' },
  reconLinkDays: { min: 1, max: 90, label: '对账确认链接有效几天' },
  arOverdueDays: { min: 1, max: 365, label: '应收超过几天没回提醒' },
  expiryRemindDays: { min: 1, max: 365, label: '批次到期前几天提醒' },
} as const satisfies Partial<Record<keyof Tunables, { min: number; max: number; label: string }>>;
export type IntTunable = keyof typeof TUNABLE_LIMITS;
export const INT_TUNABLES = Object.keys(TUNABLE_LIMITS) as IntTunable[];

export const pdfMaxBytes = (t: Pick<Tunables, 'pdfMaxMb'>) => t.pdfMaxMb * 1024 * 1024;

/** 开关项（8.0.7）：页面上是勾选框 */
export const BOOL_TUNABLES = ['financeHidesMarketingCost', 'supplierApprovedOnly', 'acceptanceHoldsPayment', 'wecomWeeklyPush'] as const;
export type BoolTunable = (typeof BOOL_TUNABLES)[number];
