// 费用报销与备用金（v0.7.7）的查询：与库存、采购共用 'inv' 缓存前缀，任何单据变化后一起刷新（采购单的「已报销」也会变）。

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExpenseClaim, ExpenseClaimList, ExpenseRules, PettyAdvance, PettyAdvanceSummary, PettyDaily, PoCandidate, PoForClaim, StaffRef } from '@shared/expenses';
import { api } from '../../lib/api';

export const ek = {
  all: ['inv'] as const,
  rules: ['inv', 'expense-rules'] as const,
  handlers: ['inv', 'expense-handlers'] as const,
  claims: (params: Record<string, string | undefined>) => ['inv', 'claims', params] as const,
  claim: (id: number) => ['inv', 'claim', id] as const,
  advances: (params: Record<string, string | undefined>) => ['inv', 'advances', params] as const,
  advance: (id: number) => ['inv', 'advance', id] as const,
  daily: (params: Record<string, string | undefined>) => ['inv', 'petty-daily', params] as const,
  poCandidates: (q: string) => ['inv', 'po-candidates', q] as const,
  poForClaim: (id: number) => ['inv', 'po-for-claim', id] as const,
};

export function useInvalidateExpenses() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ek.all });
}

export const search = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();

export const useExpenseRules = () => useQuery({ queryKey: ek.rules, queryFn: () => api.get<ExpenseRules>('/api/erp/expenses/rules'), staleTime: 60_000 });

export const useHandlers = () => useQuery({ queryKey: ek.handlers, queryFn: () => api.get<StaffRef[]>('/api/erp/expenses/handlers'), staleTime: 300_000 });

export const useClaims = (params: Record<string, string | undefined>, enabled = true) =>
  useQuery({
    queryKey: ek.claims(params),
    queryFn: () => api.get<ExpenseClaimList>(`/api/erp/expenses?${search(params)}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useClaim = (id: number | null) =>
  useQuery({ queryKey: ek.claim(id ?? 0), queryFn: () => api.get<ExpenseClaim>(`/api/erp/expenses/${id}`), enabled: !!id });

export const useAdvances = (params: Record<string, string | undefined>, enabled = true) =>
  useQuery({
    queryKey: ek.advances(params),
    queryFn: () => api.get<PettyAdvanceSummary[]>(`/api/erp/petty/advances?${search(params)}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useAdvance = (id: number | null) =>
  useQuery({ queryKey: ek.advance(id ?? 0), queryFn: () => api.get<PettyAdvance>(`/api/erp/petty/advances/${id}`), enabled: !!id });

export const usePettyDaily = (params: Record<string, string | undefined>, enabled = true) =>
  useQuery({
    queryKey: ek.daily(params),
    queryFn: () => api.get<PettyDaily>(`/api/erp/petty/daily?${search(params)}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const usePoCandidates = (q: string, enabled = true) =>
  useQuery({
    queryKey: ek.poCandidates(q),
    queryFn: () => api.get<PoCandidate[]>(`/api/erp/expenses/po-candidates?${search({ q })}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const usePoForClaim = (id: number | null) =>
  useQuery({ queryKey: ek.poForClaim(id ?? 0), queryFn: () => api.get<PoForClaim>(`/api/erp/expenses/po/${id}`), enabled: !!id });

/** 本月 1 号到今天（按自然日） */
export function monthRange(calendarToday: string) {
  return { from: `${calendarToday.slice(0, 8)}01`, to: calendarToday };
}
