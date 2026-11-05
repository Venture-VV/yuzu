// 审批中心（v0.7.30）的读与刷新：同意、退回之后，单据的状态跟着变，库存、采购、货款、报销的缓存一起刷新。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApprovalCard,
  ApprovalCounts,
  ApprovalDetail,
  ApprovalDocType,
  ApprovalRuleView,
  ApproverOption,
  DelegationView,
  UrgentAcceptItem,
  UrgentBackfillItem,
} from '@shared/approvals';
import { api } from '../../lib/api';

export type ApprovalTab = 'mine' | 'all' | 'submitted';

export const ak = {
  all: ['approvals'] as const,
  list: (tab: ApprovalTab, docType?: ApprovalDocType) => ['approvals', 'list', tab, docType ?? ''] as const,
  count: ['approvals', 'count'] as const,
  detail: (id: number) => ['approvals', 'detail', id] as const,
  rules: ['approvals', 'rules'] as const,
  approvers: ['approvals', 'approvers'] as const,
  delegations: (all: boolean) => ['approvals', 'delegations', all] as const,
  backfills: ['approvals', 'backfills'] as const,
  accepts: ['approvals', 'accepts'] as const,
};

export const useApprovals = (tab: ApprovalTab, docType?: ApprovalDocType, enabled = true) =>
  useQuery({
    queryKey: ak.list(tab, docType),
    queryFn: () => api.get<ApprovalCard[]>(`/api/approvals?tab=${tab}${docType ? `&docType=${docType}` : ''}`),
    enabled,
    refetchInterval: 60_000,
  });

export const useApprovalCount = (enabled = true) =>
  useQuery({ queryKey: ak.count, queryFn: () => api.get<ApprovalCounts>('/api/approvals/count'), enabled, refetchInterval: 60_000 });

export const useApprovalDetail = (id: number | null) =>
  useQuery({ queryKey: ak.detail(id ?? 0), queryFn: () => api.get<ApprovalDetail>(`/api/approvals/${id}`), enabled: !!id });

export const useApprovalRules = (enabled = true) =>
  useQuery({ queryKey: ak.rules, queryFn: () => api.get<ApprovalRuleView[]>('/api/approvals/rules'), enabled });

export const useApprovers = (enabled = true) =>
  useQuery({ queryKey: ak.approvers, queryFn: () => api.get<ApproverOption[]>('/api/approvals/approvers'), enabled, staleTime: 60_000 });

export const useDelegations = (all: boolean, enabled = true) =>
  useQuery({ queryKey: ak.delegations(all), queryFn: () => api.get<DelegationView[]>(`/api/approvals/delegations${all ? '?all=1' : ''}`), enabled });

/** 急采待验收（负责人看；不走审批中心，到部门验收后生效） */
export const useUrgentAccepts = (enabled = true) =>
  useQuery({ queryKey: ak.accepts, queryFn: () => api.get<UrgentAcceptItem[]>('/api/approvals/accepts'), enabled, refetchInterval: 60_000 });

export const useUrgentBackfills = (enabled = true) =>
  useQuery({ queryKey: ak.backfills, queryFn: () => api.get<UrgentBackfillItem[]>('/api/approvals/backfills'), enabled, refetchInterval: 300_000 });

/** 审批之后：审批中心、库存与采购与货款（同一个缓存前缀 inv）、报销都刷新 */
export function useRefreshAfterApproval() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ak.all }),
      qc.invalidateQueries({ queryKey: ['inv'] }),
      qc.invalidateQueries({ queryKey: ['expenses'] }),
    ]);
}
