// 菜品管理（8.1.15，docs/DISHES_V8115.md）的取数。
// 保存都带操作编号：同一个编号、同样的内容重提，服务端返回第一次的结果，不会多建一道、多记一条改价；
// 没收到结果的进「结果待确认」（8.1.16，dishPendingStore.ts）。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DishPriceChange, DishesBoard } from '@shared/dishes';
import { api } from '../../lib/api';
import { menuKey } from './queries';

export const dishesKey = ['dining', 'dishes'] as const;
const priceChangesKey = (itemId: number | null) => ['dining', 'dishes', 'price-changes', itemId] as const;

/** 全部菜品（搜索与筛选在页面上做，用的是与服务端同一个 filterDishes） */
export const useDishes = () => useQuery({ queryKey: dishesKey, queryFn: () => api.get<DishesBoard>('/api/dining/dishes') });

/** 改价记录：给了菜品只看这一道，不给是全部（新的在前） */
export const useDishPriceChanges = (itemId: number | null, enabled = true) =>
  useQuery({
    queryKey: priceChangesKey(itemId),
    queryFn: () => api.get<DishPriceChange[]>(`/api/dining/dishes/price-changes${itemId ? `?itemId=${itemId}` : ''}`),
    enabled,
  });

/** 菜品改了以后：菜品表、改价记录、点单页的菜单一起刷新（上下架、做法、加料、套餐马上到点单页） */
export function useRefreshDishes() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: dishesKey });
    void qc.invalidateQueries({ queryKey: menuKey });
  };
}
