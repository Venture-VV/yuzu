// 点单时选规格、做法、加料（8.1.15 菜品管理，docs/DISHES_V8115.md 第 5 节；8.1.17 docs/DISHES_V8117.md 第 2、3 节）：
// 点一道多档、或有做法 / 加料的菜时弹出来。
//   · 规格（档，8.1.17 BW5）：多档的菜选一档（各档的价）；只有一档的不显示这一段；
//   · 做法：分了组的同一组只能选一个（再点别的就换过去），必选的组不选不能加进已点；不分组的可以多选；
//     加价的写「+¥2」，按份加在这一行的单价上（服务端按同一套规矩核对、按自己的价算，@shared/dishes 的 methodChoiceProblem）；
//   · 加料：另外的菜，各算各的钱；加进已点时另起一行，挂在这一行主菜上（出品单上写「配 这道菜」，退主菜时问要不要一起退）；
//   · 套餐：这里把含的几样写出来（出品单上会列出来），下单还是一行；可换的一样（8.1.17 BW7）选换成哪一样（默认不换，
//     原来那一样沽清了的默认换成第一样还有的），差价按份加在这一行的单价上，出品单上写「可乐换橙汁 +¥3」。
//   · 8.1.15 块 B（ZT26）：加料在这个岗位不能下单的出品口（按出品口的三项下单权限）的，标「不能在水吧下单」、不能选。

import { useState } from 'react';
import { Ban, Hourglass, Minus, Plus } from 'lucide-react';
import { PRICE_TIER_LABELS, defaultTier, tierPrice, type PriceTier } from '@shared/catalog';
import { MAX_DISH_NOTE, type MenuDish } from '@shared/dining';
import { comboChoice, composeLineNote, methodChoiceProblem, methodsExtra, partsText, pickedMethods, plusYuan, type ComboPartOption, type DishMethodOption, type DishSwapChoice } from '@shared/dishes';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { QtyInput } from '../../components/QtyInput';
import { Badge, Button, Field, Input } from '../../components/ui';
import { StatusChip } from './DishChips';

/** 选好的一行（加进已点）：主菜带档、做法、手写的备注；加料的 addon 为真（挂在这一次选的主菜上） */
export interface PickedLine {
  dishId: number;
  quantity: number;
  tier?: PriceTier;
  methods?: string[];
  /** 套餐换菜（8.1.17 BW7）：只列换了的 */
  swaps?: DishSwapChoice[];
  note: string;
  addon?: boolean;
}

/** 这道菜要不要先弹出来选：多档、有做法、有加料、是有可换的一样的套餐 */
export const needsOptions = (d: MenuDish) => !!(d.prices && d.prices.length > 1) || !!d.methods?.length || !!d.addons?.length || swappableOf(d).length > 0;

/** 套餐里可换的几样（8.1.17 BW7） */
export const swappableOf = (d: MenuDish): ComboPartOption[] => (d.combo ?? []).filter((p) => p.swaps?.length);

/** 一道菜的做法（带分组、加价）；8.1.15 的菜单只有名字时当不分组、不加钱 */
export const methodOptionsOf = (d: MenuDish): DishMethodOption[] => d.methodOptions ?? (d.methods ?? []).map((name) => ({ name, group: '', price: 0 }));

/** 这一档的价（没有这一档、不是多档的菜用菜单上的默认价） */
export const tierPriceOf = (d: MenuDish, tier: PriceTier | undefined) => (tier && d.prices ? (tierPrice(d.prices, tier) ?? d.price) : d.price);

export function DishOptionsDialog({
  dish,
  remainingOf,
  onClose,
  onAdd,
  blockedOf,
}: {
  dish: MenuDish | null;
  /** 一道菜今天还能点几份（null 不限量）：已经在菜篮里的要扣掉 */
  remainingOf: (id: number) => number | null;
  onClose: () => void;
  onAdd: (lines: PickedLine[]) => void;
  /** 这道加料能不能在这里下单（8.1.15 块 B）：不能的给出原因（「不能在水吧下单」），标出来、不能选；不传当都能点 */
  blockedOf?: (id: number) => string | null;
}) {
  const [tier, setTier] = useState<PriceTier | undefined>(undefined);
  const [methods, setMethods] = useState<string[]>([]);
  const [addons, setAddons] = useState<Record<number, number>>({});
  /** 套餐可换的一样换成哪一样（价目项目；与原来的一样 = 不换） */
  const [swapped, setSwapped] = useState<Record<number, number>>({});
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  useResetOnOpen(
    dish !== null,
    () => {
      setTier(dish?.prices && dish.prices.length > 1 ? (defaultTier(dish.prices) ?? undefined) : undefined);
      setMethods([]);
      setAddons({});
      // 原来那一样还有的不换；沽清了的默认换成第一样还有的
      setSwapped(
        Object.fromEntries(
          (dish ? swappableOf(dish) : []).map((p) => {
            const out = (id: number) => (remainingOf(id) ?? Infinity) < p.quantity;
            return [p.itemId, out(p.itemId) ? (p.swaps!.find((w) => w.available && !out(w.itemId))?.itemId ?? p.itemId) : p.itemId];
          }),
        ),
      );
      setQuantity(1);
      setNote('');
      setHint(null);
    },
    [dish?.id],
  );
  if (!dish) return null;

  const left = remainingOf(dish.id);
  const max = Math.min(99, left ?? 99);
  const options = methodOptionsOf(dish);
  const groups = dish.methodGroups ?? [];
  const loose = options.filter((o) => !o.group || !groups.some((g) => g.name === o.group));
  const addonList = dish.addons ?? [];
  const picked = addonList.filter((a) => (addons[a.id] ?? 0) > 0 && !blockedOf?.(a.id));
  const swapParts = swappableOf(dish);
  const swaps: DishSwapChoice[] = swapParts.filter((p) => swapped[p.itemId] && swapped[p.itemId] !== p.itemId).map((p) => ({ from: p.itemId, to: swapped[p.itemId]! }));
  const combo = comboChoice(dish.combo ?? [], swaps);
  const unit = tierPriceOf(dish, tier) + methodsExtra(options, methods) + combo.extra;
  const total = unit * quantity + picked.reduce((s, a) => s + a.price * addons[a.id]!, 0);
  // 必选的组没选、同一组两个……与服务端同一个核对
  const problem = methodChoiceProblem(dish.name, options, groups, methods, { requireAll: true });
  // 可换的一样没换、原来那一样又不够了（服务端照样按沽清拒绝）
  const outPart = swapParts.find((p) => (swapped[p.itemId] ?? p.itemId) === p.itemId && (remainingOf(p.itemId) ?? Infinity) < p.quantity * quantity);
  const swapProblem = outPart ? `「${outPart.name}」今天不够了，请换一样` : null;
  const preview = composeLineNote({ methods: pickedMethods(options, methods), swaps: combo.texts, note });
  const setAddon = (id: number, n: number) => setAddons((cur) => ({ ...cur, [id]: Math.max(0, n) }));
  /** 点一种做法：分了组的换成这一个（再点一次是不选），不分组的选上 / 去掉 */
  const toggle = (m: DishMethodOption) =>
    setMethods((cur) => {
      if (cur.includes(m.name)) return cur.filter((x) => x !== m.name);
      const sameGroup = m.group ? options.filter((o) => o.group === m.group).map((o) => o.name) : [];
      return [...cur.filter((x) => !sameGroup.includes(x)), m.name];
    });

  const confirm = () => {
    if (problem || swapProblem || max < 1) return;
    onAdd([
      {
        dishId: dish.id,
        quantity,
        ...(tier ? { tier } : {}),
        ...(methods.length ? { methods: pickedMethods(options, methods).map((m) => m.name) } : {}),
        ...(swaps.length ? { swaps } : {}),
        note: note.trim(),
      },
      ...picked.map((a) => ({ dishId: a.id, quantity: addons[a.id]!, note: '', addon: true })),
    ]);
  };

  const chip = (m: DishMethodOption, radio: boolean) => {
    const on = methods.includes(m.name);
    return (
      <button
        key={m.name}
        type="button"
        role={radio ? 'radio' : undefined}
        aria-checked={radio ? on : undefined}
        aria-pressed={radio ? undefined : on}
        onClick={() => toggle(m)}
        className={cn('h-11 min-w-11 rounded-full border px-4 text-[14px] font-semibold transition-colors', on ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-pine')}
        data-testid={`dish-options-method-${m.name}`}
      >
        {m.name}
        {m.price > 0 && <span className={cn('num ml-1', on ? 'text-paper' : 'text-ember-deep')}>{plusYuan(m.price)}</span>}
      </button>
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={dish.name}
      description={
        <>
          <Money cents={tierPriceOf(dish, tier)} className="text-[16px] font-bold text-ink-2" />
          {tier && <span className="ml-1.5 text-[13px]">{PRICE_TIER_LABELS[tier]}</span>}
          <span className="ml-2">{dish.stationName}</span>
        </>
      }
      footer={
        <div className="flex w-full flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1 text-[13px] text-ink-3">
            {problem || swapProblem ? (
              <span className="text-[14px] font-semibold text-clay" data-testid="dish-options-problem">
                {problem ? (problem.code === 'DISH_METHOD_REQUIRED' ? `请先选「${problem.group}」` : problem.message) : swapProblem}
              </span>
            ) : (
              <>
                这次合计 <Money cents={total} className="text-[18px] font-bold text-ink" />
              </>
            )}
          </span>
          <Button variant="ghost" className="min-h-11" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" className="min-h-11 min-w-[112px]" disabled={!!problem || !!swapProblem || max < 1} onClick={confirm} data-autofocus data-testid="dish-options-add">
            加入已点
          </Button>
        </div>
      }
    >
      <div className="space-y-4" data-testid="dish-options">
        {dish.combo && dish.combo.length > 0 && (
          <p className="rounded-md bg-lake-soft px-3 py-2 text-[13.5px] font-semibold text-lake" data-testid="dish-options-combo">
            套餐含 {partsText(combo.parts)}（下单一行，出品单上会列出来）
          </p>
        )}

        {swapParts.map((p) => (
          <section key={p.itemId} data-testid={`dish-options-swap-${p.name}`}>
            <h3 className="mb-2 text-[13px] font-semibold text-ink-2">
              套餐里的{p.name}
              {p.quantity > 1 ? `×${p.quantity}` : ''}
              <span className="font-normal text-ink-3">（可换，选一种）</span>
            </h3>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={`套餐里的${p.name}`}>
              {[{ itemId: p.itemId, name: `${p.name}（不换）`, priceDiff: 0, available: true }, ...p.swaps!].map((w) => {
                const on = (swapped[p.itemId] ?? p.itemId) === w.itemId;
                const left = remainingOf(w.itemId);
                const out = !w.available || (left !== null && left < p.quantity);
                return (
                  <button
                    key={w.itemId}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={out && !on}
                    onClick={() => setSwapped((cur) => ({ ...cur, [p.itemId]: w.itemId }))}
                    className={cn(
                      'flex h-11 items-center gap-1 rounded-full border px-4 text-[14px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                      on ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-pine',
                    )}
                    data-testid={`dish-options-swap-${p.name}-${w.itemId === p.itemId ? '不换' : w.name}`}
                  >
                    {w.name}
                    {w.priceDiff > 0 && <span className={cn('num', on ? 'text-paper' : 'text-ember-deep')}>{plusYuan(w.priceDiff)}</span>}
                    {out && <span className="text-[12px] font-normal">{w.available ? '已沽清' : '已下架'}</span>}
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        {dish.prices && dish.prices.length > 1 && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink-2">规格</h3>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="规格">
              {dish.prices.map((p) => {
                const on = tier === p.tier;
                return (
                  <button
                    key={p.tier}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setTier(p.tier)}
                    className={cn(
                      'flex h-11 items-center gap-1.5 rounded-full border px-4 text-[14px] font-semibold transition-colors',
                      on ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-pine',
                    )}
                    data-testid={`dish-options-tier-${p.tier}`}
                  >
                    {PRICE_TIER_LABELS[p.tier]}
                    <Money cents={p.price} className="text-[14px]" />
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {groups
          .filter((g) => options.some((o) => o.group === g.name))
          .map((g) => (
            <section key={g.name} data-testid={`dish-options-group-${g.name}`}>
              <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink-2">
                {g.name}
                <span className="font-normal text-ink-3">（选一种）</span>
                {g.required && <Badge tone={methods.some((m) => options.find((o) => o.name === m)?.group === g.name) ? 'pine' : 'ember'}>必选</Badge>}
              </h3>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={g.name}>
                {options.filter((o) => o.group === g.name).map((m) => chip(m, true))}
              </div>
            </section>
          ))}

        {loose.length > 0 && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink-2">{groups.length ? '其他做法（可多选）' : '做法（可多选）'}</h3>
            <div className="flex flex-wrap gap-2">{loose.map((m) => chip(m, false))}</div>
          </section>
        )}

        {addonList.length > 0 && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink-2">加料（另算钱，出品单上写「配 {dish.name}」）</h3>
            <ul className="space-y-1.5">
              {addonList.map((a) => {
                const n = addons[a.id] ?? 0;
                const cap = remainingOf(a.id);
                const out = cap !== null && cap <= 0;
                const blocked = blockedOf?.(a.id) ?? null;
                return (
                  <li
                    key={a.id}
                    className={cn('flex min-h-12 items-center gap-2 rounded-lg border px-3', n > 0 && !blocked ? 'border-pine bg-pine-tint' : 'border-line')}
                    data-testid={`dish-options-addon-${a.name}`}
                    data-blocked={blocked ? 'true' : undefined}
                  >
                    <span className="min-w-0 flex-1 truncate text-[14.5px] font-bold">{a.name}</span>
                    <span className="num text-[16px] font-semibold text-ink-2">
                      +<Money cents={a.price} />
                    </span>
                    {blocked ? (
                      <StatusChip tone="clay" icon={<Ban />}>
                        {blocked}
                      </StatusChip>
                    ) : out ? (
                      <StatusChip tone="clay" icon={<Ban />}>
                        已沽清
                      </StatusChip>
                    ) : n === 0 ? (
                      <Button className="min-h-11 min-w-[72px]" icon={<Plus className="size-4" />} onClick={() => setAddon(a.id, 1)} data-testid={`dish-options-addon-add-${a.name}`}>
                        加
                      </Button>
                    ) : (
                      <span className="flex items-center gap-1">
                        <StepButton label={`${a.name} 少一份`} onClick={() => setAddon(a.id, n - 1)}>
                          <Minus className="size-4" />
                        </StepButton>
                        <QtyInput
                          value={n}
                          max={Math.min(99, cap ?? 99)}
                          onChange={(v) => setAddon(a.id, v)}
                          onHint={setHint}
                          label={`${a.name} 的份数`}
                          className="h-11 w-10 text-[16px]"
                          testId={`dish-options-addon-qty-${a.name}`}
                        />
                        <StepButton label={`${a.name} 多一份`} onClick={() => setAddon(a.id, Math.min(Math.min(99, cap ?? 99), n + 1))}>
                          <Plus className="size-4" />
                        </StepButton>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="flex flex-wrap items-center gap-3">
          <h3 className="text-[13px] font-semibold text-ink-2">{dish.name} 的份数</h3>
          <span className="flex items-center gap-1">
            <StepButton label="少一份" onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
              <Minus className="size-4" />
            </StepButton>
            <QtyInput value={quantity} max={Math.max(1, max)} onChange={setQuantity} onHint={setHint} label={`${dish.name} 的份数`} className="h-11 w-12 text-[18px]" testId="dish-options-qty" />
            <StepButton label="多一份" onClick={() => setQuantity((q) => Math.min(Math.max(1, max), q + 1))}>
              <Plus className="size-4" />
            </StepButton>
          </span>
          {left !== null && (
            <StatusChip tone={left <= 0 ? 'clay' : 'yuzu'} icon={left <= 0 ? <Ban /> : <Hourglass />}>
              {left <= 0 ? '已沽清' : `还能点 ${left} 份`}
            </StatusChip>
          )}
        </section>
        {hint && (
          <p className="text-[12.5px] font-semibold text-clay" role="status">
            {hint}
          </p>
        )}

        <Field label="口味备注（选填）" htmlFor="dish-options-note">
          <Input id="dish-options-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={MAX_DISH_NOTE} placeholder="例如 面硬一点" data-testid="dish-options-note" />
        </Field>
        {preview && (
          <p className="text-[12.5px] text-ink-3" data-testid="dish-options-preview">
            出品单上写：<b className="text-yuzu-deep">{preview}</b>
          </p>
        )}
      </div>
    </Dialog>
  );
}

function StepButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="flex size-11 items-center justify-center rounded-full bg-paper-2 text-ink-2 hover:bg-paper-3">
      {children}
    </button>
  );
}
