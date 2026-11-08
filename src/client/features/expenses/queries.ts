// 费用报销与备用金（v0.7.7）的查询：与库存、采购共用 'inv' 缓存前缀，任何单据变化后一起刷新（采购单的「已报销」也会变）。

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ClaimPrefill,
  ExpenseClaim,
  ExpenseClaimList,
  ExpenseRules,
  PettyAdvance,
  PettyAdvanceSummary,
  PettyAccountRow,
  PettyDaily,
  PettyJournal,
  PoCandidate,
  PoForClaim,
  StaffRef,
  ToClaimPo,
} from '@shared/expenses';
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
  toClaim: ['inv', 'to-claim'] as const,
  prefill: (id: number) => ['inv', 'claim-prefill', id] as const,
  pettyAccounts: ['inv', 'petty-accounts'] as const,
  pettyJournal: (id: number, from: string, to: string) => ['inv', 'petty-journal', id, from, to] as const,
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

/** 待报销的现付采购单（v0.7.29 ERP 采购五项②） */
export const useToClaim = (enabled = true) =>
  useQuery({ queryKey: ek.toClaim, queryFn: () => api.get<ToClaimPo[]>('/api/erp/expenses/to-claim'), enabled });

/** 转报销带出的默认值（E2）：每次选了采购单读一次，不缓存（打款、上一张报销随时会变） */
export const useClaimPrefill = (poId: number | null) =>
  useQuery({
    queryKey: ek.prefill(poId ?? 0),
    queryFn: () => api.get<{ po: PoForClaim; prefill: ClaimPrefill }>(`/api/erp/expenses/po/${poId}/prefill`),
    enabled: !!poId,
    staleTime: 0,
    gcTime: 0,
  });

/** 部门备用金看板（v0.7.29 ERP 采购五项③） */
export const usePettyAccounts = (enabled = true) =>
  useQuery({ queryKey: ek.pettyAccounts, queryFn: () => api.get<PettyAccountRow[]>('/api/erp/petty/accounts'), enabled });

/** 一个部门的备用金台账（期初、逐笔、每笔之后的余额、期末） */
export const usePettyJournal = (departmentId: number | null, from: string, to: string) =>
  useQuery({
    queryKey: ek.pettyJournal(departmentId ?? 0, from, to),
    queryFn: () => api.get<PettyJournal>(`/api/erp/petty/accounts/${departmentId}/journal?${search({ from, to })}`),
    enabled: !!departmentId && from <= to,
    placeholderData: keepPreviousData,
  });

// ───────────────────────── 费用预算（8.0.3） ─────────────────────────

export const budgetKeys = {
  grid: (month: string) => ['inv', 'budgets', month] as const,
  usage: (departmentId: number, date: string) => ['inv', 'budget-usage', departmentId, date] as const,
};

export const useBudgetGrid = (month: string) =>
  useQuery({
    queryKey: budgetKeys.grid(month),
    queryFn: () => api.get<import('@shared/budgets').BudgetGrid>(`/api/erp/expenses/budgets?month=${month}`),
    placeholderData: keepPreviousData,
  });

/** 登记报销页：这个部门这个月各科目的额度与已占用 */
export const useBudgetUsage = (departmentId: number | null, date: string) =>
  useQuery({
    queryKey: budgetKeys.usage(departmentId ?? 0, date),
    queryFn: () => api.get<import('@shared/budgets').BudgetUsage>(`/api/erp/expenses/budgets/usage?departmentId=${departmentId}&date=${date}`),
    enabled: !!departmentId && /^\d{4}-\d{2}-\d{2}$/.test(date),
    staleTime: 15_000,
  });
