// 底图转换（RQ-004 第二段，v0.7.15）：批次列表、批次预览；有一批在转换时每 3 秒刷新一次，转换完了停。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FloorplanDetail, FloorplanList } from '@shared/floorplans';
import { api } from '../../lib/api';

export const floorplansKey = ['admin', 'floorplans'] as const;
const detailKey = (id: number) => ['admin', 'floorplans', id] as const;

export const useFloorplans = () =>
  useQuery({
    queryKey: floorplansKey,
    queryFn: () => api.get<FloorplanList>('/api/admin/floorplans'),
    refetchInterval: (q) => (q.state.data?.converting ? 3000 : false),
  });

export const useFloorplanDetail = (id: number | null) =>
  useQuery({
    queryKey: detailKey(id ?? 0),
    queryFn: () => api.get<FloorplanDetail>(`/api/admin/floorplans/${id}`),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data?.batch.status === 'converting' ? 3000 : false),
  });

export function useInvalidateFloorplans() {
  const qc = useQueryClient();
  return async (detail?: FloorplanDetail) => {
    if (detail) qc.setQueryData(detailKey(detail.batch.id), detail);
    await qc.invalidateQueries({ queryKey: floorplansKey, refetchType: 'active' });
  };
}
