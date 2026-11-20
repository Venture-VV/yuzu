// 供应商季度评分与观察名单（8.0.7 供应链收尾 2.2）：「采购 → 供应商评分」。按季度现算：准时率、合格率、价格指数，
// 分数 = 准时 × 40 + 合格 × 40 + 价格 × 20（V4，待确认），低于观察线（V5，「门店基本规则 → 可调的数值」里改）的进观察名单。只读，能导出。

import { PurchasingTabs } from './PurchasingTabs';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router';
import { ArrowLeft, Download } from 'lucide-react';
import { recentQuarters, SCORE_WEIGHTS, SUPPLIER_ADMISSION_LABELS, type SupplierScoreReport } from '@shared/supply';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { DataTable } from '../../components/DataTable';
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
            <Link to="/purchasing" className="tap relative -ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回采购">
              <ArrowLeft className="size-[18px]" />
            </Link>
            供应商评分
          </span>
        }
        subtitle={`按季度：准时率 × ${SCORE_WEIGHTS.onTime} + 合格率 × ${SCORE_WEIGHTS.quality} + 价格分 × ${SCORE_WEIGHTS.price}（待确认）；低于观察线的进观察名单，下采购单时提示`}
      />
      <PurchasingTabs active="scores" />
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
          className="tap relative ml-auto flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-ink-3"
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
            <DataTable
              onPage
              tableClassName="min-w-[860px]"
              rows={rows}
              rowKey={(r) => r.supplierId}
              rowClassName={(r) => (r.watch ? 'bg-clay/5' : undefined)}
              rowTestId={(r) => `score-${r.code}`}
              empty="没有供应商"
              columns={[
                {
                  key: 'supplier',
                  header: '供应商',
                  cell: (r) => (
                    <>
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
                    </>
                  ),
                },
                { key: 'receipts', header: '收货单', numeric: true, cell: (r) => r.receipts },
                { key: 'onTime', header: '准时率', numeric: true, cell: (r) => pct(r.onTimeBp) },
                { key: 'delivered', header: '送货金额', numeric: true, cell: (r) => <Money cents={r.deliveredCents} /> },
                {
                  key: 'rejected',
                  header: '拒收 / 退货',
                  numeric: true,
                  cellClassName: 'text-ink-2',
                  cell: (r) => (
                    <>
                      <Money cents={r.rejectedCents} /> / <Money cents={r.returnedCents} />
                    </>
                  ),
                },
                { key: 'quality', header: '合格率', numeric: true, cell: (r) => pct(r.qualityBp) },
                {
                  key: 'priceIndex',
                  header: '价格指数',
                  numeric: true,
                  cellClassName: (r) => (r.priceIndexBp !== null && r.priceIndexBp > 10_000 ? 'text-clay' : r.priceIndexBp !== null && r.priceIndexBp < 10_000 ? 'text-pine' : undefined),
                  cell: (r) => (r.priceIndexBp === null ? '—' : (r.priceIndexBp / 10_000).toFixed(3)),
                },
                {
                  key: 'score',
                  header: '分数',
                  numeric: true,
                  cellClassName: (r) => cn('font-bold', r.watch && 'text-clay'),
                  cell: (r) => (r.scoreX10 === null ? <span className="font-normal text-ink-3">样本不足</span> : (r.scoreX10 / 10).toFixed(1)),
                },
              ]}
            />
            <p className="text-[12px] text-ink-3">
              准时：收货日不晚于采购单的预计到货日（没填的按下单日 + 采购规则的「到货超期天数」），急采、补单不算；合格：1 −（拒收 + 退货）÷ 送货；价格指数：这家的进价 ÷
              同一物料这个季度所有供应商的加权均价（只有一家供货的物料不计）。
            </p>
          </div>
        )}
      </div>
    </>
  );
}
