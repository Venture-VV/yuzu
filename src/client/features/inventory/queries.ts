import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CheckItem,
  Department,
  InvDoc,
  InvDocSummary,
  InventoryOverview,
  InventorySettings,
  Material,
  StockMoveRow,
  StockSummaryRow,
  Supplier,
} from '@shared/inventory';
import { api } from '../../lib/api';

export const ik = {
  all: ['inv'] as const,
  materials: (all: boolean) => ['inv', 'materials', all] as const,
  suppliers: (all: boolean) => ['inv', 'suppliers', all] as const,
  departments: (all: boolean) => ['inv', 'departments', all] as const,
  settings: ['inv', 'settings'] as const,
  overview: ['inv', 'overview'] as const,
  docs: (params: Record<string, string | undefined>) => ['inv', 'docs', params] as const,
  doc: (id: number) => ['inv', 'doc', id] as const,
  card: (id: number) => ['inv', 'card', id] as const,
  summary: (from: string, to: string) => ['inv', 'summary', from, to] as const,
  checks: ['inv', 'checks'] as const,
  usual: (departmentId: number) => ['inv', 'usual', departmentId] as const,
};

/** 任何库存单据变化后：数量、单据、汇总一起刷新 */
export function useInvalidateInventory() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ik.all });
}

export const useMaterials = (all = false) =>
  useQuery({ queryKey: ik.materials(all), queryFn: () => api.get<Material[]>(`/api/inventory/materials${all ? '?all=1' : ''}`) });

export const useSuppliers = (all = false) =>
  useQuery({
    queryKey: ik.suppliers(all),
    queryFn: () => api.get<Supplier[]>(`/api/inventory/suppliers${all ? '?all=1' : ''}`),
    staleTime: 60_000,
  });

export const useDepartments = (all = false) =>
  useQuery({
    queryKey: ik.departments(all),
    queryFn: () => api.get<Department[]>(`/api/inventory/departments${all ? '?all=1' : ''}`),
    staleTime: 60_000,
  });

export const useInvSettings = () =>
  useQuery({ queryKey: ik.settings, queryFn: () => api.get<InventorySettings>('/api/inventory/settings'), staleTime: 60_000 });

export const useOverview = () => useQuery({ queryKey: ik.overview, queryFn: () => api.get<InventoryOverview>('/api/inventory/overview') });

export interface DocFilter {
  type?: string;
  status?: string;
  from?: string;
  to?: string;
  q?: string;
  materialId?: string;
  supplierId?: string;
}

export const useInvDocs = (params: DocFilter, enabled = true) => {
  const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return useQuery({
    queryKey: ik.docs(params as Record<string, string | undefined>),
    queryFn: () => api.get<InvDocSummary[]>(`/api/inventory/docs?${search}`),
    placeholderData: keepPreviousData,
    enabled,
  });
};

export const useInvDoc = (id: number | null) =>
  useQuery({ queryKey: ik.doc(id ?? 0), queryFn: () => api.get<InvDoc>(`/api/inventory/docs/${id}`), enabled: !!id });

export interface StockCard {
  material: Material;
  moves: StockMoveRow[];
  pending: { id: number; docNo: string; docType: InvDoc['docType']; status: InvDoc['status']; docDate: string; qtyMilli: number }[];
}

export const useStockCard = (id: number | null) =>
  useQuery({ queryKey: ik.card(id ?? 0), queryFn: () => api.get<StockCard>(`/api/inventory/materials/${id}/card`), enabled: !!id });

export const useStockSummary = (from: string, to: string) =>
  useQuery({
    queryKey: ik.summary(from, to),
    queryFn: () => api.get<StockSummaryRow[]>(`/api/inventory/summary?from=${from}&to=${to}`),
    placeholderData: keepPreviousData,
  });

export const useChecks = (enabled: boolean) =>
  useQuery({ queryKey: ik.checks, queryFn: () => api.get<CheckItem[]>('/api/inventory/checks'), enabled });

export const useUsual = (departmentId: number | null) =>
  useQuery({
    queryKey: ik.usual(departmentId ?? 0),
    queryFn: () => api.get<{ materialId: number; times: number; lastQtyMilli: number }[]>(`/api/inventory/departments/${departmentId}/usual`),
    enabled: !!departmentId,
  });
