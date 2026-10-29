import { useEffect, useMemo, useState } from 'react';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { ZONE_LABELS, type VisitDetail } from '@shared/frontdesk';
import { parseYuan } from '@shared/money';
import { useCatalog } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Button, Input, MoneyInput, Notice, Skeleton } from '../../components/ui';
import { CartLineName, cartKey, cartLines, ItemCard } from '../catalog/ItemCard';
import { ZoneChip } from './parts';
import { BackfillNotice, backfillBody, backfillSummary, useBackfill } from './backfill';
import { PendingPanel, useFrontdeskOp } from './pending';

/** 挂账：点选项目（多档项目按档位点选）累加数量，确认后一次登记到手牌账单（只挂账，不收款） */
export function AddItemsDialog({
  open,
  visit,
  onClose,
  onDone,
}: {
  open: boolean;
  visit: VisitDetail;
  onClose: () => void;
  onDone: (v: VisitDetail) => void;
}) {
  const can = useCan();
  const session = useSession();
  const catalog = useCatalog();
  /** 键为「项目:价格档」，值为数量 */
  const [cart, setCart] = useState<Map<string, number>>(new Map());
  const [category, setCategory] = useState('全部');
  const [custom, setCustom] = useState<{ name: string; amount: string }[]>([]);
  // 同一位客人上一笔挂账结果待确认时，先处理那一笔，不能另起一笔（避免重复挂账）
  const op = useFrontdeskOp<VisitDetail>({
    type: 'bill_post',
    visitId: visit.id,
    staffName: session.staff.displayName,
    pick: (found) => ('visit' in found ? found.visit : null),
  });

  useEffect(() => {
    if (!open) return;
    setCart(new Map());
    setCustom([]);
    setCategory('全部');
    op.clearError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const items = useMemo(() => (catalog.data?.items ?? []).filter((i) => i.active), [catalog.data]);
  const categories = useMemo(() => ['全部', ...new Set(items.map((i) => i.category || '其他'))], [items]);
  const shown = category === '全部' ? items : items.filter((i) => (i.category || '其他') === category);

  const locked = op.locked;
  const touch = op.clearError;
  const add = (key: string, delta: number) => {
    if (locked) return;
    touch();
    setCart((m) => {
      const next = new Map(m);
      const q = Math.min(99, Math.max(0, (next.get(key) ?? 0) + delta));
      if (q === 0) next.delete(key);
      else next.set(key, q);
      return next;
    });
  };

  const lines = cartLines(cart, items).map((l) => ({ ...l, quantity: l.qty }));
  /** 只限某一性别的项目（如私汤木桶浴仅女宾）：这位客人不能用时不可选 */
  const unavailableFor = (gender: 'male' | 'female' | null) =>
    gender && gender !== visit.zone ? `仅限${ZONE_LABELS[gender].title}` : null;
  const customParsed = custom.map((c) => ({ name: c.name.trim(), amount: parseYuan(c.amount) }));
  const customValid = customParsed.every((c) => c.name && c.amount && c.amount > 0);
  const total = lines.reduce((s, l) => s + l.amount, 0) + customParsed.reduce((s, c) => s + (c.amount ?? 0), 0);
  const ready = (lines.length > 0 || custom.length > 0) && customValid && total > 0;

  const backfill = useBackfill();
  const backfillBlocked = backfill.state.active && !backfill.request;
  const submit = async () => {
    if (backfillBlocked) return;
    const result = await op.submit((key) => ({
      url: `/api/frontdesk/visits/${visit.id}/charges`,
      body: {
        clientKey: key,
        lines: lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity, tier: l.tier })),
        customLines: customParsed.map((c) => ({ name: c.name, amount: c.amount })),
        expectedTotal: total,
        ...backfillBody(backfill),
      },
      tagCodes: [visit.tag.code],
      summary: [...lines.map((l) => `${l.name} ×${l.quantity}`), ...customParsed.map((c) => c.name)].join('、') + backfillSummary(backfill),
      amount: total,
    }));
    if (result) onDone(result);
  };
  const busy = op.busy;

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      width="max-w-3xl"
      title={
        <span className="flex items-center gap-2">
          加项目 · <span className="num">{visit.tag.code}</span> <ZoneChip zone={visit.zone} size="md" />
        </span>
      }
      description="点项目累加数量；确认后挂到这张手牌的账单上，价格按当前价格留存。挂账不是收款。"
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">
            本次 <b className="num text-ink">{lines.reduce((s, l) => s + l.quantity, 0) + custom.length}</b> 项，合计{' '}
            <Money cents={total} className="text-[17px] font-bold text-ink" />
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!ready || op.locked || backfillBlocked} loading={busy} onClick={submit} data-testid="add-items-submit">
            挂到 {visit.tag.code}
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={onDone} />
      <BackfillNotice action="挂账" />
      <div className={cn('grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]', backfill.state.active && 'mt-4')}>
        <div className="min-w-0">
          <div className="scroll-thin -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={cn(
                  'h-8 shrink-0 rounded-full px-3.5 text-[13px] font-semibold transition-colors',
                  category === c ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-2 hover:bg-paper-3',
                )}
              >
                {c}
              </button>
            ))}
          </div>
          {catalog.isPending ? (
            <Skeleton className="h-40" />
          ) : shown.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">还没有可挂账的项目，请店主在「管理 → 套餐与项目」中添加</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {shown.map((i) => (
                <ItemCard
                  key={i.id}
                  item={i}
                  cart={cart}
                  disabled={locked}
                  unavailable={unavailableFor(i.gender)}
                  onAdd={(tier) => add(cartKey(i.id, tier), 1)}
                />
              ))}
            </div>
          )}
          {can('consume.customAmount') && (
            <div className="mt-4">
              {custom.map((c, i) => (
                <div key={i} className="mb-2 flex items-center gap-2">
                  <Input
                    fullWidth={false}
                    className="h-10 min-w-0 flex-1"
                    placeholder="项目名称"
                    value={c.name}
                    maxLength={32}
                    disabled={locked}
                    onChange={(e) => {
                      touch();
                      setCustom((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)));
                    }}
                    aria-label="手动项目名称"
                  />
                  <div className="w-32">
                    <MoneyInput
                      value={c.amount}
                      disabled={locked}
                      onChange={(e) => {
                        touch();
                        setCustom((list) => list.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)));
                      }}
                      placeholder="0.00"
                      aria-label="手动项目金额"
                      className="h-10"
                    />
                  </div>
                  <button type="button" aria-label="移除" onClick={() => setCustom((list) => list.filter((_, j) => j !== i))} className="flex size-10 items-center justify-center rounded-md text-ink-3 hover:bg-clay-soft hover:text-clay">
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
              {custom.length < 5 && (
                <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setCustom((list) => [...list, { name: '', amount: '' }])}>
                  手动输入项目与金额
                </Button>
              )}
            </div>
          )}
        </div>

        <aside className="rounded-lg border border-line bg-paper/70 p-3" aria-label="本次挂账">
          <p className="text-[12.5px] font-bold text-ink-2">本次挂账</p>
          {lines.length === 0 && custom.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-ink-3">点左侧项目添加</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {lines.map((l) => (
                <li key={l.key} className="flex items-center gap-2">
                  <CartLineName line={l} className="text-[13px]" />
                  <span className="flex items-center rounded-md border border-line bg-card">
                    <button type="button" aria-label={`减少 ${l.name}`} onClick={() => add(l.key, -1)} className="flex size-7 items-center justify-center text-ink-2 hover:text-ink">
                      <Minus className="size-3.5" />
                    </button>
                    <span className="num w-6 text-center text-[13px] font-bold">{l.quantity}</span>
                    <button type="button" aria-label={`增加 ${l.name}`} onClick={() => add(l.key, 1)} className="flex size-7 items-center justify-center text-ink-2 hover:text-ink">
                      <Plus className="size-3.5" />
                    </button>
                  </span>
                  <Money cents={l.amount} className="w-[72px] justify-end text-right text-[13px] font-semibold" />
                </li>
              ))}
              {customParsed.map((c, i) => (
                <li key={`c${i}`} className="flex items-center gap-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate font-semibold">{c.name || '（未填名称）'}</span>
                  {c.amount ? <Money cents={c.amount} className="font-semibold" /> : <span className="text-clay">金额未填</span>}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}
