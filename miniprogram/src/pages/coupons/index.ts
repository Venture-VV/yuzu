// 我的券（v0.7.20 的券）：前台发的、充值送的、开卡礼与生日礼都在这里；可用的排在前面。结账时告诉前台用哪张。
import type { MpCoupon } from '../../../../src/shared/mp';
import { isApiError, isOffline, member, messageOf } from '../../utils/api';
import { couponView } from '../../utils/views';
import type { CouponView } from '../../utils/views';

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'unbound' | 'offline' | 'error',
    message: '',
    usable: [] as CouponView[],
    others: [] as CouponView[],
  },

  onLoad() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const list = (await member<MpCoupon[]>('GET', '/v1/coupons')).map(couponView);
      this.setData({ state: 'ready', usable: list.filter((c) => c.usable), others: list.filter((c) => !c.usable) });
    } catch (e) {
      if (isApiError(e) && e.code === 'MP_NOT_BOUND') this.setData({ state: 'unbound' });
      else this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
  },

  onBind() {
    wx.switchTab({ url: '/pages/me/index' });
  },
});
