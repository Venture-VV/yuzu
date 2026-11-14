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
import { EmptyState } from '../../components/EmptyState';
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
              <div className="num mt-1 text-[24px] font-bold">
                {formatYuan(r.margin.rows.filter((x) => x.marginCents !== null).reduce((a, x) => a + (x.marginCents ?? 0), 0))}
              </div>
              <div className="text-[12.5px] text-ink-3">销售额（减去优惠后）− 配方 × 现在的平均成本，不是当时真实耗用</div>
            </Card>
          </div>

          <Card className="p-4">
            <div className="mb-2 text-[14.5px] font-bold">耗用成本</div>
            {r.usage.rows.length === 0 ? (
              <p className="text-[13px] text-ink-3">这段时间没有耗用。</p>
            ) : (
              <table className="w-full text-[13.5px]" data-testid="cost-usage">
                <thead>
                  <tr className="text-left text-[12px] text-ink-3">
                    <th className="py-1.5 font-semibold">仓</th>
                    <th className="font-semibold">类别</th>
                    <th className="text-right font-semibold">金额</th>
                    <th className="text-right font-semibold">流水</th>
                  </tr>
                </thead>
                <tbody>
                  {r.usage.rows.map((x) => (
                    <tr key={`${x.warehouseName}-${x.label}`} className="border-t border-line/70">
                      <td className="py-1.5">{x.warehouseName}</td>
                      <td>{x.label}</td>
                      <td className="num text-right font-semibold">{formatYuan(x.costCents)}</td>
                      <td className="num text-right text-ink-3">
                        {x.moves} 条{x.uncosted > 0 && `（${x.uncosted} 条没记成本）`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[14.5px] font-bold">项目毛利</span>
              <span className="text-[12.5px] text-ink-3">这段时间已结账的；销售额已减去分摊到这一项的券、会员折扣、优惠；没设用料的只有销售额</span>
            </div>
            {r.margin.rows.length === 0 ? (
              <p className="text-[13px] text-ink-3">这段时间没有结账的项目。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-[13.5px]" data-testid="cost-margin">
                  <thead>
                    <tr className="text-left text-[12px] text-ink-3">
                      <th className="py-1.5 font-semibold">项目</th>
                      <th className="text-right font-semibold">数量</th>
                      <th className="text-right font-semibold">销售额</th>
                      <th className="text-right font-semibold">单份成本</th>
                      <th className="text-right font-semibold">理论成本</th>
                      <th className="text-right font-semibold">毛利</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.margin.rows.map((x) => (
                      <tr key={x.itemId} className="border-t border-line/70">
                        <td className="py-1.5">
                          {x.itemName} <span className="text-[12px] text-ink-3">{x.category}</span>
                        </td>
                        <td className="num text-right">{x.quantity}</td>
                        <td className="num text-right">{formatYuan(x.revenueCents)}</td>
                        <td className="num text-right text-ink-3">{x.unitCostCents === null ? '没设用料' : formatYuan(x.unitCostCents)}</td>
                        <td className="num text-right">{x.costCents === null ? '—' : formatYuan(x.costCents)}</td>
                        <td className={cn('num text-right font-semibold', x.marginCents !== null && x.marginCents < 0 && 'text-clay')}>
                          {x.marginCents === null ? '—' : `${formatYuan(x.marginCents)}${x.revenueCents > 0 ? `（${Math.round((x.marginCents / x.revenueCents) * 100)}%）` : ''}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-2 text-[14.5px] font-bold">库存金额</div>
            {r.stock.rows.length === 0 ? (
              <EmptyState art="leaf" title="现在没有结存" className="py-8" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-[13.5px]" data-testid="cost-stock">
                  <thead>
                    <tr className="text-left text-[12px] text-ink-3">
                      <th className="py-1.5 font-semibold">物料</th>
                      <th className="text-right font-semibold">结存</th>
                      <th className="text-right font-semibold">平均成本</th>
                      <th className="text-right font-semibold">金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.stock.rows.map((x) => (
                      <tr key={x.materialId} className="border-t border-line/70">
                        <td className="py-1.5">
                          {x.name} <span className="num text-[12px] text-ink-3">{x.code}</span>
                        </td>
                        <td className="num text-right">
                          {formatQty(x.stockMilli)} {x.inventoryUnit}
                        </td>
                        <td className="num text-right">
                          {unitCost(x.avgCostE4)}
                          {x.estimated && (
                            <Badge className="ml-1.5" tone="ember">
                              估
                            </Badge>
                          )}
                        </td>
                        <td className="num text-right font-semibold">{formatYuan(x.valueCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-[12.5px] text-ink-3">标「估」的：这个版本上线时按最近一次进价（没有进价按参考价）起算，第一次按进价入库后变成真的平均成本。</p>
          </Card>
        </>
      )}
    </div>
  );
}
