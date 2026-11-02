// 房态图（RQ-004 第三段，v0.7.16）：空间与技师房的钟单每 5 秒取一次；在用的底图（楼层、轮廓）只取一次，换了一批再取。
// 客房的房态用「客房」房态看板（['rooms']，平面图打开时也每 5 秒刷新），与看板同一个口径。

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ActiveFloorplan } from '@shared/floorplans';
import type { ClockSpace, FloorMapData } from '@shared/floormap';
import { api } from '../../lib/api';

export const FLOOR_MAP_REFRESH_MS = 5_000;

export const useFloorMap = () =>
  useQuery({
    queryKey: ['rooms', 'floormap'],
    queryFn: () => api.get<FloorMapData>('/api/floormap'),
    refetchInterval: FLOOR_MAP_REFRESH_MS,
    placeholderData: keepPreviousData,
  });

/** 在用的底图：按批次编号缓存，平面图状态里的批次变了（店主启用了新的一批）才重新取 */
export const useActiveFloorplan = (batchId: number | null | undefined) =>
  useQuery({
    queryKey: ['floorplan', 'active', batchId ?? null],
    queryFn: () => api.get<ActiveFloorplan>('/api/floorplans/active'),
    enabled: batchId !== undefined,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });

/** 钟房派钟、换房间时可选的技师房（带占用），对话框打开时每 10 秒刷新 */
export const useClockSpaces = (enabled: boolean) =>
  useQuery({ queryKey: ['clockroom', 'spaces'], queryFn: () => api.get<ClockSpace[]>('/api/clockroom/spaces'), enabled, refetchInterval: enabled ? 10_000 : false });
