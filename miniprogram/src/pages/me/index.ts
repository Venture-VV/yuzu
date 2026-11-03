// 我的：绑定会员（MP6：用微信验证过的手机号，对上门店的会员档案才绑；对不上不建会员，MP3）、会员卡（会员体系 v2 的档阶与进度）、
// 余额（本金、赠金）、会员码、流水、券、解绑与换号。会员相关的数字不存本机，门店连不上时显示「门店系统连接中」。
import type { MpHome, MpMe } from '../../../../src/shared/mp';
import { appVersion } from '../../config/env';
import { isOffline, member, messageOf, mockUser, mockWechat, show, switchMockUser } from '../../utils/api';
import { clearBindPending, readBindPending, resolveBindPending, sendBind } from '../../utils/bind-pending';
import type { BindOutcome } from '../../utils/bind-pending';
import { cardView } from '../../utils/member-card';
import type { CardView } from '../../utils/member-card';
import { uuid } from '../../utils/uuid';

type State = 'loading' | 'unbound' | 'notmember' | 'pending' | 'bound' | 'offline' | 'error';

Page({
  data: {
    state: 'loading' as State,
    message: '',
    card: null as CardView | null,
    homeName: '宝安店',
    binding: false,
    mock: false,
    mockUser: '',
    mockPhone: '',
    version: '',
  },

  onLoad() {
    this.setData({ version: appVersion() });
    show<MpHome>('/v1/home')
      .then(({ data }) => {
        const home = data.stores.filter((s) => s.isHome)[0];
        if (home) this.setData({ homeName: home.name });
      })
      .catch(() => undefined);
  },

  onShow() {
    // 每次进来都读最新的余额与券
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    if (this.data.state === 'offline' || this.data.state === 'error') this.setData({ state: 'loading' });
    const mock = await mockWechat();
    if (mock !== this.data.mock) this.setData({ mock, mockUser: mock ? mockUser() : '' });
    // 上次点绑定时结果不确定：先请门店系统确认，确认之前不显示绑定按钮
    if (readBindPending()) {
      const outcome = await resolveBindPending();
      if (outcome && outcome.kind === 'pending') {
        this.setData({ state: 'pending', message: outcome.message, card: null });
        return;
      }
      if (outcome && outcome.kind === 'abandoned') wx.showToast({ title: '上次的绑定没有成功，请重新绑定', icon: 'none' });
    }
    try {
      const me = await member<MpMe>('GET', '/v1/me');
      if (me.bound && me.member) this.setData({ state: 'bound', card: cardView(me.member) });
      else this.setData({ state: this.data.state === 'notmember' ? 'notmember' : 'unbound', card: null });
    } catch (e) {
      this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e), card: null });
    }
  },

  onPhone(e: WechatMiniprogram.CustomEvent<{ code?: string; errMsg?: string }>) {
    const code = e.detail && e.detail.code;
    if (code) {
      this.bind(code);
      return;
    }
    // 顾客点了「拒绝」：什么也不做
    if (e.detail && e.detail.errMsg && /deny|cancel/.test(e.detail.errMsg)) return;
    wx.showToast({ title: '手机号没验证成功，请再试一次', icon: 'none' });
  },

  async bind(phoneCode: string) {
    if (this.data.binding || readBindPending()) return;
    this.setData({ binding: true });
    // 每次点绑定用新的操作编号（手机号验证的 code 只能用一次）；编号先存在手机上，结果不确定时请门店系统确认
    const outcome = await sendBind(phoneCode, uuid());
    this.setData({ binding: false });
    await this.after(outcome);
  },

  /** 绑定（或确认）之后：按门店系统的回答显示 */
  async after(outcome: BindOutcome) {
    if (outcome.kind === 'bound') {
      this.setData({ state: 'loading' });
      wx.showToast({ title: '绑定成功', icon: 'success' });
      await this.load();
    } else if (outcome.kind === 'pending') {
      this.setData({ state: 'pending', message: outcome.message, card: null });
    } else if (outcome.kind === 'abandoned') {
      this.setData({ state: 'unbound' });
      wx.showModal({ title: '这次没有绑定', content: '刚才网络不好，门店系统确认这次没有绑上，请再点一次绑定。', showCancel: false });
    } else if (outcome.code === 'NOT_MEMBER') {
      this.setData({ state: 'notmember' });
    } else {
      wx.showModal({ title: '没有绑定', content: outcome.message, showCancel: false });
    }
  },

  /** 「绑定结果待确认」时再确认一次 */
  async onConfirmPending() {
    if (this.data.binding) return;
    this.setData({ binding: true });
    const outcome = await resolveBindPending();
    this.setData({ binding: false });
    if (outcome) await this.after(outcome);
    else await this.load();
  },

  // ── 模拟微信（开发版、体验版连模拟微信的网关时）──

  onMockPhone(e: WechatMiniprogram.Input) {
    this.setData({ mockPhone: e.detail.value });
  },

  onMockBind() {
    const phone = this.data.mockPhone.replace(/\s/g, '');
    if (!/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '请填 11 位手机号', icon: 'none' });
      return;
    }
    this.bind('mock-phone-' + phone);
  },

  onMockSwitch() {
    // 待确认的绑定属于原来那个模拟微信：换了就不再替它确认
    clearBindPending();
    this.setData({ mockUser: switchMockUser(), state: 'loading', card: null });
    this.load();
  },

  onRetryBind() {
    this.setData({ state: 'unbound' });
  },

  // ── 菜单 ──

  onCode() {
    if (this.data.card && this.data.card.frozen) {
      wx.showToast({ title: '会员已冻结，会员码用不了，请到前台咨询', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/code/index' });
  },
  onLedger() {
    wx.navigateTo({ url: '/pages/ledger/index' });
  },
  onCoupons() {
    wx.navigateTo({ url: '/pages/coupons/index' });
  },
  onUnbind() {
    wx.navigateTo({ url: '/pages/unbind/index' });
  },
  onHome() {
    wx.switchTab({ url: '/pages/home/index' });
  },
});
