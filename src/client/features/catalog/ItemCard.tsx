import { Clock3, Star } from 'lucide-react';
import { itemTags, lineName, PRICE_TIER_LABELS, tierPrice, type PriceTier } from '@shared/catalog';
import type { ServiceItem } from '@shared/types';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';

// 消费项目卡片：会员消费与前台挂账共用。只有一档价格的项目整张卡片点一下加一份；
// 多档项目（标准 / 专业 / 优选）在卡片里按档位点选，每一档单独计数。

export const cartKey = (itemId: number, tier: PriceTier) => `${itemId}:${tier}`;

export interface CartLine {
  key: string;
  item: ServiceItem;
  tier: PriceTier;
  qty: number;
  /** 随明细留存的名称：多档项目带档位，例如「日式指压（专业）」 */
  name: string;
  unitPrice: number;
  amount: number;
}

/** 购物车（键为「项目:档位」）→ 明细；项目已停用或档位不再提供时略过（提交时服务端会提示刷新） */
export function cartLines(cart: Map<string, number>, items: ServiceItem[]): CartLine[] {
  return [...cart].flatMap(([key, qty]) => {
    const [id, tier] = key.split(':') as [string, PriceTier];
    const item = items.find((i) => i.id === Number(id));
    const unitPrice = item ? tierPrice(item.prices, tier) : null;
    if (!item || unitPrice === null) return [];
    return [{ key, item, tier, qty, name: lineName(item.name, item.prices, tier), unitPrice, amount: unitPrice * qty }];
  });
}

/** 已选明细的名称：多档项目在名称下面另起一行标档位，窄栏里不会把「（专业）」折断或截掉 */
export function CartLineName({ line, className }: { line: CartLine; className?: string }) {
  return (
    <span className={cn('min-w-0 flex-1 leading-snug', className)} title={line.name}>
      <span className="line-clamp-2 font-semibold">{line.item.name}</span>
      {line.item.prices.length > 1 && <span className="block text-[11.5px] font-semibold text-ink-3">{PRICE_TIER_LABELS[line.tier]}档</span>}
    </span>
  );
}

/** 档位按钮里的价格：整元时省略「.00」，三档并排时放得下 */
function TierMoney({ cents }: { cents: number }) {
  if (cents % 100 !== 0) return <Money cents={cents} className="text-[13px] font-bold text-ink" />;
  return (
    <span className="num inline-flex items-baseline text-[13px] font-bold whitespace-nowrap text-ink">
      <span className="mr-[0.1em] text-[0.75em] font-semibold opacity-70">¥</span>
      {(cents / 100).toLocaleString('en-US')}
    </span>
  );
}

const TONES = {
  pine: { on: 'border-pine bg-pine-tint', badge: 'bg-pine text-paper' },
  yuzu: { on: 'border-yuzu-deep/60 bg-yuzu-tint shadow-[0_0_0_3px_rgb(242_194_48/0.25)]', badge: 'bg-ink text-yuzu' },
} as const;

export function ItemCard({
  item,
  cart,
  onAdd,
  disabled,
  unavailable,
  hint,
  tone = 'pine',
}: {
  item: ServiceItem;
  cart: Map<string, number>;
  onAdd: (tier: PriceTier) => void;
  disabled?: boolean;
  /** 这位客人不能用的原因（例如「仅限女宾」）；有原因时整张卡片不可选 */
  unavailable?: string | null;
  /** 补充说明（例如「选技师」） */
  hint?: string | null;
  tone?: keyof typeof TONES;
}) {
  const t = TONES[tone];
  const tags = itemTags(item);
  const qtyOf = (tier: PriceTier) => cart.get(cartKey(item.id, tier)) ?? 0;
  const total = item.prices.reduce((s, p) => s + qtyOf(p.tier), 0);
  const single = item.prices.length === 1;
  const off = disabled || !!unavailable;
  const meta = (
    <>
      <span className="flex items-start gap-1.5 pr-6">
        <span className="line-clamp-2 text-[13.5px] leading-snug font-bold text-ink" title={item.name}>
          {item.name}
        </span>
      </span>
      {(item.durationMinutes || tags.length > 0 || item.gender || unavailable || hint) && (
        <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] font-semibold text-ink-3">
          {item.durationMinutes ? (
            <span className="num inline-flex items-center gap-0.5">
              <Clock3 className="size-3" />
              {item.durationMinutes} 分钟
            </span>
          ) : null}
          {tags.map((tag) =>
            tag === '超人气' ? (
              <span key={tag} className="inline-flex items-center gap-0.5 text-ember">
                <Star className="size-3 fill-current" />
                超人气
              </span>
            ) : (
              <span key={tag}>{tag}</span>
            ),
          )}
          {item.gender && <span className={unavailable ? 'text-clay' : 'text-ink-2'}>{unavailable ?? `仅${item.gender === 'female' ? '女宾' : '男宾'}`}</span>}
          {!item.gender && unavailable && <span className="text-clay">{unavailable}</span>}
          {hint && <span className="text-pine">{hint}</span>}
        </span>
      )}
    </>
  );

  if (single) {
    const tier = item.prices[0]!.tier;
    return (
      <button
        type="button"
        onClick={() => onAdd(tier)}
        disabled={off}
        data-testid={`item-${item.name}`}
        className={cn(
          'relative flex min-h-[66px] flex-col justify-between rounded-lg border px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
          total ? t.on : 'border-line bg-card hover:border-line-strong',
        )}
      >
        <span className="flex flex-col">{meta}</span>
        <Money cents={item.prices[0]!.price} className="mt-1 text-[14px] font-bold text-ink-2" />
        {total > 0 && (
          <span className={cn('num absolute top-2 right-2 flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-[12px] font-bold', t.badge)}>
            ×{total}
          </span>
        )}
      </button>
    );
  }

  return (
    <div
      className={cn('relative flex flex-col rounded-lg border px-3 pt-2.5 pb-2', total ? t.on : 'border-line bg-card', off && 'opacity-50')}
      data-testid={`item-${item.name}`}
    >
      {meta}
      <span className={cn('mt-2 grid gap-1', item.prices.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
        {item.prices.map((p) => {
          const q = qtyOf(p.tier);
          return (
            <button
              key={p.tier}
              type="button"
              onClick={() => onAdd(p.tier)}
              disabled={off}
              data-testid={`item-${item.name}-${p.tier}`}
              aria-label={`${item.name} ${PRICE_TIER_LABELS[p.tier]} ${(p.price / 100).toFixed(2)} 元`}
              className={cn(
                'relative flex min-h-[44px] flex-col items-center justify-center rounded-md border px-1 py-1 text-center transition-colors active:scale-[0.98] disabled:cursor-not-allowed',
                q ? 'border-current font-bold' : 'border-line bg-paper/60 hover:border-line-strong hover:bg-card',
              )}
            >
              <span className="text-[11.5px] font-semibold text-ink-3">{PRICE_TIER_LABELS[p.tier]}</span>
              <TierMoney cents={p.price} />
              {q > 0 && (
                <span className={cn('num absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold', t.badge)}>
                  {q}
                </span>
              )}
            </button>
          );
        })}
      </span>
    </div>
  );
}
