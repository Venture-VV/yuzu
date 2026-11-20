// 急采（8.0.1 采购组整改 05，CG05，docs/PURCHASING_V801.md）：没有采购单、临时给部门买的东西，收拢到采购登记；
// 按采购规则里的金额分级审批（审批中心），批了以后仓库到部门验收、进部门小仓，之后采购补采购单（提交即确认）。
// 列表按进度分：审批中、待验收、待补单、全部；点开看单据——审批、验收、补单都在单据里办。
// 8.1.10 急采后补合同（docs/ERP_V8110.md 第 1 节）：多一栏「待补合同」，写着期限；点开补单采购单补合同，还没补采购单的先补单。

import { PurchasingTabs } from './PurchasingTabs';
import { Link, Navigate, useSearchParams } from 'react-router';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { InvDocSummary } from '@shared/inventory';
import { formatAmount } from '@shared/money';
import type { UrgentContractDueRow } from '@shared/purchasing';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Badge, Notice, Segmented, Skeleton } from '../../components/ui';
import { DocSheet } from '../inventory/DocSheet';
import { StatusChip } from '../inventory/parts';
import { useInvDocs } from '../inventory/queries';
import { PoSheet } from './PoSheet';
import { usePurchaseRules } from './queries';

type Filter = 'approving' | 'verifying' | 'backfill' | 'contract' | 'all';

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
  // 待补合同另取（/api/purchase-orders/contract-due），这里不用
  contract: () => false,
  all: () => true,
};

export function UrgentPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const filter = (['approving', 'verifying', 'backfill', 'contract', 'all'] as const).find((f) => f === params.get('view')) ?? 'all';
  const openId = Number(params.get('doc')) || null;
  const poOpenId = Number(params.get('po')) || null;
  // 待补合同（8.1.10）：键以 inv 开头，补完合同时跟着刷新
  const due = useQuery({
    queryKey: ['inv', 'contract-due'],
    queryFn: () => api.get<UrgentContractDueRow[]>('/api/purchase-orders/contract-due'),
    enabled: can('inventory.read'),
  });
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
            <Link
              to="/purchasing/urgent/new"
              className="tap relative flex h-9 items-center gap-1.5 rounded-md bg-pine px-3.5 text-[13.5px] font-bold text-paper hover:bg-pine-hover"
              data-testid="urgent-new"
            >
              <Plus className="size-4" />
              登记急采
            </Link>
          ) : undefined
        }
      />
      <PurchasingTabs active="urgent" />
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-5 py-3 md:px-7">
        {/* 五个页签在手持机（360 宽）上放不下一排：这一条自己横着滑，页面不横向滚动 */}
        <div className="max-w-full overflow-x-auto">
          <Segmented<Filter>
            ariaLabel="急采进度"
            value={filter}
            onChange={(v) => set({ view: v === 'all' ? null : v })}
            options={[
              { value: 'all', label: '全部' },
              { value: 'approving', label: `审批中 ${count('approving') || ''}`.trim() },
              { value: 'verifying', label: `待验收 ${count('verifying') || ''}`.trim() },
              { value: 'backfill', label: `待补单 ${count('backfill') || ''}`.trim() },
              { value: 'contract', label: `待补合同 ${due.data?.length || ''}`.trim() },
            ]}
          />
        </div>
        {tiers.length > 0 && (
          <span className="text-[12.5px] text-ink-3" data-testid="urgent-tiers">
            分级审批：
            {tiers.map((t, i) => `${i === 0 ? '' : '、'}≤ ¥${formatAmount(t.maxCents)}${t.approverIds.length ? ` 由指定的 ${t.approverIds.length} 人审` : ' 由负责人审'}`).join('')}
            ；超过 ¥{formatAmount(tiers[tiers.length - 1]!.maxCents)} 请开采购单
          </span>
        )}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-7">
        {filter === 'contract' ? (
          <ContractDueList due={due} onOpen={(r) => set(r.poId ? { po: String(r.poId) } : { doc: String(r.receiptId) })} />
        ) : docs.error ? (
          <Notice tone="error" title={errorMessage(docs.error)} />
        ) : docs.isPending ? (
          <Skeleton className="h-64" />
        ) : rows.length === 0 ? (
          <EmptyState
            art="leaf"
            title={filter === 'all' ? '还没有急采' : '这一栏没有急采'}
            description={can('purchase.manage') ? '部门临时要的东西，点「登记急采」。' : undefined}
            className="rounded-lg border border-dashed border-line-strong"
          />
        ) : (
          <ul className="overflow-hidden rounded-lg border border-line bg-card shadow-card" data-testid="urgent-list">
            {rows.map((d) => {
              const stage = urgentStage(d);
              return (
                <li key={d.id} className="border-b border-line/70 last:border-0">
                  <button
                    type="button"
                    onClick={() => set({ doc: String(d.id) })}
                    className={cn(
                      'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-paper-2 md:grid-cols-[150px_minmax(0,1fr)_120px_auto]',
                      openId === d.id && 'bg-pine-tint/40',
                    )}
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
                    <span className="flex flex-wrap items-center justify-end gap-1.5">{stage ? <Badge tone={stage.tone}>{stage.label}</Badge> : <StatusChip status={d.status} />}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <DocSheet id={openId} onClose={() => set({ doc: null })} />
      <PoSheet id={poOpenId} onClose={() => set({ po: null })} />
    </>
  );
}

/** 待补合同（8.1.10，CK19）：期限早的在前，超期的标红；点开补单采购单补合同，还没补采购单的点开收货单先补单 */
function ContractDueList({ due, onOpen }: { due: UseQueryResult<UrgentContractDueRow[]>; onOpen: (r: UrgentContractDueRow) => void }) {
  if (due.isPending) return <Skeleton className="h-40" />;
  if (due.isError && !due.data) return <LoadFailed title="待补合同没取回来" onRetry={() => void due.refetch()} retrying={due.isFetching} />;
  const rows = due.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        art="leaf"
        title="没有要补合同的急采"
        description="急采金额达到采购规则里「急采合计到多少要补合同」的，生效后列在这里。"
        className="rounded-lg border border-dashed border-line-strong"
      />
    );
  }
  return (
    <ul className="overflow-hidden rounded-lg border border-line bg-card shadow-card" data-testid="urgent-contract-due">
      {rows.map((r) => (
        <li key={r.receiptId} className="border-b border-line/70 last:border-0">
          <button
            type="button"
            onClick={() => onOpen(r)}
            className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-paper-2 md:grid-cols-[150px_minmax(0,1fr)_120px_auto]"
            data-testid={`urgent-contract-${r.receiptId}`}
          >
            <span className="num text-[13.5px] font-bold">
              {r.docNo}
              <span className="block font-sans text-[12px] font-medium text-ink-3">{r.docDate}</span>
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13.5px] font-semibold">
                {r.supplierName} · {r.departmentName ?? '—'}
              </span>
              <span className="block truncate text-[12px] text-ink-3">
                {r.poNo ? `补单采购单 ${r.poNo}` : '还没补采购单（先补单，再补合同）'} · 期限 {r.dueOn}
              </span>
            </span>
            <Money cents={r.amountCents} className="hidden text-right text-[14px] font-bold md:block" />
            <span className="flex flex-wrap items-center justify-end gap-1.5">
              <Badge tone={r.daysLeft < 0 ? 'clay' : 'yuzu'}>{r.daysLeft < 0 ? `超期 ${-r.daysLeft} 天` : `还剩 ${r.daysLeft} 天`}</Badge>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
