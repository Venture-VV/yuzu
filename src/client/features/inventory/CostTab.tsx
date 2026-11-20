// 成本（8.0.20，docs/ERP_V8020.md 第 1 节）：「库存 → 成本」，有「看成本」权限的看得到。
// 库存金额（现在的结存 × 平均成本）、日期段内的耗用成本、项目毛利（按配方与现在的平均成本算的理论值）。只读。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { formatYuan } from '@shared/money';
import { formatQty } from '@shared/quantity';
import type { CostReport } from '@shared/stock-usage';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, Input, Notice, Skeleton } from '../../components/ui';

const unitCost = (e4: number) => `¥${(e4 / 1_000_000).toFixed(e4 % 10_000 === 0 ? 2 : 4)}`;

export function CostTab() {
  const session = useSession();
  const [from, setFrom] = useState(`${session.calendarToday.slice(0, 8)}01`);
  const [to, setTo] = useState(session.calendarToday);
  const report = useQuery({ queryKey: ['inv', 'cost', from, to], queryFn: () => api.get<CostReport>(`/api/inventory/cost?from=${from}&to=${to}`), enabled: !!from && !!to });
  const r = report.data;
  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 md:px-7" data-testid="cost-tab">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
          耗用与毛利的日期
          <Input type="date" fullWidth={false} value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-9 w-36" aria-label="从" />
          到
          <Input type="date" fullWidth={false} value={to} min={from} max={session.calendarToday} onChange={(e) => setTo(e.target.value)} className="h-9 w-36" aria-label="到" />
        </label>
        <span className="text-[12.5px] text-ink-3">成本按移动加权平均、含税到货价</span>
        <a className="ml-auto" href={`/api/inventory/cost/export?from=${from}&to=${to}`} download data-testid="cost-export">
          <Button size="sm" variant="secondary" icon={<Download className="size-4" />}>
            导出 CSV
          </Button>
        </a>
      </div>
      {report.error ? (
        <Notice tone="error" title={errorMessage(report.error)} />
      ) : !r ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <Card className="p-4" data-testid="cost-total-stock">
              <div className="text-[12.5px] font-semibold text-ink-3">库存金额（现在）</div>
              <div className="num mt-1 text-[24px] font-bold">{formatYuan(r.stock.totalCents)}</div>
              <div className="text-[12.5px] text-ink-3">
                {r.stock.rows.length} 样物料有结存{r.stock.estimatedCount > 0 && ` · ${r.stock.estimatedCount} 样的成本是估的`}
              </div>
            </Card>
            <Card className="p-4" data-testid="cost-total-usage">
              <div className="text-[12.5px] font-semibold text-ink-3">耗用成本（这段时间）</div>
              <div className="num mt-1 text-[24px] font-bold">{formatYuan(r.usage.totalCents)}</div>
              <div className="text-[12.5px] text-ink-3">耗用、报损、销售出库、配方耗用</div>
            </Card>
            <Card className="p-4" data-testid="cost-total-margin">
              <div className="text-[12.5px] font-semibold text-ink-3">设了用料的项目 · 理论毛利</div>
              <div className="num mt-1 text-[24px] font-bold">{formatYuan(r.margin.rows.filter((x) => x.marginCents !== null).reduce((a, x) => a + (x.marginCents ?? 0), 0))}</div>
              <div className="text-[12.5px] text-ink-3">销售额（减去优惠后）− 配方 × 现在的平均成本，不是当时真实耗用</div>
            </Card>
          </div>

          <Card className="p-4">
            <div className="mb-2 text-[14.5px] font-bold">耗用成本</div>
            <DataTable
              variant="plain"
              testId="cost-usage"
              rows={r.usage.rows}
              rowKey={(x) => `${x.warehouseName}-${x.label}`}
              empty="这段时间没有耗用"
              columns={[
                { key: 'warehouse', header: '仓', cell: (x) => x.warehouseName },
                { key: 'label', header: '类别', cell: (x) => x.label },
                { key: 'cost', header: '金额', numeric: true, cellClassName: 'font-semibold', cell: (x) => formatYuan(x.costCents) },
                {
                  key: 'moves',
                  header: '流水',
                  numeric: true,
                  cellClassName: 'text-ink-3',
                  cell: (x) => (
                    <>
                      {x.moves} 条{x.uncosted > 0 && `（${x.uncosted} 条没记成本）`}
                    </>
                  ),
                },
              ]}
            />
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[14.5px] font-bold">项目毛利</span>
              <span className="text-[12.5px] text-ink-3">这段时间已结账的；销售额已减去分摊到这一项的券、会员折扣、优惠；没设用料的只有销售额</span>
            </div>
            <DataTable
              variant="plain"
              testId="cost-margin"
              tableClassName="min-w-[560px]"
              rows={r.margin.rows}
              rowKey={(x) => x.itemId}
              empty="这段时间没有结账的项目"
              columns={[
                {
                  key: 'item',
                  header: '项目',
                  cell: (x) => (
                    <>
                      {x.itemName} <span className="text-[12px] text-ink-3">{x.category}</span>
                    </>
                  ),
                },
                { key: 'quantity', header: '数量', numeric: true, cell: (x) => x.quantity },
                { key: 'revenue', header: '销售额', numeric: true, cell: (x) => formatYuan(x.revenueCents) },
                { key: 'unitCost', header: '单份成本', numeric: true, cellClassName: 'text-ink-3', cell: (x) => (x.unitCostCents === null ? '没设用料' : formatYuan(x.unitCostCents)) },
                { key: 'cost', header: '理论成本', numeric: true, cell: (x) => (x.costCents === null ? '—' : formatYuan(x.costCents)) },
                {
                  key: 'margin',
                  header: '毛利',
                  numeric: true,
                  cellClassName: (x) => cn('font-semibold', x.marginCents !== null && x.marginCents < 0 && 'text-clay'),
                  cell: (x) => (x.marginCents === null ? '—' : `${formatYuan(x.marginCents)}${x.revenueCents > 0 ? `（${Math.round((x.marginCents / x.revenueCents) * 100)}%）` : ''}`),
                },
              ]}
            />
          </Card>

          <Card className="p-4">
            <div className="mb-2 text-[14.5px] font-bold">库存金额</div>
            <DataTable
              variant="plain"
              testId="cost-stock"
              tableClassName="min-w-[520px]"
              rows={r.stock.rows}
              rowKey={(x) => x.materialId}
              empty="现在没有结存"
              columns={[
                {
                  key: 'material',
                  header: '物料',
                  cell: (x) => (
                    <>
                      {x.name} <span className="num text-[12px] text-ink-3">{x.code}</span>
                    </>
                  ),
                },
                {
                  key: 'stock',
                  header: '结存',
                  numeric: true,
                  cell: (x) => (
                    <>
                      {formatQty(x.stockMilli)} {x.inventoryUnit}
                    </>
                  ),
                },
                {
                  key: 'avgCost',
                  header: '平均成本',
                  numeric: true,
                  cell: (x) => (
                    <>
                      {unitCost(x.avgCostE4)}
                      {x.estimated && (
                        <Badge className="ml-1.5" tone="ember">
                          估
                        </Badge>
                      )}
                    </>
                  ),
                },
                { key: 'value', header: '金额', numeric: true, cellClassName: 'font-semibold', cell: (x) => formatYuan(x.valueCents) },
              ]}
            />
            <p className="mt-2 text-[12.5px] text-ink-3">标「估」的：这个版本上线时按最近一次进价（没有进价按参考价）起算，第一次按进价入库后变成真的平均成本。</p>
          </Card>
        </>
      )}
    </div>
  );
}
