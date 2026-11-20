// 8.1.17 点单一行的做法、加料、换菜（docs/DISHES_V8117.md 第 2、4、7 节）。点单页、桌台点单、平板电子菜单、前台「加项目」、小程序扫码点餐
// 下单都经过这里（frontdesk/bills.ts 的 postChargesTx、tables.ts 的 postTableCharges），核对的规矩只有这一份：
//   · 做法（BW6）：按这道菜现在的做法核对——不认识的、重复的、同一组选了两个、必选的组没选（strict：点单页、桌台、平板；
//     前台「加项目」与小程序扫码点餐还选不了做法，不查必选）；加价按份加在这一行的单价上，出品单（账单上也看得到）写「微辣 +¥2」；
//   · 加料（BW8）：addonOf 是同一次下单里主菜那一行的下标（主菜写在前面），要是主菜现在配的加料；出品单写「配 主菜」，
//     账单明细记 addon_of（退主菜时问要不要一起退）；
//   · 套餐（BW7）：给出这一份套餐现在含的几样（各自的档口，用来拆子项单、扣子项的沽清与用料）；可换的子项按 swaps 换成选的那一样，
//     要是维护时设好的、现在能点的，差价按份加在这一行的单价上，出品单写「可乐换橙汁 +¥3」；
//   · 规格（档，BW5）：priceLine 按选的档计价（服务端本来就按档计价、核对这道菜有没有这一档），这里不管。
// 价格以服务端为准：这里算出来的加价加进单价，页面带来的合计对不上照旧拒绝（PRICE_CHANGED）。
// 都只读、不加锁（与读价目、做法、加料一样，docs/LOCKING.md 第 1 节「菜品管理」）。

import { z } from 'zod';
import { composeLineNote, MAX_COMBO_SWAPS, MAX_DISH_METHODS, MAX_KITCHEN_NOTE, methodChoiceProblem, methodsExtra, pickedMethods, swapText, type DishSwapChoice } from '@shared/dishes';
import type { Db } from '../db';
import { badRequest, unprocessable } from '../lib/errors';
import { comboDefsOf, dishOptionsOf, type ComboDef, type DishOptionSet } from './dish-options';

/** 请求里一行带的做法、加料、换菜（不带时与升级前的请求完全相同，幂等摘要不变） */
export const DishLineFields = {
  /** 选的做法（名字）；空的当没带 */
  methods: z
    .array(z.string().trim().min(1).max(16), '做法不对，请刷新后重新选')
    .max(MAX_DISH_METHODS, '做法选得太多了')
    .nullish()
    .transform((v) => (v && v.length ? v : undefined))
    .optional(),
  /** 加料：同一次下单里主菜那一行的下标（从 0 起） */
  addonOf: z
    .number('加料的主菜不对，请刷新后重新点')
    .int()
    .min(0)
    .max(99)
    .nullish()
    .transform((v) => v ?? undefined)
    .optional(),
  /** 套餐换菜：套餐里的哪一样（价目项目）换成哪一样；空的当没带 */
  swaps: z
    .array(z.object({ from: z.number().int().positive(), to: z.number().int().positive() }), '换菜不对，请刷新后重新选')
    .max(MAX_COMBO_SWAPS, '换的菜太多了')
    .nullish()
    .transform((v) => (v && v.length ? v : undefined))
    .optional(),
};

export interface DishLineInput {
  itemId: number;
  methods?: string[];
  addonOf?: number;
  swaps?: DishSwapChoice[];
  note?: string;
}

/** 这一份套餐里的一样（下单当时；换过的是换成的那一样） */
export interface ComboPartPlan {
  itemId: number;
  name: string;
  /** 每份套餐几份 */
  perCombo: number;
  /** 这一样自己的档口（停用了、没挂的为 null：跟着套餐的档口出） */
  stationId: number | null;
  /** 换过的：原来是哪一样（菜名） */
  swappedFrom: string | null;
}

export interface DishLinePlan {
  /** 按份加在单价上的钱（做法加价 + 换菜差价） */
  extra: number;
  /** 出品单的口味备注（账单上也看得到）：「配 主菜」、做法、换菜、手写的；什么都没选的照旧是手写的备注 */
  note: string;
  /** 加料：同一次下单里主菜那一行的下标 */
  addonOf: number | null;
  /** 套餐：这一份含的几样（不是套餐为 null） */
  parts: ComboPartPlan[] | null;
}

/** 核对换菜，给出这一份套餐的几样、差价与写在备注里的字 */
function planCombo(name: string, defs: ComboDef[], swaps: DishSwapChoice[]): { parts: ComboPartPlan[]; extra: number; texts: string[] } {
  if (new Set(swaps.map((s) => s.from)).size !== swaps.length) throw unprocessable('DISH_SWAP_INVALID', `「${name}」同一样换了两次，请重新选`);
  const stray = swaps.find((s) => !defs.some((d) => d.itemId === s.from));
  if (stray) throw unprocessable('DISH_SWAP_INVALID', `「${name}」里现在没有要换的那一样了，请刷新后重新选`);
  let extra = 0;
  const texts: string[] = [];
  const parts = defs.map((d): ComboPartPlan => {
    const choice = swaps.find((s) => s.from === d.itemId);
    if (!choice) return { itemId: d.itemId, name: d.name, perCombo: d.quantity, stationId: d.stationId, swappedFrom: null };
    const to = d.swappable ? d.swaps.find((w) => w.itemId === choice.to) : undefined;
    if (!to) throw unprocessable('DISH_SWAP_INVALID', `「${name}」里的「${d.name}」现在不能这样换了，请刷新后重新选`);
    if (!to.available) throw unprocessable('DISH_SWAP_INVALID', `「${to.name}」现在点不了（下架或档口停用），「${name}」请换别的`);
    extra += to.priceDiff;
    texts.push(swapText(d.name, to.name, to.priceDiff));
    return { itemId: to.itemId, name: to.name, perCombo: d.quantity, stationId: to.stationId, swappedFrom: d.name };
  });
  return { parts, extra, texts };
}

/**
 * 核对一次下单的做法、加料、换菜并算出每一行的加价、备注与套餐的几样。isDish：这一行是不是进厨房的菜（不进厨房的不能带这些）；
 * nameOf：项目名（提示与「配 主菜」用）；strict：查必选的组（点单页、桌台、平板）
 */
export async function planDishLines(
  db: Db,
  lines: readonly DishLineInput[],
  opts: { strict: boolean; isDish: (index: number) => boolean; nameOf: (itemId: number) => string },
): Promise<DishLinePlan[]> {
  const dishIds = lines.filter((_l, i) => opts.isDish(i)).map((l) => l.itemId);
  // 什么都没选、又不查必选的（前台加项目、小程序扫码点餐的老样子）不用读做法
  const need = opts.strict || lines.some((l) => l.methods || l.addonOf !== undefined);
  const options = need ? await dishOptionsOf(db, dishIds) : new Map<number, DishOptionSet>();
  // 套餐的几样（各自的档口、可换成的）：哪一处下单都要（拆子项单、扣子项的沽清）
  const combos = await comboDefsOf(db, dishIds);
  return lines.map((l, i) => {
    const name = opts.nameOf(l.itemId);
    if (!opts.isDish(i)) {
      if (l.methods || l.addonOf !== undefined || l.swaps) throw unprocessable('DISH_OPTIONS_NOT_ALLOWED', `「${name}」不进厨房，没有做法、加料、换菜`);
      return { extra: 0, note: l.note ?? '', addonOf: null, parts: null };
    }
    const own = options.get(l.itemId);
    const chosen = l.methods ?? [];
    const problem = methodChoiceProblem(name, own?.methods ?? [], own?.groups ?? [], chosen, { requireAll: opts.strict });
    if (problem) throw unprocessable(problem.code, problem.message, { itemId: l.itemId, ...(problem.group ? { group: problem.group } : {}) });
    let mainName: string | null = null;
    if (l.addonOf !== undefined) {
      const j = l.addonOf;
      const main = lines[j];
      if (!main || j >= i) throw badRequest('加料要跟在它的主菜后面，请刷新后重新点');
      if (main.addonOf !== undefined) throw unprocessable('DISH_ADDON_INVALID', `「${name}」不能配在加料「${opts.nameOf(main.itemId)}」上`);
      mainName = opts.nameOf(main.itemId);
      if (!opts.isDish(j) || !options.get(main.itemId)?.addons.some((a) => a.id === l.itemId)) {
        throw unprocessable('DISH_ADDON_INVALID', `「${name}」现在不是「${mainName}」的加料了，请刷新后重新点`, { itemId: l.itemId });
      }
    }
    const defs = combos.get(l.itemId);
    if (l.swaps && !defs) throw unprocessable('DISH_SWAP_INVALID', `「${name}」不是套餐，不能换菜`);
    const combo = defs ? planCombo(name, defs, l.swaps ?? []) : null;
    const picked = pickedMethods(own?.methods ?? [], chosen);
    const note = composeLineNote({ addonOf: mainName, methods: picked, swaps: combo?.texts, note: l.note });
    if (note.length > MAX_KITCHEN_NOTE) throw unprocessable('DISH_NOTE_TOO_LONG', `「${name}」的做法与备注合起来超过 ${MAX_KITCHEN_NOTE} 个字，请少选几样或写短一点`);
    return { extra: methodsExtra(own?.methods ?? [], chosen) + (combo?.extra ?? 0), note, addonOf: l.addonOf ?? null, parts: combo?.parts ?? null };
  });
}

/**
 * 一次下单要扣的沽清（交给 takeDishLimits，按项目 id 升序一起锁）：每一道菜自己的，加上套餐每一样子项的（8.1.17 BW7：
 * 这一行的份数 × 每份几份，换过的扣换成的那一样）
 */
export const limitLinesOf = (lines: readonly { itemId: number; name: string; quantity: number; parts: readonly ComboPartPlan[] | null }[]) =>
  lines.flatMap((l) => [
    { itemId: l.itemId, name: l.name, quantity: l.quantity },
    ...(l.parts ?? []).map((p) => ({ itemId: p.itemId, name: p.name, quantity: l.quantity * p.perCombo, within: l.name })),
  ]);

/** 建出品单时套餐的几样（扣过沽清的记下来，退菜时加回） */
export const kitchenPartsOf = (parts: readonly ComboPartPlan[] | null, limited: ReadonlySet<number>) => (parts ? { parts: parts.map((p) => ({ ...p, limitTaken: limited.has(p.itemId) })) } : {});
