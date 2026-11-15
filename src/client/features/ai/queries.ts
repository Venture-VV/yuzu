// AI 辅助（8.0.22，docs/AI_V8022.md）的前端取数：状态（模式、开关、今天问了几次）。

import { useQuery } from '@tanstack/react-query';
import type { AiStatus } from '@shared/ai';
import { api } from '../../lib/api';

export const AI_STATUS_KEY = ['ai', 'status'] as const;

export function useAiStatus(enabled = true) {
  return useQuery({ queryKey: AI_STATUS_KEY, queryFn: () => api.get<AiStatus>('/api/ai/status'), enabled, staleTime: 30_000 });
}

/** 没配模型服务、模拟时页面上写的一句话 */
export function aiModeNote(status: AiStatus | undefined): string | null {
  if (!status) return null;
  if (status.mode === 'off') return '还没配置模型服务（服务器 .env 的 YUZU_AI_API_KEY）：只记数字，不写小结、不能问数';
  if (status.mode === 'mock') return '模拟模式（只在开发、测试实例）：没有调用模型，文字是固定模板';
  return null;
}
