// 我的账单（第三期 3c，docs/MP_PHASE3.md 第 3 节）：在店手牌的账单上点了什么、多少钱、菜做到哪了。
// 只读；结账照旧在前台，会员折扣、券在结账时算，以前台结账为准。
import type { MpFoodBill } from '../../../../src/shared/mp';
import { isOffline, member, messageOf } from '../../utils/api';
import { billLines } from '../../utils/food';
import type { BillLineView } from '../../utils/food';
import { shopTime, yuan } from '../../utils/format';

type State = 'loading' | 'ready' | 'none' | 'offline' | 'error';

Page({
  data: {
    state: 'loading' as State,
    message: '',
    tagCode: '',
    since: '',
    lines: [] as BillLineView[],
    total: '',
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const b = await member<MpFoodBill>('GET', '/v1/food/bill');
      if (!b.open) {
        this.setData({ state: 'none', message: b.notice || '' });
        return;
      }
      this.setData({ state: 'ready', tagCode: b.tagCode || '', since: b.checkedInAt ? shopTime(b.checkedInAt) : '', lines: billLines(b), total: yuan(b.total) });
    } catch (e) {
      this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
  },

  onFood() {
    wx.navigateTo({ url: '/pages/food/index' });
  },
});
