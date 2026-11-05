import { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { PackageSearch, Plus, Search } from 'lucide-react';
import type { PoStatus } from '@shared/purchasing';
import { errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Badge, Notice, Select, Skeleton } from '../../components/ui';
import { useSuppliers } from '../inventory/queries';
import { PoSheet } from './PoSheet';
import { PoStatusChip, ReceivingChip } from './parts';
import { usePos } from './queries';

const FILTERS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'submitted', label: '待确认' },
  { value: 'approved', label: '已确认' },
  { value: 'returned', label: '退回修改' },
  { value: 'draft', label: '草稿' },
  { value: 'closed', label: '已关闭' },
];

export function PurchasingPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const status = params.get('status') ?? '';
  const supplierId = params.get('supplier') ?? '';
  const suppliers = useSuppliers(true);
  const pos = usePos({ status: status || undefined, supplierId: supplierId || undefined, q: params.get('q') ?? undefined });
  const openId = Number(params.get('po')) || null;

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const urlQ = params.get('q') ?? '';
  useEffect(() => {
    if (q.trim() === urlQ) return;
    const t = setTimeout(() => update({ q: q.trim() || null }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, urlQ]);

  if (!can('inventory.read')) return <Navigate to="/" replace />;

  return (
    <>
      <PageHeader
        dateMode="calendar"
        title="采购"
        subtitle="采购单表达「准备买什么」；收货按实际合格数量入库；付款另行登记"
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <Link
              to="/purchasing/ordered"
              className="flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3.5 text-[13.5px] font-bold text-ink-2 hover:border-ink-3"
              data-testid="ordered-link"
            >
              <PackageSearch className="size-4" />
              下单物料
            </Link>
            {can('purchase.manage') && (
              <Link to="/purchasing/new" className="flex h-9 items-center gap-1.5 rounded-md bg-pine px-3.5 text-[13.5px] font-bold text-paper hover:bg-pine-hover">
                <Plus className="size-4" />
                新建采购单
              </Link>
            )}
          </span>
        }
      />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-3 md:px-7">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="状态">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={status === f.value}
              onClick={() => update({ status: f.value || null })}
              className={cn(
                'h-8 rounded-full px-3 text-[12.5px] font-semibold transition-colors',
                status === f.value ? 'bg-ink text-paper' : 'border border-line-strong bg-card text-ink-2 hover:border-ink-3',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Select fullWidth={false} value={supplierId} onChange={(e) => update({ supplier: e.target.value || null })} className="h-9 min-w-[150px] text-[13px]" aria-label="供应商">
          <option value="">全部供应商</option>
          {suppliers.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <div className="relative min-w-[200px] flex-1 md:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="单号 / 供应商 / 备注" aria-label="搜索采购单" className="h-9 w-full rounded-md border border-line-strong bg-card pr-3 pl-9 text-[13px] outline-none focus:border-pine" />
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-7">
        {pos.error ? (
          <Notice tone="error" title={errorMessage(pos.error)} />
        ) : pos.isPending ? (
          <Skeleton className="h-64" />
        ) : pos.data.length === 0 ? (
          <EmptyState art="leaf" title="没有符合条件的采购单" description={can('purchase.manage') ? '新建采购单后，负责人确认即可按单收货。' : undefined} className="rounded-lg border border-dashed border-line-strong" />
        ) : (
          <ul className="overflow-hidden rounded-lg border border-line bg-card shadow-card">
            {pos.data.map((p) => (
              <li key={p.id} className="border-b border-line/70 last:border-0">
                <button
                  type="button"
                  onClick={() => update({ po: String(p.id) })}
                  className={cn(
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left transition-colors hover:bg-pine-tint/50 lg:grid-cols-[170px_minmax(0,1fr)_120px_120px_96px_96px]',
                    openId === p.id && 'bg-pine-tint',
                  )}
                >
                  <span className="min-w-0">
                    <span className="num block truncate text-[13.5px] font-bold">
                      {p.docNo}
                      {p.revision > 1 && <span className="ml-1 text-[11.5px] font-semibold text-ink-3">v{p.revision}</span>}
                    </span>
                    <span className="num block text-[11.5px] text-ink-3">
                      {p.orderDate}
                      {p.expectedDate && ` · 预计 ${p.expectedDate.slice(5)}`}
                    </span>
                  </span>
                  <span className="col-span-2 min-w-0 lg:col-span-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-semibold">{p.supplierName}</span>
                      {p.channel && <span className="shrink-0 truncate text-[11.5px] font-semibold text-ink-3">{p.channel.label}</span>}
                      {p.backfill && <Badge tone="ember">补单</Badge>}
                    </span>
                    <span className="block truncate text-[12.5px] text-ink-3">
                      {p.summary}
                      {p.lineCount > 3 && ` 等 ${p.lineCount} 项`}
                    </span>
                  </span>
                  <span className="hidden text-right lg:block">
                    <Money cents={p.totalCents} className="text-[14px] font-bold" />
                    <span className="block text-[11px] text-ink-3">下单</span>
                  </span>
                  <span className="hidden text-right lg:block">
                    <Money cents={p.receivedCents} className="text-[14px] font-semibold text-pine" />
                    <span className="block text-[11px] text-ink-3">已收货</span>
                  </span>
                  <span className="hidden lg:block">{(p.status === 'approved' || p.status === 'closed') && <ReceivingChip state={p.receiving} />}</span>
                  <span className="row-start-1 justify-self-end lg:row-auto">
                    <PoStatusChip status={p.status as PoStatus} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <PoSheet id={openId} onClose={() => update({ po: null })} />
    </>
  );
}
