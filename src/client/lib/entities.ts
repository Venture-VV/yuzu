// 公司主体（8.0.22，docs/MULTISTORE_V8022.md 第 9 节）：合同、银行账户等选「我方」用；只有一个主体时页面不显示选择。
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface EntityBrief {
  id: number;
  name: string;
  taxNo: string;
}

export const useEntities = (enabled = true) => useQuery({ queryKey: ['entities'], queryFn: () => api.get<EntityBrief[]>('/api/entities'), staleTime: 5 * 60_000, enabled });
