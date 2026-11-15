// 后台「对外接口」里的「AI 辅助」开关（8.0.22，docs/AI_V8022.md 第 6 节）：整项、每天的小结、问数、合同条款提示、
// 小结推企业微信、拒答时换模型（MD9）、每人每天问几次（MD10）。按「功能开关默认开」都默认开；没配模型服务时什么都不发。

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiRules } from '@shared/ai';
import { api, errorMessage } from '../../lib/api';
import { useToast } from '../../components/Toast';
import { LoadFailed } from '../../components/LoadFailed';
import { Button, Card, Field, Input, Skeleton } from '../../components/ui';
import { AI_STATUS_KEY } from './queries';

const SWITCHES: { key: Exclude<keyof AiRules, 'dailyQuestionLimit'>; label: string }[] = [
  { key: 'enabled', label: '启用 AI 辅助（关掉以后什么都不发给模型）' },
  { key: 'dailySummary', label: '每天的经营小结（数据看板「经营总览」顶上）' },
  { key: 'questions', label: '问数（数据看板「问数」）' },
  { key: 'contractHints', label: '合同条款提示（合同表单上「AI 看一下条款」）' },
  { key: 'pushWecom', label: '小结推到企业微信群（配了 ERP_WECOM_WEBHOOK 才推）' },
  { key: 'fallbacks', label: '模型拒答时由服务端换一个模型接着答' },
];

export function AiRulesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'ai-rules'], queryFn: () => api.get<AiRules>('/api/admin/ai-rules') });
  const [draft, setDraft] = useState<AiRules | null>(null);
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) {
      setDraft(q.data);
      setLimit(String(q.data.dailyQuestionLimit));
    }
  }, [q.data]);
  const save = async () => {
    if (!draft) return;
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      toast({ tone: 'error', title: '每人每天问几次：填 1 到 500 的整数' });
      return;
    }
    setBusy(true);
    try {
      await api.put('/api/admin/ai-rules', { ...draft, dailyQuestionLimit: n });
      await qc.invalidateQueries({ queryKey: ['admin', 'ai-rules'] });
      await qc.invalidateQueries({ queryKey: AI_STATUS_KEY });
      toast({ tone: 'success', title: 'AI 辅助的开关已保存' });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-5" data-testid="ai-rules">
      <h2 className="mb-1 text-[15px] font-bold">AI 辅助</h2>
      <p className="mb-3 text-[12.5px] text-ink-3">只读、只出文字：发给模型的只有汇总数与打码后的文字（会员姓名只留姓、手机号只留前三后四）。模型服务的密钥只放服务器的 .env。</p>
      {!draft ? (
        q.isError ? (
          <LoadFailed title="AI 辅助的开关取不回来，请检查网络（取回来以前不能保存）" onRetry={() => void q.refetch()} retrying={q.isFetching} testId="ai-rules-error" />
        ) : (
          <Skeleton className="h-28" />
        )
      ) : (
        <div className="space-y-2.5 text-[13.5px]">
          {SWITCHES.map((s) => (
            <label key={s.key} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-pine)]"
                checked={draft[s.key]}
                disabled={s.key !== 'enabled' && !draft.enabled}
                onChange={(e) => setDraft({ ...draft, [s.key]: e.target.checked })}
                data-testid={`ai-rule-${s.key}`}
              />
              {s.label}
            </label>
          ))}
          <Field label="每人每天最多问几次" htmlFor="ai-limit">
            <Input id="ai-limit" inputMode="numeric" fullWidth={false} className="h-9 w-28" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </Field>
          <Button variant="primary" loading={busy} onClick={() => void save()} data-testid="ai-rules-save">
            保存
          </Button>
        </div>
      )}
    </Card>
  );
}
