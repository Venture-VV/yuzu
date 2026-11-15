// 活动页（8.1.2，docs/STUDIO_MP.md 第 2、5 节）：由 UI 工作台发布的 activity 屏驱动；
// 每次进页面（onShow）、下拉刷新都重新拉取版面，定时发布到点立即切换；门店还没发布版面时显示简洁兜底并可回首页。
import type { MpBanner, MpHome, MpMe, MpStore, MpStudioAction } from '../../../../src/shared/mp';
import { imageUrl, latestBindVersion, member, show, watchBindVersion } from '../../utils/api';
import { cardView } from '../../utils/member-card';
import type { CardView } from '../../utils/member-card';
import { currentStudio, currentThemeStyle, refreshStudio, studioAssetUrl, watchStudio } from '../../utils/studio';
import { prepareScreenRender, runMpStudioAction, screenUsesMemberField } from '../../utils/studio-style';
import type { RenderScreen } from '../../utils/studio-style';

type Banner = MpBanner & { src: string };

Page({
  data: {
    themeStyle: '',
    stale: false,
    store: null as MpStore | null,
    banners: [] as Banner[],
    current: 0,
    heroImage: '',
    studioScreen: null as RenderScreen | null,
  },
  studioCard: null as CardView | null,
  studioCardVersion: -1,
  memberRound: 0,
  shown: true,
  stopStudio: null as (() => void) | null,
  stopBind: null as (() => void) | null,

  onLoad() {
    this.shown = true;
    this.syncStudio();
    this.stopStudio = watchStudio(() => {
      this.syncStudio();
      this.maybeLoadMember();
    });
    this.stopBind = watchBindVersion((v) => {
      if (this.studioCard && v > this.studioCardVersion) {
        this.studioCard = null;
        this.studioCardVersion = -1;
        this.syncStudio();
      }
      if (this.shown) this.maybeLoadMember();
    });
    refreshStudio().catch(() => undefined);
    this.loadHome();
    this.maybeLoadMember();
  },

  onShow() {
    this.shown = true;
    refreshStudio().catch(() => undefined);
    this.maybeLoadMember();
  },

  onHide() {
    this.shown = false;
    this.memberRound += 1;
    if (this.studioCard) {
      this.studioCard = null;
      this.studioCardVersion = -1;
      this.syncStudio();
    }
  },

  onUnload() {
    this.shown = false;
    if (this.stopStudio) this.stopStudio();
    if (this.stopBind) this.stopBind();
    this.stopStudio = null;
    this.stopBind = null;
  },

  onPullDownRefresh() {
    Promise.all([refreshStudio().catch(() => null), this.loadHome(), this.maybeLoadMember()]).then(() => wx.stopPullDownRefresh());
  },

  syncStudio() {
    const active = currentStudio();
    const themeStyle = currentThemeStyle();
    const studioScreen = active
      ? prepareScreenRender(active.doc, 'activity', { store: this.data.store, card: this.studioCard }, studioAssetUrl)
      : null;
    this.setData({ themeStyle, studioScreen });
  },

  async loadHome() {
    try {
      const { data, stale } = await show<MpHome>('/v1/home');
      const home = data.stores.filter((s) => s.isHome)[0] || data.stores[0] || null;
      this.setData({
        stale,
        store: home,
        banners: data.banners.map((b) => ({ ...b, src: imageUrl(b.imageId) })),
        current: 0,
        heroImage: home && home.imageId ? imageUrl(home.imageId) : '',
      });
      this.syncStudio();
    } catch {
      // 门店信息没取到时：静态的海报、文字与按钮照画，数据字段留空
    }
  },

  async maybeLoadMember() {
    const active = currentStudio();
    if (!active || !screenUsesMemberField(active.doc.screens.activity)) {
      if (this.studioCard) {
        this.studioCard = null;
        this.studioCardVersion = -1;
        this.syncStudio();
      }
      return;
    }
    const round = this.memberRound;
    try {
      const me = await member<MpMe>('GET', '/v1/me');
      if (!this.shown || round !== this.memberRound) return;
      if (typeof me.bindVersion === 'number' && me.bindVersion < latestBindVersion()) return;
      this.studioCard = me.bound && me.member ? cardView(me.member) : null;
      this.studioCardVersion = typeof me.bindVersion === 'number' ? me.bindVersion : -1;
      this.syncStudio();
    } catch {
      if (!this.shown || round !== this.memberRound) return;
      this.studioCard = null;
      this.studioCardVersion = -1;
      this.syncStudio();
    }
  },

  onBannerChange(e: WechatMiniprogram.SwiperChange) {
    this.setData({ current: e.detail.current });
  },

  onBanner(e: WechatMiniprogram.TouchEvent) {
    const b = this.data.banners[Number(e.currentTarget.dataset.index)];
    if (!b) return;
    if (b.link === 'prices') wx.switchTab({ url: '/pages/prices/index' });
    else if (b.link === 'guide') wx.switchTab({ url: '/pages/guide/index' });
    else if (b.link === 'store') wx.switchTab({ url: '/pages/home/index' });
  },

  onStudioAction(e: WechatMiniprogram.CustomEvent<MpStudioAction>) {
    runMpStudioAction(e && e.detail, {
      store: this.data.store,
      cardFrozen: !!(this.studioCard && this.studioCard.frozen),
      currentRoute: 'pages/activity/index',
    });
  },

  onHome() {
    wx.switchTab({ url: '/pages/home/index' });
  },

  onShareAppMessage() {
    return { title: '汤崎 TOUCHILL · 近期活动', path: '/pages/activity/index' };
  },
});
