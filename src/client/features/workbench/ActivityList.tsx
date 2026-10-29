import { ArchiveRestore, ArchiveX, Bath, CirclePlus, Hourglass, Undo2 } from 'lucide-react';
import { PAYMENT_METHOD_LABELS, type EntryType } from '@shared/labels';
import type { LedgerRow } from '@shared/types';
import { cn, formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Badge, Button } from '../../components/ui';

export const ENTRY_META = {
  recharge: { label: '充值', icon: CirclePlus, tone: 'bg-lake-soft text-lake' },
  consume: { label: '消费', icon: Bath, tone: 'bg-yuzu-soft text-yuzu-deep' },
  reversal: { label: '撤销', icon: Undo2, tone: 'bg-clay-soft text-clay' },
  expire: { label: '赠金过期', icon: Hourglass, tone: 'bg-paper-2 text-ink-3' },
  opening: { label: '期初导入', icon: ArchiveRestore, tone: 'bg-pine-tint text-pine' },
  opening_void: { label: '期初作废', icon: ArchiveX, tone: 'bg-clay-soft text-clay' },
} as const satisfies Record<EntryType, { label: string; icon: unknown; tone: string }>;

/** 会员的余额变化时间线：充值 / 消费 / 撤销 / 赠金过期 */
export function ActivityRow({
  row,
  onReverse,
  onOpen,
  showMember = false,
}: {
  row: LedgerRow;
  onReverse?: (consumptionId: number) => void;
  onOpen?: (row: LedgerRow) => void;
  showMember?: boolean;
}) {
  const meta = ENTRY_META[row.entryType];
  const Icon = meta.icon;
  const reversed = row.entryType === 'consume' && row.consumptionStatus === 'reversed';
  const crossDay = row.entryType === 'reversal' && row.relatedBusinessDate && row.relatedBusinessDate !== row.businessDate;
  return (
    <div
      className={cn(
        'group flex items-start gap-3 px-3 py-3 transition-colors',
        onOpen && 'cursor-pointer hover:bg-paper-2/70',
      )}
      onClick={onOpen ? () => onOpen(row) : undefined}
    >
      <span className={cn('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full', meta.tone)}>
        <Icon className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn('text-[14px] font-bold text-ink', reversed && 'text-ink-3')}>
            {row.entryType === 'recharge'
              ? `充值 · ${row.summary}`
              : row.entryType === 'reversal'
                ? '撤销消费'
                : row.entryType === 'expire' || row.entryType === 'opening' || row.entryType === 'opening_void'
                  ? row.summary || ENTRY_META[row.entryType].label
                  : row.summary || '消费'}
          </span>
          {reversed && <Badge tone="clay">已撤销</Badge>}
          {crossDay && <Badge tone="ember">跨日撤销</Badge>}
          {showMember && <span className="text-[13px] font-semibold text-ink-2">{row.memberName}</span>}
        </div>
        <p className="num mt-0.5 truncate text-[12.5px] text-ink-3">
          {row.docNo} · {formatDateTime(row.createdAt)} · {row.operatorName}
          {row.entryType === 'recharge' && row.paymentMethod ? ` · ${PAYMENT_METHOD_LABELS[row.paymentMethod]}` : ''}
        </p>
        {row.entryType === 'reversal' && (
          <p className="mt-1 text-[12.5px] text-ink-2">
            原单 <span className="num font-semibold">{row.relatedDocNo}</span> · {row.summary}
          </p>
        )}
        {reversed && row.relatedDocNo && <p className="num mt-1 text-[12.5px] text-ink-3">撤销单 {row.relatedDocNo}</p>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {row.entryType === 'recharge' && row.paidAmount != null && (
          <span className="flex items-baseline gap-1.5 text-[12px] text-ink-3">
            实收 <Money cents={row.paidAmount} className="text-[15px] font-bold text-lake" />
          </span>
        )}
        <DeltaLine label="本金" cents={row.principalDelta} struck={reversed} emphasize={row.entryType !== 'recharge'} />
        {row.bonusDelta !== 0 && <DeltaLine label="赠金" cents={row.bonusDelta} struck={reversed} bonus />}
        {onReverse && row.entryType === 'consume' && !reversed && row.consumptionId && !row.checkoutNo && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 -mr-2 text-clay hover:bg-clay-soft hover:text-clay"
            icon={<Undo2 className="size-3.5" />}
            onClick={(e) => {
              e.stopPropagation();
              onReverse(row.consumptionId!);
            }}
          >
            撤销
          </Button>
        )}
        {/* 前台结账的储值支付只能随结账单一起反结账，不提供单独撤销 */}
        {onReverse && row.entryType === 'consume' && !reversed && row.checkoutNo && (
          <span className="mt-1 text-[12px] text-ink-3" title={`结账单 ${row.checkoutNo} 的储值支付：如需更正，请到「前台 → 结账记录」反结账`}>
            需反结账更正
          </span>
        )}
      </div>
    </div>
  );
}

function DeltaLine({ label, cents, struck, bonus, emphasize }: { label: string; cents: number; struck?: boolean; bonus?: boolean; emphasize?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5 text-[12px] text-ink-3">
      {label}
      <Money
        cents={cents}
        signed
        className={cn(
          emphasize ? 'text-[15px] font-bold' : 'text-[13px] font-semibold',
          struck ? 'struck text-ink-4' : bonus ? 'text-yuzu-deep' : cents < 0 ? 'text-ink' : 'text-pine',
        )}
      />
    </span>
  );
}
