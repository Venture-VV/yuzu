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
import { MP_CODE, type MpCodeLookup } from '@shared/mp';
import { api, ApiError } from './api';

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

/** 当前会话：服务器一时出错、断网时重试两次（只有 401 才是会话失效，见 AuthGate） */
export const useSessionQuery = () =>
  useQuery({
    queryKey: qk.session,
    queryFn: () => api.get<SessionInfo>('/api/auth/me'),
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    staleTime: 60_000,
  });

/**
 * 前台扫码盒扫进查找框的会员码（v0.7.25，小程序 MP9）：去掉空格、横线后整串是会员码时返回码，否则为空。
 * 会员码 16 或 19 位、以 8 或 9 开头，不会与 11 位手机号、会员号混淆
 */
export const memberCodeOf = (q: string): string | null => {
  const s = q.replace(/[\s-]/g, '');
  return MP_CODE.test(s) ? s : null;
};

/**
 * 查找会员：手机号、后四位、姓名、会员号；扫到会员码时由 yuzu 校验（签名、时间、绑定、会员状态），查到就是那一位
 * （过期、解绑、没配会员码时是出错，页面写明原因，让客人刷新或报手机号）
 */
export const useMembers = (q: string) => {
  const code = memberCodeOf(q);
  return useQuery({
    queryKey: code ? (['members', 'code', code] as const) : qk.members(q),
    queryFn: async () => {
      if (!code) return api.get<MemberSummary[]>(`/api/members?q=${encodeURIComponent(q)}`);
      const found = await api.get<MpCodeLookup>(`/api/mp-codes/${code}`);
      return [await api.get<MemberDetail>(`/api/members/${found.memberId}`)] as MemberSummary[];
    },
    placeholderData: code ? undefined : keepPreviousData,
    staleTime: code ? 0 : 10_000,
    retry: code ? false : undefined,
  });
};

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
