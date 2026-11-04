// 我的券（v0.7.20 的券）：前台发的、充值送的、开卡礼与生日礼都在这里；可用的排在前面。结账时告诉前台用哪张。
// 到期提醒（第三期 3a）：可以用的券旁边「到期提醒我」，同意以后到期前 3 天发一条微信消息。
import type { MpCoupon, MpReminderOptions } from '../../../../src/shared/mp';
import { isApiError, isOffline, member, messageOf } from '../../utils/api';
import { loadReminders, remindButton, remindHint, remindTap, retryPendingReminders } from '../../utils/reminders';
import { couponView } from '../../utils/views';
import type { CouponView } from '../../utils/views';

type CouponItem = CouponView & { raw: string; remind: { show: boolean; set: boolean; text: string } };
const NO_REMIND = { show: false, set: false, text: '' };

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'unbound' | 'offline' | 'error',
    message: '',
    usable: [] as CouponItem[],
    others: [] as CouponItem[],
    remindHint: '',
  },
  reminders: null as MpReminderOptions | null,

  onLoad() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      // 没确认的提醒先原样重提一次，再取能设哪些（取不到时不显示「提醒我」，券照常看）
      const [coupons, reminders] = await Promise.all([member<MpCoupon[]>('GET', '/v1/coupons'), retryPendingReminders().then(loadReminders)]);
      this.reminders = reminders;
      const list: CouponItem[] = coupons.map((c) => ({
        ...couponView(c),
        raw: c.code,
        remind: c.state === 'available' ? remindButton(reminders, { kind: 'coupon', couponCode: c.code }) : NO_REMIND,
      }));
      this.setData({
        state: 'ready',
        usable: list.filter((c) => c.usable),
        others: list.filter((c) => !c.usable),
        remindHint: reminders && reminders.templates.coupon ? remindHint(reminders, 'coupon') : '',
      });
    } catch (e) {
      if (isApiError(e) && e.code === 'MP_NOT_BOUND') this.setData({ state: 'unbound' });
      else this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
  },

  onBind() {
    wx.switchTab({ url: '/pages/me/index' });
  },

  onRemind(e: WechatMiniprogram.TouchEvent) {
    const { code, set } = e.currentTarget.dataset as { code?: string; set?: boolean };
    if (!code || set) return;
    remindTap(this.reminders, { kind: 'coupon', couponCode: code }).then((refresh) => {
      if (refresh) this.load();
    });
  },
});
