import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DiningMenu, KitchenBoard } from '@shared/dining';
import { api } from '../../lib/api';

export const menuKey = ['dining', 'menu'] as const;
export const kitchenKey = ['dining', 'kitchen'] as const;
export const guestKey = (tag: string | null) => ['dining', 'guest', tag?.toUpperCase() ?? null] as const;

export const useDiningMenu = () => useQuery({ queryKey: menuKey, queryFn: () => api.get<DiningMenu>('/api/dining/menu'), refetchInterval: 30_000 });

/** 厨房屏 5 秒刷新一次；估清页不用那么勤 */
export const useKitchenBoard = (refetchInterval: number) =>
  useQuery({ queryKey: kitchenKey, queryFn: () => api.get<KitchenBoard>('/api/kitchen'), refetchInterval });

/** 以服务器时间为准的「现在」（终端时钟不准也不影响「等了几分钟」），默认 10 秒走一次 */
export function useServerNow(serverTime: string | undefined, step = 10_000) {
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (serverTime) setOffset(new Date(serverTime).getTime() - Date.now());
  }, [serverTime]);
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), step);
    return () => clearInterval(t);
  }, [step]);
  return tick + offset;
}
