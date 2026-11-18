// 8.1.7 点单分类（餐厅 / 水吧 / 果吧，docs/DINING_V817.md）的小部件：
//   · OutletEntry：点单页菜单区先弹出的三个大入口（二级菜单）；
//   · OutletFilter：全部 / 餐厅 / 水吧 / 果吧（点单页换一处、沽清列表、台账、退菜记录）；
//   · GroupChips：这一处的小分类（果吧不分小类，不显示）；
//   · SlotBadge：「餐厅 · 酒水」「果吧」。

import type { ReactNode } from 'react';
import { ChefHat, Citrus, CupSoda } from 'lucide-react';
import { DINING_OUTLETS, outletDef, slotLabel, type DiningOutlet, type DiningSlot, type MenuDish } from '@shared/dining';
import { Stagger } from '../../lib/motion';
import { cn } from '../../lib/utils';

export const OUTLET_ICONS: Record<DiningOutlet, ReactNode> = {
  restaurant: <ChefHat className="size-5" />,
  water: <CupSoda className="size-5" />,
  fruit: <Citrus className="size-5" />,
};

/** 三处各自的颜色（入口卡片、分类小标签） */
export const OUTLET_TONE: Record<DiningOutlet, { tile: string; icon: string; badge: string }> = {
  restaurant: { tile: 'hover:border-pine', icon: 'bg-pine-tint text-pine', badge: 'bg-pine-tint text-pine' },
  water: { tile: 'hover:border-lake', icon: 'bg-lake-soft text-lake', badge: 'bg-lake-soft text-lake' },
  fruit: { tile: 'hover:border-yuzu-deep', icon: 'bg-yuzu-tint text-yuzu-deep', badge: 'bg-yuzu-tint text-yuzu-deep' },
};

/**
 * 点单页的二级菜单（CF4）：餐厅、水吧、果吧三个大入口，各写着小分类与有几道菜（估清的另标）；
 * 菜单区一进来、每次下单成功以后都先弹出这里，选了进对应的点单页
 */
export function OutletEntry({ dishes, onPick, disabled }: { dishes: MenuDish[]; onPick: (o: DiningOutlet) => void; disabled?: boolean }) {
  return (
    <div className="mt-3 animate-dialog-in" data-testid="dining-outlets">
      <p className="text-[13px] font-semibold text-ink-2">这一单点哪里的？</p>
      <Stagger className="mt-2.5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {DINING_OUTLETS.map((o) => {
          const list = dishes.filter((d) => d.outlet === o.key);
          const out = list.filter((d) => d.remaining === 0).length;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => onPick(o.key)}
              disabled={disabled}
              className={cn(
                // 手持点单机（商米 V3，窄屏）上一处一行：图标、名称与小分类、几道菜；平板、收银机上是一张卡片
                'mo-lift grid min-h-[68px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl border border-line bg-card px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                'sm:flex sm:min-h-[136px] sm:flex-col sm:items-start sm:gap-0 sm:py-3.5',
                OUTLET_TONE[o.key].tile,
              )}
              data-testid={`dining-outlet-${o.key}`}
            >
              <span className={cn('flex size-10 items-center justify-center rounded-full', OUTLET_TONE[o.key].icon)}>{OUTLET_ICONS[o.key]}</span>
              <span className="min-w-0 sm:mt-2">
                <span className="block text-[19px] leading-tight font-bold sm:text-[20px]">{o.label}</span>
                <span className="mt-0.5 block truncate text-[12.5px] text-ink-3">{o.groups.length ? o.groups.join(' · ') : '不再细分'}</span>
              </span>
              <span className="text-right text-[12.5px] font-semibold text-ink-2 sm:mt-auto sm:pt-2 sm:text-left">
                <span className="num">{list.length}</span> 道菜
                {out > 0 && <span className="block text-clay sm:ml-1.5 sm:inline">估清 {out}</span>}
              </span>
            </button>
          );
        })}
      </Stagger>
    </div>
  );
}

/** 全部 / 餐厅 / 水吧 / 果吧（withAll 为假时只有三处，点单页换一处用） */
export function OutletFilter({
  value,
  onChange,
  counts,
  testPrefix,
  withAll = true,
  size = 'md',
}: {
  value: DiningOutlet | null;
  onChange: (v: DiningOutlet | null) => void;
  counts?: Partial<Record<DiningOutlet | 'all', number>>;
  testPrefix: string;
  withAll?: boolean;
  size?: 'sm' | 'md';
}) {
  const options: { key: DiningOutlet | null; label: string }[] = [...(withAll ? [{ key: null, label: '全部' }] : []), ...DINING_OUTLETS.map((o) => ({ key: o.key, label: o.label }))];
  return (
    <div className="grid w-full auto-cols-fr grid-flow-col items-center gap-1 rounded-lg bg-paper-2 p-1 sm:inline-flex sm:w-auto sm:flex-nowrap" role="tablist" aria-label="点单分类">
      {options.map((o) => {
        const on = value === o.key;
        const n = counts?.[o.key ?? 'all'];
        return (
          <button
            key={o.key ?? 'all'}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.key)}
            className={cn(
              'flex min-w-0 items-center justify-center gap-1 rounded-md font-semibold whitespace-nowrap transition-colors',
              size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-8 px-3 text-[13.5px]',
              on ? 'bg-card text-ink shadow-sm' : 'text-ink-3 hover:text-ink',
            )}
            data-testid={`${testPrefix}-outlet-${o.key ?? 'all'}`}
          >
            {o.key && <span className={cn('hidden size-5 shrink-0 items-center justify-center rounded-full min-[400px]:flex [&>svg]:size-3', OUTLET_TONE[o.key].icon)}>{OUTLET_ICONS[o.key]}</span>}
            {o.label}
            {n !== undefined && <span className="num text-[11.5px] font-normal text-ink-4">{n}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 一处的小分类：value 为选中的（空为全部）。multiple 为真时可以多选（台账、退菜记录），否则单选（点单页、沽清列表）。
 * 果吧没有小分类，什么都不显示
 */
export function GroupChips({
  outlet,
  value,
  onChange,
  multiple = false,
  testPrefix,
  counts,
  allLabel = '全部',
}: {
  outlet: DiningOutlet;
  value: string[];
  onChange: (v: string[]) => void;
  multiple?: boolean;
  testPrefix: string;
  counts?: Record<string, number>;
  /** 「全部」那一个的字（台账、退菜记录里写「不限小类」，免得与上面那排的「全部」混） */
  allLabel?: string;
}) {
  const groups = outletDef(outlet).groups;
  if (groups.length === 0) return null;
  const chip = (on: boolean) =>
    cn('h-8 shrink-0 rounded-full px-3.5 text-[13px] font-semibold whitespace-nowrap transition-colors', on ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-2 hover:text-ink');
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="小分类">
      <button type="button" aria-pressed={value.length === 0} onClick={() => onChange([])} className={chip(value.length === 0)} data-testid={`${testPrefix}-group-all`}>
        {allLabel}
      </button>
      {groups.map((g) => {
        const on = value.includes(g);
        return (
          <button
            key={g}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(multiple ? (on ? value.filter((x) => x !== g) : [...value, g]) : on ? [] : [g])}
            className={chip(on)}
            data-testid={`${testPrefix}-group-${g}`}
          >
            {g}
            {counts?.[g] !== undefined && <span className="num ml-1 text-[11.5px] opacity-70">{counts[g]}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** 「餐厅 · 酒水」「果吧」 */
export function SlotBadge({ slot, className }: { slot: DiningSlot; className?: string }) {
  return <span className={cn('inline-flex h-5 items-center rounded px-1.5 text-[11.5px] font-semibold whitespace-nowrap', OUTLET_TONE[slot.outlet].badge, className)}>{slotLabel(slot)}</span>;
}
