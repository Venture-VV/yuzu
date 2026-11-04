// 预约（第三期 3d，docs/MP_PHASE3.md 第 4 节）：预约技师（项目 → 日子 → 时段 → 技师或「不指定」）、派对房等（房间 → 时长 → 日子 → 时段 → 人数）。
// 提交后是「待门店确认」，前台确认；不收订金（MP36）。能不能约、空着的时段都由门店系统算。预约的「结果待确认」见 utils/bookings.ts。
import type { MpBookingHome, MpBookingSlot, MpReminderOptions } from '../../../../src/shared/mp';
import { isOffline, member, messageOf } from '../../utils/api';
import { bookingItemView, dayChips, doneTitle, durationText, readBookingPending, resolveBookingPending, sendBooking, slotViews, slotWhen } from '../../utils/bookings';
import type { BookingItemView, BookingOutcome, SlotView } from '../../utils/bookings';
import { loadReminders, remindButton, remindHint, remindTap } from '../../utils/reminders';
import { uuid } from '../../utils/uuid';

type State = 'loading' | 'ready' | 'done' | 'pending' | 'unreadable' | 'offline' | 'error';
type Kind = 'technician' | 'space';

/** 这几种拒绝说明时段、可约的项目或规则变了：重新取一次（选的东西还在的留着） */
const RELOAD = [
  'BOOKING_TAKEN',
  'BOOKING_TIME',
  'BOOKING_PAST',
  'BOOKING_TOO_SOON',
  'BOOKING_RANGE',
  'BOOKING_LIMIT',
  'BOOKING_BANNED',
  'BOOKING_NOT_OPEN',
  'BOOKING_TECHNICIAN',
  'BOOKING_ITEM',
  'BOOKING_SPACE',
  'BOOKING_DURATION',
  'MEMBER_UNAVAILABLE',
  'MP_BOOKING_DISABLED',
  'BIND_STALE',
];

Page({
  data: {
    state: 'loading' as State,
    message: '',
    /** 结果待确认是因为这一次还在发（不是网络不好） */
    flying: false,
    home: null as MpBookingHome | null,
    kind: 'technician' as Kind,
    kinds: [] as { kind: Kind; label: string }[],
    itemId: 0,
    spaceId: 0,
    durations: [] as { minutes: number; label: string }[],
    duration: 0,
    days: [] as { date: string; label: string; sub: string }[],
    date: '',
    slots: [] as SlotView[],
    rawSlots: [] as MpBookingSlot[],
    slotsLoading: false,
    slotsMessage: '',
    slot: '',
    techs: [] as { id: number; label: string }[],
    technicianId: 0,
    guests: 1,
    note: '',
    busy: false,
    done: null as BookingItemView | null,
    doneTitle: '',
    reminders: null as MpReminderOptions | null,
    remind: { show: false, set: false, text: '' },
    remindHintText: '',
  },
  /** 取时段的第几次：后到的旧回答不用（独立审查 3d 的 P2：换了日子以后旧日子的时段晚到，会盖掉新日子的） */
  slotSeq: 0,

  onLoad(query: Record<string, string | undefined>) {
    if (query.kind === 'space') this.setData({ kind: 'space' });
  },

  onShow() {
    // 约好了的停在结果页；正在提交（切到聊天再回来）的等它回来
    if (this.data.state !== 'done' && !this.data.busy) this.load();
  },

  async load() {
    // 上次预约时结果不确定：先请门店系统确认，确认之前不能再约
    if (readBookingPending().state !== 'none') {
      const outcome = await resolveBookingPending();
      if (outcome && this.after(outcome)) return;
    }
    try {
      const home = await member<MpBookingHome>('GET', '/v1/bookings');
      const kinds: { kind: Kind; label: string }[] = [];
      if (home.items.length) kinds.push({ kind: 'technician', label: '预约技师' });
      if (home.spaces.length) kinds.push({ kind: 'space', label: '派对房等' });
      const kind: Kind = kinds.some((k) => k.kind === this.data.kind) ? this.data.kind : kinds.length ? kinds[0]!.kind : 'technician';
      const itemId = home.items.some((i) => i.id === this.data.itemId) ? this.data.itemId : home.items.length ? home.items[0]!.id : 0;
      const spaceId = home.spaces.some((s) => s.id === this.data.spaceId) ? this.data.spaceId : home.spaces.length ? home.spaces[0]!.id : 0;
      const duration = home.durations.indexOf(this.data.duration) >= 0 ? this.data.duration : home.durations[0] || 120;
      const days = dayChips(home.dates);
      const date = home.dates.indexOf(this.data.date) >= 0 ? this.data.date : home.dates[0] || '';
      this.setData({
        state: 'ready',
        home,
        kinds,
        kind,
        itemId,
        spaceId,
        durations: home.durations.map((m) => ({ minutes: m, label: durationText(m) })),
        duration,
        days,
        date,
      });
      if (home.canBook) this.loadSlots();
    } catch (e) {
      this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
  },

  async loadSlots() {
    const d = this.data;
    const seq = ++this.slotSeq;
    // 换了项目、房间、时长、日子：先清掉选好的时段与旧的列表
    this.setData({ slotsLoading: true, slotsMessage: '', slot: '', slots: [], rawSlots: [], techs: [], technicianId: 0 });
    if (!d.date || (d.kind === 'technician' ? !d.itemId : !d.spaceId)) {
      this.setData({ slotsLoading: false });
      return;
    }
    const date = d.date;
    const q = d.kind === 'technician' ? 'kind=technician&date=' + date + '&itemId=' + d.itemId : 'kind=space&date=' + date + '&spaceId=' + d.spaceId + '&durationMinutes=' + d.duration;
    try {
      const raw = await member<MpBookingSlot[]>('GET', '/v1/bookings/slots?' + q);
      // 这期间又换过选择：这个回答是旧的，不用
      if (seq !== this.slotSeq) return;
      const slots = slotViews(d.kind, raw, date);
      this.setData({ rawSlots: raw, slots, slot: '', slotsLoading: false, slotsMessage: slots.length ? '' : '这一天没有能约的时段了，换一天看看' });
    } catch (e) {
      if (seq !== this.slotSeq) return;
      this.setData({ rawSlots: [], slots: [], slot: '', slotsLoading: false, slotsMessage: messageOf(e) });
    }
  },

  onKind(e: WechatMiniprogram.TouchEvent) {
    const kind = String(e.currentTarget.dataset.kind) as Kind;
    if (kind === this.data.kind) return;
    this.setData({ kind });
    this.loadSlots();
  },

  onItem(e: WechatMiniprogram.TouchEvent) {
    this.setData({ itemId: Number(e.currentTarget.dataset.id) });
    this.loadSlots();
  },

  onSpace(e: WechatMiniprogram.TouchEvent) {
    this.setData({ spaceId: Number(e.currentTarget.dataset.id) });
    this.loadSlots();
  },

  onDuration(e: WechatMiniprogram.TouchEvent) {
    this.setData({ duration: Number(e.currentTarget.dataset.m) });
    this.loadSlots();
  },

  onDate(e: WechatMiniprogram.TouchEvent) {
    this.setData({ date: String(e.currentTarget.dataset.date) });
    this.loadSlots();
  },

  onSlot(e: WechatMiniprogram.TouchEvent) {
    const startsAt = String(e.currentTarget.dataset.at);
    const raw = this.data.rawSlots.find((s) => s.startsAt === startsAt);
    if (!raw || raw.free < 1) return;
    this.setData({ slot: startsAt, techs: raw.technicians.map((t) => ({ id: t.id, label: t.techNo + ' 号' })), technicianId: 0 });
  },

  onTech(e: WechatMiniprogram.TouchEvent) {
    this.setData({ technicianId: Number(e.currentTarget.dataset.id) });
  },

  onGuests(e: WechatMiniprogram.TouchEvent) {
    const next = this.data.guests + Number(e.currentTarget.dataset.d);
    if (next >= 1 && next <= 30) this.setData({ guests: next });
  },

  onNote(e: WechatMiniprogram.Input) {
    this.setData({ note: e.detail.value });
  },

  onSubmit() {
    const d = this.data;
    const home = d.home;
    if (!home || !home.canBook || !d.slot || d.busy || d.slotsLoading) return;
    // 选的时段要在现在这张列表里（换了日子、列表刷新以后旧的不算）
    if (!d.rawSlots.some((s) => s.startsAt === d.slot && s.free > 0)) {
      this.setData({ slot: '', techs: [], technicianId: 0 });
      return;
    }
    const what =
      d.kind === 'technician'
        ? (home.items.find((i) => i.id === d.itemId) || { name: '' }).name + ' · ' + (d.technicianId ? (d.techs.find((t) => t.id === d.technicianId) || { label: '' }).label + '技师' : '不指定技师')
        : (home.spaces.find((s) => s.id === d.spaceId) || { name: '' }).name + ' · ' + durationText(d.duration) + ' · ' + d.guests + ' 位';
    wx.showModal({
      title: '确认预约',
      // 日子写时段在日历上的那一天（过了半夜的是第二天），不写选的营业日
      content: what + '，' + slotWhen(d.slot) + '。提交后等门店确认；开始前 ' + Math.round(home.rules.cancelLeadMinutes / 60) + ' 小时以前可以自己取消，过了开始时间 ' + home.rules.noShowMinutes + ' 分钟没到店记爽约。',
      confirmText: '提交',
      success: (r) => {
        if (r.confirm) this.submit();
      },
    });
  },

  async submit() {
    const d = this.data;
    const home = d.home;
    if (!home) return;
    this.setData({ busy: true });
    const body =
      d.kind === 'technician'
        ? { kind: d.kind, itemId: d.itemId, technicianId: d.technicianId || null, startsAt: d.slot, guests: 1, note: d.note.trim(), bindVersion: home.bindVersion }
        : { kind: d.kind, spaceId: d.spaceId, durationMinutes: d.duration, startsAt: d.slot, guests: d.guests, note: d.note.trim(), bindVersion: home.bindVersion };
    const out = await sendBooking(body, uuid());
    this.setData({ busy: false });
    if (!this.after(out)) this.load();
  },

  /** 按门店系统的回答显示；返回 true 表示已经显示好了，不用再取 */
  after(out: BookingOutcome): boolean {
    if (out.kind === 'done') {
      if (out.action === 'create') {
        this.setData({ state: 'done', done: bookingItemView(out.booking), doneTitle: doneTitle(out.booking.status), note: '' });
        this.loadRemind(out.booking.id);
        return true;
      }
      // 上次的「取消」原来已经办了：照常取页面
      wx.showToast({ title: '上次的取消已经办好了', icon: 'none' });
      return false;
    }
    if (out.kind === 'pending') {
      this.setData({ state: 'pending', message: out.message, flying: !!out.flying });
      return true;
    }
    if (out.kind === 'unreadable') {
      this.setData({ state: 'unreadable' });
      return true;
    }
    if (out.kind === 'abandoned') {
      wx.showToast({ title: out.action === 'create' ? '上次的预约没有约上，可以重新约' : '上次的取消没有办，预约还在', icon: 'none' });
      return false;
    }
    if (out.kind === 'earlier') {
      wx.showModal({ title: '这一次还没约', content: out.message, showCancel: false });
      return false;
    }
    wx.showModal({ title: '没有约上', content: out.message, showCancel: false });
    return RELOAD.indexOf(out.code) < 0;
  },

  async loadRemind(bookingId: number) {
    const o = await loadReminders();
    this.setData({ reminders: o, remind: remindButton(o, { kind: 'booking', bookingId }), remindHintText: o ? remindHint(o, 'booking') : '' });
  },

  async onRemind() {
    const done = this.data.done;
    if (!done || this.data.remind.set) return;
    if (await remindTap(this.data.reminders, { kind: 'booking', bookingId: done.id })) this.loadRemind(done.id);
  },

  onConfirmPending() {
    this.load();
  },

  onMine() {
    wx.redirectTo({ url: '/pages/bookings/index' });
  },

  onMore() {
    this.setData({ state: 'loading', done: null, slot: '' });
    this.load();
  },

  onBind() {
    wx.switchTab({ url: '/pages/me/index' });
  },
});
