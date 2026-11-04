// 好友的邀请（第三期 3b，docs/MP_PHASE3.md 第 2 节）：打开分享卡片，看是谁请你、能体验什么；用微信手机号快速验证领取。
// 已经是会员的用会员的手机号领；还不是会员的填个姓名，当场开卡，顺带绑上这个微信。领取的「结果待确认」见 utils/invites.ts。
import type { MpInviteView } from '../../../../src/shared/mp';
import { isOffline, member, messageOf } from '../../utils/api';
import { claimedText, readClaimPending, resolveClaimPending, sendClaim, shortDate } from '../../utils/invites';
import type { ClaimOutcome } from '../../utils/invites';
import { uuid } from '../../utils/uuid';

type State = 'loading' | 'ready' | 'claimed' | 'pending' | 'unreadable' | 'offline' | 'error';

const CLOSED_TEXT: Record<string, string> = {
  used: '这份邀请已经被领走了',
  revoked: '邀请人收回了这份邀请',
  expired: '这份邀请过期了（7 天内有效），请让好友重新发一份',
};

Page({
  data: {
    state: 'loading' as State,
    message: '',
    code: '',
    view: null as MpInviteView | null,
    expires: '',
    closedText: '',
    name: '',
    needName: false,
    busy: false,
    claimed: null as { text: string; bound: boolean; notice: string } | null,
  },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ code: String(query.code || '').toUpperCase() });
  },

  onShow() {
    // 领到了的停在结果页；正在领（手机号验证的弹窗刚关掉、切到聊天再回来）的等它回来
    if (this.data.state !== 'claimed' && !this.data.busy) this.load();
  },

  async load() {
    if (!/^[2-9A-HJ-NP-Z]{10}$/.test(this.data.code)) {
      this.setData({ state: 'error', message: '邀请码不对，请让好友重新发一份' });
      return;
    }
    // 上次领取时结果不确定：先请门店系统确认，确认之前不能再领
    const pend = readClaimPending();
    if (pend.state !== 'none') {
      const outcome = await resolveClaimPending();
      // 上次领的是另一份邀请、已经领到了：告诉顾客一声，这一页照常显示这一份
      if (outcome && outcome.kind === 'claimed' && outcome.claimed.code !== this.data.code) {
        wx.showToast({ title: '你之前领的另一份邀请已经领到了', icon: 'none' });
      } else if (outcome && this.after(outcome)) {
        return;
      }
    }
    try {
      const v = await member<MpInviteView>('GET', '/v1/invites/' + this.data.code);
      this.setData({ state: 'ready', view: v, expires: shortDate(v.expiresAt), closedText: CLOSED_TEXT[v.state] || '' });
    } catch (e) {
      this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
  },

  onName(e: WechatMiniprogram.Input) {
    this.setData({ name: e.detail.value });
  },

  onPhone(e: WechatMiniprogram.CustomEvent<{ code?: string; errMsg?: string }>) {
    const phoneCode = e.detail && e.detail.code;
    if (phoneCode) {
      this.claim(phoneCode);
      return;
    }
    // 顾客点了「拒绝」：什么也不做
    if (e.detail && e.detail.errMsg && /deny|cancel/.test(e.detail.errMsg)) return;
    wx.showToast({ title: '手机号没验证成功，请再试一次', icon: 'none' });
  },

  async claim(phoneCode: string) {
    const v = this.data.view;
    if (!v || this.data.busy) return;
    this.setData({ busy: true });
    const out = await sendClaim(this.data.code, phoneCode, this.data.name, uuid(), v.bindVersion);
    this.setData({ busy: false });
    if (!this.after(out)) this.load();
  },

  /** 按门店系统的回答显示；返回 true 表示已经显示好了（领到了、待确认、读不出来），不用再取邀请 */
  after(out: ClaimOutcome): boolean {
    if (out.kind === 'claimed') {
      const c = out.claimed;
      this.setData({ state: 'claimed', claimed: { text: claimedText(c), bound: c.bound, notice: c.notice || '' } });
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
      wx.showToast({ title: '上次没有领到，可以重新领', icon: 'none' });
      return false;
    }
    if (out.kind === 'earlier') {
      wx.showModal({ title: '这一份没有领', content: out.message, showCancel: false });
      return false;
    }
    if (out.code === 'NAME_REQUIRED') {
      this.setData({ needName: true });
      wx.showModal({ title: '填一下姓名', content: out.message + '（再验证一次手机号）', showCancel: false });
      return false;
    }
    wx.showModal({ title: '没有领到', content: out.message, showCancel: false });
    return false;
  },

  onConfirmPending() {
    this.load();
  },

  onCard() {
    wx.switchTab({ url: '/pages/me/index' });
  },
});
