import type { ReactNode } from 'react';
import {
  ClipboardCheck,
  Droplets,
  Flag,
  PackageMinus,
  PackagePlus,
  PackageX,
  RotateCcw,
  Truck,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { INV_DOC_META, INV_STATUS_LABELS, MOVE_TYPE_LABELS, type InvDocStatus, type InvDocType, type MoveType } from '@shared/inventory';
import { formatQty, packText } from '@shared/quantity';
import { cn } from '../../lib/utils';

export const DOC_VISUAL: Record<InvDocType, { icon: LucideIcon; tone: string; dot: string }> = {
  opening: { icon: Flag, tone: 'bg-moss-soft text-moss', dot: 'bg-moss' },
  receipt: { icon: PackagePlus, tone: 'bg-pine-soft text-pine', dot: 'bg-pine' },
  issue: { icon: PackageMinus, tone: 'bg-yuzu-soft text-yuzu-deep', dot: 'bg-yuzu-deep' },
  issue_return: { icon: Undo2, tone: 'bg-lake-soft text-lake', dot: 'bg-lake' },
  direct_use: { icon: Droplets, tone: 'bg-ember-soft text-ember', dot: 'bg-ember' },
  damage: { icon: PackageX, tone: 'bg-clay-soft text-clay', dot: 'bg-clay' },
  count: { icon: ClipboardCheck, tone: 'bg-lake-soft text-lake', dot: 'bg-lake' },
  supplier_return: { icon: Truck, tone: 'bg-clay-soft text-clay', dot: 'bg-clay' },
};

const MOVE_VISUAL: Record<MoveType, LucideIcon> = {
  opening: Flag,
  receipt: PackagePlus,
  issue: PackageMinus,
  issue_return: Undo2,
  direct_use: Droplets,
  damage: PackageX,
  count_adjust: ClipboardCheck,
  supplier_return: Truck,
  void: RotateCcw,
};

export function MoveIcon({ type, className }: { type: MoveType; className?: string }) {
  const Icon = MOVE_VISUAL[type];
  return <Icon className={className} aria-label={MOVE_TYPE_LABELS[type]} />;
}

export function DocTypeChip({ type, className }: { type: InvDocType; className?: string }) {
  const v = DOC_VISUAL[type];
  const Icon = v.icon;
  return (
    <span className={cn('inline-flex h-6 items-center gap-1 rounded-full pr-2.5 pl-2 text-[12px] font-bold whitespace-nowrap', v.tone, className)}>
      <Icon className="size-3.5" />
      {INV_DOC_META[type].title}
    </span>
  );
}

const STATUS_TONE: Record<InvDocStatus, string> = {
  draft: 'bg-paper-2 text-ink-2 ring-1 ring-line-strong',
  submitted: 'bg-yuzu-soft text-yuzu-deep',
  returned: 'bg-ember-soft text-ember',
  awaiting_supplier: 'bg-ember-soft text-ember',
  confirmed: 'bg-pine-soft text-pine',
  cancelled: 'bg-paper-2 text-ink-3 line-through decoration-ink-4',
  voided: 'bg-clay-soft text-clay',
};

export function StatusChip({ status, className }: { status: InvDocStatus; className?: string }) {
  return (
    <span className={cn('inline-flex h-[22px] items-center rounded-full px-2 text-[12px] font-semibold whitespace-nowrap', STATUS_TONE[status], className)}>
      {status === 'submitted' && <span className="mr-1 size-1.5 animate-pulse rounded-full bg-yuzu-deep" />}
      {INV_STATUS_LABELS[status]}
    </span>
  );
}

/** 数量 + 单位；单位缩小弱化，「10 箱」和「10 瓶」一眼可辨 */
export function Qty({
  milli,
  unit,
  signed,
  className,
  unitClassName,
}: {
  milli: number;
  unit: string;
  signed?: boolean;
  className?: string;
  unitClassName?: string;
}) {
  const sign = signed ? (milli > 0 ? '+' : milli < 0 ? '−' : '') : milli < 0 ? '−' : '';
  return (
    <span className={cn('num inline-flex items-baseline gap-[0.22em] whitespace-nowrap', className)}>
      <span>
        {sign}
        {formatQty(Math.abs(milli))}
      </span>
      <span className={cn('text-[0.78em] font-semibold opacity-60', unitClassName)}>{unit}</span>
    </span>
  );
}

/** 「= 9 箱 + 67 双」：按整包装提示，便于对照货架清点；不足一个包装时不显示 */
export function PackHint({ milli, factorMilli, purchaseUnit, inventoryUnit, className }: { milli: number; factorMilli: number; purchaseUnit: string; inventoryUnit: string; className?: string }) {
  const text = packText(Math.abs(milli), factorMilli, purchaseUnit, inventoryUnit);
  if (!text) return null;
  return <span className={cn('num text-[11.5px] text-ink-3', className)}>= {text}</span>;
}

/** 「模拟规则」：未经店主确认的经营规则统一标注 */
export function SimRule({ children = '模拟规则', className }: { children?: ReactNode; className?: string }) {
  return (
    <span
      title="经营规则尚待店主确认，当前为模拟规则"
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-dashed border-yuzu-deep/50 bg-yuzu-tint px-2 text-[11px] leading-none font-semibold text-yuzu-deep',
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-yuzu" />
      {children}
    </span>
  );
}

/** 库存条：当前结存相对低库存阈值的位置 */
export function StockMeter({ stock, low, className }: { stock: number; low: number | null; className?: string }) {
  if (low === null || low <= 0) return null;
  const ratio = Math.min(1, stock / (low * 3));
  const isLow = stock < low;
  return (
    <span className={cn('relative block h-1.5 w-full overflow-hidden rounded-full bg-paper-3', className)} aria-hidden>
      <span className={cn('absolute inset-y-0 left-0 rounded-full', isLow ? 'bg-clay' : 'bg-pine/70')} style={{ width: `${Math.max(4, ratio * 100)}%` }} />
      <span className="absolute inset-y-0 w-px bg-ink-3/60" style={{ left: `${100 / 3}%` }} />
    </span>
  );
}
