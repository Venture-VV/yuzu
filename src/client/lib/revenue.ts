// 营业额与收银流水的刷新（8.0.8，A02「收银系统单日营业额流水账单不实时刷新」）：
//   · 收款、反结账、退款、退储值、充值、桌台结账、退房结算之后统一刷新日结、交班、流水、结账记录、退款记录、工作台「今日」、数据看板、ERP 营业数据；
//   · 这些页面开着时每 15 秒自动取一次（别的电脑收的款 15 秒内出现，F6）；
//   · 页面上的「今天」跟着服务端的营业日走：过了营业日切换时间自动换到新的一天（登录时的营业日会过时）。

import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useSession } from './session';

/** 营业额相关页面开着时的自动刷新间隔（F6，15 秒） */
export const REVENUE_REFRESH_MS = 15_000;

/** 收款类操作成功后调用：刷新所有显示营业额、收银流水的数据（只刷新打开着的，没打开的下次打开时再取） */
export function invalidateRevenue(qc: QueryClient) {
  for (const queryKey of [
    ['settlement'],
    ['ledger'],
    ['shift'],
    ['frontdesk', 'checkouts'],
    ['frontdesk', 'checkouts-summary'],
    ['frontdesk', 'refunds'],
    ['dashboard'],
    ['erp', 'revenue'],
    ['consumption'],
  ]) {
    void qc.invalidateQueries({ queryKey });
  }
}

/**
 * 现在的营业日：每分钟问一次服务端（与营业日切换时间、门店时区一致），取不到时用登录时的。
 * 页面默认显示「今天」的用这个，过了切换时间自动换到新的一天
 */
export function useBusinessToday(): string {
  const session = useSession();
  const q = useQuery({
    queryKey: ['business-day'],
    queryFn: () => api.get<{ today: string; calendarToday: string }>('/api/business-day'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  return q.data?.today ?? session.today;
}
