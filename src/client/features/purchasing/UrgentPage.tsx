// 急采（8.0.1 采购组整改 05，CG05，docs/PURCHASING_V801.md）：没有采购单、临时给部门买的东西，收拢到采购登记；
// 按采购规则里的金额分级审批（审批中心），批了以后仓库到部门验收、进部门小仓，之后采购补采购单（提交即确认）。
// 列表按进度分：审批中、待验收、待补单、全部；点开看单据——审批、验收、补单都在单据里办。

import { Link, Navigate, useSearchParams } from 'react-router';
import { Plus } from 'lucide-react';
import type { InvDocSummary } from '@shared/inventory';
import { formatAmount } from '@shared/money';
import { errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Badge, Notice, Segmented, Skeleton } from '../../components/ui';
import { DocSheet } from '../inventory/DocSheet';
import { StatusChip } from '../inventory/parts';
import { useInvDocs } from '../inventory/queries';
import { usePurchaseRules } from './queries';

type Filter = 'approving' | 'verifying' | 'backfill' | 'all';

/** 急采走到哪一步了 */
export function urgentStage(d: Pick<InvDocSummary, 'status' | 'urgentApproved' | 'needsBackfill'>): { label: string; tone: 'yuzu' | 'lake' | 'clay' | 'pine' | 'neutral' } | null {
  if (d.status === 'submitted') return d.urgentApproved ? { label: '待仓库验收', tone: 'lake' } : { label: '审批中', tone: 'yuzu' };
  if (d.needsBackfill) return { label: '待补采购单', tone: 'clay' };
  if (d.status === 'confirmed') return { label: '已补单', tone: 'pine' };
  return null;
}

const MATCH: Record<Filter, (d: InvDocSummary) => boolean> = {
  approving: (d) => d.status === 'submitted' && !d.urgentApproved,
  verifying: (d) => d.status === 'submitted' && d.urgentApproved,
  backfill: (d) => d.needsBackfill,
  all: () => true,
};

export function UrgentPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const filter = (['approving', 'verifying', 'backfill', 'all'] as const).find((f) => f === params.get('view')) ?? 'all';
  const openId = Number(params.get('doc')) || null;
  const docs = useInvDocs({ urgent: '1' }, can('inventory.read'));
  const rules = usePurchaseRules(can('inventory.read'));
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  if (!can('inventory.read')) return <Navigate to="/purchasing" replace />;
  const all = docs.data ?? [];
  const count = (f: Filter) => all.filter(MATCH[f]).length;
  const rows = all.filter(MATCH[filter]);
  const tiers = rules.data?.urgentTiers ?? [];

  return (
    <>
      <PageHeader
        dateMode="calendar"
        title="急采"
        subtitle="没有采购单、临时给部门买的东西：采购登记 → 按金额分级审批 → 仓库到部门验收 → 补采购单（提交即确认）"
        actions={
          can('purchase.manage') ? (
            <Link to="/purchasing/urgent/new" className="flex h-9 items-center gap-1.5 rounded-md bg-pine px-3.5 text-[13.5px] font-bold text-paper hover:bg-pine-hover" data-testid="urgent-new">
              <Plus className="size-4" />
              登记急采
            </Link>
          ) : undefined
        }
      />
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-5 py-3 md:px-7">
        <Segmented<Filter>
          ariaLabel="急采进度"
          value={filter}
          onChange={(v) => set({ view: v === 'all' ? null : v })}
          options={[
            { value: 'all', label: '全部' },
            { value: 'approving', label: `审批中 ${count('approving') || ''}`.trim() },
            { value: 'verifying', label: `待验收 ${count('verifying') || ''}`.trim() },
            { value: 'backfill', label: `待补单 ${count('backfill') || ''}`.trim() },
          ]}
        />
        {tiers.length > 0 && (
          <span className="text-[12.5px] text-ink-3" data-testid="urgent-tiers">
            分级审批：
            {tiers.map((t, i) => `${i === 0 ? '' : '、'}≤ ¥${formatAmount(t.maxCents)}${t.approverIds.length ? ` 由指定的 ${t.approverIds.length} 人审` : ' 由负责人审'}`).join('')}
            ；超过 ¥{formatAmount(tiers[tiers.length - 1]!.maxCents)} 请开采购单
          </span>
        )}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-7">
        {docs.error ? (
          <Notice tone="error" title={errorMessage(docs.error)} />
        ) : docs.isPending ? (
          <Skeleton className="h-64" />
        ) : rows.length === 0 ? (
          <EmptyState art="leaf" title={filter === 'all' ? '还没有急采' : '这一栏没有急采'} description={can('purchase.manage') ? '部门临时要的东西，点「登记急采」。' : undefined} className="rounded-lg border border-dashed border-line-strong" />
        ) : (
          <ul className="overflow-hidden rounded-lg border border-line bg-card shadow-card" data-testid="urgent-list">
            {rows.map((d) => {
              const stage = urgentStage(d);
              return (
                <li key={d.id} className="border-b border-line/70 last:border-0">
                  <button
                    type="button"
                    onClick={() => set({ doc: String(d.id) })}
                    className={cn('grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-paper-2 md:grid-cols-[150px_minmax(0,1fr)_120px_auto]', openId === d.id && 'bg-pine-tint/40')}
                    data-testid={`urgent-row-${d.id}`}
                  >
                    <span className="num text-[13.5px] font-bold">
                      {d.docNo}
                      <span className="block font-sans text-[12px] font-medium text-ink-3">{d.docDate}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-semibold">
                        {d.warehouseName ?? '—'} · {d.summary || '—'}
                      </span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {d.partyName ?? '—'} · {d.createdByName} 登记 · {formatDateTime(d.createdAt)}
                      </span>
                    </span>
                    <Money cents={d.amountCents} className="hidden text-right text-[14px] font-bold md:block" />
                    <span className="flex flex-wrap items-center justify-end gap-1.5">
                      {stage ? <Badge tone={stage.tone}>{stage.label}</Badge> : <StatusChip status={d.status} />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <DocSheet id={openId} onClose={() => set({ doc: null })} />
    </>
  );
}
