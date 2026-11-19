// 菜品管理（8.1.15，docs/DISHES_V8115.md）的取数与保存。
//
// 保存都带操作编号：同一个编号、同样的内容重提，服务端返回第一次的结果，不会多建一道、多记一条改价。
// 菜品维护不是收款，不进门店的「结果待确认」（不存本机、没有确认作废）：结果不明（超时、断网、服务器出错）时弹窗留着、
// 内容没动的话再点一次用的还是原来的编号（useOpKey）；也可以关掉刷新，看表里是不是已经改了。

import { useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DishPriceChange, DishesBoard } from '@shared/dishes';
import { api, UncertainError } from '../../lib/api';
import { uuid } from '../../lib/utils';
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

/**
 * 这一次保存用的操作编号：内容（signature）没变就一直是同一个——结果不明以后原样再点一次，服务端认得出是同一笔；
 * 内容改了、或者上一次已经有了明确的结果（成功、被拒绝），下一次换新的。
 */
export function useOpKey() {
  const held = useRef<{ signature: string; key: string } | null>(null);
  return {
    keyFor(signature: string): string {
      if (held.current?.signature !== signature) held.current = { signature, key: uuid() };
      return held.current.key;
    },
    /** 有了明确的结果：这个编号用完了 */
    settle(error?: unknown) {
      if (!(error instanceof UncertainError)) held.current = null;
    },
  };
}

/** 结果不明时给员工看的话 */
export const UNCERTAIN_HINT = '没收到结果（网络不稳或超时）。可以原样再点一次保存（不会重复）；或者关掉刷新，看表里是不是已经改了。';
