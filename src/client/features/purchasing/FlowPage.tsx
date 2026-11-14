// 采购 → 流程进度（8.0.17，docs/FLOW_V8017.md）：进行中的每一条画一张卡——流程 A / B、金额、从提需求到付款的一排环节。
// 顶上写现在的分流规则（读采购规则），可以按「卡住或超期」与停在哪个环节筛。只读；全部做完的不列。

import { PurchasingTabs } from './PurchasingTabs';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useSearchParams } from 'react-router';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { payDaysLabel } from '@shared/payments';
import { FLOW_STAGE_LABELS, flowYuan, type FlowNodeKey, type PurchaseFlowList } from '@shared/purchase-flow';
import { api, errorMessage } from '../../lib/api';
import { Stagger } from '../../lib/motion';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { FlowLegend } from '../../components/FlowTrack';
import { Notice, Skeleton } from '../../components/ui';
import { PurchaseFlowCard } from './PurchaseFlow';

/** 按停在哪个环节筛：这几个是会停人的环节（提需求不会停） */
const STAGES: FlowNodeKey[] = ['confirm', 'review', 'sourcing', 'award', 'approval', 'order', 'receive', 'stockin', 'pay'];

export function FlowPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const filter = params.get('stage') ?? '';
  const list = useQuery({ queryKey: ['inv', 'flow', 'list'], queryFn: () => api.get<PurchaseFlowList>('/api/purchase-flow/list'), enabled: can('inventory.read') });
  if (!can('inventory.read')) return <Navigate to="/purchasing" replace />;

  const flows = list.data?.flows ?? [];
  const count = (key: string) => (key === '' ? flows.length : key === 'alert' ? flows.filter((f) => f.alert).length : flows.filter((f) => f.stage === key).length);
  const shown = filter === '' ? flows : filter === 'alert' ? flows.filter((f) => f.alert) : flows.filter((f) => f.stage === filter);
  const rules = list.data?.rules;
  const chips: { value: string; label: string }[] = [{ value: '', label: '全部' }, { value: 'alert', label: '卡住或超期' }, ...STAGES.map((s) => ({ value: s as string, label: FLOW_STAGE_LABELS[s] }))];

  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/purchasing" className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回采购">
              <ArrowLeft className="size-[18px]" />
            </Link>
            流程进度
          </span>
        }
        subtitle="进行中的采购从提需求到付款走到哪了；每个环节的状态是从单据算出来的，点环节去那张单"
        actions={
          <Link to="/purchasing/rules" className="flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3.5 text-[13.5px] font-bold text-ink-2 hover:border-ink-3">
            <Settings2 className="size-4" />
            采购规则
          </Link>
        }
      />
      <PurchasingTabs active="flow" />
      <div className="shrink-0 border-b border-line px-5 py-3 md:px-7">
        {rules && (
          <p className="mb-2.5 text-[13px] text-ink-2" data-testid="flow-rules">
            按金额分流：
            {rules.quoteThresholdCents > 0 ? (
              <>
                <b className="font-bold text-ink">小于 {flowYuan(rules.quoteThresholdCents)}</b> 免比价（流程 A） ｜ <b className="font-bold text-ink">达到 {flowYuan(rules.quoteThresholdCents)}</b> 必须 ≥ {rules.minQuotes} 家比价并审批（流程 B）
              </>
            ) : (
              <>采购规则没设询价门槛，都走流程 A（免比价）；发起了询价的走流程 B</>
            )}
            <span className="text-ink-3">
              　·　一个环节等了 {rules.stallDays > 0 ? `${rules.stallDays} 天` : '多久都不'}标红，到货按预计到货日（没填按下单后 {rules.arrivalOverdueDays} 天）
              {rules.payDays.length > 0 && `；${payDaysLabel(rules.payDays)}付款`}
            </span>
          </p>
        )}
        <div className="scroll-thin flex gap-1.5 overflow-x-auto" role="group" aria-label="按环节筛">
          {chips.map((c) => {
            const n = count(c.value);
            const on = filter === c.value;
            return (
              <button
                key={c.value}
                type="button"
                aria-pressed={on}
                onClick={() => setParams(c.value ? { stage: c.value } : {}, { replace: true })}
                className={cn(
                  'flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors duration-150',
                  on ? 'border-pine bg-pine text-paper' : 'border-line-strong bg-card text-ink-2 hover:border-ink-3',
                  c.value === 'alert' && !on && n > 0 && 'border-clay/50 text-clay',
                )}
                data-testid={`flow-filter-${c.value || 'all'}`}
              >
                {c.label}
                <span className={cn('num text-[12px]', on ? 'text-paper/80' : 'text-ink-3')}>{n}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-5 md:px-7" data-testid="flow-page">
        {list.isPending ? (
          <div className="space-y-4">
            <Skeleton className="h-44" />
            <Skeleton className="h-44" />
          </div>
        ) : list.error ? (
          <Notice tone="error" title="流程进度没读出来">
            {errorMessage(list.error)}
          </Notice>
        ) : shown.length === 0 ? (
          <EmptyState art="leaf" title={flows.length === 0 ? '现在没有进行中的采购' : '这一类现在没有'} description={flows.length === 0 ? '部门提了需求、采购建了采购单或询价单以后，会在这里画出它走到哪了' : undefined} />
        ) : (
          <>
            {list.data?.truncated && <Notice tone="info" title="进行中的太多，只列了最近的 60 条" className="mb-4" />}
            <Stagger className="space-y-4">
              {shown.map((f) => (
                <PurchaseFlowCard key={`${f.anchor.kind}-${f.anchor.id}`} flow={f} />
              ))}
            </Stagger>
            <FlowLegend className="mt-5" />
          </>
        )}
      </div>
    </>
  );
}
