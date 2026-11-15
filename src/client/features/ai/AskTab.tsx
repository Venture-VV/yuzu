// 数据看板「问数」（8.0.22，docs/AI_V8022.md 第 2 节）：用一句话问经营数据，AI 挑只读报表取数、写答案并注明用了哪张报表。
// 只读：问答不改任何数据。每问一个操作编号——没收到结果再点一次返回同一份（不会再调一次模型、多算一次）。

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquareText, Send } from 'lucide-react';
import { AI_QUESTION_MAX, type AiQuestionView } from '@shared/ai';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Button, Card, Notice, Skeleton, Textarea } from '../../components/ui';
import { AI_STATUS_KEY, aiModeNote, useAiStatus } from './queries';

const EXAMPLES = ['上周哪些项目卖得最好？', '这个月和上个月比，餐饮少了多少？', '昨天的退款有多少，主要是哪种收款方式？', '最近 7 天每天的客人数'];
const TOOL_LABELS: Record<string, string> = {
  daily_close: '营收合计',
  revenue_by_day: '每天的营收',
  dept_items: '部门与项目',
  member_overview: '会员合计',
  technician_performance: '技师业绩',
  bookings_overview: '预约',
  inventory_alerts: '库存提醒',
  payables_week: '本周应付',
};

function Answer({ q }: { q: AiQuestionView }) {
  return (
    <div className="space-y-1.5" data-testid={`ai-question-${q.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <span className="font-semibold text-ink">{q.question}</span>
        <span>{formatDateTime(q.createdAt)}</span>
        {q.status === 'running' && <Badge tone="yuzu">回答中</Badge>}
        {q.status === 'refused' && <Badge tone="neutral">答不了</Badge>}
        {q.status === 'failed' && <Badge tone="clay">出错</Badge>}
      </div>
      {q.status === 'done' ? (
        <p className="text-[14px] leading-relaxed whitespace-pre-line [overflow-wrap:anywhere]" data-testid="ai-answer">
          {q.answer}
        </p>
      ) : q.status === 'running' ? (
        <p className="text-[13.5px] text-ink-3">正在取数、写答案…（一般十几秒）</p>
      ) : (
        <p className="text-[13.5px] text-clay [overflow-wrap:anywhere]">{q.error}</p>
      )}
      {q.tools.length > 0 && (
        <p className="text-[12px] text-ink-4">
          用了：
          {q.tools
            .map((t) => {
              const input = t.input as { from?: string; to?: string } | null;
              return `${TOOL_LABELS[t.name] ?? t.name}${input?.from ? `（${input.from === input.to ? input.from : `${input.from} 至 ${input.to}`}）` : ''}${t.ok ? '' : '（没取到）'}`;
            })
            .join('、')}
        </p>
      )}
    </div>
  );
}

export function AskTab() {
  const session = useSession();
  const qc = useQueryClient();
  const status = useAiStatus();
  const [text, setText] = useState('');
  // 发出去还没收到结果的那一问：原样重发用同一个编号
  const [pending, setPending] = useState<{ clientKey: string; question: string } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const list = useQuery({ queryKey: ['ai', 'questions'], queryFn: () => api.get<AiQuestionView[]>('/api/ai/questions') });
  const current = useQuery({
    queryKey: ['ai', 'question', currentId],
    queryFn: () => api.get<AiQuestionView>(`/api/ai/questions/${currentId}`),
    enabled: currentId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1500 : false),
  });
  useEffect(() => {
    if (current.data && current.data.status !== 'running') void qc.invalidateQueries({ queryKey: ['ai', 'questions'] });
  }, [current.data, qc]);

  const rules = status.data?.rules;
  // 上面单独显示的这一问不在下面重复
  const earlier = (list.data ?? []).filter((q) => q.id !== current.data?.id);
  const ask = async (p: { clientKey: string; question: string }) => {
    setBusy(true);
    setSendError(null);
    setPending(p);
    try {
      const r = await api.post<AiQuestionView>('/api/ai/questions', p);
      qc.setQueryData(['ai', 'question', r.id], r);
      setCurrentId(r.id);
      setPending(null);
      setText('');
      void qc.invalidateQueries({ queryKey: AI_STATUS_KEY });
    } catch (e) {
      // 明确被拒绝的（限额、关着、没配置……）换个问题再问；连不上的留着编号，原样再发一次
      if (e instanceof ApiError && e.status < 500) setPending(null);
      setSendError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    const question = text.trim();
    if (question.length < 2) return;
    void ask({ clientKey: uuid(), question });
  };

  if (status.isPending) return <Skeleton className="h-40" />;
  if (status.isError && !status.data) return <LoadFailed title="AI 辅助的状态取不回来，请检查网络" onRetry={() => void status.refetch()} retrying={status.isFetching} testId="ai-status-error" />;
  const off = !rules?.enabled || !rules.questions;
  const note = aiModeNote(status.data);
  return (
    <div className="space-y-5" data-testid="ai-ask">
      <Card className="p-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <MessageSquareText className="size-4 text-pine" />
          <h2 className="text-[15px] font-bold">问数</h2>
          <span className="text-[12.5px] text-ink-3">
            {session.store.name} · 今天问了 {status.data?.usedToday ?? 0} / {rules?.dailyQuestionLimit ?? '—'} 次
          </span>
        </div>
        <p className="mb-3 text-[13px] text-ink-3">用一句话问经营数据：AI 只能用看板上的只读报表取数（你看得到的那几张），答案里会写用了哪张、哪个日期范围；数字以看板为准。问数只看汇总的数、查不了某一位会员——问题里不要写会员的姓名、会员号、手机号、证件号：认出来会拦下、什么都不发。</p>
        {off ? (
          <Notice tone="info" title="问数已关闭">店主可以在后台「对外接口」→ AI 辅助里打开。</Notice>
        ) : status.data?.mode === 'off' ? (
          <Notice tone="info" title="还没配置模型服务">服务器 .env 里配了 YUZU_AI_API_KEY 以后才能问数。</Notice>
        ) : (
          <>
            <Textarea
              rows={2}
              maxLength={AI_QUESTION_MAX}
              placeholder="例如：上周哪些项目卖得最好？"
              value={pending?.question ?? text}
              disabled={!!pending}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
              }}
              aria-label="要问的问题"
              data-testid="ai-question-input"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {pending ? (
                <>
                  <Button variant="primary" size="sm" loading={busy} onClick={() => void ask(pending)} data-testid="ai-question-retry">
                    原样再发一次
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
                    不问了
                  </Button>
                </>
              ) : (
                <Button variant="primary" size="sm" icon={<Send className="size-3.5" />} loading={busy} disabled={text.trim().length < 2} onClick={submit} data-testid="ai-question-send">
                  问
                </Button>
              )}
              {!pending &&
                EXAMPLES.map((x) => (
                  <button key={x} type="button" className="rounded-full bg-paper-2 px-2.5 py-1 text-[12.5px] text-ink-2 hover:bg-paper-3" onClick={() => setText(x)}>
                    {x}
                  </button>
                ))}
            </div>
            {sendError && <p className="mt-2 text-[13px] text-clay">{sendError}{pending ? '（没收到结果：原样再发一次不会多问一次）' : ''}</p>}
          </>
        )}
        {note && <p className="mt-2 text-[12px] text-ink-3">{note}</p>}
      </Card>

      {current.data && (
        <Card className="p-5">
          <Answer q={current.data} />
        </Card>
      )}

      <Card className="p-5">
        <h2 className="mb-3 text-[15px] font-bold">我问过的</h2>
        {list.isPending ? (
          <Skeleton className="h-24" />
        ) : list.isError && !list.data ? (
          <LoadFailed title="问过的问题取不回来，请检查网络" onRetry={() => void list.refetch()} retrying={list.isFetching} testId="ai-questions-error" />
        ) : !earlier.length ? (
          <p className="text-[13px] text-ink-3">{current.data ? '除了上面这一问，还没问过别的。' : '还没问过。'}</p>
        ) : (
          <ul className="divide-y divide-line/70">
            {earlier.map((q) => (
              <li key={q.id} className="py-3">
                <Answer q={q} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
