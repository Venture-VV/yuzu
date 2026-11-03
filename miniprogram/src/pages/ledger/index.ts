// 余额与流水：门店系统会员钱包里的记录（充值、消费、撤销、赠金过期……），只读；最近 50 条。
import type { MpLedgerRow, MpMe } from '../../../../src/shared/mp';
import { isApiError, isOffline, member, messageOf } from '../../utils/api';
import { yuan } from '../../utils/format';
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
  },

  onLoad() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
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
    } catch (e) {
      if (isApiError(e) && e.code === 'MP_NOT_BOUND') this.setData({ state: 'unbound' });
      else this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
  },

  onBind() {
    wx.switchTab({ url: '/pages/me/index' });
  },
});
