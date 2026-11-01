import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CENTRAL_WAREHOUSE_ID,
  type CheckItem,
  type Department,
  type InvDoc,
  type InvDocSummary,
  type InventoryOverview,
  type InventorySettings,
  type Material,
  type StockCard,
  type StockSummaryRow,
  type Supplier,
  type Warehouse,
  type WarehouseSel,
  type WarehouseStockRow,
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
  card: (id: number, warehouse: number) => ['inv', 'card', id, warehouse] as const,
  summary: (from: string, to: string, warehouse: WarehouseSel) => ['inv', 'summary', from, to, warehouse] as const,
  warehouses: ['inv', 'warehouses'] as const,
  warehouseStock: (id: number) => ['inv', 'warehouse-stock', id] as const,
  checks: ['inv', 'checks'] as const,
  usual: (departmentId: number) => ['inv', 'usual', departmentId] as const,
};

/** 任何库存单据变化后：数量、单据、汇总一起刷新 */
export function useInvalidateInventory() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ik.all });
}

export const useMaterials = (all = false, enabled = true) =>
  useQuery({ queryKey: ik.materials(all), queryFn: () => api.get<Material[]>(`/api/inventory/materials${all ? '?all=1' : ''}`), enabled });

export const useSuppliers = (all = false, enabled = true) =>
  useQuery({
    queryKey: ik.suppliers(all),
    queryFn: () => api.get<Supplier[]>(`/api/inventory/suppliers${all ? '?all=1' : ''}`),
    staleTime: 60_000,
    enabled,
  });

export const useDepartments = (all = false, enabled = true) =>
  useQuery({
    queryKey: ik.departments(all),
    queryFn: () => api.get<Department[]>(`/api/inventory/departments${all ? '?all=1' : ''}`),
    staleTime: 60_000,
    enabled,
  });

export const useInvSettings = (enabled = true) =>
  useQuery({ queryKey: ik.settings, queryFn: () => api.get<InventorySettings>('/api/inventory/settings'), staleTime: 60_000, enabled });

export const useOverview = () => useQuery({ queryKey: ik.overview, queryFn: () => api.get<InventoryOverview>('/api/inventory/overview') });

/** 仓库列表（总仓 + 部门小仓，v0.7.11） */
export const useWarehouses = (enabled = true) =>
  useQuery({ queryKey: ik.warehouses, queryFn: () => api.get<Warehouse[]>('/api/inventory/warehouses'), staleTime: 60_000, enabled });

/** 部门小仓的结存 */
export const useWarehouseStock = (warehouseId: number | null) =>
  useQuery({
    queryKey: ik.warehouseStock(warehouseId ?? 0),
    queryFn: () => api.get<WarehouseStockRow[]>(`/api/inventory/warehouses/${warehouseId}/stock`),
    enabled: !!warehouseId,
  });

/** 收货时一起验收的采购经办（#17） */
export const useCoAcceptors = (enabled = true) =>
  useQuery({
    queryKey: ['inv', 'co-acceptors'] as const,
    queryFn: () => api.get<{ id: number; displayName: string }[]>('/api/inventory/co-acceptors'),
    staleTime: 60_000,
    enabled,
  });

export interface DocFilter {
  type?: string;
  status?: string;
  from?: string;
  to?: string;
  q?: string;
  materialId?: string;
  supplierId?: string;
  /** v0.7.11：按仓、急采、未签收的领料 */
  warehouseId?: string;
  urgent?: string;
  unsigned?: string;
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

/** 库存卡按仓（v0.7.11）；不填是总仓 */
export const useStockCard = (id: number | null, warehouseId = CENTRAL_WAREHOUSE_ID) =>
  useQuery({
    queryKey: ik.card(id ?? 0, warehouseId),
    queryFn: () => api.get<StockCard>(`/api/inventory/materials/${id}/card?warehouse=${warehouseId}`),
    enabled: !!id,
    placeholderData: keepPreviousData,
  });

export const useStockSummary = (from: string, to: string, warehouse: WarehouseSel = CENTRAL_WAREHOUSE_ID) =>
  useQuery({
    queryKey: ik.summary(from, to, warehouse),
    queryFn: () => api.get<StockSummaryRow[]>(`/api/inventory/summary?from=${from}&to=${to}&warehouse=${warehouse}`),
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
