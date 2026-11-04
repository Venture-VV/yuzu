// 扫码点餐（第三期 3c，docs/MP_PHASE3.md 第 3 节）：在店的会员（手牌挂上了会员卡）自己点菜，进厨房出品单，挂在自己的手牌账单上；
// 扫了桌上的码，出品单写送到这张桌。结账照旧在前台；自己不能退菜（MP33）。下单的「结果待确认」见 utils/food.ts。
import type { MpFoodMenu } from '../../../../src/shared/mp';
import { isOffline, member, messageOf } from '../../utils/api';
import { addProblem, cartSum, changeCount, menuGroups, orderedView, readOrderPending, resolveOrderPending, sendOrder, setNote, tableCodeOf, tableFromOptions } from '../../utils/food';
import type { Cart, GroupView, OrderedView, OrderOutcome } from '../../utils/food';
import { yuan } from '../../utils/format';
import { uuid } from '../../utils/uuid';

type State = 'loading' | 'ready' | 'ordered' | 'pending' | 'unreadable' | 'offline' | 'error';

/** 这几种拒绝说明菜单变了：重新取一次菜单（购物车留着） */
const RELOAD = ['PRICE_CHANGED', 'DISH_SOLD_OUT', 'DISH_NOT_OPEN', 'BIND_STALE', 'TABLE_CODE_INVALID', 'VISIT_CHANGED', 'VISIT_CLOSED', 'BILL_CLOSED', 'NO_OPEN_VISIT', 'ITEM_GENDER', 'MP_FOOD_DISABLED', 'DINING_DISABLED', 'MEMBER_UNAVAILABLE'];

Page({
  data: {
    state: 'loading' as State,
    message: '',
    table: '',
    menu: null as MpFoodMenu | null,
    groups: [] as GroupView[],
    cart: {} as Cart,
    count: 0,
    total: '',
    busy: false,
    ordered: null as OrderedView | null,
  },

  onLoad(options: Record<string, string | undefined>) {
    this.setData({ table: tableFromOptions(options) });
  },

  onShow() {
    // 下好了的停在结果页；正在下单（扫码、切到聊天再回来）的等它回来
    if (this.data.state !== 'ordered' && !this.data.busy) this.load();
  },

  async load() {
    // 上次下单时结果不确定：先请门店系统确认，确认之前不能再下
    if (readOrderPending().state !== 'none') {
      const outcome = await resolveOrderPending();
      if (outcome && this.after(outcome)) return;
    }
    try {
      const menu = await member<MpFoodMenu>('GET', '/v1/food/menu' + (this.data.table ? '?table=' + this.data.table : ''));
      // 菜单上已经没有的菜从购物车里拿掉
      const cart: Cart = {};
      for (const d of menu.dishes) {
        const line = this.data.cart[String(d.id)];
        if (line && d.remaining !== 0) cart[String(d.id)] = line;
      }
      this.setData({ state: 'ready', menu, cart });
      this.refresh();
    } catch (e) {
      this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
  },

  refresh() {
    const menu = this.data.menu;
    if (!menu) return;
    const sum = cartSum(this.data.cart, menu.dishes);
    this.setData({ groups: menuGroups(menu.dishes, this.data.cart), count: sum.quantity, total: yuan(sum.total) });
  },

  onScan() {
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: (res) => {
        const code = tableCodeOf(res.result);
        if (!code) {
          wx.showToast({ title: '这不是本店的桌码，请扫桌上的码', icon: 'none' });
          return;
        }
        this.setData({ table: code });
        this.load();
      },
    });
  },

  onAdd(e: WechatMiniprogram.TouchEvent) {
    const menu = this.data.menu;
    if (!menu || !menu.canOrder) return;
    const dish = menu.dishes.find((d) => d.id === Number(e.currentTarget.dataset.id));
    if (!dish) return;
    const problem = addProblem(this.data.cart, dish, menu.dishes, menu.limits);
    if (problem) {
      wx.showToast({ title: problem, icon: 'none' });
      return;
    }
    this.setData({ cart: changeCount(this.data.cart, dish.id, 1) });
    this.refresh();
  },

  onMinus(e: WechatMiniprogram.TouchEvent) {
    this.setData({ cart: changeCount(this.data.cart, Number(e.currentTarget.dataset.id), -1) });
    this.refresh();
  },

  onNote(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const line = this.data.cart[String(id)];
    if (!line) return;
    wx.showModal({
      title: '口味备注',
      editable: true,
      placeholderText: '少辣、不要香菜、走冰……（40 字以内）',
      content: line.note,
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ cart: setNote(this.data.cart, id, String(r.content || '')) });
        this.refresh();
      },
    });
  },

  onSubmit() {
    const menu = this.data.menu;
    if (!menu || !menu.canOrder || this.data.busy || this.data.count === 0) return;
    const sum = cartSum(this.data.cart, menu.dishes);
    const where = menu.table ? '送到 ' + menu.table.name + ' 桌' : '服务员按手牌送';
    wx.showModal({
      title: '确认下单',
      content: '共 ' + sum.quantity + ' 份，' + yuan(sum.total) + '，' + where + '。下单后厨房马上做，挂在手牌 ' + menu.tagCode + ' 的账单上，结账在前台；自己不能退菜，要退请服务员。',
      confirmText: '下单',
      success: (r) => {
        if (r.confirm) this.submit();
      },
    });
  },

  async submit() {
    const menu = this.data.menu;
    if (!menu) return;
    const sum = cartSum(this.data.cart, menu.dishes);
    this.setData({ busy: true });
    const out = await sendOrder({ items: sum.items, table: menu.table ? menu.table.code : '', expectedTotal: sum.total, bindVersion: menu.bindVersion }, uuid());
    this.setData({ busy: false });
    if (!this.after(out)) this.load();
  },

  /** 按门店系统的回答显示；返回 true 表示已经显示好了（下了、待确认、读不出来），不用再取菜单 */
  after(out: OrderOutcome): boolean {
    if (out.kind === 'ordered') {
      this.setData({ state: 'ordered', ordered: orderedView(out.ordered), cart: {}, count: 0, total: '' });
      return true;
    }
    if (out.kind === 'pending') {
      this.setData({ state: 'pending', message: out.message });
      return true;
    }
    if (out.kind === 'unreadable') {
      this.setData({ state: 'unreadable' });
      return true;
    }
    if (out.kind === 'abandoned') {
      wx.showToast({ title: '上次那一单没有下成，可以重新下', icon: 'none' });
      return false;
    }
    if (out.kind === 'earlier') {
      wx.showModal({ title: '这一单还没下', content: out.message, showCancel: false });
      return false;
    }
    wx.showModal({ title: '没有下单', content: out.message, showCancel: false });
    // 菜单变了的重新取；其他的（存不了、超过上限）菜单没变，不用重新取
    return RELOAD.indexOf(out.code) < 0;
  },

  onConfirmPending() {
    this.load();
  },

  onMore() {
    this.setData({ state: 'loading', ordered: null });
    this.load();
  },

  onBill() {
    wx.navigateTo({ url: '/pages/bill/index' });
  },

  onBind() {
    wx.switchTab({ url: '/pages/me/index' });
  },
});
