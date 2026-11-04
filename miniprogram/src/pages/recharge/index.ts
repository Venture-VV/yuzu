// 充值（第二期 2a，docs/MP_RECHARGE.md）：店主勾选的套餐与自定义金额（后台开着时）；确认 → 微信支付 → 等门店系统入账
// （页面自己再查，最多 1 分钟，之后可以离开，入账后在「余额与流水」里能看到）。赠金、档阶都是预估，以到账时为准。
// 同一位会员同时只有一张待支付的单：有的话先接着付或取消。下单「结果待确认」以门店系统的回答为准（utils/recharge.ts）。
// 模拟微信支付（只在演示库）：不调 wx.requestPayment，点「模拟支付」。
import type { MpPayParams, MpRechargeCreated, MpRechargeEstimate, MpRechargeOptions, MpRechargeOrder } from '../../../../src/shared/mp';
import { isApiError, isOffline, member, messageOf } from '../../utils/api';
import { yuan } from '../../utils/format';
import { orderCard, optionsView, parseCustomAmount, readRechargePending, resolveRechargePending, sendCreate } from '../../utils/recharge';
import type { CreateOutcome, OptionsView, OrderCard } from '../../utils/recharge';
import { uuid } from '../../utils/uuid';

type State = 'loading' | 'unbound' | 'offline' | 'error' | 'ready' | 'confirm' | 'paying' | 'waiting' | 'done' | 'pending' | 'unreadable';

interface Choice {
  planId: number | null;
  amount: number;
  title: string;
  amountText: string;
  estimate: string;
  coupons: string;
}

/** 付完以后等门店系统入账：2 秒查一次，最多 30 次（1 分钟） */
const POLL_MS = 2000;
const POLL_TIMES = 30;

function pay(p: MpPayParams): Promise<'paid' | 'cancel' | 'fail'> {
  return new Promise((resolve) => {
    wx.requestPayment({
      timeStamp: p.timeStamp,
      nonceStr: p.nonceStr,
      package: p.package,
      signType: p.signType,
      paySign: p.paySign,
      success: () => resolve('paid'),
      fail: (e: { errMsg?: string }) => resolve(/cancel/.test((e && e.errMsg) || '') ? 'cancel' : 'fail'),
    });
  });
}

Page({
  data: {
    state: 'loading' as State,
    message: '',
    view: null as OptionsView | null,
    customInput: '',
    customError: '',
    choice: null as Choice | null,
    order: null as OrderCard | null,
    busy: false,
  },
  /** 门店系统给的可充项（页面上的字由它拼出来；Page 自带的 options 是页面参数，不用它） */
  loaded: null as MpRechargeOptions | null,
  timer: 0 as unknown as ReturnType<typeof setTimeout> | 0,
  polls: 0,

  onShow() {
    // 正在付款、等入账时回到页面不打断（微信支付的界面关掉也会触发 onShow）
    if (this.data.state === 'paying' || this.data.state === 'waiting') return;
    this.load();
  },

  onHide() {
    this.stopPoll();
  },

  onUnload() {
    this.stopPoll();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    // 上次下单时结果不确定：先请门店系统确认，确认之前不能下新单
    if (readRechargePending().state !== 'none') {
      const outcome = await resolveRechargePending();
      if (outcome && (outcome.kind === 'pending' || outcome.kind === 'unreadable')) {
        this.setData({ state: outcome.kind, message: outcome.kind === 'pending' ? outcome.message : '' });
        return;
      }
      if (outcome && outcome.kind === 'abandoned') wx.showToast({ title: '上次没有下单成功，请重新选择', icon: 'none' });
    }
    try {
      const o = await member<MpRechargeOptions>('GET', '/v1/recharge');
      this.loaded = o;
      this.setData({ state: 'ready', view: optionsView(o), choice: null, customError: '' });
    } catch (e) {
      if (isApiError(e) && e.code === 'MP_NOT_BOUND') this.setData({ state: 'unbound' });
      else this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
  },

  // ── 选 ──

  onPlan(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const o = this.loaded;
    const p = o && o.plans.filter((x) => x.planId === id)[0];
    if (!o || !p || !o.open || o.pending) return;
    if (p.blocked) {
      wx.showToast({ title: p.blocked, icon: 'none' });
      return;
    }
    this.setData({
      state: 'confirm',
      choice: {
        planId: p.planId,
        amount: p.amount,
        title: p.name,
        amountText: yuan(p.amount),
        estimate: (p.bonus > 0 ? '预估赠 ' + yuan(p.bonus) + '，' : '') + '充完 ' + p.label,
        coupons: p.coupons.length ? '另送 ' + p.coupons.join('、') : '',
      },
    });
  },

  onCustomInput(e: WechatMiniprogram.Input) {
    this.setData({ customInput: e.detail.value, customError: '' });
  },

  async onCustom() {
    const o = this.loaded;
    if (!o || !o.custom || !o.open || o.pending || this.data.busy) return;
    const r = parseCustomAmount(this.data.customInput, o.custom);
    if (!r.ok) {
      this.setData({ customError: r.message });
      return;
    }
    this.setData({ busy: true });
    try {
      const est = await member<MpRechargeEstimate>('GET', '/v1/recharge/preview?amount=' + r.cents);
      this.setData({
        state: 'confirm',
        choice: {
          planId: null,
          amount: r.cents,
          title: '自定义金额',
          amountText: yuan(r.cents),
          estimate: (est.bonus > 0 ? '预估赠 ' + yuan(est.bonus) + '，' : '') + '充完 ' + est.label,
          coupons: '',
        },
      });
    } catch (e) {
      wx.showToast({ title: messageOf(e), icon: 'none' });
    } finally {
      this.setData({ busy: false });
    }
  },

  onBack() {
    this.setData({ state: 'ready', choice: null });
  },

  // ── 下单、付款 ──

  async onConfirm() {
    const c = this.data.choice;
    if (!c || this.data.busy) return;
    this.setData({ busy: true });
    const outcome = await sendCreate({ planId: c.planId, amount: c.planId === null ? c.amount : null }, uuid());
    this.setData({ busy: false });
    await this.afterCreate(outcome);
  },

  async afterCreate(outcome: CreateOutcome) {
    if (outcome.kind === 'created') {
      await this.payOrder(outcome.created);
    } else if (outcome.kind === 'existing') {
      // 原来那次已经建了单：显示在充值页最上面，接着付或取消
      wx.showToast({ title: '上次已经下了单，可以接着付', icon: 'none' });
      await this.load();
    } else if (outcome.kind === 'abandoned') {
      wx.showModal({ title: '这次没有下单', content: '刚才网络不好，门店系统确认这次没有下单，请再选一次。', showCancel: false });
      await this.load();
    } else if (outcome.kind === 'pending' || outcome.kind === 'unreadable') {
      this.setData({ state: outcome.kind, message: outcome.kind === 'pending' ? outcome.message : '' });
    } else {
      wx.showModal({ title: '没有下单', content: outcome.message, showCancel: false });
      await this.load();
    }
  },

  /** 拿到支付参数以后调起微信支付（模拟的点「模拟支付」）；付完等门店系统入账 */
  async payOrder(created: MpRechargeCreated) {
    const order = created.order;
    this.setData({ order: orderCard(order) });
    if (order.status !== 'pending') {
      this.setData({ state: 'done' });
      return;
    }
    if (created.mock) {
      const ok = await new Promise<boolean>((resolve) =>
        wx.showModal({
          title: '模拟支付',
          content: '这是演示库：点「付款」就算付了 ' + yuan(order.amount) + '，不走真钱。',
          confirmText: '付款',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false),
        }),
      );
      if (!ok) {
        await this.load();
        return;
      }
      this.setData({ state: 'waiting' });
      try {
        const after = await member<MpRechargeOrder>('POST', '/v1/recharge/orders/' + order.orderNo + '/mock-pay', {});
        this.show(after);
      } catch (e) {
        wx.showToast({ title: messageOf(e), icon: 'none' });
        this.startPoll(order.orderNo);
      }
      return;
    }
    if (!created.payment) {
      wx.showModal({ title: '微信支付暂时连不上', content: '单子已经建好，稍后在充值页点「接着付」。15 分钟没付会自动关掉。', showCancel: false });
      await this.load();
      return;
    }
    this.setData({ state: 'paying' });
    const r = await pay(created.payment);
    if (r === 'paid') {
      this.setData({ state: 'waiting' });
      this.startPoll(order.orderNo);
    } else {
      if (r === 'fail') wx.showToast({ title: '没有付成功，可以接着付', icon: 'none' });
      await this.load();
    }
  },

  /** 有待支付的单：接着付（重新拿支付参数） */
  async onContinue() {
    const o = this.loaded;
    if (!o || !o.pending || this.data.busy) return;
    this.setData({ busy: true });
    try {
      const created = await member<MpRechargeCreated>('POST', '/v1/recharge/orders/' + o.pending.orderNo + '/pay', {});
      this.setData({ busy: false });
      await this.payOrder(created);
    } catch (e) {
      this.setData({ busy: false });
      wx.showModal({ title: '没能接着付', content: messageOf(e), showCancel: false });
      await this.load();
    }
  },

  async onCancelPending() {
    const o = this.loaded;
    if (!o || !o.pending || this.data.busy) return;
    const sure = await new Promise<boolean>((resolve) =>
      wx.showModal({ title: '取消这张单', content: '还没付的单取消以后可以重新选。已经付了的门店系统照样入账。', success: (r) => resolve(!!r.confirm), fail: () => resolve(false) }),
    );
    if (!sure) return;
    this.setData({ busy: true });
    try {
      const after = await member<MpRechargeOrder>('POST', '/v1/recharge/orders/' + o.pending.orderNo + '/cancel', {});
      wx.showToast({ title: after.status === 'closed' ? '已取消' : orderCard(after).status, icon: 'none' });
    } catch (e) {
      wx.showToast({ title: messageOf(e), icon: 'none' });
    }
    this.setData({ busy: false });
    await this.load();
  },

  // ── 等入账 ──

  startPoll(orderNo: string) {
    this.stopPoll();
    this.polls = 0;
    const tick = async () => {
      this.timer = 0;
      this.polls += 1;
      try {
        const o = await member<MpRechargeOrder>('GET', '/v1/recharge/orders/' + orderNo);
        if (o.status !== 'pending') {
          this.show(o);
          return;
        }
        this.setData({ order: orderCard(o) });
      } catch {
        // 网络不好：接着等
      }
      if (this.polls >= POLL_TIMES) {
        // 1 分钟还没入账：到账通知在路上，之后可以离开，入账后在「余额与流水」里能看到
        this.setData({ state: 'done' });
        return;
      }
      this.timer = setTimeout(tick, POLL_MS);
    };
    this.timer = setTimeout(tick, POLL_MS);
  },

  stopPoll() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
  },

  show(o: MpRechargeOrder) {
    this.stopPoll();
    this.setData({ state: 'done', order: orderCard(o) });
  },

  /** 「下单结果待确认」时再确认一次 */
  async onConfirmPending() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    const outcome = await resolveRechargePending();
    this.setData({ busy: false });
    if (outcome) await this.afterCreate(outcome);
    else await this.load();
  },

  onLedger() {
    wx.redirectTo({ url: '/pages/ledger/index' });
  },

  onBind() {
    wx.switchTab({ url: '/pages/me/index' });
  },

  onDone() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/me/index' }) });
  },
});
