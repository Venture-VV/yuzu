import { useState } from 'react';
import { Link } from 'react-router';
import { CircleCheck, CircleX, Download, ShieldCheck } from 'lucide-react';
import { CENTRAL_WAREHOUSE_ID, type StockSummaryRow, type WarehouseSel } from '@shared/inventory';
import { shiftDate } from '@shared/labels';
import { formatQty } from '@shared/quantity';
import { errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { cn, downloadUrl } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Button, Input, Notice, Segmented, Skeleton } from '../../components/ui';
import { useChecks, useStockSummary, useWarehouses } from './queries';

type Preset = 'today' | '7d' | 'month' | 'custom';

type Column = { key: keyof StockSummaryRow; label: string; sign?: '+' | '−' | '±' };

/** 按仓的列（v0.7.11）：部门小仓的领料是进、退回是出；全部合计里迁移后的领料、退回一出一进抵消 */
function columnsFor(warehouse: WarehouseSel): Column[] {
  const dept = warehouse !== 'all' && warehouse !== CENTRAL_WAREHOUSE_ID;
  return COLUMNS.map((c) =>
    c.key === 'issued'
      ? dept
        ? { key: c.key, label: '从总仓领料', sign: '+' }
        : { key: c.key, label: warehouse === 'all' ? '部门领用（迁移前）' : '部门领料', sign: '−' }
      : c.key === 'issueReturned'
        ? dept
          ? { key: c.key, label: '退回总仓', sign: '−' }
          : { key: c.key, label: warehouse === 'all' ? '领用退回（迁移前）' : '领料退回', sign: '+' }
        : c,
  );
}

const COLUMNS: Column[] = [
  { key: 'begin', label: '期初结存' },
  { key: 'opening', label: '期初建账', sign: '+' },
  { key: 'received', label: '收货入库', sign: '+' },
  { key: 'issued', label: '部门领料', sign: '−' },
  { key: 'issueReturned', label: '领料退回', sign: '+' },
  { key: 'directUsed', label: '直接耗用', sign: '−' },
  { key: 'damaged', label: '报损', sign: '−' },
  { key: 'countAdjusted', label: '盘点调整', sign: '±' },
  { key: 'supplierReturned', label: '退供应商', sign: '−' },
  { key: 'voided', label: '冲销', sign: '±' },
  { key: 'closing', label: '期末结存' },
];

export function SummaryTab() {
  const session = useSession();
  const today = session.calendarToday;
  const [preset, setPreset] = useState<Preset>('month');
  const [custom, setCustom] = useState({ from: shiftDate(today, -6), to: today });
  const range =
    preset === 'today'
      ? { from: today, to: today }
      : preset === '7d'
        ? { from: shiftDate(today, -6), to: today }
        : preset === 'month'
          ? { from: `${today.slice(0, 8)}01`, to: today }
          : custom;
  const warehouses = useWarehouses();
  const [warehouse, setWarehouse] = useState<WarehouseSel>(CENTRAL_WAREHOUSE_ID);
  const columns = columnsFor(warehouse);
  const summary = useStockSummary(range.from, range.to, warehouse);
  const [showChecks, setShowChecks] = useState(false);
  const checks = useChecks(showChecks);
  const rows = (summary.data ?? []).filter((r) => r.active || r.begin !== 0 || r.closing !== 0);

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-5 py-3 md:px-7">
        <Segmented<Preset>
          size="sm"
          value={preset}
          onChange={setPreset}
          ariaLabel="期间"
          options={[
            { value: 'today', label: '今天' },
            { value: '7d', label: '近 7 天' },
            { value: 'month', label: '本月' },
            { value: 'custom', label: '自定义' },
          ]}
        />
        {preset === 'custom' && (
          <span className="flex items-center gap-1.5 text-[13px] text-ink-3">
            <Input fullWidth={false} type="date" value={custom.from} max={today} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="h-9 w-[150px] text-[13px]" aria-label="开始日期" />
            至
            <Input fullWidth={false} type="date" value={custom.to} max={today} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="h-9 w-[150px] text-[13px]" aria-label="结束日期" />
          </span>
        )}
        {(warehouses.data?.length ?? 0) > 1 && (
          <select
            value={String(warehouse)}
            onChange={(e) => setWarehouse(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            aria-label="仓库"
            data-testid="summary-warehouse"
            className="h-9 rounded-md border border-line-strong bg-card px-2.5 text-[13px] font-semibold outline-none focus:border-pine"
          >
            {warehouses.data!.map((w) => (
              <option key={w.id} value={w.id}>
                {w.kind === 'central' ? `总仓 · ${w.name}` : w.name}
              </option>
            ))}
            <option value="all">全部合计（总仓 + 部门小仓）</option>
          </select>
        )}
        <span className="num text-[12.5px] text-ink-3">
          {range.from} 至 {range.to} · 按单据日期（自然日）统计
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" icon={<ShieldCheck className="size-4" />} onClick={() => setShowChecks((v) => !v)}>
          数据自检
        </Button>
        <Button size="sm" variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadUrl(`/api/inventory/summary/export?from=${range.from}&to=${range.to}&warehouse=${warehouse}`)}>
          导出 CSV
        </Button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-auto px-5 py-4 md:px-7">
        {showChecks && (
          <div className="mb-4 rounded-lg border border-line bg-card px-4 py-3 shadow-card">
            <p className="mb-2 text-[13px] font-bold">账实自检：结存、库存流水与单据是否一致</p>
            {checks.isPending ? (
              <Skeleton className="h-16" />
            ) : checks.error ? (
              <Notice tone="error" title={errorMessage(checks.error)} />
            ) : (
              <ul className="grid gap-1.5 md:grid-cols-2">
                {checks.data.map((c) => (
                  <li key={c.key} className="flex items-start gap-2 text-[12.5px]">
                    {c.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-pine" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-clay" />}
                    <span>
                      <span className="font-semibold">{c.label}</span>
                      <span className={cn('block', c.ok ? 'text-ink-3' : 'text-clay')}>{c.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <p className="mb-2 text-[12.5px] text-ink-3">
          每行按物料自己的库存单位统计，不跨单位求和。期初结存 + 本期各项（出库类为减）= 期末结存。
          {warehouse === CENTRAL_WAREHOUSE_ID
            ? '领料是从总仓领进部门小仓，部门用掉的在部门小仓的耗用、盘点里。'
            : warehouse === 'all'
              ? '全部合计里领料、退回是总仓与部门小仓之间的调拨，一出一进抵消；迁移前的领用没进部门小仓，仍算出库。'
              : '部门小仓的领料是从总仓领进、退回是退回总仓；盘点差异默认「耗用」。'}
        </p>

        {summary.error ? (
          <Notice tone="error" title={errorMessage(summary.error)} />
        ) : summary.isPending ? (
          <Skeleton className="h-64" />
        ) : rows.length === 0 ? (
          <EmptyState art="calm" title="还没有受管物料" className="rounded-lg border border-dashed border-line-strong" />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-card shadow-card">
            <table className="w-full min-w-[1080px] text-left text-[13px]">
              <thead className="sticky top-0 bg-paper-2 text-[12px] font-bold text-ink-3">
                <tr>
                  <th className="w-[220px] px-4 py-2.5">物料</th>
                  {columns.map((c) => (
                    <th key={c.key} className={cn('px-2 py-2.5 text-right whitespace-nowrap', (c.key === 'begin' || c.key === 'closing') && 'bg-paper-3/50 text-ink-2')}>
                      {c.sign && <span className="mr-0.5 text-ink-4">{c.sign}</span>}
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {rows.map((r) => (
                  <tr key={r.materialId} className="hover:bg-pine-tint/40">
                    <td className="px-4 py-2.5">
                      <Link to={`/inventory?m=${r.materialId}`} className="block min-w-0 hover:text-pine">
                        <span className="block truncate font-bold">{r.name}</span>
                        <span className="num block truncate text-[11.5px] text-ink-3">
                          {r.code} · {r.inventoryUnit}
                          {r.specification && ` · ${r.specification}`}
                        </span>
                      </Link>
                    </td>
                    {columns.map((c) => {
                      const v = r[c.key] as number;
                      const edge = c.key === 'begin' || c.key === 'closing';
                      return (
                        <td
                          key={c.key}
                          className={cn(
                            'num px-2 py-2.5 text-right',
                            edge && 'bg-paper-2/50 font-bold',
                            !edge && v === 0 && 'text-ink-4',
                            c.key === 'countAdjusted' && v < 0 && 'font-semibold text-clay',
                            c.key === 'countAdjusted' && v > 0 && 'font-semibold text-lake',
                          )}
                        >
                          {v === 0 && !edge ? '·' : `${c.sign === '±' && v > 0 ? '+' : ''}${formatQty(v)}`}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
