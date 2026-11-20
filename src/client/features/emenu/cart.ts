// 平板「未下单」的几行怎么排（从 EmenuPage 抽出来，8.1.17 BW9 起多了做法与加料）：
//   · 主菜一行：价 = 规格的价 + 选的做法的加价（价格以门店系统为准，对不上门店系统会拒绝、重新确认），菜名下面写选的做法；
//   · 加料一行：挂在主菜那一行上，价、能不能点照主菜那个规格带的加料，菜名下面写「配 主菜」；主菜不在了、加料不再配它了的当已不在菜单上；
//   · 同一道菜同一个规格同样的做法合成一行，做法不同的另起一行；加料各一行、按主菜分开。

import { methodsExtra, methodText, pickedMethods } from '@shared/dishes';
import type { EmenuBlock, EmenuDishView, EmenuSpecView } from '@shared/emenu';
import { blockLabel, dishNames, dishTagline, specLabel, type Lang, type Messages } from './i18n';
import type { PickedOptions } from './options';
import type { CartRow } from './overlays';
import { cartKey, type CartLine } from './store';

/** 「未下单」一行要知道的：哪道菜、哪个规格、现在能不能点（收起来的分类里的菜只给菜名与规格） */
export interface CartHit {
  dish: Pick<EmenuDishView, 'name' | 'nameEn' | 'tagline' | 'taglineEn'>;
  spec: Pick<EmenuSpecView, 'label' | 'labelEn' | 'price' | 'state' | 'remaining' | 'options'>;
  open: boolean;
}

export function cartRows(cart: CartLine[], hitOf: (itemId: number) => CartHit | undefined, lang: Lang, m: Messages): CartRow[] {
  return cart.map((l) => {
    const key = cartKey(l);
    const gone: CartRow = { ...l, key, names: { main: m.goneDish, sub: '', mainEn: lang === 'en' }, tagline: { text: '', en: false }, label: '', price: 0, problem: m.goneProblem };
    const why = (block: EmenuBlock) => m.blockedProblem(blockLabel(block, lang).main);
    if (l.addonOf) {
      const main = cart.find((x) => cartKey(x) === l.addonOf);
      const mainHit = main ? hitOf(main.itemId) : undefined;
      const addon = mainHit?.spec.options?.addons.find((a) => a.itemId === l.itemId);
      if (!main || !mainHit || !addon) return gone;
      const problem =
        addon.state !== 'ok'
          ? why(addon.state === 'sold_out' ? 'sold_out' : addon.state === 'unavailable' ? 'unavailable' : 'off')
          : addon.remaining !== null && l.quantity > addon.remaining
            ? m.leftProblem(addon.remaining)
            : null;
      return {
        ...l,
        key,
        names: { main: addon.name, sub: '', mainEn: false },
        tagline: { text: '', en: false },
        label: '',
        price: addon.price,
        problem,
        detail: m.addonOfLine(dishNames(mainHit.dish, lang).main),
      };
    }
    const hit = hitOf(l.itemId);
    if (!hit) return gone;
    const { dish, spec, open } = hit;
    const problem =
      spec.state === 'off'
        ? why('off')
        : spec.state === 'unavailable'
          ? why('unavailable')
          : !open
            ? why('closed')
            : spec.state === 'sold_out'
              ? why('sold_out')
              : spec.remaining !== null && l.quantity > spec.remaining
                ? m.leftProblem(spec.remaining)
                : null;
    const chosen = spec.options && l.methods?.length ? pickedMethods(spec.options.methods, l.methods) : [];
    return {
      ...l,
      key,
      names: dishNames(dish, lang),
      tagline: dishTagline(dish, lang),
      label: specLabel(spec, lang),
      price: spec.price + (spec.options ? methodsExtra(spec.options.methods, l.methods ?? []) : 0),
      problem,
      ...(chosen.length ? { detail: chosen.map(methodText).join(lang === 'en' ? ', ' : '，') } : {}),
    };
  });
}

/** 选好做法、加料以后的「未下单」：主菜一份（同样的做法合进已有的那一行），加料按选的份数各一行、挂在主菜上 */
export function withOptionLines(cart: CartLine[], dishId: number, itemId: number, picked: PickedOptions): CartLine[] {
  const mainKey = `${itemId}:${[...picked.methods].sort().join(',')}`;
  const bump = (list: CartLine[], key: string, by: number, line: CartLine) =>
    list.some((l) => cartKey(l) === key) ? list.map((l) => (cartKey(l) === key ? { ...l, quantity: Math.min(99, l.quantity + by) } : l)) : [...list, line];
  let next = bump(cart, mainKey, 1, { key: mainKey, itemId, dishId, quantity: 1, ...(picked.methods.length ? { methods: picked.methods } : {}) });
  for (const a of picked.addons) {
    const key = `${a.itemId}@${mainKey}`;
    next = bump(next, key, a.quantity, { key, itemId: a.itemId, dishId, quantity: a.quantity, addonOf: mainKey });
  }
  return next;
}

/** 选好做法以后要新开几行（核对一单最多几行） */
export const optionLineKeys = (itemId: number, picked: PickedOptions): string[] => {
  const mainKey = `${itemId}:${[...picked.methods].sort().join(',')}`;
  return [mainKey, ...picked.addons.map((a) => `${a.itemId}@${mainKey}`)];
};
