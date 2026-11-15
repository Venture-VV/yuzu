// 平板电子菜单的卡片模板（8.1.2，GZ13）：11 种版式里每一块在哪，照 @shared/studio 的 EMENU_TEMPLATES（设计稿量的数），
// 再叠上版面里设计师改过的（templates[版式][块]）；菜的几种状态（售罄、当前时段不可售、已下架）的样子照版面里的 dishStates（变体）。
// 平板、编辑器、后台的版面预览都从这里取，没给改动时与以前一模一样。

import { createContext, useContext, type ReactNode } from 'react';
import type { EmenuBlock, EmenuLayout } from '@shared/emenu';
import { colorValue, dishStateStyle, EMENU_SURFACE, EMENU_TEMPLATES, resolveSlot, slotSpot, type ResolvedSlot, type StudioColor, type StudioDishStateStyle, type StudioDoc } from '@shared/studio';
import { useBig } from './stage';

interface Cards {
  templates: StudioDoc['templates'] | null;
  dishStates: StudioDoc['dishStates'] | null;
}
const CardsCtx = createContext<Cards>({ templates: null, dishStates: null });

/** 版面里的卡片模板改动与菜的几种样子（平板用的那一份版面、编辑器里的草稿）；不给就照设计稿 */
export function EmenuTemplatesProvider({
  templates,
  dishStates,
  children,
}: {
  templates: StudioDoc['templates'] | null | undefined;
  dishStates?: StudioDoc['dishStates'] | null;
  children: ReactNode;
}) {
  return <CardsCtx.Provider value={{ templates: templates ?? null, dishStates: dishStates ?? null }}>{children}</CardsCtx.Provider>;
}

/** 一种版式里的各块：slot('a.photo') */
export function useSlots(layout: EmenuLayout): (key: string) => ResolvedSlot {
  const all = useContext(CardsCtx).templates;
  const defs = EMENU_TEMPLATES[layout].slots;
  return (key) => {
    const def = defs.find((s) => s.key === key);
    if (!def) throw new Error(`版式 ${layout} 没有 ${key}`);
    return resolveSlot(def, all?.[layout]?.[key]);
  };
}

/** 照片、小标题、文字陈列的一行这类「整块挪」的：当前这一档（原样 / 放大）在哪 */
export function useSlotPos(): (s: ResolvedSlot) => { x: number; y: number; w: number; h: number } {
  const large = useBig();
  return (s) => slotSpot(s, large ? 'big' : 'design');
}

/** 一道菜这种状态（售罄……）的样子；能点的菜（block 为空）给设计稿的样子，不用 */
export function useDishState(block: EmenuBlock | null): Required<StudioDishStateStyle> {
  const states = useContext(CardsCtx).dishStates;
  return dishStateStyle(states, block ?? 'sold_out');
}

/** 压暗的那一层：#RRGGBB 换成 rgb(r g b / 透明度)（设计稿的样子正好是 rgb(0 0 0 / 0.55)），主题色用 color-mix */
export function shadeCss(color: StudioColor, opacity: number): string {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})?$/.exec(color);
  if (m) {
    const a = Math.round(opacity * (m[4] ? parseInt(m[4], 16) / 255 : 1) * 1000) / 1000;
    return `rgb(${parseInt(m[1]!, 16)} ${parseInt(m[2]!, 16)} ${parseInt(m[3]!, 16)} / ${a})`;
  }
  return `color-mix(in srgb, ${colorValue(color, EMENU_SURFACE.cssVar)} ${Math.round(opacity * 1000) / 10}%, transparent)`;
}

/** 字的颜色（#RRGGBB 或主题色） */
export const inkCss = (color: StudioColor): string => colorValue(color, EMENU_SURFACE.cssVar) ?? '#F4F3F2';

export type { ResolvedSlot };
