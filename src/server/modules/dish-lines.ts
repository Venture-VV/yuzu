// 8.1.17 点单一行的做法与加料（docs/DISHES_V8117.md 第 3、4 节）。点单页、桌台点单、平板电子菜单、前台「加项目」、小程序扫码点餐
// 下单都经过这里（frontdesk/bills.ts 的 postChargesTx、tables.ts 的 postTableCharges），核对的规矩只有这一份：
//   · 做法（BW6）：按这道菜现在的做法核对——不认识的、重复的、同一组选了两个、必选的组没选（strict：点单页、桌台、平板；
//     前台「加项目」与小程序扫码点餐还选不了做法，不查必选）；加价按份加在这一行的单价上，出品单（账单上也看得到）写「微辣 +¥2」；
//   · 加料（BW8）：addonOf 是同一次下单里主菜那一行的下标（主菜写在前面），要是主菜现在配的加料；出品单写「配 主菜」，
//     账单明细记 addon_of（退主菜时问要不要一起退）；
//   · 规格（档，BW5）：priceLine 按选的档计价（服务端本来就按档计价、核对这道菜有没有这一档），这里不管。
// 价格以服务端为准：这里算出来的加价加进单价，页面带来的合计对不上照旧拒绝（PRICE_CHANGED）。
// 都只读、不加锁（与读价目、做法、加料一样，docs/LOCKING.md 第 1 节「菜品管理」）。

import { z } from 'zod';
import { composeLineNote, MAX_DISH_METHODS, MAX_KITCHEN_NOTE, methodChoiceProblem, methodsExtra, pickedMethods } from '@shared/dishes';
import type { Db } from '../db';
import { badRequest, unprocessable } from '../lib/errors';
import { dishOptionsOf, type DishOptionSet } from './dish-options';

/** 请求里一行带的做法与加料（不带时与升级前的请求完全相同，幂等摘要不变） */
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
};

export interface DishLineInput {
  itemId: number;
  methods?: string[];
  addonOf?: number;
  note?: string;
}

export interface DishLinePlan {
  /** 按份加在单价上的钱（做法加价） */
  extra: number;
  /** 出品单的口味备注（账单上也看得到）：「配 主菜」、做法、手写的；什么都没选的照旧是手写的备注 */
  note: string;
  /** 加料：同一次下单里主菜那一行的下标 */
  addonOf: number | null;
}

/**
 * 核对一次下单的做法、加料并算出每一行的加价与备注。isDish：这一行是不是进厨房的菜（不进厨房的不能带做法、加料）；
 * nameOf：项目名（提示与「配 主菜」用）；strict：查必选的组（点单页、桌台、平板）
 */
export async function planDishLines(
  db: Db,
  lines: readonly DishLineInput[],
  opts: { strict: boolean; isDish: (index: number) => boolean; nameOf: (itemId: number) => string },
): Promise<DishLinePlan[]> {
  // 什么都没选、又不查必选的（前台加项目、小程序扫码点餐的老样子）不用读
  const need = opts.strict || lines.some((l) => l.methods || l.addonOf !== undefined);
  const options = need
    ? await dishOptionsOf(
        db,
        lines.filter((_l, i) => opts.isDish(i)).map((l) => l.itemId),
      )
    : new Map<number, DishOptionSet>();
  return lines.map((l, i) => {
    const name = opts.nameOf(l.itemId);
    if (!opts.isDish(i)) {
      if (l.methods || l.addonOf !== undefined) throw unprocessable('DISH_OPTIONS_NOT_ALLOWED', `「${name}」不进厨房，没有做法、加料`);
      return { extra: 0, note: l.note ?? '', addonOf: null };
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
    const picked = pickedMethods(own?.methods ?? [], chosen);
    const note = composeLineNote({ addonOf: mainName, methods: picked, note: l.note });
    if (note.length > MAX_KITCHEN_NOTE) throw unprocessable('DISH_NOTE_TOO_LONG', `「${name}」的做法与备注合起来超过 ${MAX_KITCHEN_NOTE} 个字，请少选几样或写短一点`);
    return { extra: methodsExtra(own?.methods ?? [], chosen), note, addonOf: l.addonOf ?? null };
  });
}
