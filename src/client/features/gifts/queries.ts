// 签赠（8.1.9，docs/GIFTS_V819.md）：查询键与几个共用的取数。
// 后台「签赠」三个页签、管家部与客户部的「签赠台账」、发放弹窗共用。

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GiftAuthorizer, GiftLedger, GiftRules, GiftType } from '@shared/gifts';
import { api } from '../../lib/api';

export const giftKeys = {
  all: ['gifts'] as const,
  rules: ['gifts', 'rules'] as const,
  types: ['gifts', 'types'] as const,
  meta: ['gifts', 'meta'] as const,
  authorizers: ['gifts', 'authorizers'] as const,
  ledger: (query: string) => ['gifts', 'ledger', query] as const,
};

export interface GiftMeta {
  items: { id: number; name: string; category: string; active: boolean }[];
  ticketTypes: { id: number; name: string; active: boolean }[];
  categories: string[];
}

export const useGiftRules = (enabled = true) => useQuery({ queryKey: giftKeys.rules, queryFn: () => api.get<GiftRules>('/api/gifts/rules'), enabled, staleTime: 30_000 });
export const useGiftTypes = (enabled = true) => useQuery({ queryKey: giftKeys.types, queryFn: () => api.get<GiftType[]>('/api/gifts/types'), enabled });
export const useGiftMeta = (enabled = true) => useQuery({ queryKey: giftKeys.meta, queryFn: () => api.get<GiftMeta>('/api/gifts/meta'), enabled, staleTime: 300_000 });
export const useGiftAuthorizers = (enabled = true) => useQuery({ queryKey: giftKeys.authorizers, queryFn: () => api.get<GiftAuthorizer[]>('/api/gifts/authorizers'), enabled, staleTime: 60_000 });
export const useGiftLedger = (query: string, enabled = true) =>
  useQuery({ queryKey: giftKeys.ledger(query), queryFn: () => api.get<GiftLedger>(`/api/gifts/ledger?${query}`), enabled, placeholderData: keepPreviousData });

/** 发放、作废、改知识库以后：签赠的几样都重取（券的列表也跟着变） */
export function useInvalidateGifts() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: giftKeys.all }), qc.invalidateQueries({ queryKey: ['coupons'] })]);
}
