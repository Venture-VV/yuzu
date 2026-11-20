// 房态中心（8.1.15，docs/ROOM_CENTER_V8115.md）的取数与提交：看板 10 秒刷新一次（共用的 useLivePoll：页面在后台、连不上服务器时不取，
// 回到页面、网络恢复时马上取），房间历史、退房前的预览点开时取。
// 房间动作（换房、退房、并房、拆并、维修、恢复、标待清、清洁完成）8.1.16 起带操作编号，照前台的「结果待确认」（useRoomAction）。

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RoomCard, RoomCenterBoard, RoomCheckoutPreview, RoomHistory } from '@shared/room-center';
import { api } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { useSession } from '../../lib/session';
import { useFrontdeskOp } from '../frontdesk/pending';
import { roomsKey } from '../rooms/queries';

export const roomCenterKey = ['room-center'] as const;
/**
 * 钟房看板的缓存键（与钟房页的 clockKey 相同）：登记、续钟、换房以后让钟房跟着刷新，登记对话框按它取技师。
 * 不从钟房页引：那样打开房态中心就得连带下载整个钟房页
 */
export const clockroomKey = ['clockroom'] as const;
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
    // 服务端回了最新的看板就直接用上，只让房间历史、退房预览这些重新取；没回（出错、结果不确定、查回的）整份重新取
    if (board) qc.setQueryData(roomCenterKey, board);
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === roomCenterKey[0] && (!board || q.queryKey.length > 1) });
    void qc.invalidateQueries({ queryKey: clockroomKey });
    void qc.invalidateQueries({ queryKey: roomsKey });
    void qc.invalidateQueries({ queryKey: ['usages'] });
    void qc.invalidateQueries({ queryKey: ['floormap'] });
  };
}

/** 房间动作的两类操作编号：改房态（维修、恢复、标待清、清洁完成）、调度（换房、退房、并房、拆并） */
export type RoomOpType = 'space_state' | 'space_dispatch';

/**
 * 房间动作（8.1.16）：带操作编号，照前台的「结果待确认」——提交前本机存原编号与原请求（存不了就不发），超时、断网、服务器出错以后
 * 这间房上同一类的动作锁住，只能查回、按原内容重新提交（同一个编号只生效一次）或确认作废（服务端登记以后原请求再到也不生效）。
 * 房态版本号照旧带着（第二道：两个人同时点、带着旧状态重做的被拒绝）。成功时服务端回最新的看板，直接用上；查回的没有看板，重新取。
 */
export function useRoomAction(room: Pick<RoomCard, 'spaceId' | 'code'>, type: RoomOpType) {
  const session = useSession();
  const refresh = useRefreshRoomCenter();
  const op = useFrontdeskOp<RoomCenterBoard | true>({
    type,
    visitId: null,
    spaceId: room.spaceId,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === type ? true : null),
  });
  /** 提交一个动作；生效了（含查回、按原内容重新提交）返回 true。also：换房、并房连着的另一间（那一间上也不能另起一笔） */
  const run = async (action: string, body: Record<string, unknown>, summary: string, also?: number): Promise<boolean> => {
    const r = await op.submit((key) => ({
      url: roomUrl(room.spaceId!, action),
      body: { clientKey: key, ...body },
      tagCodes: [`房 ${room.code}`],
      summary,
      amount: null,
      ...(also ? { spaceIds: [room.spaceId!, also] } : {}),
    }));
    refresh(r && r !== true ? r : null);
    return r !== null;
  };
  return { type, op, run, busy: op.busy, locked: op.locked, resolved: () => refresh() };
}

/** 房间的操作地址 */
export const roomUrl = (spaceId: number, action: string) => `/api/room-center/rooms/${spaceId}/${action}`;
