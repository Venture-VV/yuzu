// 采购台账、账目自检、下单物料（v0.7.9）的查询：与库存、采购、费用共用 'inv' 缓存前缀，单据变化后一起刷新。

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Ledger, LedgerAudit, OrderedLines } from '@shared/purchase-ledger';
import { api } from '../../lib/api';

export const search = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();

export const useLedger = (params: Record<string, string | undefined>, enabled = true) =>
  useQuery({ queryKey: ['inv', 'purchase-ledger', params], queryFn: () => api.get<Ledger>(`/api/erp/ledger?${search(params)}`), placeholderData: keepPreviousData, enabled });

export const useAudit = () => useQuery({ queryKey: ['inv', 'ledger-audit'], queryFn: () => api.get<LedgerAudit>('/api/erp/audit') });

export const useOrderedLines = (params: Record<string, string | undefined>, enabled = true) =>
  useQuery({
    queryKey: ['inv', 'ordered-lines', params],
    queryFn: () => api.get<OrderedLines>(`/api/purchase-orders/ordered-lines?${search(params)}`),
    placeholderData: keepPreviousData,
    enabled,
  });

/** 往前推几天（按自然日） */
export function minusDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}
