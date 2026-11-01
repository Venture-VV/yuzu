import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { RoomBoard, RoomsAdmin, RoomsReport, StayCheckoutPreview, StayDetail } from '@shared/rooms';
import { api } from '../../lib/api';

/** 客房（S7）：房态看板、入住单与退房核对都在 ['rooms'] 下，入住、押金、退房、夜审、改房态后一起刷新 */
export const roomsKey = ['rooms'] as const;
export const stayKey = (id: number | null) => ['rooms', 'stay', id] as const;
export const roomsAdminKey = ['admin', 'rooms'] as const;

/** 房态看板：多台终端同时入住、退房，15 秒刷新一次（平面图打开时 5 秒，与平面图的状态一起刷新） */
export const useRoomBoard = (enabled = true, refetchInterval = 15_000) =>
  useQuery({ queryKey: roomsKey, queryFn: () => api.get<RoomBoard>('/api/rooms'), refetchInterval, placeholderData: keepPreviousData, enabled });

export const useStay = (id: number | null) =>
  useQuery({ queryKey: stayKey(id), queryFn: () => api.get<StayDetail>(`/api/rooms/stays/${id}`), enabled: id !== null, refetchInterval: 30_000 });

/** 退房前核对（要补的房费、押金）；30 秒刷新一次，过了退房时间要补的房费会变 */
export const useStayClosePreview = (id: number, enabled: boolean) =>
  useQuery({
    queryKey: ['rooms', 'close-preview', id],
    queryFn: () => api.get<StayCheckoutPreview>(`/api/rooms/stays/${id}/checkout-preview`),
    enabled,
    refetchInterval: 30_000,
  });

export const useRoomsAdmin = () => useQuery({ queryKey: roomsAdminKey, queryFn: () => api.get<RoomsAdmin>('/api/admin/rooms') });

export const useRoomsReport = (from: string, to: string, enabled = true) =>
  useQuery({
    queryKey: ['reports', 'rooms', from, to],
    queryFn: () => api.get<RoomsReport>(`/api/reports/rooms?from=${from}&to=${to}`),
    enabled,
    placeholderData: keepPreviousData,
  });

/** 「几点几分」：规则里的第几分钟 */
export const minuteText = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 「11月2日」 */
export const dayText = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
