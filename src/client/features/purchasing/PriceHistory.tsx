// 价格曲线（v0.7.29 ERP 采购五项⑤，E8）：一个物料近 12 个月的成交价（已生效收货的单价）与询价报价，按日期列出，
// 最低、最高、最近一次一眼看到。采购单编制、询价比价页都能打开。

import { useState } from 'react';
import { LineChart } from 'lucide-react';
import { formatAmount } from '@shared/money';
import { formatQty } from '@shared/quantity';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { Badge, IconButton, Notice, Skeleton } from '../../components/ui';
import { usePriceHistory } from './queries';

export function PriceHistoryButton({ materialId, name }: { materialId: number; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label={`${name} 的价格曲线`} onClick={() => setOpen(true)} data-testid={`price-history-${materialId}`}>
        <LineChart className="size-4" />
      </IconButton>
      <PriceHistoryDialog materialId={open ? materialId : null} onClose={() => setOpen(false)} />
    </>
  );
}

export function PriceHistoryDialog({ materialId, onClose }: { materialId: number | null; onClose: () => void }) {
  const h = usePriceHistory(materialId);
  const points = h.data?.points ?? [];
  const receipts = points.filter((p) => p.source === 'receipt');
  const prices = receipts.map((p) => p.priceCents);
  const min = prices.length ? Math.min(...prices) : null;
  const max = prices.length ? Math.max(...prices) : null;
  const last = receipts.at(-1) ?? null;
  // 简单的柱状图：按价格高低画横条（同一采购单位才可比，单位不同的另起一行显示单位）
  const top = Math.max(1, ...points.map((p) => p.priceCents));
  return (
    <Dialog open={materialId !== null} onClose={onClose} title={`价格曲线 · ${h.data?.materialName ?? ''}`} description="近 12 个月：已生效收货的单价（同价格口径）与询价报价" width="max-w-2xl">
      {h.isPending ? (
        <Skeleton className="h-40" />
      ) : h.error ? (
        <Notice tone="error" title={errorMessage(h.error)} />
      ) : points.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-ink-3">近 12 个月没有成交，也没有报价</p>
      ) : (
        <div className="space-y-3" data-testid="price-history">
          {min !== null && (
            <p className="text-[13px] text-ink-2">
              成交价 最低 <b>¥{formatAmount(min)}</b> · 最高 <b>¥{formatAmount(max!)}</b>
              {last && (
                <>
                  {' '}
                  · 最近 <b>¥{formatAmount(last.priceCents)}</b>（{last.date} {last.supplierName}）
                </>
              )}
            </p>
          )}
          <ul className="max-h-[50vh] space-y-1 overflow-y-auto pr-1">
            {points.map((p, i) => (
              <li key={`${p.docNo}-${p.source}-${i}`} className="grid grid-cols-[86px_minmax(0,1fr)_96px] items-center gap-2 text-[12.5px]">
                <span className="num text-ink-3">{p.date}</span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 truncate">
                    <Badge tone={p.source === 'quote' ? 'lake' : 'neutral'}>{p.source === 'quote' ? '报价' : '成交'}</Badge>
                    <span className="truncate">{p.supplierName}</span>
                    <span className="num text-ink-4">{p.docNo}</span>
                  </span>
                  <span className="mt-0.5 block h-1.5 rounded-full bg-paper-3">
                    <span className={cn('block h-full rounded-full', p.source === 'quote' ? 'bg-lake/60' : 'bg-pine/60')} style={{ width: `${Math.max(4, (p.priceCents / top) * 100)}%` }} />
                  </span>
                </span>
                <span className="num text-right font-semibold">
                  ¥{formatAmount(p.priceCents)}
                  <span className="font-normal text-ink-3">/{p.purchaseUnit}</span>
                  {p.qtyMilli !== null && <span className="block text-[11px] font-normal text-ink-4">{formatQty(p.qtyMilli)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
