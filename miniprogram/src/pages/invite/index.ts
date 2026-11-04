// 邀请好友（第三期 3b，docs/MP_PHASE3.md 第 2 节）：这个月还能邀请几次、好友能体验什么；生成一个邀请码（7 天内有效、只能用一次），
// 用「发给好友」分享小程序卡片；没人领的可以收回（次数退回来）。规则照会员体系的「邀请体验」，由门店系统算好。
// 发邀请码的「结果待确认」见 utils/invites.ts。
import type { MpInviteHome } from '../../../../src/shared/mp';
import { isApiError, isOffline, member, messageOf } from '../../utils/api';
import { inviteItemView, retryCreate, sendCreate, shortDate } from '../../utils/invites';
import type { InviteItemView } from '../../utils/invites';
import { uuid } from '../../utils/uuid';

type State = 'loading' | 'ready' | 'unbound' | 'offline' | 'error';

Page({
  data: {
    state: 'loading' as State,
    message: '',
    open: false,
    notice: '',
    allowed: false,
    reason: '',
    label: '',
    until: '',
    quota: '',
    items: [] as InviteItemView[],
    busy: false,
  },
  bindVersion: -1,

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    // 上次生成邀请码时结果不确定：原样重提一次（同一个编号只出一个码）
    const retried = await retryCreate();
    if (retried && retried.kind === 'rejected') wx.showToast({ title: retried.message, icon: 'none' });
    try {
      const h = await member<MpInviteHome>('GET', '/v1/invites');
      this.bindVersion = h.bindVersion;
      const o = h.option;
      this.setData({
        state: 'ready',
        open: h.open,
        notice: h.notice || '',
        allowed: !!o && o.allowed,
        reason: (o && o.reason) || '',
        label: (o && o.label) || '',
        until: o && o.endsOn ? shortDate(o.endsOn) : '',
        quota: !o ? '' : o.limit === null ? o.limitText : o.limitText + '已邀请 ' + o.used + ' 次，每月 ' + o.limit + ' 次',
        items: h.invites.map(inviteItemView),
      });
    } catch (e) {
      if (isApiError(e) && e.code === 'MP_NOT_BOUND') this.setData({ state: 'unbound' });
      else this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
  },

  async onCreate() {
    if (this.data.busy || !this.data.allowed) return;
    this.setData({ busy: true });
    const out = await sendCreate(uuid(), this.bindVersion);
    this.setData({ busy: false });
    if (out.kind === 'created') wx.showToast({ title: '生成好了，点「发给好友」', icon: 'none' });
    else if (out.kind === 'rejected') wx.showModal({ title: '没有生成', content: out.message, showCancel: false });
    else wx.showModal({ title: '还不知道生成没有', content: '网络不好。下次打开这一页会再试一次，不会生成两个。', showCancel: false });
    this.load();
  },

  onRevoke(e: WechatMiniprogram.TouchEvent) {
    const code = (e.currentTarget.dataset as { code?: string }).code;
    if (!code) return;
    wx.showModal({
      title: '收回这份邀请？',
      content: '收回以后好友就领不了了；这个月的次数退回来，可以再发一份。',
      confirmText: '收回',
      success: (r) => {
        if (r.confirm) this.revoke(code);
      },
    });
  },

  async revoke(code: string) {
    try {
      await member('POST', '/v1/invites/' + code + '/revoke', {});
      wx.showToast({ title: '已收回', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: messageOf(e), icon: 'none' });
    }
    this.load();
  },

  /** 「发给好友」：分享小程序卡片，好友点开进领取页 */
  onShareAppMessage(res: { from?: string; target?: { dataset?: { code?: string } } }) {
    const code = res && res.target && res.target.dataset ? res.target.dataset.code : '';
    return { title: '送你一份汤崎的会员体验', path: code ? '/pages/invite-claim/index?code=' + code : '/pages/home/index' };
  },

  onBind() {
    wx.switchTab({ url: '/pages/me/index' });
  },
});
