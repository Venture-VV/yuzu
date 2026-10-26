import { forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import type { Material } from '@shared/inventory';
import { formatQty, packText, parseQty, toBaseQty, toPurchaseQty } from '@shared/quantity';
import { cn } from '../../lib/utils';
import { Qty } from './parts';

// ───────────────────────── 物料选择 ─────────────────────────

function matches(m: Material, q: string) {
  if (!q) return true;
  const text = `${m.code} ${m.name} ${m.specification} ${m.category}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => text.includes(part));
}

/**
 * 物料搜索框：输入编码、名称、规格或分类筛选，↑↓ 选择，回车加入。
 * 选中后清空，焦点交给调用方（通常是该行的数量框），便于连续录入多行。
 */
export const MaterialPicker = forwardRef<
  HTMLInputElement,
  {
    materials: Material[];
    onPick: (m: Material) => void;
    /** 已在单据里的物料：灰显并提示 */
    taken?: Set<number>;
    /** 不可选的物料及原因（例如已有流水不能建期初） */
    disabledReason?: (m: Material) => string | null;
    placeholder?: string;
    className?: string;
  }
>(function MaterialPicker({ materials, onPick, taken, disabledReason, placeholder = '搜索物料：编码 / 名称 / 规格', className }, ref) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const listId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const list = useMemo(() => materials.filter((m) => m.tracked && m.active && matches(m, q.trim())).slice(0, 40), [materials, q]);

  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const reasonOf = (m: Material) => (taken?.has(m.id) ? '已在单据中' : (disabledReason?.(m) ?? null));
  const pick = (m: Material | undefined) => {
    if (!m || reasonOf(m)) return;
    onPick(m);
    setQ('');
    setOpen(false);
  };

  return (
    <div ref={wrap} className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
      <input
        ref={ref}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setCursor((c) => Math.min(c + 1, list.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (open) pick(list[cursor]);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="添加物料"
        placeholder={placeholder}
        className="h-11 w-full rounded-md border border-dashed border-line-strong bg-card pr-3 pl-9 text-[14px] outline-none transition-colors placeholder:text-ink-4 hover:border-ink-4 focus:border-solid focus:border-pine focus:shadow-[0_0_0_3px_rgb(36_73_58/0.12)]"
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="scroll-thin absolute top-[calc(100%+6px)] right-0 left-0 z-30 max-h-[320px] animate-rise overflow-y-auto rounded-lg border border-line bg-card p-1.5 shadow-pop"
        >
          {list.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-ink-3">没有匹配的受管物料</li>}
          {list.map((m, i) => {
            const reason = reasonOf(m);
            return (
              <li
                key={m.id}
                role="option"
                aria-selected={i === cursor}
                aria-disabled={!!reason}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(m)}
                onPointerMove={() => setCursor(i)}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2',
                  i === cursor && !reason && 'bg-pine-tint',
                  reason && 'cursor-not-allowed opacity-55',
                )}
              >
                <span className="num w-12 shrink-0 text-[12px] font-semibold text-ink-3">{m.code}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold">{m.name}</span>
                  <span className="block truncate text-[12px] text-ink-3">{m.specification || m.category || '—'}</span>
                </span>
                {reason ? (
                  <span className="shrink-0 text-[12px] text-ink-3">{reason}</span>
                ) : (
                  <span className="shrink-0 text-right">
                    <Qty milli={m.stockMilli} unit={m.inventoryUnit} className={cn('text-[13px] font-bold', m.isLow && 'text-clay')} />
                    {m.isLow && <span className="block text-[11px] font-semibold text-clay">低于提醒</span>}
                  </span>
                )}
                {!reason && i === cursor && <Plus className="size-4 shrink-0 text-pine" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

// ───────────────────────── 数量输入（库存单位 / 采购单位） ─────────────────────────

export interface QtyEntry {
  text: string;
  /** base = 库存单位；pack = 采购单位 */
  unit: 'base' | 'pack';
}

export const emptyQty = (unit: QtyEntry['unit'] = 'base'): QtyEntry => ({ text: '', unit });

export function qtyEntryFromMilli(milli: number | null, m: Pick<Material, 'purchaseFactorMilli'>, unit: QtyEntry['unit'] = 'base'): QtyEntry {
  if (milli === null) return emptyQty(unit);
  if (unit === 'pack') {
    const packs = toPurchaseQty(milli, m.purchaseFactorMilli);
    if (packs !== null) return { text: formatQty(packs).replace(/,/g, ''), unit: 'pack' };
  }
  return { text: formatQty(milli).replace(/,/g, ''), unit: 'base' };
}

type UnitInfo = Pick<Material, 'inventoryUnit' | 'purchaseUnit' | 'purchaseFactorMilli' | 'decimals'>;

export const hasPack = (m: UnitInfo) => m.purchaseUnit !== m.inventoryUnit && m.purchaseFactorMilli !== 1000;

/** 录入值 → 库存单位 milli；返回 error 说明为什么不能用 */
export function resolveQty(entry: QtyEntry, m: UnitInfo): { milli: number | null; entered: number | null; error: string | null } {
  if (!entry.text.trim()) return { milli: null, entered: null, error: null };
  if (entry.unit === 'pack' && hasPack(m)) {
    const packs = parseQty(entry.text, 3);
    if (packs === null) return { milli: null, entered: null, error: '数量格式不正确' };
    const base = toBaseQty(packs, m.purchaseFactorMilli);
    if (base === null || base % 10 ** (3 - m.decimals) !== 0) {
      return { milli: null, entered: null, error: `换算后不是整${m.inventoryUnit}，请改按${m.inventoryUnit}录入` };
    }
    return { milli: base, entered: packs, error: null };
  }
  const milli = parseQty(entry.text, m.decimals);
  if (milli === null) {
    return { milli: null, entered: null, error: m.decimals === 0 ? `请填写整数${m.inventoryUnit}` : `最多 ${m.decimals} 位小数` };
  }
  return { milli, entered: milli, error: null };
}

export function QtyInput({
  value,
  onChange,
  material,
  label,
  invalid,
  inputRef,
  allowPack = true,
  className,
  autoFocus,
}: {
  value: QtyEntry;
  onChange: (v: QtyEntry) => void;
  material: UnitInfo;
  label: string;
  invalid?: boolean;
  inputRef?: (el: HTMLInputElement | null) => void;
  allowPack?: boolean;
  className?: string;
  autoFocus?: boolean;
}) {
  const pack = allowPack && hasPack(material);
  const r = resolveQty(value, material);
  const unitLabel = value.unit === 'pack' && pack ? material.purchaseUnit : material.inventoryUnit;
  return (
    <div className={cn('min-w-0', className)}>
      <div
        className={cn(
          'flex h-10 items-stretch overflow-hidden rounded-md border bg-card transition-[border-color,box-shadow] focus-within:border-pine focus-within:shadow-[0_0_0_3px_rgb(36_73_58/0.12)]',
          invalid || r.error ? 'border-clay' : 'border-line-strong hover:border-ink-4',
        )}
      >
        <input
          ref={inputRef}
          value={value.text}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
          inputMode="decimal"
          autoComplete="off"
          aria-label={`${label}（${unitLabel}）`}
          aria-invalid={invalid || !!r.error || undefined}
          autoFocus={autoFocus}
          className="num w-full min-w-0 bg-transparent px-3 text-right text-[15px] font-bold outline-none"
        />
        {pack ? (
          <div role="radiogroup" aria-label={`${label}单位`} className="flex shrink-0 items-center gap-0.5 border-l border-line bg-paper-2/70 p-0.5">
            {(['base', 'pack'] as const).map((u) => (
              <button
                key={u}
                type="button"
                role="radio"
                aria-checked={value.unit === u}
                onClick={() => {
                  if (value.unit === u) return;
                  // 切换单位时按新单位理解所填数字（2 → 2 箱），下方的「= 200 双」提示随之变化，一眼可辨
                  onChange({ ...value, unit: u });
                }}
                className={cn(
                  'h-full min-w-8 rounded-[6px] px-1.5 text-[12.5px] font-bold transition-colors',
                  value.unit === u ? 'bg-card text-ink shadow-[0_1px_2px_rgb(28_35_31/0.12)]' : 'text-ink-3 hover:text-ink',
                )}
              >
                {u === 'base' ? material.inventoryUnit : material.purchaseUnit}
              </button>
            ))}
          </div>
        ) : (
          <span className="flex shrink-0 items-center border-l border-line bg-paper-2/70 px-2.5 text-[12.5px] font-bold text-ink-2">{material.inventoryUnit}</span>
        )}
      </div>
      <p className={cn('mt-1 h-4 truncate text-right text-[11.5px]', r.error ? 'font-semibold text-clay' : 'text-ink-3')}>
        {r.error
          ? r.error
          : r.milli !== null && value.unit === 'pack' && pack
            ? `= ${formatQty(r.milli)} ${material.inventoryUnit}`
            : r.milli !== null && pack
              ? (() => {
                  const t = packText(r.milli, material.purchaseFactorMilli, material.purchaseUnit, material.inventoryUnit);
                  return t ? `= ${t}` : '';
                })()
              : ''}
      </p>
    </div>
  );
}
