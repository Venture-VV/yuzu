import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FrontdeskBoard, FrontdeskCheck, PreviewBill, VisitDetail } from '@shared/frontdesk';
import { api } from '../../lib/api';

export const fk = {
  board: ['frontdesk', 'board'] as const,
  visit: (id: number) => ['frontdesk', 'visit', id] as const,
  preview: (ids: number[]) => ['frontdesk', 'preview', ids.join(',')] as const,
  tags: ['frontdesk', 'tags'] as const,
  checks: ['frontdesk', 'checks'] as const,
};

/** 状态板每 10 秒刷新一次；多台前台终端同时使用时能看到彼此的发牌与挂账 */
export const useBoard = () =>
  useQuery({
    queryKey: fk.board,
    queryFn: () => api.get<FrontdeskBoard>('/api/frontdesk/board'),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });

export const useVisit = (id: number | null) =>
  useQuery({
    queryKey: fk.visit(id ?? 0),
    queryFn: () => api.get<VisitDetail>(`/api/frontdesk/visits/${id}`),
    enabled: !!id,
    refetchInterval: 15_000,
  });

export const usePreview = (ids: number[], enabled: boolean) =>
  useQuery({
    queryKey: fk.preview(ids),
    queryFn: () => api.get<PreviewBill>(`/api/frontdesk/preview?ids=${ids.join(',')}`),
    enabled: enabled && ids.length > 0,
    placeholderData: keepPreviousData,
  });

export const useFrontdeskChecks = (enabled: boolean) =>
  useQuery({ queryKey: fk.checks, queryFn: () => api.get<FrontdeskCheck[]>('/api/frontdesk/checks'), enabled });

/** 写操作后刷新状态板与相关手牌账单 */
export function useRefreshFrontdesk() {
  const qc = useQueryClient();
  return (visitIds: number[] = []) => {
    void qc.invalidateQueries({ queryKey: fk.board });
    void qc.invalidateQueries({ queryKey: ['frontdesk', 'preview'] });
    void qc.invalidateQueries({ queryKey: fk.checks });
    for (const id of visitIds) void qc.invalidateQueries({ queryKey: fk.visit(id) });
    if (visitIds.length === 0) void qc.invalidateQueries({ queryKey: ['frontdesk', 'visit'] });
  };
}

/**
 * 以服务器时间为准的「现在」：在店时长按服务器时钟计算，避免前台电脑时间不准。
 * 每 30 秒刷新一次显示。
 */
export function useServerNow(serverTime: string | undefined) {
  const offset = useRef(0);
  useEffect(() => {
    if (serverTime) offset.current = new Date(serverTime).getTime() - Date.now();
  }, [serverTime]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now + offset.current;
}

/** 在店时长："45分" / "2时05分" */
export function stayText(checkedInAt: string, now: number): string {
  const min = Math.max(0, Math.floor((now - new Date(checkedInAt).getTime()) / 60_000));
  if (min < 60) return `${min}分`;
  return `${Math.floor(min / 60)}时${String(min % 60).padStart(2, '0')}分`;
}

export const stayMinutes = (checkedInAt: string, now: number) => Math.max(0, Math.floor((now - new Date(checkedInAt).getTime()) / 60_000));
