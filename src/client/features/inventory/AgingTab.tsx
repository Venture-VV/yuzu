// 库存「呆滞与临期」（8.0.7）：
//   · 呆滞与周转（2.4）：按仓看每种有结存的物料——结存、结存金额、最近出库日、多少天没出库、近 90 天日均用量、周转天数；
//     超过设置的天数（V7，默认 90）没出库的标呆滞，能导出。处理照旧用退供应商、报损、领料退回（只提醒）。
//   · 临期批次（3.3）：管效期的物料按先进先出推算剩下的批次，到期前 N 天（V18）以内与已过期的列出，能导出。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type { ExpiryLot, SlowMovingReport } from '@shared/supply';
import { formatQty } from '@shared/quantity';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Badge, Notice, Select, Skeleton } from '../../components/ui';
import { useWarehouses } from './queries';

const qty = (milli: number, unit: string) => `${formatQty(milli)} ${unit}`;

export function AgingTab() {
  const session = useSession();
  const warehouses = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [slowOnly, setSlowOnly] = useState(true);
  const qs = new URLSearchParams(Object.entries({ warehouseId, slow: slowOnly ? '1' : '' }).filter(([, v]) => v) as [string, string][]).toString();
  const slow = useQuery({ queryKey: ['inv', 'slow-moving', qs], queryFn: () => api.get<SlowMovingReport>(`/api/inventory/slow-moving?${qs}`) });
  const lots = useQuery({ queryKey: ['inv', 'expiry-lots'], queryFn: () => api.get<ExpiryLot[]>('/api/inventory/expiry-lots') });
  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4 md:px-7" data-testid="aging-tab">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-bold">呆滞与周转</h2>
          {slow.data && <span className="text-[12.5px] text-ink-3">有结存、超过 {slow.data.slowDays} 天没出库的算呆滞（经营规则「可调的数值」里改）；只提醒，处理照旧用退供应商、报损、领料退回</span>}
          <Select fullWidth={false} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="ml-auto h-9 min-w-[140px] text-[13px]" aria-label="仓">
            <option value="">全部仓</option>
            {(warehouses.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
            <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={slowOnly} onChange={(e) => setSlowOnly(e.target.checked)} data-testid="slow-only" />
            只看呆滞的
          </label>
          <a href={`/api/inventory/slow-moving/export?${qs}`} className="flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-ink-3">
            <Download className="size-4" />
            导出
          </a>
        </div>
        {slow.error ? (
          <Notice tone="error" title={errorMessage(slow.error)} />
        ) : slow.isPending ? (
          <Skeleton className="h-40" />
        ) : slow.data.rows.length === 0 ? (
          <EmptyState art="leaf" title={slowOnly ? '没有呆滞的物料' : '没有结存'} className="rounded-lg border border-dashed border-line-strong" />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-card">
            <table className="w-full min-w-[820px] text-[13px]" data-testid="slow-table">
              <thead className="bg-paper-2 text-left text-[12px] text-ink-3">
                <tr>
                  <th className="px-3 py-2 font-semibold">仓</th>
                  <th className="px-3 py-2 font-semibold">物料</th>
                  <th className="px-3 py-2 text-right font-semibold">结存</th>
                  <th className="px-3 py-2 text-right font-semibold">结存金额</th>
                  <th className="px-3 py-2 font-semibold">最近出库</th>
                  <th className="px-3 py-2 text-right font-semibold">没出库</th>
                  <th className="px-3 py-2 text-right font-semibold">日均用量</th>
                  <th className="px-3 py-2 text-right font-semibold">周转天数</th>
                </tr>
              </thead>
              <tbody>
                {slow.data.rows.map((r) => (
                  <tr key={`${r.departmentId ?? 0}-${r.materialId}`} className={cn('border-t border-line', r.slow && 'bg-clay/5')}>
                    <td className="px-3 py-1.5 text-ink-2">{r.warehouseName}</td>
                    <td className="px-3 py-1.5">
                      <span className="num mr-1.5 text-[12px] text-ink-3">{r.code}</span>
                      <span className="font-semibold">{r.name}</span>
                      {r.slow && (
                        <Badge tone="clay" className="ml-1.5">
                          呆滞
                        </Badge>
                      )}
                    </td>
                    <td className="num px-3 py-1.5 text-right">{qty(r.stockMilli, r.inventoryUnit)}</td>
                    <td className="px-3 py-1.5 text-right">{r.amountCents === null ? '—' : <Money cents={r.amountCents} />}</td>
                    <td className="num px-3 py-1.5">{r.lastOutDate ?? <span className="text-ink-3">没出过库</span>}</td>
                    <td className="num px-3 py-1.5 text-right">{r.idleDays === null ? '—' : `${r.idleDays} 天`}</td>
                    <td className="num px-3 py-1.5 text-right">{r.dailyUsageMilli > 0 ? qty(r.dailyUsageMilli, r.inventoryUnit) : '—'}</td>
                    <td className="num px-3 py-1.5 text-right">{r.turnoverDays === null ? '—' : `${r.turnoverDays} 天`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-bold">临期批次</h2>
          <span className="text-[12.5px] text-ink-3">管效期的物料按先进先出推算总仓剩下的批次；到期前 {session.rules.expiryRemindDays} 天以内与已过期的</span>
          <a href="/api/inventory/expiry-lots/export" className="ml-auto flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-ink-3">
            <Download className="size-4" />
            导出
          </a>
        </div>
        {lots.error ? (
          <Notice tone="error" title={errorMessage(lots.error)} />
        ) : lots.isPending ? (
          <Skeleton className="h-24" />
        ) : lots.data.length === 0 ? (
          <p className="text-[13px] text-ink-3">没有临期或过期的批次（物料档案里打开「效期管理」的才算）。</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-card">
            <table className="w-full min-w-[720px] text-[13px]" data-testid="expiry-table">
              <thead className="bg-paper-2 text-left text-[12px] text-ink-3">
                <tr>
                  <th className="px-3 py-2 font-semibold">物料</th>
                  <th className="px-3 py-2 font-semibold">批号</th>
                  <th className="px-3 py-2 font-semibold">收货</th>
                  <th className="px-3 py-2 font-semibold">到期日</th>
                  <th className="px-3 py-2 text-right font-semibold">推算剩余</th>
                </tr>
              </thead>
              <tbody>
                {lots.data.map((l) => (
                  <tr key={`${l.docId}-${l.materialId}-${l.batchNo}-${l.expiresOn}`} className={cn('border-t border-line', l.daysLeft < 0 && 'bg-clay/5')}>
                    <td className="px-3 py-1.5">
                      <span className="num mr-1.5 text-[12px] text-ink-3">{l.code}</span>
                      <span className="font-semibold">{l.name}</span>
                    </td>
                    <td className="num px-3 py-1.5">{l.batchNo || '—'}</td>
                    <td className="num px-3 py-1.5 text-ink-2">
                      {l.receivedDate} · {l.docNo}
                    </td>
                    <td className="num px-3 py-1.5">
                      {l.expiresOn}
                      <Badge tone={l.daysLeft < 0 ? 'clay' : 'yuzu'} className="ml-1.5">
                        {l.daysLeft < 0 ? `过期 ${-l.daysLeft} 天` : l.daysLeft === 0 ? '今天到期' : `${l.daysLeft} 天后到期`}
                      </Badge>
                    </td>
                    <td className="num px-3 py-1.5 text-right">{qty(l.remainingMilli, l.inventoryUnit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
