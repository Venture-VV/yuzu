// 数据看板「经营总览」顶上的「昨日小结」（8.0.22，docs/AI_V8022.md 第 1 节）：每家店前一个营业日的一份，
// 合并看时是全公司的那一份；可以展开看给 AI 的数字（事实包）、可以「重新生成」。没配模型服务时只有数字。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ChevronDown, ChevronUp, RefreshCw, Sparkles } from 'lucide-react';
import type { AiCompanyFacts, AiDailyFacts, AiSummaryResponse, AiSummaryView } from '@shared/ai';
import { api, ApiError, errorMessage, shouldRetryQuery } from '../../lib/api';
import { useReportScope } from '../../lib/reportScope';
import { formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Button, Card, Skeleton } from '../../components/ui';
import { aiModeNote, useAiStatus } from './queries';

const STATUS_LABEL: Record<AiSummaryView['status'], { text: string; tone: 'neutral' | 'yuzu' | 'pine' | 'clay' }> = {
  running: { text: '生成中', tone: 'yuzu' },
  done: { text: '已生成', tone: 'pine' },
  failed: { text: '没生成出来', tone: 'clay' },
  unconfigured: { text: '只有数字', tone: 'neutral' },
};

function StoreFacts({ f }: { f: AiDailyFacts }) {
  return (
    <div className="space-y-1">
      <p>
        <span className="font-semibold">{f.store}</span>：净营业额 {f.revenue.net}（上周同一天 {f.compare.lastWeekSameDay}，近 7 天日均 {f.compare.avg7}）· 结账 {f.revenue.checkouts} 张 ·
        客人 {f.revenue.guests} 位 · 客单价 {f.revenue.perGuest}
        {f.revenue.refund !== '¥0.00' && ` · 退款 ${f.revenue.refund}`}
      </p>
      <p className="text-ink-3">
        新会员 {f.members.newMembers} 位 · 充值 {f.members.rechargeCount} 笔 {f.members.rechargePaid} · 储值消费 {f.members.walletConsumed}
        {f.topItems.length > 0 && ` · 卖得最好：${f.topItems.map((i) => `${i.name} ${i.quantity}`).join('、')}`}
      </p>
      {f.anomalies.length > 0 && <p className="text-ink-3">对账提醒：{f.anomalies.map((a) => `${a.kind} ${a.count}`).join('、')}</p>}
      {f.erpTodo && f.erpTodo.length > 0 && <p className="text-ink-3">ERP 待办：{f.erpTodo.join('；')}</p>}
    </div>
  );
}

function FactsView({ facts }: { facts: AiDailyFacts | AiCompanyFacts }) {
  if ('stores' in facts) {
    return (
      <div className="space-y-2">
        {facts.stores.map((f) => (
          <StoreFacts key={f.store} f={f} />
        ))}
        {facts.erpTodo.length > 0 && <p className="text-ink-3">ERP 待办：{facts.erpTodo.join('；')}</p>}
      </div>
    );
  }
  return <StoreFacts f={facts} />;
}

export function AiSummaryCard() {
  const scope = useReportScope();
  const qc = useQueryClient();
  const toast = useToast();
  const status = useAiStatus();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rules = status.data?.rules;
  const on = !rules || (rules.enabled && rules.dailySummary);
  const key = ['ai', 'summary', scope.merged] as const;
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<AiSummaryResponse>(`/api/ai/summaries${scope.qs}`),
    enabled: on,
    retry: shouldRetryQuery,
    // 生成中时每 2 秒看一次
    refetchInterval: (query) => (query.state.data?.summary?.status === 'running' ? 2000 : false),
  });
  if (!on) return null;
  // 全公司的那一份只有能进全部门店的人看得到
  if (q.error instanceof ApiError && q.error.status === 403) return null;
  const s = q.data?.summary ?? null;
  const regenerate = async () => {
    if (!q.data) return;
    setBusy(true);
    try {
      const r = await api.post<AiSummaryResponse>('/api/ai/summaries/regenerate', { date: q.data.date, ...(scope.merged ? { scope: 'all' } : {}) });
      qc.setQueryData(key, r);
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const note = aiModeNote(status.data);
  return (
    <Card className="p-5" data-testid="ai-summary">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Sparkles className="size-4 text-yuzu-deep" />
        <h2 className="text-[15px] font-bold">
          昨日小结{q.data && <span className="ml-1.5 font-normal text-ink-3">{q.data.date}{scope.merged ? ' · 全公司' : ''}</span>}
        </h2>
        {s && <Badge tone={STATUS_LABEL[s.status].tone}>{STATUS_LABEL[s.status].text}</Badge>}
        <span className="flex-1" />
        {q.data && s?.status !== 'running' && (
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void regenerate()} data-testid="ai-summary-regenerate">
            {s ? '重新生成' : '生成'}
          </Button>
        )}
      </div>
      {q.isPending ? (
        <Skeleton className="h-16" />
      ) : q.isError && !q.data ? (
        <LoadFailed title="昨日小结取不回来，请检查网络" onRetry={() => void q.refetch()} retrying={q.isFetching} testId="ai-summary-error" />
      ) : !s ? (
        <p className="text-[13.5px] text-ink-3">这一天的小结还没生成（每家店营业日切换以后自动生成；应用当时没开着的点「生成」）。</p>
      ) : (
        <div className="space-y-2 text-[14px] leading-relaxed">
          {s.status === 'running' ? (
            <p className="text-ink-3">正在生成…</p>
          ) : s.status === 'failed' ? (
            <p className="text-clay">没生成出来：{s.error}（会隔 5 分钟自动再试，最多 3 次；也可以点「重新生成」）</p>
          ) : s.status === 'unconfigured' ? (
            <p className="text-ink-3">还没配置模型服务，只记了当天的数字（展开看）。</p>
          ) : (
            <p className="whitespace-pre-line [overflow-wrap:anywhere]" data-testid="ai-summary-text">
              {s.text}
            </p>
          )}
          {s.facts && (
            <button type="button" className="flex items-center gap-1 text-[12.5px] font-semibold text-ink-3 hover:text-ink" onClick={() => setOpen((v) => !v)} data-testid="ai-summary-toggle">
              {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              {open ? '收起数字' : '看给 AI 的数字'}
            </button>
          )}
          {open && s.facts && (
            <div className="rounded-md bg-paper-2 px-3 py-2 text-[12.5px]" data-testid="ai-summary-facts">
              <FactsView facts={s.facts} />
            </div>
          )}
          <p className="text-[12px] text-ink-4">
            AI 按当天的汇总数写的，数字以看板为准；发给模型的只有汇总，没有会员的姓名、手机号。{s.model && s.status === 'done' ? `（${s.model === 'mock' ? '模拟' : s.model}，${formatDateTime(s.updatedAt)}）` : ''}
            {s.pushedAt && ' 已推送到企业微信。'}
            {s.pushError && ` 企业微信没推出去：${s.pushError}`}
          </p>
        </div>
      )}
      {note && <p className="mt-2 text-[12px] text-ink-3">{note}</p>}
    </Card>
  );
}

/** ERP 首页的一行（8.0.22）：生成好的昨日小结，点了去数据看板看全文；没有、关着、没权限时不显示 */
export function AiSummaryLine() {
  const status = useAiStatus();
  const rules = status.data?.rules;
  const on = !!rules && rules.enabled && rules.dailySummary;
  const q = useQuery({ queryKey: ['ai', 'summary', false], queryFn: () => api.get<AiSummaryResponse>('/api/ai/summaries'), enabled: on, retry: false });
  const s = q.data?.summary;
  if (!on || !s || s.status !== 'done' || !s.text) return null;
  return (
    <Link to="/admin/dashboard/overview" className="mb-4 flex items-start gap-2 rounded-lg border border-line bg-card px-4 py-3 text-[13.5px] hover:border-pine" data-testid="erp-ai-summary">
      <Sparkles className="mt-0.5 size-4 shrink-0 text-yuzu-deep" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">昨日小结 · {q.data!.date}</span>
        <span className="ml-2 line-clamp-2 text-ink-2">{s.text}</span>
      </span>
      <span className="shrink-0 text-[12.5px] font-semibold text-pine">看全文</span>
    </Link>
  );
}
