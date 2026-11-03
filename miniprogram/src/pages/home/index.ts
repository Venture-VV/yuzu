// 首页：版头大图加标志（首页轮播；没有轮播时用门店照片，再没有用木色底）、门店信息（两家店都显示，MP5）、
// 三块业务（TASTE、WELLNESS、EXPERIENCE）、服务入口、门店公告。门店连不上时用之前的信息并标出来。
import type { MpBanner, MpHome, MpStore } from '../../../../src/shared/mp';
import { imageUrl, messageOf, show } from '../../utils/api';
import { appData } from '../../utils/app-state';
import { navMetrics } from '../../utils/nav';

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
  },
  heroPx: 300,

  onLoad() {
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

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
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
