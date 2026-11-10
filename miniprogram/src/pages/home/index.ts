// 首页：版头大图加标志（首页轮播；没有轮播时用门店照片，再没有用木色底）、门店信息（两家店都显示，MP5）、
// 三块业务（TASTE、WELLNESS、EXPERIENCE）、服务入口、门店公告。门店连不上时用之前的信息并标出来。
// 会员端提醒（RQ-014）：首页显示时问一次，有收到券、券快到期的提醒就弹出来，看过记已读（utils/notices.ts）；
// 不在首页时不问、不弹，要再问的等回到首页再问。
import type { MpBanner, MpHome, MpStore } from '../../../../src/shared/mp';
import { imageUrl, latestBindVersion, messageOf, show, watchBindVersion } from '../../utils/api';
import { appData } from '../../utils/app-state';
import { navMetrics } from '../../utils/nav';
import { loadNotices, markRead } from '../../utils/notices';
import type { NoticeView } from '../../utils/notices';

type Banner = MpBanner & { src: string };
const HERO_RPX = 600;

Page({
  data: {
    statusBar: 20,
    bar: 44,
    capsuleRight: 96,
    /** 滚过版头后导航栏变成米白底、黑字 */
    solid: false,
    status: 'loading' as 'loading' | 'ready' | 'error',
    message: '',
    stale: false,
    stores: [] as MpStore[],
    storeIndex: 0,
    store: null as MpStore | null,
    homeName: '',
    actCount: 0,
    banners: [] as Banner[],
    current: 0,
    heroImage: '',
    /** 会员端提醒：弹着的几条；有券的提醒时多一个「看我的券」 */
    notices: [] as NoticeView[],
    noticeOpen: false,
    noticeCoupon: false,
  },
  heroPx: 300,
  /** 上次问提醒的时刻：切回首页 30 秒内不再问（弹着的时候每次都重新问，解绑、换绑以后换成那位会员的） */
  noticeAt: 0,
  noticeBusy: false,
  /** 这次打开以后点过「知道了」的：已读还没回来时同时在问的那一次不会把它们又弹出来 */
  dismissed: [] as number[],
  /** 弹着的提醒是哪个绑定状态版本号下问到的：记已读时带上；之后见过更新的（解绑、换绑过），弹着的就不是这位会员的了 */
  noticeVersion: -1,
  /** 在问的时候又要问一次（切回首页、绑定状态变了）：这一次回来以后再问 */
  noticeAgain: false,
  /**
   * 第几轮：每离开一次首页（去别的页面、小程序退到后台）加一。离开之前发出去的回答回来时作废，不弹——
   * 回到首页以后弹的，都是回来以后才问到的（离开期间可能解绑、换绑了，小程序线测试 280b08a 的 P1）
   */
  noticeRound: 0,
  /**
   * 首页在显示（onShow 到 onHide 之间；微信先 onLoad 再 onShow，所以一开始算在显示）。不在显示时不问、不弹：
   * 不在首页时问到的不会弹在看不见的首页上、回来时直接露出来（离开期间可能解绑、换绑了，Codex 审查 83e74b3 的 P2）
   */
  noticeShown: true,
  stopWatch: null as (() => void) | null,

  onLoad() {
    // 别的页面看到了更新的绑定状态（解绑、换绑过；比如「我的」的回答晚到，顾客已经回到首页）：弹着的是之前那位会员的，马上关上、重新问
    this.stopWatch = watchBindVersion((v) => this.onBindVersion(v));
    const n = navMetrics();
    let width = 375;
    try {
      width = wx.getWindowInfo().windowWidth || width;
    } catch {
      // 用默认宽度
    }
    this.heroPx = (HERO_RPX * width) / 750 - n.statusBar - n.bar;
    this.setData({ statusBar: n.statusBar, bar: n.bar, capsuleRight: n.capsuleRight });
    this.load();
  },

  onUnload() {
    if (this.stopWatch) this.stopWatch();
    this.stopWatch = null;
    this.noticeShown = false;
  },

  onShow() {
    this.noticeShown = true;
    if (Date.now() - this.noticeAt > 30000) this.loadNotices();
  },

  /**
   * 离开首页：弹着的先收起来、离开之前发出去的回答作废，回来时重新问、问到了才弹（没看的照旧还会弹）。
   * 离开期间解绑、换绑了，旧会员的提醒不会在新的绑定状态到之前露出来（小程序线测试 280b08a 的 P1）
   */
  onHide() {
    // 弹着的、正在问的：回来时一定重新问；都没有的照旧 30 秒内不再问
    const pending = this.data.noticeOpen || this.noticeBusy;
    this.noticeShown = false;
    this.noticeRound += 1;
    if (this.data.noticeOpen) this.setData({ noticeOpen: false, notices: [], noticeCoupon: false });
    if (pending) this.noticeAt = 0;
  },

  /** 绑定状态版本号变新：弹着的是之前那位会员的，关上、重新问；正在问的那一次回来时按版本号核对（旧的丢掉、再问一次） */
  onBindVersion(v: number) {
    if (!this.data.noticeOpen || this.noticeVersion >= v) return;
    this.setData({ noticeOpen: false, notices: [], noticeCoupon: false });
    if (!this.noticeBusy) this.loadNotices();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  /** retry：丢掉旧回答以后再问的那一次（只再问一次，不会一直问）。不在首页时不问，约好回到首页再问 */
  async loadNotices(retry = false) {
    if (!this.noticeShown) {
      this.noticeAt = 0;
      return;
    }
    if (this.noticeBusy) {
      this.noticeAgain = true;
      return;
    }
    this.noticeBusy = true;
    this.noticeAt = Date.now();
    const round = this.noticeRound;
    let stale = false;
    try {
      const got = await loadNotices();
      // 离开过首页（这是离开之前发出去的）、现在不在首页：作废；回到首页时再问
      if (round !== this.noticeRound || !this.noticeShown) {
        this.noticeAt = 0;
        return;
      }
      // 问不到（断网、门店连不上、手机上的记录一时读不出来）：弹着的照旧
      if (got === null) return;
      // 换绑以前发出去、换绑以后才回来的旧回答：丢掉，按现在的绑定再问一次（小程序线测试 29aa0cc 的 P1）
      if (got.bindVersion !== null && got.bindVersion < latestBindVersion()) {
        stale = true;
        return;
      }
      const notices = got.bindVersion === null ? [] : got.notices.filter((n) => this.dismissed.indexOf(n.id) < 0);
      this.noticeVersion = got.bindVersion === null ? -1 : got.bindVersion;
      this.setData({ notices, noticeOpen: notices.length > 0, noticeCoupon: notices.some((n) => n.coupon) });
    } finally {
      this.noticeBusy = false;
      const again = this.noticeAgain || (stale && !retry);
      this.noticeAgain = false;
      // 这时不在首页的：不问，等回到首页再问（不在看不见的首页上弹，Codex 审查 83e74b3 的 P2）
      if (again) this.loadNotices(stale);
    }
  },

  /** 看过了：先关上，再记已读（记不上的下次打开补发，不打扰） */
  onNoticeOk() {
    const ids = this.data.notices.map((n) => n.id);
    this.setData({ noticeOpen: false, notices: [], noticeCoupon: false });
    this.noticeAt = Date.now();
    this.dismissed = this.dismissed.concat(ids).slice(-100);
    markRead(ids, this.noticeVersion);
  },

  onNoticeCoupons() {
    this.onNoticeOk();
    wx.navigateTo({ url: '/pages/coupons/index' });
  },

  /** 弹窗下面的页面不跟着滑 */
  onNoticeHold() {
    return;
  },

  async load() {
    if (!this.data.stores.length) this.setData({ status: 'loading' });
    try {
      const { data, stale } = await show<MpHome>('/v1/home');
      const stores = data.stores;
      const home = stores.filter((s) => s.isHome)[0];
      const keep = this.data.store ? stores.map((s) => s.code).indexOf(this.data.store.code) : -1;
      const storeIndex = keep >= 0 ? keep : Math.max(0, home ? stores.indexOf(home) : 0);
      this.setData({
        status: stores.length ? 'ready' : 'error',
        message: stores.length ? '' : '门店信息正在整理，请稍后再看',
        stale,
        stores,
        homeName: home ? home.name : '本店',
        banners: data.banners.map((b) => ({ ...b, src: imageUrl(b.imageId) })),
        current: 0,
      });
      this.pickStore(storeIndex);
    } catch (e) {
      // 已经有内容时（下拉刷新失败）照旧显示，只提示一下
      if (this.data.stores.length) wx.showToast({ title: messageOf(e), icon: 'none' });
      else this.setData({ status: 'error', message: messageOf(e) });
    }
  },

  pickStore(index: number) {
    const store = this.data.stores[index] || null;
    if (!store) return;
    const acts = (store.latitude !== null && store.longitude !== null ? 1 : 0) + (store.phone ? 1 : 0) + (store.isHome ? 1 : 0);
    this.setData({ storeIndex: index, store, actCount: acts, heroImage: store.imageId ? imageUrl(store.imageId) : '' });
  },

  onStore(e: WechatMiniprogram.TouchEvent) {
    this.pickStore(Number(e.currentTarget.dataset.index));
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    const solid = e.scrollTop > this.heroPx;
    if (solid === this.data.solid) return;
    this.setData({ solid });
    wx.setNavigationBarColor({ frontColor: solid ? '#000000' : '#ffffff', backgroundColor: '#F5F1EA' }).catch(() => undefined);
  },

  onBannerChange(e: WechatMiniprogram.SwiperChange) {
    this.setData({ current: e.detail.current });
  },

  onBanner(e: WechatMiniprogram.TouchEvent) {
    const b = this.data.banners[Number(e.currentTarget.dataset.index)];
    if (!b) return;
    if (b.link === 'prices') wx.switchTab({ url: '/pages/prices/index' });
    else if (b.link === 'guide') wx.switchTab({ url: '/pages/guide/index' });
    else if (b.link === 'store') wx.pageScrollTo({ selector: '#store', offsetTop: -(this.data.statusBar + this.data.bar + 8), duration: 300 });
  },

  onNavigate() {
    const s = this.data.store;
    if (!s || s.latitude === null || s.longitude === null) return;
    wx.openLocation({ latitude: s.latitude, longitude: s.longitude, name: '汤崎 TOUCHILL ' + s.name, address: s.address, scale: 16 });
  },

  onCall() {
    const s = this.data.store;
    if (!s || !s.phone) return;
    wx.makePhoneCall({ phoneNumber: s.phone.replace(/[^\d+-]/g, '') }).catch(() => undefined);
  },

  onGuide() {
    wx.switchTab({ url: '/pages/guide/index' });
  },

  onPillar(e: WechatMiniprogram.TouchEvent) {
    const p = String(e.currentTarget.dataset.p);
    if (p === 'experience') {
      wx.switchTab({ url: '/pages/guide/index' });
      return;
    }
    // TASTE：餐含在门票里，先看门票；WELLNESS：按摩、SPA、理疗
    appData().pricesTab = p === 'taste' ? 'tickets' : 'wellness';
    wx.switchTab({ url: '/pages/prices/index' });
  },

  onCode() {
    wx.navigateTo({ url: '/pages/code/index' });
  },

  onPrices() {
    wx.switchTab({ url: '/pages/prices/index' });
  },

  onContact() {
    if (this.data.store && this.data.store.phone) this.onCall();
    else wx.pageScrollTo({ selector: '#store', offsetTop: -(this.data.statusBar + this.data.bar + 8), duration: 300 });
  },

  onShareAppMessage() {
    return { title: '汤崎 TOUCHILL · 都市新旅生活目的地', path: '/pages/home/index' };
  },

  onShareTimeline() {
    return { title: '汤崎 TOUCHILL · 都市新旅生活目的地' };
  },
});
