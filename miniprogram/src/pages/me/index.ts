// 我的：绑定会员（MP6：用微信验证过的手机号，对上门店的会员档案才绑；对不上不建会员，MP3）、会员卡（会员体系 v2 的档阶与进度）、
// 余额（本金、赠金）、会员码、充值（线上充值开着时，第二期 2a）、流水、券、解绑与换号。会员相关的数字不存本机，门店连不上时显示「门店系统连接中」。
import type { MpHome, MpMe, MpReminderOptions } from '../../../../src/shared/mp';
import { appVersion } from '../../config/env';
import { isOffline, member, messageOf, mockUser, mockWechat, show, switchMockUser } from '../../utils/api';
import { clearBindPending, dropUnreadableWhenBound, readBindPending, resolveBindPending, sendBind } from '../../utils/bind-pending';
import type { BindOutcome } from '../../utils/bind-pending';
import { cardView } from '../../utils/member-card';
import type { CardView } from '../../utils/member-card';
import { loadReminders, remindButton, remindHint, remindTap, retryPendingReminders } from '../../utils/reminders';
import type { ReminderTarget } from '../../utils/reminders';
import { uuid } from '../../utils/uuid';
import { readStored } from '../../utils/pending-store';

/** 模拟微信（开发版）换人之前要确认完的「结果待确认」记录（绑定的另外处理） */
const MOCK_PENDING_KEYS = ['tq_recharge_pending', 'tq_coupon_pending', 'tq_reminder_pending', 'tq_invite_create_pending', 'tq_invite_claim_pending', 'tq_food_order_pending', 'tq_booking_pending'];

const NO_REMIND = { show: false, set: false, text: '' };

type State = 'loading' | 'unbound' | 'notmember' | 'pending' | 'unreadable' | 'bound' | 'offline' | 'error';

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
    /** 绑定状态版本号（/v1/me 给的，点绑定时带上）；没读到之前是 -1 */
    bindVersion: -1,
    /** 到期提醒（第三期 3a）：会籍快到期、进补充期当天 */
    remindMember: NO_REMIND,
    remindGrace: NO_REMIND,
    remindHint: '',
  },
  reminders: null as MpReminderOptions | null,

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
    // 每次进来都读最新的余额与券；正在绑定（手机号验证的弹窗刚关掉）的等它回来
    if (!this.data.binding) this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    if (this.data.state === 'offline' || this.data.state === 'error') this.setData({ state: 'loading' });
    const mock = await mockWechat();
    if (mock !== this.data.mock) this.setData({ mock, mockUser: mock ? mockUser() : '' });
    // 上次点绑定时结果不确定：先请门店系统确认，确认之前不显示绑定按钮
    if (readBindPending().state === 'pending') {
      const outcome = await resolveBindPending();
      if (outcome && outcome.kind === 'pending') {
        this.setData({ state: 'pending', message: outcome.message, card: null });
        return;
      }
      if (outcome && outcome.kind === 'abandoned') wx.showToast({ title: '上次的绑定没有成功，请重新绑定', icon: 'none' });
    }
    try {
      const me = await member<MpMe>('GET', '/v1/me');
      this.setData({ bindVersion: typeof me.bindVersion === 'number' ? me.bindVersion : -1 });
      if (me.bound && me.member) {
        dropUnreadableWhenBound();
        this.setData({ state: 'bound', card: cardView(me.member) });
        this.loadReminders();
        return;
      }
      // 没绑定：手机上的记录读不出来（或又有了没确认的）时先不能绑定，读得出来、确认之后才显示绑定按钮
      const now = readBindPending();
      if (now.state === 'unreadable') this.setData({ state: 'unreadable', card: null });
      else if (now.state === 'pending') this.setData({ state: 'pending', message: '', card: null });
      else this.setData({ state: this.data.state === 'notmember' ? 'notmember' : 'unbound', card: null });
    } catch (e) {
      this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e), card: null });
    }
  },

  /** 到期提醒：取不到不影响会员卡；L0、在补充期里的不显示会籍提醒；会籍的设好了才显示「进补充期也提醒我」 */
  async loadReminders() {
    const o = await retryPendingReminders().then(loadReminders);
    this.reminders = o;
    const m = o && o.membership;
    if (!o || !m || !m.cycleEnd || m.inGrace) {
      this.setData({ remindMember: NO_REMIND, remindGrace: NO_REMIND, remindHint: '' });
      return;
    }
    const member = remindButton(o, { kind: 'membership', targetDate: m.cycleEnd });
    this.setData({
      remindMember: member,
      remindGrace: member.set ? remindButton(o, { kind: 'grace', targetDate: m.cycleEnd }) : NO_REMIND,
      remindHint: member.show && !member.set ? remindHint(o, 'membership') : '',
    });
  },

  onRemind(e: WechatMiniprogram.TouchEvent) {
    const kind = (e.currentTarget.dataset as { kind?: string }).kind;
    const m = this.reminders && this.reminders.membership;
    if (!m || !m.cycleEnd || (kind !== 'membership' && kind !== 'grace')) return;
    if ((kind === 'membership' ? this.data.remindMember : this.data.remindGrace).set) return;
    const target: ReminderTarget = { kind, targetDate: m.cycleEnd };
    remindTap(this.reminders, target).then((refresh) => {
      if (refresh) this.loadReminders();
    });
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
    if (this.data.binding) return;
    // 还没读到绑定状态（页面刚打开、门店连不上）：先读一次，读不到就不发
    if (this.data.bindVersion < 0) {
      await this.load();
      if (this.data.bindVersion < 0) {
        wx.showToast({ title: '门店系统连接中，请稍后再试', icon: 'none' });
        return;
      }
    }
    // 手机上还有没确认的、或记录读不出来：sendBind 不发新的请求，按它的回答显示
    this.setData({ binding: true });
    // 每次点绑定用新的操作编号（手机号验证的 code 只能用一次）；编号先存在手机上，结果不确定时请门店系统确认
    const outcome = await sendBind(phoneCode, uuid(), this.data.bindVersion);
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
    } else if (outcome.kind === 'unreadable') {
      this.setData({ state: 'unreadable', card: null });
    } else if (outcome.kind === 'abandoned') {
      this.setData({ state: 'unbound' });
      wx.showModal({ title: '这次没有绑定', content: '刚才网络不好，门店系统确认这次没有绑上，请再点一次绑定。', showCancel: false });
    } else if (outcome.code === 'NOT_MEMBER') {
      this.setData({ state: 'notmember' });
    } else if (outcome.code === 'BIND_STALE') {
      // 打开页面之后在别处绑过或解绑过：按门店系统现在的样子刷新，要绑再点一次
      wx.showToast({ title: '绑定状态刚刚变过，已刷新', icon: 'none' });
      this.setData({ state: 'loading' });
      await this.load();
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
    // 别的「结果待确认」也属于原来那个模拟微信：换了以后门店系统认不出这些编号，会当成没办（独立审查 3b/3c 的 P3），没确认完不能换
    const left = MOCK_PENDING_KEYS.filter((k) => readStored(k).state !== 'none');
    if (left.length) {
      wx.showModal({
        title: '先确认完再换',
        content: '这个模拟微信还有没确认的操作（充值、领券、提醒、邀请、点餐或预约）。请先打开那一页点「再确认一次」，确认完再换一个微信。',
        showCancel: false,
      });
      return;
    }
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
  onRecharge() {
    wx.navigateTo({ url: '/pages/recharge/index' });
  },
  onInvite() {
    wx.navigateTo({ url: '/pages/invite/index' });
  },

  onBookings() {
    wx.navigateTo({ url: '/pages/bookings/index' });
  },

  onFood() {
    wx.navigateTo({ url: '/pages/food/index' });
  },

  onBill() {
    wx.navigateTo({ url: '/pages/bill/index' });
  },

  onCouponCenter() {
    wx.navigateTo({ url: '/pages/coupon-center/index' });
  },
  onLedger() {
    wx.navigateTo({ url: '/pages/ledger/index' });
  },
  onBenefits() {
    wx.navigateTo({ url: '/pages/benefits/index' });
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
