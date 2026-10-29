import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type {
  AuditRecord,
  Catalog,
  LedgerRow,
  MemberDetail,
  MemberSummary,
  SessionInfo,
  SettlementSummary,
  StaffRecord,
} from '@shared/types';
import type { StoreRules } from '@shared/types';
import { api } from './api';

export const qk = {
  session: ['session'] as const,
  members: (q: string) => ['members', q] as const,
  member: (id: number) => ['member', id] as const,
  activity: (id: number) => ['activity', id] as const,
  catalog: (all = false) => ['catalog', all] as const,
  ledger: (params: Record<string, string | undefined>) => ['ledger', params] as const,
  settlement: (date: string) => ['settlement', date] as const,
  staff: ['staff'] as const,
  settings: ['settings'] as const,
  audit: (date?: string) => ['audit', date] as const,
};

export const useSessionQuery = () =>
  useQuery({ queryKey: qk.session, queryFn: () => api.get<SessionInfo>('/api/auth/me'), retry: false, staleTime: 60_000 });

export const useMembers = (q: string) =>
  useQuery({
    queryKey: qk.members(q),
    queryFn: () => api.get<MemberSummary[]>(`/api/members?q=${encodeURIComponent(q)}`),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

export const useMember = (id: number | null) =>
  useQuery({
    queryKey: qk.member(id ?? 0),
    queryFn: () => api.get<MemberDetail>(`/api/members/${id}`),
    enabled: !!id,
  });

export const useActivity = (id: number | null) =>
  useQuery({
    queryKey: qk.activity(id ?? 0),
    queryFn: () => api.get<LedgerRow[]>(`/api/members/${id}/activity`),
    enabled: !!id,
  });

export const useCatalog = (all = false) =>
  useQuery({
    queryKey: qk.catalog(all),
    queryFn: () => api.get<Catalog>(`/api/catalog${all ? '?all=1' : ''}`),
    staleTime: 60_000,
  });

export const useLedger = (params: { date?: string; type?: string; staffId?: string; q?: string }) => {
  const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return useQuery({
    queryKey: qk.ledger(params),
    queryFn: () => api.get<LedgerRow[]>(`/api/ledger?${search}`),
    placeholderData: keepPreviousData,
  });
};

export const useSettlement = (date: string) =>
  useQuery({ queryKey: qk.settlement(date), queryFn: () => api.get<SettlementSummary>(`/api/settlements/${date}`) });

export const useStaff = (enabled = true) =>
  useQuery({ queryKey: qk.staff, queryFn: () => api.get<StaffRecord[]>('/api/staff'), enabled });

export const useSettings = () =>
  useQuery({ queryKey: qk.settings, queryFn: () => api.get<StoreRules & { storeName: string }>('/api/settings') });

export const useAudit = (date?: string) =>
  useQuery({
    queryKey: qk.audit(date),
    queryFn: () => api.get<AuditRecord[]>(`/api/audit${date ? `?date=${date}` : ''}`),
  });
