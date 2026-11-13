// 供应商比价看板（8.0.1 采购组整改 07，CG07，docs/PURCHASING_V801.md）：「采购 → 供应商比价」。
// 按品类或物料、时间段（默认近 90 天），每个物料 × 供应商一行：价格（次数、数量、最近 / 平均 / 最低 / 最高单价、比上一个时段涨跌）、
// 品质（退货率、合同验收登记的质量问题数）、耗用（这段时间的领用与直接耗用）。只读。

import { PurchasingTabs } from './PurchasingTabs';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { COMPARE_DEFAULT_DAYS, type SupplierCompare, type SupplierCompareRow } from '@shared/purchasing';
import { shiftDate } from '@shared/labels';
import { formatQty } from '@shared/quantity';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Card, Input, Notice, Select, Skeleton } from '../../components/ui';

function Change({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-ink-4">—</span>;
  return <span className={cn('num font-semibold', pct > 0 ? 'text-clay' : pct < 0 ? 'text-pine' : 'text-ink-3')}>{pct > 0 ? `+${pct}%` : `${pct}%`}</span>;
}

export function ComparePage() {
  const can = useCan();
  const session = useSession();
  const [to, setTo] = useState(session.calendarToday);
  const [from, setFrom] = useState(shiftDate(session.calendarToday, -(COMPARE_DEFAULT_DAYS - 1)));
  const [category, setCategory] = useState('');
  const qs = new URLSearchParams(Object.entries({ from, to, category }).filter(([, v]) => v) as [string, string][]).toString();
  const data = useQuery({ queryKey: ['inv', 'purchase-compare', qs], queryFn: () => api.get<SupplierCompare>(`/api/purchase-compare?${qs}`), enabled: !!from && !!to });
  if (!can('inventory.read') && !can('purchase.manage')) return <Navigate to="/purchasing" replace />;

  // 按物料分组：同一物料的几家供应商放在一起（平均单价低的在前）
  const groups = new Map<number, SupplierCompareRow[]>();
  for (const r of data.data?.rows ?? []) groups.set(r.materialId, [...(groups.get(r.materialId) ?? []), r]);
  const quality = new Map((data.data?.quality ?? []).map((q) => [q.supplierId, q.issues]));
  const usage = new Map((data.data?.consumption ?? []).map((c) => [c.materialId, c]));

  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/purchasing" className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回采购">
              <ArrowLeft className="size-[18px]" />
            </Link>
            供应商比价
          </span>
        }
        subtitle="同一物料不同供应商的价格波动、品质（退货、质量问题）与耗用；单价按物料现在的采购单位折算"
      />
      <PurchasingTabs active="compare" />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-3 md:px-7">
        <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
          收货日期
          <Input type="date" fullWidth={false} value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-9 w-36" aria-label="从" />
          到
          <Input type="date" fullWidth={false} value={to} min={from} max={session.calendarToday} onChange={(e) => setTo(e.target.value)} className="h-9 w-36" aria-label="到" />
        </label>
        <Select fullWidth={false} value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 min-w-[140px] text-[13px]" aria-label="品类" data-testid="compare-category">
          <option value="">全部品类</option>
          {data.data?.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        {data.data && (
          <span className="text-[12.5px] text-ink-3">
            涨跌比的是上一个同样长的时段（{data.data.prevFrom} 到 {data.data.prevTo}）
          </span>
        )}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-7" data-testid="compare-page">
        {data.error ? (
          <Notice tone="error" title={errorMessage(data.error)} />
        ) : data.isPending ? (
          <Skeleton className="h-64" />
        ) : groups.size === 0 ? (
          <EmptyState art="leaf" title="这段时间没有收货" description="换一个时间段或品类看看。" className="rounded-lg border border-dashed border-line-strong" />
        ) : (
          <div className="space-y-3">
            {[...groups.values()].map((rows) => {
              const m = rows[0]!;
              const u = usage.get(m.materialId);
              return (
                <Card key={m.materialId} className="overflow-hidden" data-testid={`compare-material-${m.materialId}`}>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
                    <span className="num text-[12px] font-semibold text-ink-3">{m.materialCode}</span>
                    <span className="text-[14px] font-bold">{m.materialName}</span>
                    {m.category && <span className="text-[12px] text-ink-3">{m.category}</span>}
                    <span className="ml-auto text-[12.5px] text-ink-2">
                      耗用：领用 {formatQty(u?.issuedMilli ?? 0)} · 直接耗用 {formatQty(u?.directUsedMilli ?? 0)} {m.inventoryUnit}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[880px] text-[13px]">
                      <thead>
                        <tr className="text-left text-[12px] font-semibold text-ink-3">
                          <th className="px-4 py-2">供应商</th>
                          <th className="px-2 text-right">次数</th>
                          <th className="px-2 text-right">收货（{m.inventoryUnit}）</th>
                          <th className="px-2 text-right">最近单价</th>
                          <th className="px-2 text-right">平均（元/{m.purchaseUnit}）</th>
                          <th className="px-2 text-right">最低 ~ 最高</th>
                          <th className="px-2 text-right">比上一时段</th>
                          <th className="px-2 text-right">退货率</th>
                          <th className="px-4 text-right">质量问题</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={r.supplierId} className={cn('border-t border-line/60', i === 0 && rows.length > 1 && 'bg-pine-tint/30')} data-testid={`compare-row-${r.materialId}-${r.supplierId}`}>
                            <td className="px-4 py-2 font-semibold">{r.supplierName}</td>
                            <td className="num px-2 text-right">{r.receipts}</td>
                            <td className="num px-2 text-right">{formatQty(r.receivedMilli)}</td>
                            <td className="px-2 text-right">
                              {r.lastPriceCents !== null ? <Money cents={r.lastPriceCents} /> : '—'}
                              {r.lastDate && <span className="block text-[11.5px] text-ink-3">{r.lastDate}</span>}
                            </td>
                            <td className="px-2 text-right font-bold">{r.avgPriceCents !== null ? <Money cents={r.avgPriceCents} /> : '—'}</td>
                            <td className="px-2 text-right text-ink-2">
                              {r.minPriceCents !== null && r.maxPriceCents !== null ? (
                                <>
                                  <Money cents={r.minPriceCents} /> ~ <Money cents={r.maxPriceCents} />
                                </>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-2 text-right">
                              <Change pct={r.changePercent} />
                            </td>
                            <td className="num px-2 text-right">{r.returnRatePct === null ? '—' : `${r.returnRatePct}%`}</td>
                            <td className="num px-4 text-right">{quality.get(r.supplierId) ?? 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
