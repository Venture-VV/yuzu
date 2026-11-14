import type { CheckoutOrderDetail } from "./orders";
import type { Grade, Tier } from "./membership";
import type { ConsumptionDoc } from "./types";
import type { CustomerAmountGrade, CUSTOMER_RATING_RULES } from "./customer-ratings";

/** Customer operations are an extension of native records. All amounts are integer cents. */
export type CustomerCreditStatus =
  "unclaimed" | "pending" | "verified" | "rejected" | "voided";
export type CustomerRechargeKind = "unknown" | "first" | "renewal";
export interface CustomerStaff {
  id: number;
  name: string;
  active: boolean;
}
export interface CustomerMemberRef {
  id: number;
  memberNo: string;
  name: string;
  phone: string;
  status: string;
}
export interface CustomerVisitMember extends CustomerMemberRef {
  grade: Grade;
  tier: Tier | null;
  gradeLabel: string;
}
export type CustomerAmountBand =
  "all" | "lt1k" | "1k-3k" | "3k-5k" | "5k-10k" | "gte10k";
export type CustomerGroupName = "A组" | "B组";
export interface CustomerMeta {
  serverTime: string;
  timezone: string;
  businessDate: string;
  capabilities: {
    manage: boolean;
    operate: boolean;
    scope: "all" | "self";
    actorId: number;
    financialReadToday: boolean;
    financialReadHistory: boolean;
    financialScope: "all" | "self";
    memberFinancialTimeline: boolean;
  };
}
export interface CustomerPage<T> extends CustomerMeta {
  rows: T[];
  offset: number;
  limit: number;
  hasMore: boolean;
  filteredTotal: number;
}
export interface CustomerBinding {
  memberId: number;
  maintainer: CustomerStaff | null;
  version: number;
  updatedAt: string | null;
}
export interface CustomerNote {
  id: number;
  memberId: number | null;
  visitId: number | null;
  content: string;
  kind: string;
  occurredAt: string;
  outcome: string;
  feedback: string;
  nextContactOn: string | null;
  createdAt: string;
  author: CustomerStaff;
}
export interface CustomerCredit {
  id: number | null;
  version: number;
  status: CustomerCreditStatus;
  rechargeKind: CustomerRechargeKind;
  ownerDepartment: "unknown" | "customer" | "frontdesk";
  claimedSeller: CustomerStaff | null;
  verifiedSeller: CustomerStaff | null;
  receptionist: CustomerStaff | null;
  /** Explicitly recorded historical owner; never inferred from today's binding. */
  ownerAtTrade: CustomerStaff | null;
  reason: string;
  updatedAt: string | null;
}
export interface CustomerRechargeRow {
  id: number;
  docNo: string;
  member: CustomerMemberRef;
  occurredAt: string;
  businessDate: string;
  paidCents: number;
  bonusCents: number;
  refundedCents: number;
  netPaidCents: number;
  paymentMethod: string;
  channel: string;
  operator: CustomerStaff;
  maintainer: CustomerStaff | null;
  credit: CustomerCredit;
}
export interface CustomerRechargePage extends CustomerPage<CustomerRechargeRow> {
  totals: {
    paidCents: number;
    bonusCents: number;
    refundedCents: number;
    netPaidCents: number;
    verifiedCreditCents: number;
    pendingPaidCents: number;
  };
  filters: {
    from: string;
    to: string;
    managerId: number | null;
    status: string;
    q: string;
    hour: number | null;
  };
}
export interface CustomerRechargeDetail extends CustomerMeta {
  recharge: CustomerRechargeRow;
  refunds: Array<{
    id: number;
    docNo: string;
    occurredAt: string;
    businessDate: string;
    amountCents: number;
    route: string;
  }>;
  note: string;
}
export interface CustomerSettlementRow {
  sourceKind: "checkout" | "consumption";
  id: number;
  docNo: string;
  occurredAt: string;
  businessDate: string;
  status: "completed" | "voided" | "reversed";
  principalCents: number | null;
  bonusCents: number | null;
  amountCents: number;
  discountedCents: number;
  refundedCents: number;
  netCents: number;
  cashReceivedCents: number;
  operator: CustomerStaff;
  tagCodes: string[];
  guestNames: string[];
  methods: string[];
}
export interface CustomerPayment {
  id: number;
  method: string;
  amountCents: number;
  payer: CustomerMemberRef | null;
  discountMember: CustomerMemberRef | null;
  consumptionId: number | null;
  principalCents: number | null;
  bonusCents: number | null;
}
export interface CustomerSettlementPage extends CustomerPage<CustomerSettlementRow> {
  totals: {
    amountCents: number;
    discountedCents: number;
    refundedCents: number;
    netCents: number;
    cashReceivedCents: number;
  };
}
export interface CustomerSettlementDetail extends CustomerMeta {
  settlement: CustomerSettlementRow;
  detail: CheckoutOrderDetail | null;
  consumption: ConsumptionDoc | null;
  payments: CustomerPayment[];
}
export interface CustomerVisitRow {
  id: number;
  visitNo: string;
  tagCode: string;
  status: string;
  checkedInAt: string;
  closedAt: string | null;
  businessDate: string;
  guestLabel: string;
  member: CustomerVisitMember | null;
  amountCents: number;
  lineCount: number;
  maintainer: CustomerStaff | null;
  lastServiceAt: string | null;
}
export interface CustomerVisitPage extends CustomerPage<CustomerVisitRow> {
  totals: {
    /** Current native front-desk population, independent of list filters/pagination. */
    inStoreCount: number;
    amountCents: number;
    filteredInStoreCount: number;
    filteredAmountCents: number;
  };
}
export interface CustomerVisitDetail extends CustomerMeta {
  visit: CustomerVisitRow;
  linesReadable: boolean;
  lines: Array<{
    id: number;
    name: string;
    quantity: number;
    unitPriceCents: number;
    amountCents: number;
    status: string;
    occurredAt: string;
  }>;
  notes: CustomerNote[];
}
export interface CustomerMember extends CustomerMemberRef {
  grade: Grade;
  tier: Tier | null;
  gradeLabel: string;
  principalCents: number;
  bonusCents: number;
  totalCents: number;
  createdAt: string;
  lastVisitAt: string | null;
  binding: CustomerBinding;
}
export interface CustomerLowBalancePage extends CustomerPage<CustomerMember> {
  thresholdCents: number;
  totals: { memberCount: number; principalCents: number; bonusCents: number; totalCents: number };
}
export interface CustomerBindingRequest {
  id: number;
  memberId: number;
  manager: CustomerStaff | null;
  version: number;
  from: CustomerStaff | null;
  requester: CustomerStaff;
  reviewer: CustomerStaff | null;
  reviewReason: string;
  status: string;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
}
export type CustomerBindingQueue = CustomerPage<
  CustomerBindingRequest & { member: CustomerMemberRef }
>;
export interface CustomerLedgerEvent {
  checkoutId: number | null;
  id: number;
  type: string;
  docNo: string;
  occurredAt: string;
  businessDate: string;
  principalDeltaCents: number;
  bonusDeltaCents: number;
  operatorName: string;
  rechargeId: number | null;
  consumptionId: number | null;
}
export interface CustomerMemberDetail extends CustomerMeta {
  member: CustomerMember;
  timeline: CustomerLedgerEvent[];
  timelineHasMore: boolean;
  timelineOffset: number;
  notes: CustomerNote[];
  bindingRequests: CustomerBindingRequest[];
}
export interface CustomerTargetRow {
  manager: CustomerStaff;
  targetCents: number | null;
  verifiedCreditCents: number;
  todayCreditCents: number;
  lastMonthSameDayCents: number;
  progress: number | null;
  version: number;
  groupName: CustomerGroupName | null;
  rank: number;
  amountGrade: CustomerAmountGrade;
}
export interface CustomerTargets extends CustomerMeta {
  month: string;
  asOfDay: string;
  departmentVerifiedCreditCents: number;
  departmentTodayCreditCents: number;
  ungroupedVerifiedCreditCents: number;
  ungroupedTodayCreditCents: number;
  departmentAmountGrade: CustomerAmountGrade;
  ratings: typeof CUSTOMER_RATING_RULES;
  departmentLastMonthSameDayCents: number | null;
  departmentTargetCents: number | null;
  assignedTargetCents: number;
  allocationDifferenceCents: number | null;
  departmentVersion: number;
  groups: Array<{
    groupName: CustomerGroupName;
    verifiedCreditCents: number;
    todayCreditCents: number;
    lastMonthSameDayCents: number;
    targetCents: number | null;
  }>;
  rows: CustomerTargetRow[];
  daily: Array<{
    day: string;
    verifiedCreditCents: number;
    targetCents: number | null;
  }>;
  history: Array<{
    id: number;
    scope: string;
    managerId: number | null;
    month: string;
    targetCents: number;
    version: number;
    createdAt: string;
  }>;
}
export interface CustomerPerformanceEvent {
  id: number;
  eventType: "recharge" | "refund";
  docNo: string;
  occurredAt: string;
  businessDate: string;
  amountCents: number;
  rechargeId: number;
  refundId: number | null;
  member: CustomerMemberRef;
  manager: CustomerStaff;
  groupName: CustomerGroupName | null;
}
export interface CustomerPerformancePage extends CustomerPage<CustomerPerformanceEvent> {
  period: "today" | "month" | "lastMonthSame";
  scope: "department" | "group" | "staff";
  asOfDay: string;
  from: string;
  to: string;
  groupName: CustomerGroupName | null;
  managerId: number | null;
  totals: { rechargeCents: number; refundCents: number; netCents: number };
}
export interface CustomerOverview extends CustomerMeta {
  day: string;
  month: string;
  metrics: {
    visitCount: number;
    inStoreCount: number;
    settlementCount: number;
    settlementDueCents: number;
    settlementNetCents: number;
    cashReceivedCents: number;
    standaloneWalletNetCents: number;
    rechargePaidCents: number;
    rechargeBonusCents: number;
    verifiedCreditCents: number;
    pendingPaidCents: number;
    unmappedRefundCents: number | null;
    monthVerifiedCreditCents: number;
    monthTargetCents: number | null;
    targetProgress: number | null;
  };
  hourly: Array<{
    hour: number;
    label: string;
    visitCount: number;
    rechargePaidCents: number;
    settlementNetCents: number;
  }>;
  payments: Array<{
    method: string;
    label: string;
    settlementCents: number;
    rechargeCents: number;
    refundCents: number;
  }>;
  managers: CustomerTargetRow[];
  /** Confirmed recharge-principal basis; never a payroll or commission calculation. */
  performanceBasis: "verified-native-recharge-principal";
}
