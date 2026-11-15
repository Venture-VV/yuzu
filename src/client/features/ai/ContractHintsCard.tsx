// 合同表单上的「AI 看一下条款」（8.0.22，docs/AI_V8022.md 第 5 节）：把表单上现在的内容（还没保存的也行）发给模型，
// 按条列出缺了的常见条款、结构化字段与正文对不上的地方、要留意的风险；每条可以「知道了」收起。
// 只是提示：不改合同、不进法务审查的结论；正文里的手机号、身份证号由服务端先打码再发。

import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { AI_HINT_KIND_LABELS, type AiContractHint, type AiContractHintsInput } from '@shared/ai';
import { api, errorMessage } from '../../lib/api';
import { Badge, Button, Card } from '../../components/ui';
import { useAiStatus } from './queries';

const KIND_TONE: Record<AiContractHint['kind'], 'yuzu' | 'clay' | 'neutral'> = { missing: 'yuzu', mismatch: 'clay', risk: 'neutral' };

export function ContractHintsCard({ input }: { input: () => AiContractHintsInput }) {
  const status = useAiStatus();
  const [hints, setHints] = useState<AiContractHint[] | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rules = status.data?.rules;
  // 关着、没配模型服务时不显示
  if (!status.data || !rules?.enabled || !rules.contractHints || status.data.mode === 'off') return null;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ hints: AiContractHint[] }>('/api/ai/contract-hints', input());
      setHints(r.hints);
      setHidden(new Set());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const shown = (hints ?? []).map((h, i) => ({ h, i })).filter(({ i }) => !hidden.has(i));
  return (
    <Card className="p-5" data-testid="contract-ai-hints">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="size-4 text-yuzu-deep" />
        <h2 className="text-[15px] font-bold">AI 看一下条款</h2>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void run()} data-testid="contract-ai-hints-run">
          {hints ? '再看一次' : '看一下'}
        </Button>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-3">
        只是提示：不改合同、不算法务审查的结论。发出去的是表单上现在的内容，会员的姓名、会员号、手机号、身份证号先打码。{status.data.mode === 'mock' ? '（模拟模式：固定的示例）' : ''}
      </p>
      {error && <p className="mt-2 text-[13px] text-clay">{error}</p>}
      {hints && (
        <ul className="mt-3 space-y-2" data-testid="contract-ai-hint-list">
          {shown.length === 0 ? (
            <li className="text-[13px] text-ink-3">{hints.length ? '都看过了。' : '没看出要提醒的。'}</li>
          ) : (
            shown.map(({ h, i }) => (
              <li key={i} className="flex items-start gap-2 rounded-md bg-paper-2 px-3 py-2 text-[13.5px]">
                <Badge tone={KIND_TONE[h.kind]} className="mt-0.5 shrink-0">
                  {AI_HINT_KIND_LABELS[h.kind]}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{h.title}</p>
                  <p className="text-ink-2">{h.detail}</p>
                </div>
                <button type="button" className="shrink-0 text-[12.5px] text-ink-3 hover:text-ink" onClick={() => setHidden((s) => new Set(s).add(i))} aria-label={`知道了：${h.title}`}>
                  <X className="inline size-3.5" /> 知道了
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </Card>
  );
}
