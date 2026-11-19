// 8.1.15《浴族系统需求汇总》块 B3（docs/DINING_V8115.md 第 4 节）：点单页的几个插入点，单独放在这里——
//   · useOrderOutlets：这个岗位能在哪几处下单（在餐厅 / 水吧 / 果吧下单三项权限），点单页只列这几处；
//   · guestParams：找客人的查询参数（手牌号、房号至少一样；只填房号按这间房现在的客人找，都填时房号是送到哪）；
//   · orderExtras：下单时多带的送达房号、只填房号的核对、整单备注；
//   · OrderNoteInput：整单备注（写进这一单每道菜的出品单：厨房出品屏、点菜单）。

import { DINING_OUTLET_KEYS, DINING_OUTLET_LABELS, type DiningGuest, type DiningOutlet, type MenuDish } from '@shared/dining';
import { MAX_ORDER_NOTE, OUTLET_ORDER_PERMISSIONS } from '@shared/dining-v8115';
import { useCan } from '../../lib/session';
import { Field, Input } from '../../components/ui';

/** 这个岗位能下单的出品口 */
export function useOrderOutlets(): DiningOutlet[] {
  const can = useCan();
  return DINING_OUTLET_KEYS.filter((o) => can(OUTLET_ORDER_PERMISSIONS[o]));
}

/** 购物车里有没有不能下单的出品口的菜（改单放回来的、权限刚改过的）：有就写明哪一道 */
export function outletProblem(dishes: (MenuDish | null)[], allowed: readonly DiningOutlet[]): string | null {
  const bad = dishes.find((d) => d && !allowed.includes(d.outlet));
  return bad ? `「${bad.name}」在${DINING_OUTLET_LABELS[bad.outlet]}，你的岗位不能在${DINING_OUTLET_LABELS[bad.outlet]}下单，请删掉` : null;
}

/** 找客人的查询参数：手牌号、房号至少一样 */
export const guestParams = (tag: string | null, room: string | null) => new URLSearchParams({ ...(tag ? { tag } : {}), ...(room ? { room } : {}) }).toString();

/**
 * 下单多带的：按房号找到的客人带「只填房号」（服务端在挂账的事务里再核对一次这间房还是他）与房号，都填的带房号（写在送达位置），
 * 有整单备注的带备注；都没有时与原来的请求一样
 */
export function orderExtras(g: DiningGuest | null, note: string) {
  const room = g?.deliverRoom ?? '';
  return { ...(room ? { deliverRoom: room } : {}), ...(room && g?.via === 'room' ? { roomOnly: true } : {}), ...(note.trim() ? { orderNote: note.trim() } : {}) };
}

/** 整单备注：写进这一单每道菜的出品单 */
export function OrderNoteInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <Field label="整单备注" htmlFor="dining-order-note" hint="选填：写进这一单每道菜的出品单（厨房屏、点菜单）">
      <Input
        id="dining-order-note"
        value={value}
        maxLength={MAX_ORDER_NOTE}
        onChange={(e) => onChange(e.target.value)}
        placeholder="例如：一起上、先上饮料、送到房间请敲门"
        disabled={disabled}
        data-testid="dining-order-note"
      />
    </Field>
  );
}
