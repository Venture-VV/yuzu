import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Search } from 'lucide-react';
import { INV_DOC_META, INV_DOC_TYPES, INV_STATUS_LABELS, type InvDocStatus, type InvDocType } from '@shared/inventory';
import { errorMessage } from '../../lib/api';
import { cn, formatDateTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Badge, Input, Notice, Select, Skeleton } from '../../components/ui';
import { DocSheet } from './DocSheet';
import { DocTypeChip, StatusChip } from './parts';
import { useInvDocs } from './queries';

export function DocsTab() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const filter = {
    type: params.get('type') ?? undefined,
    status: params.get('status') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    q: params.get('q') ?? undefined,
  };
  const docs = useInvDocs(filter);
  const openId = Number(params.get('doc')) || null;

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

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-3 md:px-7">
        <Select fullWidth={false} value={filter.type ?? ''} onChange={(e) => update({ type: e.target.value || null })} className="h-9 min-w-[128px] text-[13px]" aria-label="单据类型">
          <option value="">全部类型</option>
          {INV_DOC_TYPES.map((t) => (
            <option key={t} value={t}>
              {INV_DOC_META[t].title}
            </option>
          ))}
        </Select>
        <Select fullWidth={false} value={filter.status ?? ''} onChange={(e) => update({ status: e.target.value || null })} className="h-9 min-w-[120px] text-[13px]" aria-label="状态">
          <option value="">全部状态</option>
          {(Object.keys(INV_STATUS_LABELS) as InvDocStatus[]).map((s) => (
            <option key={s} value={s}>
              {INV_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <span className="flex items-center gap-1.5 text-[13px] text-ink-3">
          <Input fullWidth={false} type="date" value={filter.from ?? ''} onChange={(e) => update({ from: e.target.value || null })} className="h-9 w-[150px] text-[13px]" aria-label="开始日期" />
          至
          <Input fullWidth={false} type="date" value={filter.to ?? ''} onChange={(e) => update({ to: e.target.value || null })} className="h-9 w-[150px] text-[13px]" aria-label="结束日期" />
        </span>
        <div className="relative min-w-[200px] flex-1 md:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="单号 / 供应商 / 部门 / 经办"
            aria-label="搜索单据"
            className="h-9 w-full rounded-md border border-line-strong bg-card pr-3 pl-9 text-[13px] outline-none focus:border-pine"
          />
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-7">
        {docs.error ? (
          <Notice tone="error" title={errorMessage(docs.error)} />
        ) : docs.isPending ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : docs.data.length === 0 ? (
          <EmptyState art="calm" title="没有符合条件的单据" description="换个类型、状态或日期试试。" className="rounded-lg border border-dashed border-line-strong" />
        ) : (
          <ul className="overflow-hidden rounded-lg border border-line bg-card shadow-card">
            {docs.data.map((d) => (
              <li key={d.id} className="border-b border-line/70 last:border-0">
                <button
                  type="button"
                  onClick={() => update({ doc: String(d.id) })}
                  className={cn(
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left transition-colors hover:bg-pine-tint/50 lg:grid-cols-[110px_170px_minmax(0,1fr)_120px_100px_100px]',
                    openId === d.id && 'bg-pine-tint',
                  )}
                >
                  <span className="hidden lg:block">
                    <DocTypeChip type={d.docType as InvDocType} />
                  </span>
                  <span className="min-w-0">
                    <span className="num block truncate text-[13.5px] font-bold">{d.docNo}</span>
                    <span className="num block text-[11.5px] text-ink-3">
                      {d.docDate} · {d.createdByName}
                    </span>
                  </span>
                  <span className="col-span-2 min-w-0 lg:col-span-1">
                    <span className="flex items-center gap-1.5">
                      <span className="lg:hidden">
                        <DocTypeChip type={d.docType as InvDocType} />
                      </span>
                      {d.partyName && <span className="truncate text-[13px] font-semibold">{d.partyName}</span>}
                      {d.noPo && d.docType === 'receipt' && <Badge tone="ember">缺少采购依据</Badge>}
                    </span>
                    <span className="block truncate text-[12.5px] text-ink-3">
                      {d.summary}
                      {d.lineCount > 3 && ` 等 ${d.lineCount} 项`}
                    </span>
                  </span>
                  <span className="hidden text-right lg:block">
                    {d.docType === 'receipt' || d.docType === 'supplier_return' ? (
                      <Money cents={d.docType === 'supplier_return' ? -d.amountCents : d.amountCents} className="text-[14px] font-bold" />
                    ) : (
                      <span className="text-[12.5px] text-ink-3">{d.lineCount} 项</span>
                    )}
                  </span>
                  <span className="row-start-1 justify-self-end lg:row-auto">
                    <StatusChip status={d.status} />
                  </span>
                  <span className="hidden text-right text-[11.5px] text-ink-3 lg:block">{formatDateTime(d.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {docs.data && docs.data.length >= 200 && <p className="mt-3 text-center text-[12.5px] text-ink-3">只显示最近 200 张，可按日期或类型缩小范围。</p>}
      </div>

      <DocSheet id={openId} onClose={() => update({ doc: null })} />
    </>
  );
}
