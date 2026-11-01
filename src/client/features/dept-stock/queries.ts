import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeptStockMeta, InvDoc, InvDocSummary, WarehouseStockRow } from '@shared/inventory';
import { api } from '../../lib/api';

// 本部门小仓（v0.7.11）：部门的员工没有「查看库存」，数据都从 /api/erp/dept-stock 取

export const dk = {
  all: ['dept'] as const,
  meta: ['dept', 'meta'] as const,
  stock: (deptId: number) => ['dept', 'stock', deptId] as const,
  docs: (deptId: number, params: Record<string, string | undefined>) => ['dept', 'docs', deptId, params] as const,
  doc: (id: number) => ['dept', 'doc', id] as const,
};

/** 本部门小仓与库存的单据一起刷新 */
export function useInvalidateDept() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: dk.all }), qc.invalidateQueries({ queryKey: ['inv'] })]);
}

export const useDeptMeta = (enabled = true) =>
  useQuery({ queryKey: dk.meta, queryFn: () => api.get<DeptStockMeta>('/api/erp/dept-stock/meta'), staleTime: 60_000, enabled });

export const useDeptStock = (deptId: number | null) =>
  useQuery({ queryKey: dk.stock(deptId ?? 0), queryFn: () => api.get<WarehouseStockRow[]>(`/api/erp/dept-stock/${deptId}/stock`), enabled: !!deptId });

export interface DeptDocFilter {
  type?: string;
  status?: string;
  unsigned?: string;
  urgent?: string;
}

export const useDeptDocs = (deptId: number | null, params: DeptDocFilter) => {
  const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return useQuery({
    queryKey: dk.docs(deptId ?? 0, params as Record<string, string | undefined>),
    queryFn: () => api.get<InvDocSummary[]>(`/api/erp/dept-stock/${deptId}/docs?${search}`),
    placeholderData: keepPreviousData,
    enabled: !!deptId,
  });
};

export const useDeptDoc = (id: number | null) =>
  useQuery({ queryKey: dk.doc(id ?? 0), queryFn: () => api.get<InvDoc>(`/api/erp/dept-stock/docs/${id}`), enabled: !!id });
