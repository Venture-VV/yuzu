import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OpeningPayableDoc, OpenItem, PayablesOverview, PaymentDoc, PoSummary, PriceCompare, PurchaseOrder, Statement } from '@shared/purchasing';
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
