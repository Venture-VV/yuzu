// 房态中心（8.1.15，docs/ROOM_CENTER_V8115.md）的取数与提交：看板 10 秒刷新一次（共用的 useLivePoll：页面在后台、连不上服务器时不取，
// 回到页面、网络恢复时马上取），房间历史、退房前的预览点开时取；改房态一类的写操作带着看到的房态版本号提交。

import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RoomCenterBoard, RoomCheckoutPreview, RoomHistory } from '@shared/room-center';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { clockKey } from '../clockroom/ClockroomPage';
import { roomsKey } from '../rooms/queries';

export const roomCenterKey = ['room-center'] as const;
const historyKey = (spaceId: number | null) => ['room-center', 'history', spaceId] as const;

/** 多台终端同时登记、退房、改房态：看板多久刷新一次 */
const ROOM_CENTER_REFRESH_MS = 10_000;

export function useRoomCenter() {
  const q = useQuery({ queryKey: roomCenterKey, queryFn: () => api.get<RoomCenterBoard>('/api/room-center'), placeholderData: keepPreviousData });
  useLivePoll(
    async (isLive) => {
      if (isLive()) await q.refetch({ cancelRefetch: false });
    },
    [],
    { intervalMs: ROOM_CENTER_REFRESH_MS },
  );
  return q;
}

export const useRoomHistory = (spaceId: number | null) =>
  useQuery({ queryKey: historyKey(spaceId), queryFn: () => api.get<RoomHistory>(`/api/room-center/rooms/${spaceId}/history`), enabled: spaceId !== null });

export const useCheckoutPreview = (spaceId: number, version: number) =>
  useQuery({
    // 房态版本号变了（续了钟、加了人）重新取
    queryKey: ['room-center', 'checkout-preview', spaceId, version],
    queryFn: () => api.get<RoomCheckoutPreview>(`/api/room-center/rooms/${spaceId}/checkout-preview`),
    staleTime: 0,
  });

/** 房态中心动过以后别的页面也要跟着变的几份数据：钟房看板、客房看板与平面图、派对房看板 */
export function useRefreshRoomCenter() {
  const qc = useQueryClient();
  return (board?: RoomCenterBoard | null) => {
    // 服务端回了最新的看板就直接用上，只让房间历史、退房预览这些重新取；没回（出错、结果不确定）的整份重新取
    if (board) qc.setQueryData(roomCenterKey, board);
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === roomCenterKey[0] && (!board || q.queryKey.length > 1) });
    void qc.invalidateQueries({ queryKey: clockKey });
    void qc.invalidateQueries({ queryKey: roomsKey });
    void qc.invalidateQueries({ queryKey: ['usages'] });
    void qc.invalidateQueries({ queryKey: ['floormap'] });
  };
}

/**
 * 带房态版本号的写操作（换房、退房、并房、维修、恢复、标待清、清洁完成）：成功时服务端回最新的看板，直接用上。
 * 结果不确定（超时、断网、服务器出错）时不知道做没做：重新取一遍房态，让人看了现在的状态再决定——带着旧版本号重做会被拒绝，不会做两遍。
 */
export function useRoomAction() {
  const refresh = useRefreshRoomCenter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (url: string, body: Record<string, unknown>): Promise<RoomCenterBoard | null> => {
    setBusy(true);
    setError(null);
    try {
      const board = await api.post<RoomCenterBoard>(url, body);
      refresh(board);
      return board;
    } catch (e) {
      refresh();
      setError(
        e instanceof UncertainError
          ? `${e.message}。房态已经重新取了一遍：先看这间房现在的状态，再决定要不要重做（带着旧状态重做会被拒绝，不会做两遍）`
          : errorMessage(e),
      );
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error, clearError: () => setError(null) };
}

/** 房间的操作地址 */
export const roomUrl = (spaceId: number, action: string) => `/api/room-center/rooms/${spaceId}/${action}`;
