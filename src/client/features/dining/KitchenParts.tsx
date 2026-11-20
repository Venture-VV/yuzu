// 套餐在别的档口出的子项单（8.1.17 BW7，docs/DISHES_V8117.md 第 7 节）：套餐里的一样不在套餐的档口做的（热菜的套餐里有水吧的饮料），
// 在那个档口的出品屏上单独出一张——待做 → 制作中 → 已出餐，与普通的菜放在同一列、按下单先后；上菜在套餐那一张上点。
// 套餐那一张（主档口）上写出别的档口的几样各做到哪了。

import type { ReactNode } from 'react';
import { KITCHEN_PART_STATUS_LABELS, kitchenElapsed, type KitchenItem, type KitchenPartItem, type KitchenPartStatus } from '@shared/dining';
import { cn } from '../../lib/utils';
import { Badge } from '../../components/ui';

const PART_TONE: Record<KitchenPartStatus, 'neutral' | 'yuzu' | 'pine' | 'clay'> = { queued: 'neutral', cooking: 'yuzu', done: 'pine', cancelled: 'clay' };

/** 一列里的一张：普通的菜（含套餐那一张）或子项单，按下单先后排 */
export type KitchenCard = { kind: 'item'; k: KitchenItem } | { kind: 'part'; p: KitchenPartItem };

export const kitchenCards = (items: readonly KitchenItem[], parts: readonly KitchenPartItem[]): KitchenCard[] =>
  [...items.map((k): KitchenCard => ({ kind: 'item', k })), ...parts.map((p): KitchenCard => ({ kind: 'part', p }))].sort((a, b) => {
    const at = (c: KitchenCard) => new Date(c.kind === 'item' ? c.k.createdAt : c.p.createdAt).getTime();
    return at(a) - at(b) || (a.kind === b.kind ? 0 : a.kind === 'item' ? -1 : 1);
  });

/** 子项单的一张 */
export function PartTicket({ p, now, warnMinutes, showStation, children }: { p: KitchenPartItem; now: number; warnMinutes: number; showStation: boolean; children: ReactNode }) {
  const waited = kitchenElapsed(p.createdAt, now);
  const late = (p.status === 'queued' || p.status === 'cooking') && waited >= warnMinutes;
  return (
    <div className={cn('rounded-lg border border-dashed bg-card p-3 shadow-card', late ? 'border-clay/70' : 'border-lake/60')} data-testid={`kds-part-${p.id}`} data-dish={p.name}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-[17px] leading-snug font-bold">{p.name}</span>
        <span className="num text-[20px] font-bold">×{p.quantity}</span>
      </div>
      <p className="mt-1 rounded-md bg-lake-soft px-2 py-1 text-[13.5px] font-bold text-lake" data-testid={`kds-part-combo-${p.id}`}>
        套餐「{p.comboName}」里的{p.swappedFrom ? `（原 ${p.swappedFrom}）` : ''}
      </p>
      {p.note && <p className="mt-1 rounded-md bg-yuzu-tint px-2 py-1 text-[13.5px] font-bold text-yuzu-deep">{p.note}</p>}
      {p.orderNote && <p className="mt-1 rounded-md border border-dashed border-line-strong bg-paper-2 px-2 py-1 text-[13.5px] font-semibold text-ink-2">整单：{p.orderNote}</p>}
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-ink-3">
        <span className={cn('num text-[14px] font-bold', p.tableName !== null ? 'text-pine' : 'text-lake')}>{p.tableName !== null ? `桌 ${p.tableName}` : (p.tagCode ?? '')}</span>
        <span className="min-w-0 truncate">{p.guest}</span>
        {showStation && <span>· {p.stationName}</span>}
        <span className="num text-ink-4">· {p.orderNo}</span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className={cn('num text-[13px] font-bold', late ? 'text-clay' : 'text-ink-2')}>
          {p.status === 'done' && p.doneAt ? `出餐 ${kitchenElapsed(p.doneAt, now)} 分钟` : `已等 ${waited} 分钟`}
        </span>
        {p.visitClosed && <Badge tone="ember">{p.tableName !== null ? '这桌已结账' : '客人已结账'}</Badge>}
        <span className="flex flex-1 flex-wrap justify-end gap-1.5">{children}</span>
      </div>
    </div>
  );
}

/** 套餐那一张上：在别的档口做的几样各做到哪了（颜色 + 文字） */
export function PartTicketsLine({ k }: { k: KitchenItem }) {
  if (!k.partTickets?.length) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3" data-testid={`kds-part-tickets-${k.id}`}>
      <span>别的档口：</span>
      {k.partTickets.map((t) => (
        <Badge key={t.id} tone={PART_TONE[t.status]}>
          {t.name}×{t.quantity} · {t.stationName} {KITCHEN_PART_STATUS_LABELS[t.status]}
        </Badge>
      ))}
    </p>
  );
}
