// 我的预约（第三期 3d，docs/MP_PHASE3.md 第 4 节）：自己的预约（待门店确认、已预约、已到店、已取消、没到店）。
// 开始前 2 小时以前可以自己取消（之后请打电话给门店）；还没开始的可以「到店提醒我」（门店确认以后，预约那天发一条微信消息）。
// 取消的「结果待确认」见 utils/bookings.ts。
import type { MpBookingHome, MpReminderOptions } from '../../../../src/shared/mp';
import { isOffline, member, messageOf } from '../../utils/api';
import { bookingItemView, readBookingPending, resolveBookingPending, sendCancel } from '../../utils/bookings';
import type { BookingItemView, BookingOutcome } from '../../utils/bookings';
import { loadReminders, remindButton, remindTap } from '../../utils/reminders';
import { uuid } from '../../utils/uuid';

type State = 'loading' | 'ready' | 'pending' | 'unreadable' | 'offline' | 'error';
type Row = BookingItemView & { remind: { show: boolean; set: boolean; text: string } };

const NO_REMIND = { show: false, set: false, text: '' };

Page({
  data: {
    state: 'loading' as State,
    message: '',
    open: false,
    bound: false,
    canBook: false,
    notice: '',
    rows: [] as Row[],
    cancelHours: 2,
    busy: false,
  },
  bindVersion: -1,
  reminders: null as MpReminderOptions | null,

  onShow() {
    // 正在取消（切到聊天再回来）的等它回来
    if (!this.data.busy) this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    // 上次预约、取消时结果不确定：先请门店系统确认
    if (readBookingPending().state !== 'none') {
      const outcome = await resolveBookingPending();
      if (outcome && this.after(outcome)) return;
    }
    try {
      const [h, o] = await Promise.all([member<MpBookingHome>('GET', '/v1/bookings'), loadReminders()]);
      this.bindVersion = h.bindVersion;
      this.reminders = o;
      this.setData({
        state: 'ready',
        open: h.open,
        bound: h.bound,
        canBook: h.canBook,
        notice: (h.bound ? h.bookNotice : h.notice) || '',
        cancelHours: Math.round(h.rules.cancelLeadMinutes / 60),
        rows: h.bookings.map((b) => {
          const v = bookingItemView(b);
          const future = v.open && Date.parse(b.startsAt) > Date.now();
          return { ...v, remind: future ? remindButton(o, { kind: 'booking', bookingId: b.id }) : NO_REMIND };
        }),
      });
    } catch (e) {
      this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
  },

  onCancel(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const row = this.data.rows.find((r) => r.id === id);
    if (!row || !row.cancellable || this.data.busy) return;
    wx.showModal({
      title: '取消这个预约？',
      content: row.title + '，' + row.when + '。取消以后这个时段让给别人；要再约请重新预约。',
      confirmText: '取消预约',
      cancelText: '不取消',
      success: (r) => {
        if (r.confirm) this.cancel(id);
      },
    });
  },

  async cancel(id: number) {
    this.setData({ busy: true });
    const out = await sendCancel(id, this.bindVersion, uuid());
    this.setData({ busy: false });
    if (!this.after(out)) this.load();
  },

  /** 按门店系统的回答显示；返回 true 表示已经显示好了，不用再取 */
  after(out: BookingOutcome): boolean {
    if (out.kind === 'done') {
      wx.showToast({ title: out.action === 'cancel' ? '取消好了' : '上次的预约已经约上了', icon: 'none' });
      return false;
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
      wx.showToast({ title: out.action === 'cancel' ? '上次的取消没有办，预约还在' : '上次的预约没有约上', icon: 'none' });
      return false;
    }
    if (out.kind === 'earlier') {
      wx.showModal({ title: '这一次还没办', content: out.message, showCancel: false });
      return false;
    }
    wx.showModal({ title: '没有取消', content: out.message, showCancel: false });
    return false;
  },

  async onRemind(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const row = this.data.rows.find((r) => r.id === id);
    if (!row || row.remind.set) return;
    if (await remindTap(this.reminders, { kind: 'booking', bookingId: id })) this.load();
  },

  onNew() {
    wx.navigateTo({ url: '/pages/booking/index' });
  },

  onConfirmPending() {
    this.load();
  },

  onBind() {
    wx.switchTab({ url: '/pages/me/index' });
  },
});
