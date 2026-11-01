// 下单物料（库管视图，v0.7.9，飞书需求 RQ-005）：已确认的采购单每一行的图片、规格、已到与未到、应到日期，
// 没到齐且过了应到日期的标红。导出带图片的 Excel（每行嵌入第一张图片）与 CSV。

import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { ArrowLeft, Download, FileSpreadsheet, PackageSearch } from 'lucide-react';
import { ORDERED_STATE_LABELS, type OrderedLine } from '@shared/purchase-ledger';
import { formatQty } from '@shared/quantity';
import { errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { ImageThumbs } from '../../components/Images';
import { Money } from '../../components/Money';
import { Badge, Button, Input, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { useSuppliers } from '../inventory/queries';
import { minusDays, search, useOrderedLines } from '../purchase-ledger/queries';

type StateFilter = 'all' | 'open' | 'overdue' | 'received';

const STATE_TONE: Record<OrderedLine['state'], 'neutral' | 'yuzu' | 'pine' | 'clay'> = { open: 'neutral', partial: 'yuzu', received: 'pine', closed: 'clay' };

export function OrderedPage() {
  const can = useCan();
  const session = useSession();
  const suppliers = useSuppliers(true);
  const [range, setRange] = useState(() => ({ from: minusDays(session.calendarToday, 30), to: session.calendarToday }));
  const [supplierId, setSupplierId] = useState('');
  const [state, setState] = useState<StateFilter>('open');
  const filters = { from: range.from, to: range.to, supplierId: supplierId || undefined, state };
  const list = useOrderedLines(filters, range.from <= range.to);
  if (!can('inventory.read')) return <Navigate to="/" replace />;
  const lines = list.data?.lines ?? [];

  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/purchasing" className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回采购">
              <ArrowLeft className="size-[18px]" />
            </Link>
            <span className="flex size-8 items-center justify-center rounded-full bg-pine-soft text-pine">
              <PackageSearch className="size-4" />
            </span>
            下单物料
          </span>
        }
        subtitle="已确认的采购单每一行：图片、规格、已到与未到；没到齐且过了应到日期的标红（应到日期：预计到货日，没填的按下单后约定天数）"
        actions={
          <div className="flex flex-wrap gap-2">
            <a href={`/api/purchase-orders/ordered-lines/export.xlsx?${search(filters)}`} download data-testid="ordered-export-xlsx">
              <Button variant="secondary" size="sm" icon={<FileSpreadsheet className="size-4" />}>
                导出 Excel（带图片）
              </Button>
            </a>
            <a href={`/api/purchase-orders/ordered-lines/export.csv?${search(filters)}`} download>
              <Button variant="ghost" size="sm" icon={<Download className="size-4" />}>
                CSV
              </Button>
            </a>
          </div>
        }
      />
      <div className="flex shrink-0 flex-wrap items-end gap-3 border-b border-line px-5 py-3 md:px-7">
        <Segmented
          size="sm"
          ariaLabel="到货状态"
          value={state}
          onChange={setState}
          options={[
            { value: 'open', label: '未到齐' },
            { value: 'overdue', label: '超期' },
            { value: 'received', label: '已到齐' },
            { value: 'all', label: '全部' },
          ]}
        />
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-3">
          下单日期 从
          <Input type="date" fullWidth={false} value={range.from} max={range.to} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="h-9 w-40" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-3">
          到
          <Input type="date" fullWidth={false} value={range.to} max={session.calendarToday} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="h-9 w-40" />
        </label>
        <Select fullWidth={false} aria-label="供应商" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="h-9 w-44">
          <option value="">全部供应商</option>
          {suppliers.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        {list.data && <span className="ml-auto text-[12.5px] text-ink-3">{lines.length} 行{list.data.truncated ? '（只显示前 2000 行）' : ''}</span>}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="ordered-page">
        <div className="mx-auto w-full max-w-[1180px] px-5 py-4 md:px-7">
          {list.isPending ? (
            <Skeleton className="h-64" />
          ) : list.error ? (
            <Notice tone="error" title={errorMessage(list.error)} />
          ) : lines.length === 0 ? (
            <EmptyState art="calm" title="没有符合条件的下单物料" />
          ) : (
            <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card shadow-card">
              {lines.map((l) => (
                <li key={l.lineId} className={cn('grid grid-cols-[56px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-3', l.overdue && 'bg-clay-soft/20')} data-testid={`ordered-line-${l.lineId}`}>
                  <span className="pt-0.5">
                    {l.images.length > 0 ? (
                      <ImageThumbs images={l.images.slice(0, 1)} size={52} />
                    ) : (
                      <span className="flex size-[52px] items-center justify-center rounded-md border border-dashed border-line text-[11px] text-ink-4">无图</span>
                    )}
                  </span>
                  <span className="min-w-0 space-y-0.5">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[14px] font-bold">{l.materialName}</span>
                      <span className="num text-[12px] text-ink-3">{l.materialCode}</span>
                      {l.images.length > 1 && <span className="text-[12px] text-ink-3">共 {l.images.length} 张图</span>}
                    </span>
                    {l.spec && <span className="block text-[12.5px] font-semibold text-ink-2">规格：{l.spec}</span>}
                    <span className="block text-[12px] text-ink-3">
                      <Link to={`/purchasing?po=${l.poId}`} className="num font-semibold text-lake hover:underline">
                        {l.docNo}
                      </Link>{' '}
                      · {l.supplierName} · 下单 {l.orderDate} · 应到 <span className={cn(l.overdue && 'font-bold text-clay')}>{l.dueDate}</span>
                      {l.departments.length > 0 && ` · 需求：${l.departments.join('、')}`}
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-1 text-right">
                    <span className="num text-[13.5px] font-bold">
                      {formatQty(l.purchaseQtyMilli)} {l.purchaseUnit}
                    </span>
                    <span className="num text-[12px] text-ink-3">
                      已到 {formatQty(l.receivedMilli)} / {formatQty(l.baseQtyMilli)} {l.inventoryUnit}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Badge tone={l.overdue ? 'clay' : STATE_TONE[l.state]}>{l.overdue ? `${ORDERED_STATE_LABELS[l.state]} · 超期` : ORDERED_STATE_LABELS[l.state]}</Badge>
                      <Money cents={l.amountCents} className="text-[12.5px] text-ink-2" />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
