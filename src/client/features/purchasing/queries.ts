import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApOffsetDoc,
  ErpImportRecord,
  OpeningPayableDoc,
  OpenItem,
  PayablesOverview,
  PaymentDoc,
  PoSummary,
  PriceCompare,
  PurchaseOrder,
  PriceHistory,
  PurchaseRules,
  ReplenishSuggestions,
  SourcingEvent,
  SourcingSummary,
  Statement,
  SupplierCredit,
  SupplierRefundDoc,
} from '@shared/purchasing';
import { api } from '../../lib/api';

export const pk = {
  all: ['inv'] as const,
  pos: (params: Record<string, string | undefined>) => ['inv', 'pos', params] as const,
  po: (id: number) => ['inv', 'po', id] as const,
  overview: ['inv', 'payables'] as const,
  openItems: (supplierId: number) => ['inv', 'open-items', supplierId] as const,
  statement: (supplierId: number, from: string, to: string) => ['inv', 'statement', supplierId, from, to] as const,
  payments: (params: Record<string, string | undefined>) => ['inv', 'payments', params] as const,
  payment: (id: number) => ['inv', 'payment', id] as const,
  openings: (params: Record<string, string | undefined>) => ['inv', 'openings', params] as const,
  opening: (id: number) => ['inv', 'opening', id] as const,
  baseline: (materialId: number) => ['inv', 'baseline', materialId] as const,
  credits: (supplierId: number) => ['inv', 'credits', supplierId] as const,
  offsets: (params: Record<string, string | undefined>) => ['inv', 'offsets', params] as const,
  offset: (id: number) => ['inv', 'offset', id] as const,
  refunds: (params: Record<string, string | undefined>) => ['inv', 'refunds', params] as const,
  refund: (id: number) => ['inv', 'refund', id] as const,
  imports: ['inv', 'erp-imports'] as const,
  purchaseRules: ['inv', 'purchase-rules'] as const,
  suggestions: ['inv', 'purchase-suggestions'] as const,
  sourcingList: (params: Record<string, string | undefined>) => ['inv', 'sourcing', params] as const,
  sourcing: (id: number) => ['inv', 'sourcing-one', id] as const,
  priceHistory: (materialId: number) => ['inv', 'price-history', materialId] as const,
};

/** 采购、货款与库存共用一个缓存前缀：任何单据变化后一起刷新 */
export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: pk.all });
}

const search = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();

export const usePos = (params: { status?: string; supplierId?: string; q?: string; open?: string }, enabled = true) =>
  useQuery({
    queryKey: pk.pos(params),
    queryFn: () => api.get<PoSummary[]>(`/api/purchase-orders?${search(params)}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const usePo = (id: number | null) =>
  useQuery({ queryKey: pk.po(id ?? 0), queryFn: () => api.get<PurchaseOrder>(`/api/purchase-orders/${id}`), enabled: !!id });

export const useBaseline = (materialId: number) =>
  useQuery({
    queryKey: pk.baseline(materialId),
    queryFn: () => api.get<{ baseline: PriceCompare['baseline']; priceBasis: string }>(`/api/purchase-baseline?materialId=${materialId}`),
    staleTime: 60_000,
  });

export const usePayablesOverview = (enabled = true) =>
  useQuery({ queryKey: pk.overview, queryFn: () => api.get<PayablesOverview>('/api/payables/overview'), enabled });

export const useOpenItems = (supplierId: number | null) =>
  useQuery({
    queryKey: pk.openItems(supplierId ?? 0),
    queryFn: () => api.get<OpenItem[]>(`/api/payables/suppliers/${supplierId}/open-items`),
    enabled: !!supplierId,
  });

export const useStatement = (supplierId: number | null, from: string, to: string) =>
  useQuery({
    queryKey: pk.statement(supplierId ?? 0, from, to),
    queryFn: () => api.get<Statement>(`/api/payables/statement?supplierId=${supplierId}&from=${from}&to=${to}`),
    enabled: !!supplierId,
    placeholderData: keepPreviousData,
  });

export const usePayments = (params: { supplierId?: string; status?: string }, enabled = true) =>
  useQuery({ queryKey: pk.payments(params), queryFn: () => api.get<PaymentDoc[]>(`/api/payables/payments?${search(params)}`), enabled });

export const usePayment = (id: number | null) =>
  useQuery({ queryKey: pk.payment(id ?? 0), queryFn: () => api.get<PaymentDoc>(`/api/payables/payments/${id}`), enabled: !!id });

export const useOpenings = (params: { supplierId?: string; status?: string }, enabled = true) =>
  useQuery({ queryKey: pk.openings(params), queryFn: () => api.get<OpeningPayableDoc[]>(`/api/payables/openings?${search(params)}`), enabled });

// ── 可抵扣、核销与供应商退款（v0.7.12） ──

export const useCredits = (supplierId: number | null) =>
  useQuery({
    queryKey: pk.credits(supplierId ?? 0),
    queryFn: () => api.get<(SupplierCredit & { supplierId: number })[]>(`/api/payables/suppliers/${supplierId}/credits`),
    enabled: !!supplierId,
  });

export const useOffsets = (params: { supplierId?: string; status?: string }, enabled = true) =>
  useQuery({ queryKey: pk.offsets(params), queryFn: () => api.get<ApOffsetDoc[]>(`/api/payables/offsets?${search(params)}`), enabled });

export const useOffset = (id: number | null) =>
  useQuery({ queryKey: pk.offset(id ?? 0), queryFn: () => api.get<ApOffsetDoc>(`/api/payables/offsets/${id}`), enabled: !!id });

export const useRefunds = (params: { supplierId?: string; status?: string }, enabled = true) =>
  useQuery({ queryKey: pk.refunds(params), queryFn: () => api.get<SupplierRefundDoc[]>(`/api/payables/refunds?${search(params)}`), enabled });

export const useRefund = (id: number | null) =>
  useQuery({ queryKey: pk.refund(id ?? 0), queryFn: () => api.get<SupplierRefundDoc>(`/api/payables/refunds/${id}`), enabled: !!id });

export const useErpImports = (enabled = true) => useQuery({ queryKey: pk.imports, queryFn: () => api.get<ErpImportRecord[]>('/api/payables/imports'), enabled });

/** 采购规则（v0.7.29）：采购途径字典、询价门槛、补货天数；编制采购单、登记报销、补货建议都读它 */
export const usePurchaseRules = (enabled = true) =>
  useQuery({ queryKey: pk.purchaseRules, queryFn: () => api.get<PurchaseRules>('/api/inventory/purchase-rules'), staleTime: 60_000, enabled });

/** 补货建议（v0.7.29 ERP 采购五项④）：与采购单共用 'inv' 缓存前缀，生成草稿后一起刷新 */
export const useSuggestions = (enabled = true) =>
  useQuery({ queryKey: pk.suggestions, queryFn: () => api.get<ReplenishSuggestions>('/api/purchase-suggestions'), enabled, staleTime: 30_000 });

/** 询价比价（v0.7.29 ERP 采购五项⑤） */
export const useSourcingList = (params: { status?: string; q?: string }, enabled = true) =>
  useQuery({
    queryKey: pk.sourcingList(params),
    queryFn: () => api.get<SourcingSummary[]>(`/api/purchase-sourcing?${search(params)}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useSourcing = (id: number | null) =>
  useQuery({ queryKey: pk.sourcing(id ?? 0), queryFn: () => api.get<SourcingEvent>(`/api/purchase-sourcing/${id}`), enabled: !!id });

/** 价格曲线（E8）：近 12 个月的成交价与报价 */
export const usePriceHistory = (materialId: number | null) =>
  useQuery({
    queryKey: pk.priceHistory(materialId ?? 0),
    queryFn: () => api.get<PriceHistory>(`/api/purchase-price-history?materialId=${materialId}`),
    enabled: !!materialId,
    staleTime: 60_000,
  });
