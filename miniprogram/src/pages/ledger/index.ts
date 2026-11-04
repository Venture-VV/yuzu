// 余额与流水：门店系统会员钱包里的记录（充值、消费、撤销、赠金过期……），只读；最近 50 条。
// 到期提醒（第三期 3a）：有会到期的赠金时写「¥X 赠金用到 M月D日」（最后能用的那一天），旁边「到期提醒我」（到期前 7 天发一条微信消息）。
import type { MpLedgerRow, MpMe, MpReminderOptions } from '../../../../src/shared/mp';
import { isApiError, isOffline, member, messageOf } from '../../utils/api';
import { yuan } from '../../utils/format';
import { loadReminders, remindButton, remindHint, remindTap, retryPendingReminders } from '../../utils/reminders';
import { ledgerRow } from '../../utils/views';
import type { LedgerView } from '../../utils/views';

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'unbound' | 'offline' | 'error',
    message: '',
    total: '',
    principal: '',
    bonus: '',
    rows: [] as LedgerView[],
    /** 最早到期的赠金：「¥50.00 赠金用到 11月19日」；没有会到期的为空 */
    bonusExpiring: '',
    remind: { show: false, set: false, text: '' },
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
      // 可以同时取：门店系统的会员卡和流水都先作废到期的赠金，流水总在作废提交之后才读，结尾余额与会员卡一致
      const [me, rows] = await Promise.all([member<MpMe>('GET', '/v1/me'), member<MpLedgerRow[]>('GET', '/v1/ledger?limit=50')]);
      if (!me.member) {
        this.setData({ state: 'unbound' });
        return;
      }
      const m = me.member;
      this.setData({
        state: 'ready',
        total: yuan(m.principalBalance + m.bonusBalance),
        principal: yuan(m.principalBalance),
        bonus: yuan(m.bonusBalance),
        rows: rows.map(ledgerRow),
      });
      // 到期提醒：取不到不影响余额与流水
      const o = await retryPendingReminders().then(loadReminders);
      this.reminders = o;
      const b = o && o.bonus;
      const [, mm, dd] = b ? b.lastDay.split('-') : [];
      this.setData({
        bonusExpiring: b ? yuan(b.amount) + ' 赠金用到 ' + Number(mm) + '月' + Number(dd) + '日' : '',
        remind: b ? remindButton(o, { kind: 'bonus', targetDate: b.lastDay }) : { show: false, set: false, text: '' },
        remindHint: o && b && o.templates.bonus ? remindHint(o, 'bonus') : '',
      });
    } catch (e) {
      if (isApiError(e) && e.code === 'MP_NOT_BOUND') this.setData({ state: 'unbound' });
      else this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
  },

  onBind() {
    wx.switchTab({ url: '/pages/me/index' });
  },

  onRemind() {
    const b = this.reminders && this.reminders.bonus;
    if (!b || this.data.remind.set) return;
    remindTap(this.reminders, { kind: 'bonus', targetDate: b.lastDay }).then((refresh) => {
      if (refresh) this.load();
    });
  },
});
