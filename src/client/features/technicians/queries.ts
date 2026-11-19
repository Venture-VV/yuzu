// 技师管理的取数（8.1.15）：总览（名册、组别、班次、今天的班与休假、待审批几张）、排班表、休假单。
// 保存以后把相关的页面一起刷新：钟房看板、后台的名册卡片、前台选技师——「与钟房、排位实时联动」靠它和钟房自己每 10 秒取一次。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LeaveStatus, ScheduleView, TechLeave, TechnicianAdminView } from '@shared/technician-admin';
import { api } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';

export const techAdminKey = ['technician-admin'] as const;
export const techViewKey = [...techAdminKey, 'view'] as const;
export const scheduleKey = (from: string, days: number) => [...techAdminKey, 'schedule', from, days] as const;
const leavesKey = (status: LeaveStatus | 'all') => [...techAdminKey, 'leaves', status] as const;

/** 总览。live：每 20 秒取一次（别的终端批了休假、改了排班，这里跟着变） */
export function useTechAdmin(live = false) {
  const query = useQuery({ queryKey: techViewKey, queryFn: () => api.get<TechnicianAdminView>('/api/technician-admin') });
  const { refetch } = query;
  // 第一次由上面的查询自己取；之后每 20 秒、回到页面、网络恢复时再取（正在取的不打断）
  useLivePoll(
    async () => {
      if (live) await refetch({ cancelRefetch: false });
    },
    [live, refetch],
    { intervalMs: 20_000, delayMs: 20_000 },
  );
  return query;
}

export const scheduleUrl = (from: string, days: number) => `/api/technician-admin/schedule?from=${from}&days=${days}`;

export const useSchedule = (from: string, days: number) => useQuery({ queryKey: scheduleKey(from, days), queryFn: () => api.get<ScheduleView>(scheduleUrl(from, days)) });

export const useLeaves = (status: LeaveStatus | 'all') =>
  useQuery({ queryKey: leavesKey(status), queryFn: () => api.get<TechLeave[]>(`/api/technician-admin/leaves${status === 'all' ? '' : `?status=${status}`}`) });

/** 保存以后：技师管理的几样、钟房看板、后台名册、前台选技师都重新取 */
export function useTechAdminRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: techAdminKey });
    void qc.invalidateQueries({ queryKey: ['clockroom'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'technicians'] });
    void qc.invalidateQueries({ queryKey: ['frontdesk', 'technicians'] });
  };
}
