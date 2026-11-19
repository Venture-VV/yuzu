// 点单时选做法、加料（8.1.15 菜品管理，docs/DISHES_V8115.md 第 5 节）：点一道有做法或加料的菜时弹出来。
//   · 做法：不加钱，选了的写进这道菜的出品备注（「微辣，免葱」），后面还能接手写的备注；
//   · 加料：另外的菜，各算各的钱；加进已点时另起一行，备注写「配 这道菜」；
//   · 套餐：这里只把含的几样写出来（出品单上会列出来），下单还是一行。
//   · 8.1.15 块 B（ZT26）：加料在这个岗位不能下单的出品口（按出品口的三项下单权限）的，标「不能在水吧下单」、不能选。
// 这里只是把这几样拼成点单页原有的「一行一道菜 + 口味备注」，下单的请求与以前一样。

import { useState } from 'react';
import { Ban, Hourglass, Minus, Plus } from 'lucide-react';
import { MAX_DISH_NOTE, type MenuDish } from '@shared/dining';
import { addonNote, composeDishNote, dishNoteFits, partsText } from '@shared/dishes';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { QtyInput } from '../../components/QtyInput';
import { Button, Field, Input } from '../../components/ui';
import { StatusChip } from './DishChips';

export interface PickedLine {
  dishId: number;
  quantity: number;
  note: string;
}

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
  const [methods, setMethods] = useState<string[]>([]);
  const [addons, setAddons] = useState<Record<number, number>>({});
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  useResetOnOpen(
    dish !== null,
    () => {
      setMethods([]);
      setAddons({});
      setQuantity(1);
      setNote('');
      setHint(null);
    },
    [dish?.id],
  );
  if (!dish) return null;

  const left = remainingOf(dish.id);
  const max = Math.min(99, left ?? 99);
  const options = dish.addons ?? [];
  const picked = options.filter((a) => (addons[a.id] ?? 0) > 0 && !blockedOf?.(a.id));
  const total = dish.price * quantity + picked.reduce((s, a) => s + a.price * addons[a.id]!, 0);
  const fits = dishNoteFits(methods, note);
  const setAddon = (id: number, n: number) => setAddons((cur) => ({ ...cur, [id]: Math.max(0, n) }));

  const confirm = () => {
    if (!fits || max < 1) return;
    onAdd([{ dishId: dish.id, quantity, note: composeDishNote(methods, note) }, ...picked.map((a) => ({ dishId: a.id, quantity: addons[a.id]!, note: addonNote(dish.name) }))]);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={dish.name}
      description={
        <>
          <Money cents={dish.price} className="text-[16px] font-bold text-ink-2" />
          <span className="ml-2">{dish.stationName}</span>
        </>
      }
      footer={
        <div className="flex w-full flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1 text-[13px] text-ink-3">
            这次合计 <Money cents={total} className="text-[18px] font-bold text-ink" />
          </span>
          <Button variant="ghost" className="min-h-11" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" className="min-h-11 min-w-[112px]" disabled={!fits || max < 1} onClick={confirm} data-autofocus data-testid="dish-options-add">
            加入已点
          </Button>
        </div>
      }
    >
      <div className="space-y-4" data-testid="dish-options">
        {dish.combo && dish.combo.length > 0 && (
          <p className="rounded-md bg-lake-soft px-3 py-2 text-[13.5px] font-semibold text-lake" data-testid="dish-options-combo">
            套餐含 {partsText(dish.combo)}（下单一行，出品单上会列出来）
          </p>
        )}

        {dish.methods && dish.methods.length > 0 && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink-2">做法（不加钱，可多选）</h3>
            <div className="flex flex-wrap gap-2">
              {dish.methods.map((m) => {
                const on = methods.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setMethods((cur) => (on ? cur.filter((x) => x !== m) : [...cur, m]))}
                    className={cn(
                      'h-11 min-w-11 rounded-full border px-4 text-[14px] font-semibold transition-colors',
                      on ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-pine',
                    )}
                    data-testid={`dish-options-method-${m}`}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {options.length > 0 && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink-2">加料（另算钱，出品单上写「配 {dish.name}」）</h3>
            <ul className="space-y-1.5">
              {options.map((a) => {
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

        <Field
          label="口味备注（选填）"
          htmlFor="dish-options-note"
          error={fits ? null : `做法与备注合起来最多 ${MAX_DISH_NOTE} 个字，现在 ${composeDishNote(methods, note).length} 个：少选一种做法或写短一点`}
        >
          <Input id="dish-options-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={MAX_DISH_NOTE} placeholder="例如 面硬一点" data-testid="dish-options-note" />
        </Field>
        {(methods.length > 0 || note.trim()) && fits && (
          <p className="text-[12.5px] text-ink-3" data-testid="dish-options-preview">
            出品单上写：<b className="text-yuzu-deep">{composeDishNote(methods, note)}</b>
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
