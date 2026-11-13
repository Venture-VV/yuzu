// 供应商季度评分与观察名单（8.0.7 供应链收尾 2.2）：「采购 → 供应商评分」。按季度现算：准时率、合格率、价格指数，
// 分数 = 准时 × 40 + 合格 × 40 + 价格 × 20（V4，待确认），低于观察线（V5，「门店基本规则 → 可调的数值」里改）的进观察名单。只读，能导出。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router';
import { ArrowLeft, Download } from 'lucide-react';
import { recentQuarters, SCORE_WEIGHTS, SUPPLIER_ADMISSION_LABELS, type SupplierScoreReport } from '@shared/supply';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Badge, Notice, Select, Skeleton } from '../../components/ui';

const pct = (bp: number | null) => (bp === null ? '—' : `${(bp / 100).toFixed(1)}%`);

export function ScoresPage() {
  const can = useCan();
  const session = useSession();
  const quarters = recentQuarters(session.calendarToday, 8);
  const [quarter, setQuarter] = useState(quarters[0]!);
  const data = useQuery({ queryKey: ['inv', 'supplier-scores', quarter], queryFn: () => api.get<SupplierScoreReport>(`/api/purchase-compare/scores?quarter=${quarter}`) });
  if (!can('inventory.read') && !can('purchase.manage')) return <Navigate to="/purchasing" replace />;
  const rows = data.data?.rows ?? [];
  const watch = rows.filter((r) => r.watch);
  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/purchasing" className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回采购">
              <ArrowLeft className="size-[18px]" />
            </Link>
            供应商评分
          </span>
        }
        subtitle={`按季度：准时率 × ${SCORE_WEIGHTS.onTime} + 合格率 × ${SCORE_WEIGHTS.quality} + 价格分 × ${SCORE_WEIGHTS.price}（待确认）；低于观察线的进观察名单，下采购单时提示`}
      />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-3 md:px-7">
        <Select fullWidth={false} value={quarter} onChange={(e) => setQuarter(e.target.value)} className="h-9 min-w-[120px] text-[13px]" aria-label="季度" data-testid="scores-quarter">
          {quarters.map((q) => (
            <option key={q} value={q}>
              {q.replace('Q', ' 年第 ')} 季度
            </option>
          ))}
        </Select>
        {data.data && (
          <span className="text-[12.5px] text-ink-3">
            {data.data.from} 到 {data.data.to} · 观察线 {data.data.watchBelow} 分
          </span>
        )}
        <a
          href={`/api/purchase-compare/scores/export?quarter=${quarter}`}
          className="ml-auto flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-ink-3"
        >
          <Download className="size-4" />
          导出
        </a>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-7" data-testid="scores-page">
        {data.error ? (
          <Notice tone="error" title={errorMessage(data.error)} />
        ) : data.isPending ? (
          <Skeleton className="h-64" />
        ) : rows.length === 0 ? (
          <EmptyState art="leaf" title="没有供应商" />
        ) : (
          <div className="space-y-3">
            {watch.length > 0 && (
              <Notice tone="warning" title={`观察名单 ${watch.length} 家`} data-testid="scores-watch">
                {watch.map((w) => w.name).join('、')}：分数低于 {data.data!.watchBelow} 分，下采购单时会提示（不拦）。
              </Notice>
            )}
            <div className="overflow-x-auto rounded-lg border border-line bg-card">
              <table className="w-full min-w-[860px] text-[13px]">
                <thead className="bg-paper-2 text-left text-[12px] text-ink-3">
                  <tr>
                    <th className="px-3 py-2 font-semibold">供应商</th>
                    <th className="px-3 py-2 text-right font-semibold">收货单</th>
                    <th className="px-3 py-2 text-right font-semibold">准时率</th>
                    <th className="px-3 py-2 text-right font-semibold">送货金额</th>
                    <th className="px-3 py-2 text-right font-semibold">拒收 / 退货</th>
                    <th className="px-3 py-2 text-right font-semibold">合格率</th>
                    <th className="px-3 py-2 text-right font-semibold">价格指数</th>
                    <th className="px-3 py-2 text-right font-semibold">分数</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.supplierId} className={cn('border-t border-line', r.watch && 'bg-clay/5')} data-testid={`score-${r.code}`}>
                      <td className="px-3 py-1.5">
                        <span className="num mr-1.5 text-[12px] text-ink-3">{r.code}</span>
                        <span className="font-semibold">{r.name}</span>
                        {r.admission !== 'approved' && (
                          <Badge tone={r.admission === 'suspended' ? 'clay' : 'yuzu'} className="ml-1.5">
                            {SUPPLIER_ADMISSION_LABELS[r.admission]}
                          </Badge>
                        )}
                        {r.watch && (
                          <Badge tone="clay" className="ml-1.5">
                            观察
                          </Badge>
                        )}
                      </td>
                      <td className="num px-3 py-1.5 text-right">{r.receipts}</td>
                      <td className="num px-3 py-1.5 text-right">{pct(r.onTimeBp)}</td>
                      <td className="px-3 py-1.5 text-right">
                        <Money cents={r.deliveredCents} />
                      </td>
                      <td className="px-3 py-1.5 text-right text-ink-2">
                        <Money cents={r.rejectedCents} /> / <Money cents={r.returnedCents} />
                      </td>
                      <td className="num px-3 py-1.5 text-right">{pct(r.qualityBp)}</td>
                      <td className={cn('num px-3 py-1.5 text-right', r.priceIndexBp !== null && r.priceIndexBp > 10_000 ? 'text-clay' : r.priceIndexBp !== null && r.priceIndexBp < 10_000 ? 'text-pine' : '')}>
                        {r.priceIndexBp === null ? '—' : (r.priceIndexBp / 10_000).toFixed(3)}
                      </td>
                      <td className={cn('num px-3 py-1.5 text-right font-bold', r.watch && 'text-clay')}>{r.scoreX10 === null ? <span className="font-normal text-ink-3">样本不足</span> : (r.scoreX10 / 10).toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[12px] text-ink-3">
              准时：收货日不晚于采购单的预计到货日（没填的按下单日 + 采购规则的「到货超期天数」），急采、补单不算；合格：1 −（拒收 + 退货）÷ 送货；价格指数：这家的进价 ÷ 同一物料这个季度所有供应商的加权均价（只有一家供货的物料不计）。
            </p>
          </div>
        )}
      </div>
    </>
  );
}
