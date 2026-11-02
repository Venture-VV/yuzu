// 房态图的接口查询（RQ-004 第三段，v0.7.16；与组件 FloorMap.tsx 分开命名，大小写不敏感的文件系统上不会撞名）：空间与技师房的钟单每 5 秒取一次；在用的底图（楼层、轮廓）只取一次，换了一批再取。
// 客房的房态用「客房」房态看板（['rooms']，平面图打开时也每 5 秒刷新），与看板同一个口径。

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ActiveFloorplan } from '@shared/floorplans';
import type { ClockSpace, FloorMapData } from '@shared/floormap';
import type { LocationsCurrent, LocationTrackData } from '@shared/locations';
import { api } from '../../lib/api';

export const FLOOR_MAP_REFRESH_MS = 5_000;

export const useFloorMap = () =>
  useQuery({
    queryKey: ['rooms', 'floormap'],
    queryFn: () => api.get<FloorMapData>('/api/floormap'),
    refetchInterval: FLOOR_MAP_REFRESH_MS,
    placeholderData: keepPreviousData,
  });

/** 在用的底图：按批次编号（与补画轮廓的版本）缓存，平面图状态里的批次变了（店主启用了新的一批、补画了轮廓）才重新取 */
export const useActiveFloorplan = (batchId: number | null | undefined, rev = 0) =>
  useQuery({
    queryKey: ['floorplan', 'active', batchId ?? null, rev],
    queryFn: () => api.get<ActiveFloorplan>('/api/floorplans/active'),
    enabled: batchId !== undefined,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });

/** 钟房派钟、换房间时可选的技师房（带占用），对话框打开时每 10 秒刷新 */
export const useClockSpaces = (enabled: boolean) =>
  useQuery({ queryKey: ['clockroom', 'spaces'], queryFn: () => api.get<ClockSpace[]>('/api/clockroom/spaces'), enabled, refetchInterval: enabled ? 10_000 : false });

/** 实时位置（v0.7.17）：现在谁在哪，与平面图一起每 5 秒刷新；没有「看实时位置」权限时不取 */
export const useLocations = (enabled: boolean) =>
  useQuery({
    queryKey: ['rooms', 'locations'],
    queryFn: () => api.get<LocationsCurrent>('/api/locations/current'),
    enabled,
    refetchInterval: enabled ? FLOOR_MAP_REFRESH_MS : false,
    placeholderData: keepPreviousData,
  });

/** 一个人的轨迹（客人看这次来访，技师看今天）；对话框打开时每 10 秒刷新 */
export const useLocationTrack = (query: string | null) =>
  useQuery({
    queryKey: ['rooms', 'locations', 'track', query],
    queryFn: () => api.get<LocationTrackData>(`/api/locations/tracks?${query}`),
    enabled: !!query,
    refetchInterval: query ? 10_000 : false,
  });
