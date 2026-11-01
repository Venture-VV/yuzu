// 部门采购需求单（v0.7.8）的查询：与库存、采购共用 'inv' 缓存前缀，采购单、收货单变化后需求单的进度一起刷新。

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OpenRequestLine, PurchaseRequest, RequestMeta, RequestsList } from '@shared/requests';
import { api } from '../../lib/api';

export const rk = {
  all: ['inv'] as const,
  list: (params: Record<string, string | undefined>) => ['inv', 'requests', params] as const,
  one: (id: number) => ['inv', 'request', id] as const,
  meta: ['inv', 'request-meta'] as const,
  open: (ids: string) => ['inv', 'request-open-lines', ids] as const,
};

export function useInvalidateRequests() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: rk.all });
}

const search = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();

export const useRequests = (params: { status?: string; departmentId?: string; from?: string; to?: string }) =>
  useQuery({ queryKey: rk.list(params), queryFn: () => api.get<RequestsList>(`/api/erp/requests?${search(params)}`), placeholderData: keepPreviousData });

export const useRequest = (id: number | null) =>
  useQuery({ queryKey: rk.one(id ?? 0), queryFn: () => api.get<PurchaseRequest>(`/api/erp/requests/${id}`), enabled: !!id });

export const useRequestMeta = () => useQuery({ queryKey: rk.meta, queryFn: () => api.get<RequestMeta>('/api/erp/requests/meta'), staleTime: 60_000 });

/** 已通过、还没下单的需求行；ids 给了就只取这些（转采购单） */
export const useOpenLines = (ids: string | null, enabled = true) =>
  useQuery({
    queryKey: rk.open(ids ?? ''),
    queryFn: () => api.get<OpenRequestLine[]>(`/api/erp/requests/open-lines${ids ? `?ids=${ids}` : ''}`),
    enabled,
  });
