import { useMemo } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { ArrowRight, Inbox, TriangleAlert } from 'lucide-react';
import { INV_DOC_META, type InvDocType } from '@shared/inventory';
import { errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, relativeTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Badge, Notice, Skeleton } from '../../components/ui';
import { DocSheet } from './DocSheet';
import { DOC_VISUAL, Qty, SimRule } from './parts';
import { useInvDocs, useMaterials } from './queries';

/** 负责人待办：先处理需要确认的申请，再看需要关注的异常 */
export function TodoPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const openId = Number(params.get('doc')) || null;
  const pending = useInvDocs({ status: 'submitted' });
  const noPo = useInvDocs({ type: 'receipt', status: 'confirmed' });
  const materials = useMaterials();
  const low = useMemo(() => (materials.data ?? []).filter((m) => m.isLow), [materials.data]);
  const missingPo = (noPo.data ?? []).filter((d) => d.noPo);

  if (!can('inventory.approve')) return <Navigate to="/inventory" replace />;
  const open = (id: number | null) => setParams(id ? { doc: String(id) } : {}, { replace: true });

  return (
    <>
      <PageHeader dateMode="calendar" title="待办" subtitle="需要负责人确认的申请与需要关注的异常" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-[1180px] gap-5 px-5 py-5 md:px-7 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-[15px] font-bold">待确认</h2>
              {pending.data && <span className="num rounded-full bg-yuzu px-2 text-[12px] font-bold">{pending.data.length}</span>}
              <SimRule>审批安排为模拟规则</SimRule>
            </div>
            {pending.error ? (
              <Notice tone="error" title={errorMessage(pending.error)} />
            ) : pending.isPending ? (
              <Skeleton className="h-40" />
            ) : pending.data.length === 0 ? (
              <EmptyState art="calm" title="没有待确认的申请" description="新的报损、盘点调整、退货与期初提交后会出现在这里。" className="rounded-lg border border-dashed border-line-strong bg-card" />
            ) : (
              <ul className="space-y-2">
                {pending.data.map((d) => {
                  const v = DOC_VISUAL[d.docType as InvDocType];
                  const Icon = v.icon;
                  return (
                    <li key={d.id}>
                      <button
                        type="button"
                        onClick={() => open(d.id)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left shadow-card transition-colors hover:border-line-strong',
                          openId === d.id ? 'border-pine' : 'border-line',
                        )}
                      >
                        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full', v.tone)}>
                          <Icon className="size-5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="text-[14px] font-bold">{INV_DOC_META[d.docType as InvDocType].title}</span>
                            <span className="num text-[12.5px] text-ink-3">{d.docNo}</span>
                          </span>
                          <span className="block truncate text-[12.5px] text-ink-2">
                            {d.partyName && `${d.partyName} · `}
                            {d.summary}
                            {d.lineCount > 3 && ` 等 ${d.lineCount} 项`}
                          </span>
                          <span className="block text-[11.5px] text-ink-3">
                            {d.createdByName} 提交 · {relativeTime(d.createdAt)}
                          </span>
                        </span>
                        {d.docType === 'supplier_return' && <Money cents={-d.amountCents} className="text-[14px] font-bold text-clay" />}
                        <ArrowRight className="size-4 shrink-0 text-ink-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <aside className="space-y-4">
            <div className="rounded-lg border border-line bg-card p-4 shadow-card">
              <p className="mb-2 flex items-center gap-1.5 text-[13px] font-bold">
                <TriangleAlert className="size-4 text-clay" />
                低库存提醒 <span className="num text-ink-3">{low.length}</span>
              </p>
              {low.length === 0 ? (
                <p className="text-[12.5px] text-ink-3">没有低于提醒线的物料。</p>
              ) : (
                <ul className="space-y-1.5">
                  {low.slice(0, 8).map((m) => (
                    <li key={m.id}>
                      <Link to={`/inventory?m=${m.id}`} className="flex items-center gap-2 text-[13px] hover:text-pine">
                        <span className="min-w-0 flex-1 truncate font-semibold">{m.name}</span>
                        <Qty milli={m.stockMilli} unit={m.inventoryUnit} className="font-bold text-clay" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[11.5px] text-ink-3">提醒线为人工设定的模拟值，不是行业推荐用量。</p>
            </div>
            <div className="rounded-lg border border-line bg-card p-4 shadow-card">
              <p className="mb-2 flex items-center gap-1.5 text-[13px] font-bold">
                <Inbox className="size-4 text-ember" />
                缺少采购依据的收货 <span className="num text-ink-3">{missingPo.length}</span>
              </p>
              {missingPo.length === 0 ? (
                <p className="text-[12.5px] text-ink-3">所有收货都有采购依据。</p>
              ) : (
                <ul className="space-y-1.5">
                  {missingPo.slice(0, 6).map((d) => (
                    <li key={d.id}>
                      <button type="button" onClick={() => open(d.id)} className="flex w-full items-center gap-2 text-left text-[13px] hover:text-pine">
                        <span className="num font-semibold">{d.docNo}</span>
                        <span className="min-w-0 flex-1 truncate text-ink-3">{d.partyName}</span>
                        <Money cents={d.amountCents} className="font-semibold" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[11.5px] text-ink-3">
                直接收货已计入库存与货款；补采购单时关联原收货，不会重复入库。<Badge tone="yuzu" className="ml-1">先收货后补单待确认</Badge>
              </p>
            </div>
          </aside>
        </div>
      </div>
      <DocSheet id={openId} onClose={() => open(null)} />
    </>
  );
}
