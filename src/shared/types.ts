// 前后端共用的接口数据结构。金额字段均为整数「分」。

import type { DeductionRule, WalletBalance } from './deduction';
import type { EntryType, PaymentMethod } from './labels';
import type { Duty, Permission, Role } from './permissions';

export type AppEnv = 'development' | 'trial' | 'production' | 'test';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export interface StaffBrief {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  duties: Duty[];
  mustChangePassword: boolean;
}

export interface StoreRules {
  deductionRule: DeductionRule;
  businessDayStartHour: number;
  maxRechargeCents: number;
  maxConsumeCents: number;
}

export interface SessionInfo {
  staff: StaffBrief;
  permissions: Permission[];
  storeName: string;
  rules: StoreRules;
  /** 当前营业日 YYYY-MM-DD */
  today: string;
  timezone: string;
  env: AppEnv;
  version: string;
  /** 库里存在合成演示数据 */
  hasSyntheticData: boolean;
}

export interface MemberSummary {
  id: number;
  memberNo: string;
  name: string;
  phone: string;
  gender: 'female' | 'male' | null;
  birthday: string | null;
  note: string;
  principalBalance: number;
  bonusBalance: number;
  status: 'active' | 'frozen';
  isSynthetic: boolean;
  createdAt: string;
  lastActivityAt: string | null;
}

export interface MemberDetail extends MemberSummary {
  createdByName: string | null;
  stats: {
    totalPaid: number;
    totalBonusGranted: number;
    rechargeCount: number;
    totalConsumed: number;
    consumeCount: number;
    reversedCount: number;
  };
}

export interface RechargePlan {
  id: number;
  name: string;
  payAmount: number;
  bonusAmount: number;
  note: string;
  active: boolean;
  sortOrder: number;
}

export interface ServiceItem {
  id: number;
  name: string;
  category: string;
  price: number;
  active: boolean;
  sortOrder: number;
}

export interface Catalog {
  plans: RechargePlan[];
  items: ServiceItem[];
}

export interface RechargeDoc {
  id: number;
  docNo: string;
  memberId: number;
  planId: number | null;
  planName: string | null;
  paidAmount: number;
  bonusAmount: number;
  paymentMethod: PaymentMethod;
  paymentRef: string;
  note: string;
  businessDate: string;
  operatorName: string;
  createdAt: string;
}

export interface ConsumptionLine {
  id: number;
  itemId: number | null;
  name: string;
  unitPrice: number;
  quantity: number;
  amount: number;
}

export interface ReversalBrief {
  id: number;
  docNo: string;
  reason: string;
  businessDate: string;
  operatorName: string;
  createdAt: string;
}

export interface ConsumptionDoc {
  id: number;
  docNo: string;
  memberId: number;
  totalAmount: number;
  principalAmount: number;
  bonusAmount: number;
  deductionRule: DeductionRule;
  note: string;
  status: 'completed' | 'reversed';
  businessDate: string;
  operatorName: string;
  createdAt: string;
  lines: ConsumptionLine[];
  reversal: ReversalBrief | null;
}

export interface ReversalDoc {
  id: number;
  docNo: string;
  consumptionId: number;
  consumptionDocNo: string;
  memberId: number;
  principalAmount: number;
  bonusAmount: number;
  reason: string;
  businessDate: string;
  operatorName: string;
  createdAt: string;
}

interface OperationBase {
  /** true 表示这是一次重复提交，返回的是第一次已入账的结果 */
  replayed: boolean;
  balanceBefore: WalletBalance;
  balanceAfter: WalletBalance;
  member: MemberSummary;
}

export type OperationResult =
  | (OperationBase & { type: 'recharge'; recharge: RechargeDoc })
  | (OperationBase & { type: 'consume'; consumption: ConsumptionDoc })
  | (OperationBase & { type: 'reversal'; reversal: ReversalDoc; consumption: ConsumptionDoc });

export type OperationLookup = { found: false } | ({ found: true } & OperationResult);

export interface LedgerRow {
  id: number;
  entryType: EntryType;
  docNo: string;
  memberId: number;
  memberNo: string;
  memberName: string;
  memberPhone: string;
  principalDelta: number;
  bonusDelta: number;
  principalAfter: number;
  bonusAfter: number;
  businessDate: string;
  createdAt: string;
  operatorName: string;
  rechargeId: number | null;
  consumptionId: number | null;
  reversalId: number | null;
  /** 充值实收 */
  paidAmount: number | null;
  paymentMethod: PaymentMethod | null;
  /** 消费单当前状态 */
  consumptionStatus: 'completed' | 'reversed' | null;
  /** 消费单对应的撤销单号 / 撤销单对应的原消费单号 */
  relatedDocNo: string | null;
  /** 撤销单的原消费营业日，跨日撤销时与本行营业日不同 */
  relatedBusinessDate: string | null;
  /** 消费项目摘要 / 撤销原因 / 充值套餐 */
  summary: string;
}

export interface SettlementCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface SettlementAnomaly {
  kind: 'reversal' | 'cross_day_reversal' | 'duplicate_blocked' | 'rejected' | 'balance_mismatch' | 'chain_break';
  at: string | null;
  docNo: string | null;
  memberName: string | null;
  description: string;
  amount: number | null;
}

export interface SettlementTotals {
  recharge: { count: number; paid: number; bonus: number; byMethod: { method: PaymentMethod; count: number; amount: number }[] };
  consume: { count: number; total: number; principal: number; bonus: number; reversedCount: number };
  reversal: { count: number; principal: number; bonus: number; crossDayCount: number };
  /** 本营业日流水的余额净变动 */
  net: WalletBalance;
}

export interface SettlementSummary extends SettlementTotals {
  businessDate: string;
  isToday: boolean;
  isFuture: boolean;
  balances: { opening: WalletBalance; closing: WalletBalance; membersNow: WalletBalance; ledgerNow: WalletBalance };
  checks: SettlementCheck[];
  anomalies: SettlementAnomaly[];
  byStaff: {
    staffId: number;
    name: string;
    rechargeCount: number;
    rechargePaid: number;
    consumeCount: number;
    consumeTotal: number;
    reversalCount: number;
  }[];
  closed: {
    closedAt: string;
    closedByName: string;
    note: string;
    revision: number;
    /** 日结确认后数据是否又有变动 */
    changedSinceClose: boolean;
  } | null;
}

export interface StaffRecord {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  duties: Duty[];
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AuditRecord {
  id: number;
  action: string;
  staffName: string | null;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}
