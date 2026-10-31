import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CheckoutDetail, CheckoutPreview, CheckoutSummary, TicketType } from '@shared/checkout';
import type { FrontdeskBoard, FrontdeskCheck, MemberLevel, PreviewBill, VisitDetail } from '@shared/frontdesk';
import type { FrontdeskTechnicians } from '@shared/technicians';
import { api } from '../../lib/api';
import { useServerNow as useServerNowAt } from '../../lib/serverClock';

export const fk = {
  board: ['frontdesk', 'board'] as const,
  visit: (id: number) => ['frontdesk', 'visit', id] as const,
  preview: (ids: number[]) => ['frontdesk', 'preview', ids.join(',')] as const,
  tags: ['frontdesk', 'tags'] as const,
  checks: ['frontdesk', 'checks'] as const,
  ticketTypes: (all: boolean) => ['frontdesk', 'ticket-types', all] as const,
  checkoutPreview: (ids: number[], at?: string) => ['frontdesk', 'checkout-preview', ids.join(','), at ?? 'now'] as const,
  checkouts: (date: string) => ['frontdesk', 'checkouts', date] as const,
  checkout: (id: number) => ['frontdesk', 'checkout', id] as const,
  technicians: ['frontdesk', 'technicians'] as const,
};

/** 技师规则与在职技师（加项目时选技师；含今日已上的钟数） */
export const useFrontdeskTechnicians = (enabled = true) =>
  useQuery({ queryKey: fk.technicians, queryFn: () => api.get<FrontdeskTechnicians>('/api/frontdesk/technicians'), staleTime: 15_000, enabled });

/** 票种（接待时选择；管理页看全部） */
export const useTicketTypes = (all = false) =>
  useQuery({ queryKey: fk.ticketTypes(all), queryFn: () => api.get<TicketType[]>(`/api/frontdesk/ticket-types${all ? '?all=1' : ''}`), staleTime: 60_000 });

/** 结账前核对：按此刻计算门票；每 30 秒刷新一次，跳档时员工能看到新金额 */
/** 结账前核对；at 为补录纸质单时的实际离店时间（按这个时间计价，不随时间刷新） */
export const useCheckoutPreview = (ids: number[], enabled: boolean, at?: string) =>
  useQuery({
    queryKey: fk.checkoutPreview(ids, at),
    queryFn: () =>
      api.get<CheckoutPreview>(`/api/frontdesk/checkout-preview?ids=${ids.join(',')}${at ? `&at=${encodeURIComponent(at)}` : ''}`),
    enabled: enabled && ids.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: at ? false : 30_000,
  });

export const useCheckouts = (date: string, enabled = true) =>
  useQuery({ queryKey: fk.checkouts(date), queryFn: () => api.get<CheckoutSummary[]>(`/api/frontdesk/checkouts?date=${date}`), enabled });

export const useCheckout = (id: number | null) =>
  useQuery({ queryKey: fk.checkout(id ?? 0), queryFn: () => api.get<CheckoutDetail>(`/api/frontdesk/checkouts/${id}`), enabled: !!id });

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

/** 会员按当前规则口径的等级（发牌、换牌到 VIP 柜时核对） */
export const useMemberLevel = (memberId: number | null) =>
  useQuery({
    queryKey: ['frontdesk', 'member-level', memberId ?? 0],
    queryFn: () => api.get<MemberLevel>(`/api/frontdesk/members/${memberId}/level`),
    enabled: !!memberId,
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
 * 以服务器时间为准的「现在」：在店时长、作废与转单的时限按服务器时钟判断，避免前台电脑时间不准（每 30 秒刷新显示）。
 * 时差在接口响应收到时记下，第一次显示就按服务器时间（v0.7.7，见 lib/serverClock.ts）。
 */
export const useServerNow = (serverTime: string | undefined) => useServerNowAt(serverTime, 30_000);

/** 在店时长："45分" / "2时05分" */
export function stayText(checkedInAt: string, now: number): string {
  const min = Math.max(0, Math.floor((now - new Date(checkedInAt).getTime()) / 60_000));
  if (min < 60) return `${min}分`;
  return `${Math.floor(min / 60)}时${String(min % 60).padStart(2, '0')}分`;
}

export const stayMinutes = (checkedInAt: string, now: number) => Math.max(0, Math.floor((now - new Date(checkedInAt).getTime()) / 60_000));
