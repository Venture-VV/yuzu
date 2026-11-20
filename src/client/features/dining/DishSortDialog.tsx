// 菜品排序（8.1.17 BW10，docs/DISHES_V8117.md 第 6 节）：选一个点单小类（餐厅 · 餐饮、水吧 · 手作饮料……），把这一类的菜排好先后，
// 点单页的菜单、菜品表都按这个排。拖住左边的把手上下拖；手指不方便拖、用键盘的，点每一行的「上移」「下移」，或在把手上按上下键。
// 这一类里没删除的菜都在（含下架的）；保存时服务端核对还是这一批（别人刚新增、挪走、删除了就请刷新再排）。
// 带操作编号；没收到结果的进「结果待确认」（与菜品维护的其他操作同一套，dishPendingStore.ts）：弹窗里列着那一笔，
// 查回、按原内容重新提交或确认作废之前，这一小类不能再排（晚到的旧排序不会盖掉后来排好的）。

import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { ALL_DINING_SLOTS, slotKey, slotLabel, type DiningOutlet } from '@shared/dining';
import type { DishRow } from '@shared/dishes';
import { ApiError, errorMessage, UncertainError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { Button, Field, Notice, Select } from '../../components/ui';
import { StatusChip } from './DishChips';
import { DishPendingNotice } from './DishPendingNotice';
import { sendDishOp, sortPendingOf, useDishPending } from './dishPendingStore';

/** 一个小类里的菜现在的先后：排过的按排的，没排过的跟在后面、照菜品表的顺序 */
export function slotDishes(dishes: readonly DishRow[], key: string): DishRow[] {
  const list = dishes.filter((d) => !d.deleted && slotKey(d) === key);
  return list
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (a.d.sort ?? Infinity) - (b.d.sort ?? Infinity) || a.i - b.i)
    .map((x) => x.d);
}

export function DishSortDialog({
  open,
  dishes,
  outlets,
  onClose,
  onSaved,
  onRejected,
}: {
  open: boolean;
  dishes: readonly DishRow[];
  /** 这位员工能维护的出品口（只能给这几处排） */
  outlets: DiningOutlet[];
  onClose: () => void;
  onSaved: (label: string) => void;
  onRejected: () => void;
}) {
  const slots = useMemo(() => ALL_DINING_SLOTS.filter((s) => outlets.includes(s.outlet)), [outlets]);
  const firstWithDishes = slots.find((s) => slotDishes(dishes, slotKey(s)).length > 1) ?? slots[0];
  const [slot, setSlot] = useState<string>('');
  const [order, setOrder] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const session = useSession();
  const pending = useDishPending();
  const pick = (key: string) => {
    setSlot(key);
    setOrder(slotDishes(dishes, key).map((d) => d.id));
    setError(null);
  };
  useResetOnOpen(open, () => pick(firstWithDishes ? slotKey(firstWithDishes) : ''));
  const byId = useMemo(() => new Map(dishes.map((d) => [d.id, d])), [dishes]);
  const current = slots.find((s) => slotKey(s) === slot);
  /** 这一小类上一笔排序结果待确认：处理好之前不能再排 */
  const waiting = sortPendingOf(pending, slot);
  const changed =
    order.join(',') !==
    slotDishes(dishes, slot)
      .map((d) => d.id)
      .join(',');

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    setOrder((cur) => {
      const next = [...cur];
      const [id] = next.splice(from, 1);
      next.splice(to, 0, id!);
      return next;
    });
    setError(null);
  };
  /** 拖：按住把手，经过哪一行就挪到哪一行的位置 */
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>, id: number) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(id);
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (dragging === null || !list.current) return;
    const rows = [...list.current.querySelectorAll<HTMLElement>('[data-sort-row]')];
    const over = rows.findIndex((r) => {
      const box = r.getBoundingClientRect();
      return e.clientY >= box.top && e.clientY < box.bottom;
    });
    const from = order.indexOf(dragging);
    if (over >= 0 && over !== from) move(from, over);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      move(index, index + (e.key === 'ArrowUp' ? -1 : 1));
      // 焦点跟着这一道走
      requestAnimationFrame(() => list.current?.querySelectorAll<HTMLButtonElement>('[data-sort-handle]')[index + (e.key === 'ArrowUp' ? -1 : 1)]?.focus());
    }
  };

  const save = async () => {
    if (!current || waiting) return;
    const key = uuid();
    setBusy(true);
    setError(null);
    try {
      await sendDishOp({
        key,
        type: 'sort',
        itemId: null,
        scope: slot,
        method: 'post',
        url: '/api/dining/dishes/sort',
        body: { clientKey: key, slot, ids: order },
        summary: `「${slotLabel(current)}」排序`,
        staffName: session.staff.displayName,
      });
      onSaved(slotLabel(current));
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
      open={open}
      onClose={onClose}
      title="菜品排序"
      description="点单页的菜单按这个先后排：拖住左边的把手上下拖，或点「上移」「下移」（把手上按上下键也行）。"
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" className="min-h-11" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            className="min-h-11 min-w-[112px]"
            loading={busy}
            disabled={!current || order.length < 2 || !changed || !!waiting}
            onClick={() => void save()}
            data-testid="dish-sort-save"
          >
            保存先后
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="dish-sort">
        {waiting && <DishPendingNotice op={waiting} onApplied={() => onSaved(waiting.summary.replace(/^「|」排序$/g, ''))} onAbandoned={onRejected} />}
        <Field label="点单小类" htmlFor="dish-sort-slot" hint="同一个小类里的菜一起排；挪到别的小类的菜排在那一类的最后">
          <Select id="dish-sort-slot" className="min-h-11" value={slot} onChange={(e) => pick(e.target.value)} data-testid="dish-sort-slot">
            {slots.map((s) => (
              <option key={slotKey(s)} value={slotKey(s)}>
                {slotLabel(s)}（{slotDishes(dishes, slotKey(s)).length} 道）
              </option>
            ))}
          </Select>
        </Field>
        {order.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-3">这一类还没有菜</p>
        ) : (
          <ol ref={list} className="space-y-1.5" data-testid="dish-sort-list">
            {order.map((id, i) => {
              const d = byId.get(id);
              if (!d) return null;
              return (
                <li
                  key={id}
                  data-sort-row
                  className={cn('flex min-h-12 items-center gap-2 rounded-lg border bg-card px-2', dragging === id ? 'border-pine shadow-md' : 'border-line')}
                  data-testid={`dish-sort-row-${d.name}`}
                >
                  <button
                    type="button"
                    data-sort-handle
                    aria-label={`拖动或用上下键调整「${d.name}」的位置（现在第 ${i + 1} 个）`}
                    title="按住拖动"
                    onPointerDown={(e) => onPointerDown(e, id)}
                    onPointerMove={onPointerMove}
                    onPointerUp={() => setDragging(null)}
                    onPointerCancel={() => setDragging(null)}
                    onKeyDown={(e) => onKey(e, i)}
                    className="flex size-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 active:cursor-grabbing"
                    data-testid={`dish-sort-handle-${d.name}`}
                  >
                    <GripVertical className="size-5" />
                  </button>
                  <span className="num w-7 shrink-0 text-right text-[13px] text-ink-3">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{d.name}</span>
                  {!d.active && <StatusChip tone="neutral">下架</StatusChip>}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="min-h-11"
                    icon={<ArrowUp className="size-4" />}
                    disabled={i === 0}
                    onClick={() => move(i, i - 1)}
                    aria-label={`上移 ${d.name}`}
                    data-testid={`dish-sort-up-${d.name}`}
                  >
                    上移
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="min-h-11"
                    icon={<ArrowDown className="size-4" />}
                    disabled={i === order.length - 1}
                    onClick={() => move(i, i + 1)}
                    aria-label={`下移 ${d.name}`}
                    data-testid={`dish-sort-down-${d.name}`}
                  >
                    下移
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
        {error && <Notice tone="error" title={error} data-testid="dish-sort-error" />}
      </div>
    </Dialog>
  );
}
