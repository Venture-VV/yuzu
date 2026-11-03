// 会员体系 v2（v0.7.23，docs/MEMBERSHIP.md）的查询：会员规则、会员的等级卡、看板、提醒名单、状态变化。

import { useQuery } from '@tanstack/react-query';
import type { GradeEventKind, GradeEventListRow, MemberGradeInfo, MembershipOverview, MembershipRules, RetentionRow } from '@shared/membership';
import { api } from '../../lib/api';

/** 会员权益（v0.7.24）：后台清单、会员的「本月可享」、看板汇总。
 *  会员的「本月可享」挂在 ['member', id] 下面（同会员的券）：充值、消费、结账、调档阶、改资料后刷新会员时一起刷新 */
export const benefitKeys = {
  catalog: ['benefits', 'catalog'] as const,
  member: (memberId: number) => ['member', memberId, 'benefits'] as const,
  summary: ['benefits', 'summary'] as const,
};

export const membershipKeys = {
  rules: ['membership', 'rules'] as const,
  grade: (memberId: number) => ['membership', 'grade', memberId] as const,
  overview: ['membership', 'overview'] as const,
  retention: (kind: 'expiring' | 'grace', within: number) => ['membership', 'retention', kind, within] as const,
  events: (date: string, kind: GradeEventKind | null) => ['membership', 'events', date, kind ?? 'all'] as const,
};

/** 会员规则（档名、门槛、比例、周期）：充值页、会员详情、前台徽标都用 */
export const useMembershipRules = () =>
  useQuery({ queryKey: membershipKeys.rules, queryFn: () => api.get<MembershipRules>('/api/membership/rules'), staleTime: 5 * 60_000 });

/** 会员的等级卡（到期没处理的已按规则推算到今天）；充值页用它预览充完的档阶 */
export const useMemberGrade = (memberId: number | null) =>
  useQuery({
    queryKey: membershipKeys.grade(memberId ?? 0),
    queryFn: () => api.get<MemberGradeInfo>(`/api/members/${memberId}/grade`),
    enabled: !!memberId,
  });

export const useMembershipOverview = (enabled = true) =>
  useQuery({ queryKey: membershipKeys.overview, queryFn: () => api.get<MembershipOverview>('/api/membership/overview'), enabled, refetchInterval: 60_000 });

export const useRetention = (kind: 'expiring' | 'grace', within: number) =>
  useQuery({
    queryKey: membershipKeys.retention(kind, within),
    queryFn: () => api.get<RetentionRow[]>(`/api/membership/retention?kind=${kind}&within=${within}`),
  });

export const useGradeEvents = (date: string, kind: GradeEventKind | null) =>
  useQuery({
    queryKey: membershipKeys.events(date, kind),
    queryFn: () => api.get<GradeEventListRow[]>(`/api/membership/events?date=${date}${kind ? `&kind=${kind}` : ''}`),
  });
