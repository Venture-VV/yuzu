// 本月可享（第一期 ⑥，接主线 v0.7.24 的会员权益）：按会员现在的档阶列出本店权益——服务与资格（次数）、每期的券、礼遇、说明，
// 升档以后能享的另列。只读：服务类在前台出示会员码、由店员登记次数；发的券在「我的券」。
import type { MpBenefits } from '../../../../src/shared/mp';
import { isApiError, isOffline, member, messageOf } from '../../utils/api';
import { benefitsView } from '../../utils/views';
import type { BenefitsView } from '../../utils/views';

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'unbound' | 'offline' | 'error',
    message: '',
    view: null as BenefitsView | null,
  },

  onLoad() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const b = await member<MpBenefits>('GET', '/v1/benefits');
      this.setData({ state: 'ready', view: benefitsView(b) });
    } catch (e) {
      if (isApiError(e) && e.code === 'MP_NOT_BOUND') this.setData({ state: 'unbound' });
      else this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
  },

  onBind() {
    wx.switchTab({ url: '/pages/me/index' });
  },

  onCoupons() {
    wx.navigateTo({ url: '/pages/coupons/index' });
  },
});
