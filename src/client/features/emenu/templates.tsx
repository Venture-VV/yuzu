// 平板电子菜单的卡片模板（8.1.2，GZ13）：11 种版式里每一块在哪，照 @shared/studio 的 EMENU_TEMPLATES（设计稿量的数），
// 再叠上版面里设计师改过的（templates[版式][块]）。平板、编辑器、后台的版面预览都从这里取，没给改动时与以前一模一样。

import { createContext, useContext, type ReactNode } from 'react';
import type { EmenuLayout } from '@shared/emenu';
import { EMENU_TEMPLATES, resolveSlot, slotSpot, type ResolvedSlot, type StudioDoc } from '@shared/studio';
import { useBig } from './stage';

type Templates = NonNullable<StudioDoc['templates']>;
const TemplatesCtx = createContext<Templates | null>(null);

/** 版面里的卡片模板改动（平板用的那一份版面、编辑器里的草稿）；不给就照设计稿 */
export function EmenuTemplatesProvider({ value, children }: { value: Templates | null | undefined; children: ReactNode }) {
  return <TemplatesCtx.Provider value={value ?? null}>{children}</TemplatesCtx.Provider>;
}

/** 一种版式里的各块：slot('a.photo') */
export function useSlots(layout: EmenuLayout): (key: string) => ResolvedSlot {
  const all = useContext(TemplatesCtx);
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

export type { ResolvedSlot };
