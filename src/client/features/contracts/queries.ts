// 合同（v0.7.31）的读：台账、详情、起草页的下拉选项、到期提醒、采购单选合同。
// 缓存前缀与库存、采购、货款一样用 inv：审批中心同意或退回、「结果待确认」查回以后一起刷新。

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AcceptanceTemplate, ContractCategory, ContractDetail, ContractExpiryItem, ContractMeta, ContractOption, ContractSummary } from '@shared/contracts';
import { api } from '../../lib/api';

export type ContractFilter = 'all' | 'drafting' | 'reviewing' | 'effective' | 'expiring' | 'closed';

export const ck = {
  all: ['inv', 'contracts'] as const,
  list: (filter: ContractFilter, category: string, q: string) => ['inv', 'contracts', 'list', filter, category, q] as const,
  one: (id: number) => ['inv', 'contracts', 'one', id] as const,
  meta: ['inv', 'contracts', 'meta'] as const,
  expiring: ['inv', 'contracts', 'expiring'] as const,
  options: (supplierId: number) => ['inv', 'contracts', 'options', supplierId] as const,
};

export const useContracts = (filter: ContractFilter, category: ContractCategory | '', q: string) =>
  useQuery({
    queryKey: ck.list(filter, category, q),
    queryFn: () =>
      api.get<ContractSummary[]>(
        `/api/erp/contracts?${new URLSearchParams(Object.entries({ filter, category, q: q.trim() }).filter(([, v]) => v) as [string, string][]).toString()}`,
      ),
    placeholderData: keepPreviousData,
  });

export const useContract = (id: number | null) =>
  useQuery({ queryKey: ck.one(id ?? 0), queryFn: () => api.get<ContractDetail>(`/api/erp/contracts/${id}`), enabled: !!id });

export const useContractMeta = () => useQuery({ queryKey: ck.meta, queryFn: () => api.get<ContractMeta>('/api/erp/contracts/meta'), staleTime: 60_000 });

/** 到期提醒（C11）：已签署、已归档，结束日在 60 天内（含已过期没续签的） */
export const useContractExpiring = (enabled = true) =>
  useQuery({ queryKey: ck.expiring, queryFn: () => api.get<ContractExpiryItem[]>('/api/erp/contracts/expiring'), enabled, refetchInterval: 300_000 });

/** 采购单选合同：同一供应商、采购类、生效中、今天在起止日内 */
export const useContractOptions = (supplierId: number | null, enabled = true) =>
  useQuery({
    queryKey: ck.options(supplierId ?? 0),
    queryFn: () => api.get<ContractOption[]>(`/api/erp/contracts/options?supplierId=${supplierId}`),
    enabled: enabled && !!supplierId,
  });

export function useInvalidateContracts() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ck.all });
}

/** 验收标准模板（8.0.7 2.5）：all = 含停用的（维护页用） */
export const useAcceptanceTemplates = (all = false) =>
  useQuery({
    queryKey: [...ck.all, 'acceptance-templates', all],
    queryFn: () => api.get<AcceptanceTemplate[]>(`/api/erp/contracts/acceptance-templates${all ? '?all=1' : ''}`),
    staleTime: 60_000,
  });
