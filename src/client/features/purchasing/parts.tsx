import { TrendingDown, TrendingUp } from 'lucide-react';
import { PAYABLE_STATUS_LABELS, PO_STATUS_LABELS, RECEIVING_LABELS, type PayableStatus, type PoStatus, type PriceCompare, type ReceivingState } from '@shared/purchasing';
import { formatAmount } from '@shared/money';
import { cn } from '../../lib/utils';

const PO_TONE: Record<PoStatus, string> = {
  draft: 'bg-paper-2 text-ink-2 ring-1 ring-line-strong',
  submitted: 'bg-yuzu-soft text-yuzu-deep',
  returned: 'bg-ember-soft text-ember',
  approved: 'bg-pine-soft text-pine',
  cancelled: 'bg-paper-2 text-ink-3 line-through decoration-ink-4',
  closed: 'bg-paper-3 text-ink-2',
};

export function PoStatusChip({ status, className }: { status: PoStatus; className?: string }) {
  return (
    <span className={cn('inline-flex h-[22px] items-center rounded-full px-2 text-[12px] font-semibold whitespace-nowrap', PO_TONE[status], className)}>
      {status === 'submitted' && <span className="mr-1 size-1.5 animate-pulse rounded-full bg-yuzu-deep" />}
      {PO_STATUS_LABELS[status]}
    </span>
  );
}

const PAYABLE_TONE: Record<PayableStatus, string> = {
  submitted: 'bg-yuzu-soft text-yuzu-deep',
  returned: 'bg-ember-soft text-ember',
  confirmed: 'bg-pine-soft text-pine',
  cancelled: 'bg-paper-2 text-ink-3 line-through decoration-ink-4',
  voided: 'bg-clay-soft text-clay',
};

export function PayableStatusChip({ status, className }: { status: PayableStatus; className?: string }) {
  return (
    <span className={cn('inline-flex h-[22px] items-center rounded-full px-2 text-[12px] font-semibold whitespace-nowrap', PAYABLE_TONE[status], className)}>
      {status === 'submitted' && <span className="mr-1 size-1.5 animate-pulse rounded-full bg-yuzu-deep" />}
      {PAYABLE_STATUS_LABELS[status]}
    </span>
  );
}

/** 到货进度：收货状态与付款状态分开展示 */
export function ReceivingChip({ state, className }: { state: ReceivingState; className?: string }) {
  const tone = state === 'full' ? 'text-pine' : state === 'partial' ? 'text-lake' : 'text-ink-3';
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[12px] font-semibold whitespace-nowrap', tone, className)}>
      <span className="flex gap-0.5" aria-hidden>
        <span className={cn('h-2 w-1.5 rounded-sm', state === 'none' ? 'bg-line-strong' : 'bg-current')} />
        <span className={cn('h-2 w-1.5 rounded-sm', state === 'full' ? 'bg-current' : 'bg-line-strong')} />
      </span>
      {RECEIVING_LABELS[state]}
    </span>
  );
}

/** 与最近同口径成交价比较；没有可比历史时明确写「暂无可比成交价」 */
export function CompareChip({ compare, unit, className }: { compare: PriceCompare | null | undefined; unit: string; className?: string }) {
  if (!compare?.baseline || compare.changePercent === null) {
    return <span className={cn('text-[11.5px] text-ink-3', className)}>暂无可比成交价</span>;
  }
  const p = compare.changePercent;
  const b = compare.baseline;
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-[11.5px] whitespace-nowrap', className)}
      title={`比较对象：${b.docNo}（${b.docDate} · ${b.supplierName}）同规格、同单位、同价格口径`}
    >
      {p > 0 ? (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-clay-soft px-1.5 font-bold text-clay">
          <TrendingUp className="size-3" />+{p.toFixed(2)}%
        </span>
      ) : p < 0 ? (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-pine-soft px-1.5 font-bold text-pine">
          <TrendingDown className="size-3" />
          {p.toFixed(2)}%
        </span>
      ) : (
        <span className="rounded-full bg-paper-2 px-1.5 font-bold text-ink-2">持平</span>
      )}
      <span className="text-ink-3">
        上次 ¥{formatAmount(b.priceCents)}/{unit}
      </span>
    </span>
  );
}
