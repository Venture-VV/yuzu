import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { DiningMenu, KitchenBoard, TableCheckoutPreview, TableSessionDetail, TablesBoard } from '@shared/dining';
import { api } from '../../lib/api';
import { useServerNow as useServerNowAt } from '../../lib/serverClock';

export const menuKey = ['dining', 'menu'] as const;
export const kitchenKey = ['dining', 'kitchen'] as const;
export const guestKey = (tag: string | null) => ['dining', 'guest', tag?.toUpperCase() ?? null] as const;
/** 桌台（第二步）：看板、开台详情与结账核对都在 ['dining', 'tables'] 下，下单、退菜、结账后一起刷新 */
export const tablesKey = ['dining', 'tables'] as const;
export const tableSessionKey = (id: number | null) => ['dining', 'tables', 'session', id] as const;
const tableCheckoutKey = (ids: number[]) => ['dining', 'tables', 'checkout-preview', ids.join(',')] as const;

/** 菜单与余量（估清）：10 秒刷新一次（8.0.8，B03 / F12），别的终端点了菜，余量很快跟上；前台「加项目」打开时才取 */
export const useDiningMenu = (enabled = true) =>
  useQuery({ queryKey: menuKey, queryFn: () => api.get<DiningMenu>('/api/dining/menu'), refetchInterval: 10_000, enabled });

/** 厨房屏 5 秒刷新一次；估清页不用那么勤 */
export const useKitchenBoard = (refetchInterval: number) =>
  useQuery({ queryKey: kitchenKey, queryFn: () => api.get<KitchenBoard>('/api/kitchen'), refetchInterval });

/** 桌台看板：多台终端同时开台、点单，10 秒刷新一次 */
export const useTablesBoard = (enabled = true) =>
  useQuery({ queryKey: tablesKey, queryFn: () => api.get<TablesBoard>('/api/dining/tables'), refetchInterval: 10_000, placeholderData: keepPreviousData, enabled });

export const useTableSession = (id: number | null) =>
  useQuery({
    queryKey: tableSessionKey(id),
    queryFn: () => api.get<TableSessionDetail>(`/api/dining/tables/sessions/${id}`),
    enabled: id !== null,
    refetchInterval: 15_000,
  });

/** 桌台结账前核对；30 秒刷新一次 */
export const useTableCheckoutPreview = (ids: number[], enabled: boolean) =>
  useQuery({
    queryKey: tableCheckoutKey(ids),
    queryFn: () => api.get<TableCheckoutPreview>(`/api/dining/tables/checkout-preview?ids=${ids.join(',')}`),
    enabled: enabled && ids.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

/** 以服务器时间为准的「现在」（终端时钟不准也不影响「等了几分钟」），默认 10 秒走一次 */
export const useServerNow = (serverTime: string | undefined, step = 10_000) => useServerNowAt(serverTime, step);
