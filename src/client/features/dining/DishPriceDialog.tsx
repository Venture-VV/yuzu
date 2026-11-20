// 菜品管理：改价与改价记录（8.1.15，docs/DISHES_V8115.md 第 4 节）。
// 改价是单独一项权限，要写原因；每一档的变化记一条（改前、改后、谁、几点、原因、从哪里改的），只追加。
// 以前的订单照下单时的价：明细上留着当时的单价，改价不碰它。
// 8.1.16：带着打开时看到的价与版本（晚到的旧改价被拒绝）；没收到结果的进「结果待确认」，处理好之前这道菜不能再改价。

import { useState } from 'react';
import { PRICE_TIER_LABELS, PRICE_TIERS, type PriceTier, type TierPrice } from '@shared/catalog';
import { DISH_PRICE_SOURCE_LABELS, MAX_PRICE_REASON, priceChangeText, priceDiff, type DishPriceChange, type DishRow, type DishSaveResult } from '@shared/dishes';
import { centsToInput, parseYuan } from '@shared/money';
import { ApiError, errorMessage, UncertainError } from '../../lib/api';
import { useReasons, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { ReasonChips } from '../../components/ReasonChips';
import { Badge, Button, Field, Input, MoneyInput, Notice, Skeleton } from '../../components/ui';
import { DishPendingNotice } from './DishPendingNotice';
import { pendingOf, sendDishOp, useDishPending } from './dishPendingStore';
import { useDishPriceChanges } from './dishQueries';

/** 各档现在的价填进输入框（元）；没有的档空着 */
const toInputs = (prices: readonly TierPrice[]) =>
  Object.fromEntries(
    PRICE_TIERS.map((tier) => {
      const now = prices.find((p) => p.tier === tier);
      return [tier, now ? centsToInput(now.price) : ''];
    }),
  ) as Record<PriceTier, string>;

export function DishPriceDialog({
  dish,
  onClose,
  onSaved,
  onRejected,
}: {
  dish: DishRow | null;
  onClose: () => void;
  onSaved: (dish: DishRow) => void;
  /** 服务端明确拒绝了（价格刚被别人改过……）：外面把菜品表刷新一下 */
  onRejected: () => void;
}) {
  const reasons = useReasons('dishPriceReasons');
  const [inputs, setInputs] = useState<Record<PriceTier, string>>(() => toInputs([]));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useSession();
  const pending = useDishPending();
  useResetOnOpen(
    dish !== null,
    () => {
      setInputs(toInputs(dish?.prices ?? []));
      setReason('');
      setBusy(false);
      setError(null);
    },
    [dish?.id, dish?.rev],
  );
  const history = useDishPriceChanges(dish?.id ?? null, dish !== null);
  if (!dish) return null;
  const waiting = pendingOf(pending, 'price', dish.id);

  // 填的各档：空着是不卖这一档；写得不对的先不算
  const parsed = PRICE_TIERS.map((tier) => {
    const text = inputs[tier].trim();
    return { tier, text, cents: text ? parseYuan(text) : null };
  });
  const wrong = parsed.find((p) => p.text && (p.cents === null || p.cents <= 0));
  const next: TierPrice[] = parsed.flatMap((p) => (p.cents ? [{ tier: p.tier, price: p.cents }] : []));
  const diff = wrong ? [] : priceDiff(dish.prices, next);
  const problem = wrong
    ? `${PRICE_TIER_LABELS[wrong.tier]}价「${wrong.text}」不是有效的金额`
    : next.length === 0
      ? '至少留一档价格'
      : diff.length === 0
        ? '价格没有变'
        : reason.trim().length < 2
          ? '请写改价原因（至少 2 个字）'
          : null;

  const save = async () => {
    if (problem || waiting) return;
    const asObject = (list: readonly TierPrice[]) => Object.fromEntries(PRICE_TIERS.map((tier) => [tier, list.find((p) => p.tier === tier)?.price ?? null]));
    const key = uuid();
    setBusy(true);
    setError(null);
    try {
      const r = await sendDishOp<DishSaveResult>({
        key,
        type: 'price',
        itemId: dish.id,
        method: 'post',
        url: `/api/dining/dishes/${dish.id}/price`,
        body: { clientKey: key, prices: asObject(next), expected: asObject(dish.prices), rev: dish.rev, reason: reason.trim() },
        summary: `「${dish.name}」改价（${diff.map(priceChangeText).join('；')}）`.slice(0, 120),
        staffName: session.staff.displayName,
      });
      onSaved(r.dish);
    } catch (e) {
      // 没收到结果：记录留在本机，弹窗上方出现「结果待确认」那一条
      if (!(e instanceof UncertainError)) setError(errorMessage(e));
      if (e instanceof ApiError) onRejected();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`改价 · ${dish.name}`}
      description="改的是以后下单的价；已经点了的、以前的订单照下单时的价。"
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" className="min-h-11" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" className="min-h-11 min-w-[112px]" disabled={!!problem || !!waiting} loading={busy} onClick={() => void save()} data-testid="dish-price-save">
            确认改价
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="dish-price-dialog">
        {waiting && <DishPendingNotice op={waiting} onApplied={(saved) => (saved ? onSaved(saved) : onRejected())} onAbandoned={onRejected} />}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {PRICE_TIERS.map((tier, i) => (
            <Field key={tier} label={`${PRICE_TIER_LABELS[tier]}价`} htmlFor={`price-${tier}`} hint={dish.prices.some((p) => p.tier === tier) ? undefined : '现在没有这一档'}>
              <MoneyInput
                id={`price-${tier}`}
                value={inputs[tier]}
                onChange={(e) => {
                  setInputs((cur) => ({ ...cur, [tier]: e.target.value }));
                  setError(null);
                }}
                placeholder="不卖就空着"
                data-autofocus={i === 0 || undefined}
                data-testid={`dish-price-new-${tier}`}
              />
            </Field>
          ))}
        </div>
        <p className="min-h-6 text-[16px] font-semibold" data-testid="dish-price-diff">
          {diff.length ? diff.map(priceChangeText).join('；') : <span className="font-normal text-ink-3">改了哪一档，这里写出改前 → 改后</span>}
        </p>
        <Field label="改价原因" htmlFor="price-reason">
          <ReasonChips reasons={reasons} value={reason} onPick={setReason} disabled={busy} testId="dish-price-reasons" />
          <Input id="price-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={MAX_PRICE_REASON} placeholder="例如 食材涨价" data-testid="dish-price-reason" />
        </Field>
        {error ? <Notice tone="error" title={error} data-testid="dish-price-error" /> : problem && diff.length > 0 ? <p className="text-[13px] font-semibold text-clay">{problem}</p> : null}

        <section className="border-t border-line pt-3">
          <h3 className="mb-2 text-[14px] font-bold">这道菜的改价记录</h3>
          <PriceChangeList query={history} emptyText="还没有改过价" />
        </section>
      </div>
    </Dialog>
  );
}

/** 全部菜品的改价记录（新的在前，最近 200 条） */
export function PriceHistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const history = useDishPriceChanges(null, open);
  return (
    <Dialog open={open} onClose={onClose} title="改价记录" description="每一次定价、改价都在这里：改前、改后、谁、几点、原因。只追加，不能改。最近 200 条，新的在前。" width="max-w-2xl">
      <PriceChangeList query={history} emptyText="还没有定价、改价的记录" withName />
    </Dialog>
  );
}

function PriceChangeList({ query, emptyText, withName }: { query: ReturnType<typeof useDishPriceChanges>; emptyText: string; withName?: boolean }) {
  if (query.isPending) return <Skeleton className="h-20" />;
  if (query.isError && !query.data) return <LoadFailed title="改价记录没有取回来" onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  const rows: DishPriceChange[] = query.data ?? [];
  if (rows.length === 0) return <EmptyState art="calm" title={emptyText} className="py-6" />;
  return (
    <ul className="divide-y divide-line/70" data-testid="dish-price-history">
      {rows.map((c) => (
        <li key={c.id} className="py-2 text-[13px]">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {withName && <span className="text-[15px] font-bold">{c.itemName}</span>}
            <span className="num text-[16px] font-semibold">{priceChangeText(c)}</span>
            <Badge>{DISH_PRICE_SOURCE_LABELS[c.source]}</Badge>
          </p>
          <p className="mt-0.5 text-[12.5px] text-ink-3">
            {formatDateTime(c.createdAt)} · {c.staffName ?? '命令行'} · {c.reason}
          </p>
        </li>
      ))}
    </ul>
  );
}
