// 每月盘点与供应商对账的提醒、对账登记（#23，v0.7.13）。查询键挂在 'inv' 下：库存单据、付款变化后一起刷新

import { useQuery } from '@tanstack/react-query';
import type { ReconReminders, StocktakeReminders, SupplierReconciliation } from '@shared/cycles';
import { api } from '../../lib/api';

export const cyclesKeys = {
  stocktake: ['inv', 'cycles', 'stocktake'] as const,
  deptStocktake: (deptId: number) => ['inv', 'cycles', 'dept-stocktake', deptId] as const,
  recon: ['inv', 'cycles', 'recon'] as const,
  recons: (supplierId: number) => ['inv', 'cycles', 'recons', supplierId] as const,
};

/** 本月盘点进度：总仓（仓库）与所有部门小仓（成本核算、负责人） */
export const useStocktakeReminders = (enabled = true) =>
  useQuery({ queryKey: cyclesKeys.stocktake, queryFn: () => api.get<StocktakeReminders>('/api/inventory/cycles/stocktake'), staleTime: 60_000, enabled });

/** 一个部门小仓本月的盘点进度（「本部门小仓」页） */
export const useDeptStocktake = (deptId: number | null) =>
  useQuery({
    queryKey: cyclesKeys.deptStocktake(deptId ?? 0),
    queryFn: () => api.get<StocktakeReminders>(`/api/erp/dept-stock/${deptId}/stocktake`),
    staleTime: 60_000,
    enabled: !!deptId,
  });

/** 对账提醒：月结的上个月、按批次的收货单 */
export const useReconReminders = (enabled = true) =>
  useQuery({ queryKey: cyclesKeys.recon, queryFn: () => api.get<ReconReminders>('/api/payables/cycles'), enabled });

/** 对账登记记录（可按供应商） */
export const useReconciliations = (supplierId: number | null, enabled = true) =>
  useQuery({
    queryKey: cyclesKeys.recons(supplierId ?? 0),
    queryFn: () => api.get<SupplierReconciliation[]>(`/api/payables/reconciliations${supplierId ? `?supplierId=${supplierId}` : ''}`),
    enabled,
  });
