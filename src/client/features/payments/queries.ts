// 付款流（v0.7.32）的读：付款申请、合同的付款计划、发票、三单、质保金台账、本周应付、待办数字。
// 缓存前缀与库存、采购、货款、合同一样用 inv：审批中心同意或退回、「结果待确认」查回以后一起刷新。

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ContractPaymentPlan,
  PaymentRequestDetail,
  PaymentRequestMeta,
  PaymentRequestSummary,
  PaymentTodo,
  SupplierInvoiceView,
  ThreeWayRow,
  WarrantyRow,
  WeeklyPayables,
} from '@shared/payments';
import type { OpenItem } from '@shared/purchasing';
import { api } from '../../lib/api';

export type RequestFilter = 'all' | 'reviewing' | 'returned' | 'approved' | 'done' | 'mine';
export type WarrantyFilter = 'all' | 'due' | 'unsettled';

/** 新建申请页选的应付：标出挂合同的（要从合同申请）、没有采购单的（急采还没补单）、别的申请占着的 */
export type RequestableItem = OpenItem & { contractNo: string | null; hasPo: boolean; requestedCents: number };

export const pk = {
  all: ['inv', 'payments'] as const,
  list: (filter: RequestFilter, q: string) => ['inv', 'payments', 'list', filter, q] as const,
  one: (id: number) => ['inv', 'payments', 'one', id] as const,
  meta: ['inv', 'payments', 'meta'] as const,
  plan: (contractId: number) => ['inv', 'payments', 'plan', contractId] as const,
  openItems: (supplierId: number) => ['inv', 'payments', 'open-items', supplierId] as const,
  invoices: (q: string, status: string) => ['inv', 'payments', 'invoices', q, status] as const,
  supplierPos: (supplierId: number) => ['inv', 'payments', 'supplier-pos', supplierId] as const,
  threeWay: (pending: boolean) => ['inv', 'payments', 'three-way', pending] as const,
  threeWayPo: (poId: number) => ['inv', 'payments', 'three-way-po', poId] as const,
  warranty: (filter: WarrantyFilter) => ['inv', 'payments', 'warranty', filter] as const,
  weekly: ['inv', 'payments', 'weekly'] as const,
  todo: ['inv', 'payments', 'todo'] as const,
};

export const usePaymentRequests = (filter: RequestFilter, q: string) =>
  useQuery({
    queryKey: pk.list(filter, q),
    queryFn: () => api.get<PaymentRequestSummary[]>(`/api/erp/payments/requests?${new URLSearchParams(Object.entries({ filter, q: q.trim() }).filter(([, v]) => v) as [string, string][]).toString()}`),
    placeholderData: keepPreviousData,
  });

export const usePaymentRequest = (id: number | null) =>
  useQuery({ queryKey: pk.one(id ?? 0), queryFn: () => api.get<PaymentRequestDetail>(`/api/erp/payments/requests/${id}`), enabled: !!id });

export const usePaymentMeta = () => useQuery({ queryKey: pk.meta, queryFn: () => api.get<PaymentRequestMeta>('/api/erp/payments/meta'), staleTime: 60_000 });

/** 合同的付款计划：付款模块里用付款的接口（不要求「查看合同」），合同详情里用合同的接口 */
export const usePaymentPlan = (contractId: number | null, via: 'payments' | 'contracts' = 'payments') =>
  useQuery({
    queryKey: pk.plan(contractId ?? 0),
    queryFn: () => api.get<ContractPaymentPlan>(via === 'payments' ? `/api/erp/payments/contracts/${contractId}/plan` : `/api/erp/contracts/${contractId}/payment-plan`),
    enabled: !!contractId,
  });

export const useRequestableItems = (supplierId: number | null) =>
  useQuery({ queryKey: pk.openItems(supplierId ?? 0), queryFn: () => api.get<RequestableItem[]>(`/api/erp/payments/suppliers/${supplierId}/open-items`), enabled: !!supplierId });

export const useInvoices = (q: string, status: '' | 'valid' | 'voided') =>
  useQuery({
    queryKey: pk.invoices(q, status),
    queryFn: () => api.get<SupplierInvoiceView[]>(`/api/erp/payments/invoices?${new URLSearchParams(Object.entries({ q: q.trim(), status }).filter(([, v]) => v) as [string, string][]).toString()}`),
    placeholderData: keepPreviousData,
  });

export const useSupplierPos = (supplierId: number | null) =>
  useQuery({ queryKey: pk.supplierPos(supplierId ?? 0), queryFn: () => api.get<ThreeWayRow[]>(`/api/erp/payments/suppliers/${supplierId}/pos`), enabled: !!supplierId });

export const useThreeWay = (pending: boolean) =>
  useQuery({ queryKey: pk.threeWay(pending), queryFn: () => api.get<ThreeWayRow[]>(`/api/erp/payments/three-way?pending=${pending ? 1 : 0}`), placeholderData: keepPreviousData });

export const usePoThreeWay = (poId: number | null, enabled = true) =>
  useQuery({ queryKey: pk.threeWayPo(poId ?? 0), queryFn: () => api.get<ThreeWayRow | null>(`/api/erp/payments/three-way/po/${poId}`), enabled: enabled && !!poId });

export const useWarranty = (filter: WarrantyFilter) =>
  useQuery({ queryKey: pk.warranty(filter), queryFn: () => api.get<WarrantyRow[]>(`/api/erp/payments/warranty?filter=${filter}`), placeholderData: keepPreviousData });

export const useWeeklyPayables = () => useQuery({ queryKey: pk.weekly, queryFn: () => api.get<WeeklyPayables>('/api/erp/payments/weekly') });

export const usePaymentTodo = (enabled = true) => useQuery({ queryKey: pk.todo, queryFn: () => api.get<PaymentTodo>('/api/erp/payments/todo'), enabled, refetchInterval: 300_000 });

/** 付款、合同、货款一起刷新（付款申请会改合同的付款计划、供应商往来） */
export function useInvalidatePayments() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['inv'] });
}
