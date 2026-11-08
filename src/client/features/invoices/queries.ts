// 进项发票台账（8.0.3，docs/BUDGET_INVOICES.md 第 3 节）的查询：与库存、采购、费用共用 'inv' 缓存前缀，报销、三单登记以后一起刷新。

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InputInvoiceDetail, InvoiceLedger, InvoiceTodo, InvoiceView } from '@shared/invoices';
import { api } from '../../lib/api';

export const ik = {
  all: ['inv'] as const,
  ledger: (params: Record<string, string | undefined>) => ['inv', 'input-invoices', params] as const,
  one: (id: number) => ['inv', 'input-invoice', id] as const,
  lookup: (no: string) => ['inv', 'input-invoice-lookup', no] as const,
  todo: ['erp', 'invoices', 'todo'] as const,
};

export const search = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();

export function useInvalidateInvoices() {
  const qc = useQueryClient();
  return async () => {
    await qc.invalidateQueries({ queryKey: ik.all });
    await qc.invalidateQueries({ queryKey: ik.todo });
  };
}

export const useInvoiceLedger = (params: { view: InvoiceView; source?: string; from?: string; to?: string; q?: string }) =>
  useQuery({
    queryKey: ik.ledger(params),
    queryFn: () => api.get<InvoiceLedger>(`/api/erp/invoices?${search(params)}`),
    placeholderData: keepPreviousData,
  });

export const useInputInvoice = (id: number | null) =>
  useQuery({ queryKey: ik.one(id ?? 0), queryFn: () => api.get<InputInvoiceDetail>(`/api/erp/invoices/${id}`), enabled: !!id });

export interface InvoiceMatch {
  id: number;
  invoiceNo: string;
  kind: string;
  kindLabel: string;
  issuerName: string;
  supplierId: number | null;
  invoiceDate: string;
  totalCents: number;
  taxCents: number;
  taxRateBp: number;
  usedBy: string | null;
  inPayables: boolean;
}

/** 登记报销页按号码找台账里的发票 */
export const useInvoiceLookup = (no: string, enabled: boolean) =>
  useQuery({
    queryKey: ik.lookup(no),
    queryFn: () => api.get<InvoiceMatch[]>(`/api/erp/invoices/lookup?no=${encodeURIComponent(no)}`),
    enabled: enabled && no.trim().length >= 4,
    staleTime: 10_000,
  });

export const useInvoiceTodo = (enabled: boolean) =>
  useQuery({ queryKey: ik.todo, queryFn: () => api.get<InvoiceTodo>('/api/erp/invoices/todo'), enabled, refetchInterval: 300_000 });
