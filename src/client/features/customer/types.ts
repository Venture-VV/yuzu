import type { CustomerBindingRequest, CustomerMember, CustomerRechargeRow, CustomerStaff } from "@shared/customer";
export type CustomerTab = "overview" | "visits" | "daily" | "targets" | "members" | "lowBalances";
export type RecordKind = "visit" | "recharge" | "settlement" | "consumption" | "member";
export type OpenRecord = (kind: RecordKind, id: number) => void;
export type CustomerForm =
  | { kind: "note"; memberId?: number; visitId?: number; noteKind: "reception" | "maintenance"; label: string }
  | { kind: "binding"; member: CustomerMember }
  | { kind: "bindingReview"; request: CustomerBindingRequest }
  | { kind: "credit"; recharge: CustomerRechargeRow }
  | { kind: "creditReview"; recharge: CustomerRechargeRow }
  | { kind: "target"; month: string; staffId: number | null; label: string; amountCents: number | null; version: number; groupName?: "A组" | "B组" | null };
export type OpenForm = (form: CustomerForm) => void;
export type Filters = { query: string; managerId: string; status: string; hour: string; amountBand: string; offset: number };
export const emptyFilters: Filters = { query: "", managerId: "", status: "", hour: "", amountBand: "", offset: 0 };
export const creditStatus = { unclaimed: "未申报归属", pending: "归属待核", verified: "已核定", rejected: "已驳回", voided: "已撤销" } as const;
export const kindLabel = { unknown: "首续待核", first: "首办", renewal: "续充" } as const;
export const staffName = (staff: CustomerStaff | null | undefined) => staff?.name || "未登记";
