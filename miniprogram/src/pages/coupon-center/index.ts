// 领券中心（第二期 2c，docs/MP_COUPONS.md）：店主在后台放进来的券，按这位会员此刻能不能领列出来；点「领取」发到会员名下，
// 在「我的券」里能看到，到前台结账时照常用。限领按会员算：换绑微信也不能多领。领取「结果待确认」以门店系统的回答为准
// （utils/coupon-center.ts）。
import type { MpCouponCenter } from '../../../../src/shared/mp';
import { isApiError, isOffline, member, messageOf } from '../../utils/api';
import { centerView, claimedText, readCouponPending, resolveCouponPending, sendClaim } from '../../utils/coupon-center';
import type { CenterView, ClaimOutcome } from '../../utils/coupon-center';
import { uuid } from '../../utils/uuid';

type State = 'loading' | 'unbound' | 'offline' | 'error' | 'ready' | 'pending' | 'unreadable';

Page({
  data: {
    state: 'loading' as State,
    message: '',
    view: null as CenterView | null,
    busy: 0,
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    // 上次领取时结果不确定：先请门店系统确认，确认之前不能再领
    if (readCouponPending().state !== 'none') {
      const outcome = await resolveCouponPending();
      if (outcome && (outcome.kind === 'pending' || outcome.kind === 'unreadable')) {
        this.setData({ state: outcome.kind, message: outcome.kind === 'pending' ? outcome.message : '' });
        return;
      }
      if (outcome && outcome.kind === 'claimed') this.toastClaimed(outcome);
      if (outcome && outcome.kind === 'abandoned') wx.showToast({ title: '上次没有领到，可以重新领', icon: 'none' });
    }
    try {
      const c = await member<MpCouponCenter>('GET', '/v1/coupon-center');
      this.setData({ state: 'ready', view: centerView(c) });
    } catch (e) {
      if (isApiError(e) && e.code === 'MP_NOT_BOUND') this.setData({ state: 'unbound' });
      else this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
  },

  toastClaimed(outcome: Extract<ClaimOutcome, { kind: 'claimed' }>) {
    wx.showModal({ title: '领到了', content: claimedText(outcome.claimed), confirmText: '去我的券', cancelText: '接着看', success: (r) => r.confirm && this.onMine() });
  },

  async onClaim(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const v = this.data.view;
    const item = v && v.items.filter((x) => x.templateId === id)[0];
    if (!item || this.data.busy) return;
    if (!item.canClaim) {
      wx.showToast({ title: item.reason || '现在领不了这张券', icon: 'none' });
      return;
    }
    this.setData({ busy: id });
    // 带上这一页显示时的绑定版本号：点了领取之后才解绑、换绑的，门店系统不发券
    const outcome = await sendClaim(id, uuid(), v!.bindVersion);
    this.setData({ busy: 0 });
    if (outcome.kind === 'claimed') this.toastClaimed(outcome);
    else if (outcome.kind === 'rejected') wx.showToast({ title: outcome.message, icon: 'none' });
    else if (outcome.kind === 'abandoned') wx.showToast({ title: '这次没有领到，请再点一次领取', icon: 'none' });
    if (outcome.kind === 'pending' || outcome.kind === 'unreadable') {
      this.setData({ state: outcome.kind, message: outcome.kind === 'pending' ? outcome.message : '' });
      return;
    }
    await this.load();
  },

  async onConfirmPending() {
    if (this.data.busy) return;
    this.setData({ busy: -1 });
    await this.load();
    this.setData({ busy: 0 });
  },

  onMine() {
    wx.navigateTo({ url: '/pages/coupons/index' });
  },

  onBind() {
    wx.switchTab({ url: '/pages/me/index' });
  },
});
