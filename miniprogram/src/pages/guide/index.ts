// 楼层导览（对客，只到区域）：门店后台「空间台账 → 对客导览」配好的区域色块、中英文名、设施图标，按楼层画在画布上；
// 底图线稿（去掉了图上文字）半透明垫在下面，拿不到底图时只画色块。点「看大图」用微信的看图放大。
import type { GuideData } from '../../../../src/shared/guide';
import { gatewayBase } from '../../config/env';
import { messageOf, show } from '../../utils/api';
import { drawFloor, fitFloor, legendOf, sortFloorCodes } from '../../utils/guide-draw';

interface Base {
  image: unknown;
  width: number;
  height: number;
}

Page({
  data: {
    status: 'loading' as 'loading' | 'ready' | 'empty' | 'error',
    message: '',
    stale: false,
    floors: [] as { code: string; title: string }[],
    floor: '',
    mapHeight: 0,
    legend: { zones: [], facilities: [] } as ReturnType<typeof legendOf>,
  },
  guide: null as GuideData | null,
  canvas: null as WechatMiniprogram.Canvas | null,
  /** 底图按「批次:楼层」缓存：后台换了底图批次，下拉刷新后不再垫着旧图 */
  bases: {} as Record<string, Base | 'loading' | 'failed'>,
  width: 343,
  maxHeight: 480,

  onLoad() {
    try {
      const w = wx.getWindowInfo();
      // 页面左右各留 36rpx
      this.width = Math.floor(w.windowWidth - (72 * w.windowWidth) / 750);
      this.maxHeight = Math.max(this.width * 0.75, Math.min(this.width * 1.4, w.windowHeight * 0.62));
    } catch {
      // 用默认尺寸
    }
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    if (!this.guide) this.setData({ status: 'loading' });
    try {
      const { data, stale } = await show<GuideData>('/v1/guide');
      // 换了底图批次：旧批次的底图都不要了（还在加载的，回来时按批次核对、不会写进来）
      if (!this.guide || this.guide.batchId !== data.batchId) this.bases = {};
      this.guide = data;
      const floors = sortFloorCodes(data.floors).map((f) => ({ code: f.code, title: f.title || f.code }));
      if (!floors.length || data.batchId === null) {
        this.setData({ status: 'empty', stale, floors: [] });
        return;
      }
      const keep = floors.some((f) => f.code === this.data.floor) ? this.data.floor : floors[0]!.code;
      this.setData({ status: 'ready', stale, floors });
      this.pick(keep);
    } catch (e) {
      if (this.guide) wx.showToast({ title: messageOf(e), icon: 'none' });
      else this.setData({ status: 'error', message: messageOf(e) });
    }
  },

  onFloor(e: WechatMiniprogram.TouchEvent) {
    this.pick(String(e.currentTarget.dataset.code));
  },

  pick(code: string) {
    const g = this.guide;
    if (!g) return;
    const floor = g.floors.filter((f) => f.code === code)[0];
    if (!floor) return;
    const fit = fitFloor(floor, this.width, this.maxHeight);
    const zones = g.zones.filter((z) => z.floorCode === code);
    const markers = g.markers.filter((m) => m.floorCode === code);
    this.setData({ floor: code, mapHeight: fit.height, legend: legendOf(zones, markers) }, () => this.draw());
  },

  /** 画当前楼层；底图第一次用到时去取，取到后再画一遍 */
  draw() {
    const g = this.guide;
    const code = this.data.floor;
    const floor = g ? g.floors.filter((f) => f.code === code)[0] : undefined;
    if (!g || !floor) return;
    this.createSelectorQuery()
      .select('#map')
      .fields({ node: true, size: true })
      .exec((res: { node?: WechatMiniprogram.Canvas; width?: number; height?: number }[]) => {
        const r = res && res[0];
        if (!r || !r.node) return;
        const canvas = r.node;
        this.canvas = canvas;
        let dpr = 2;
        try {
          dpr = wx.getWindowInfo().pixelRatio || 2;
        } catch {
          // 用 2 倍
        }
        // 比屏幕再清楚一点，看大图时字不糊；最大 2048 像素宽
        const ratio = Math.min(dpr * 1.5, 2048 / (r.width || this.width));
        const fit = fitFloor(floor, r.width || this.width, this.maxHeight);
        canvas.width = Math.round(fit.width * ratio);
        canvas.height = Math.round(fit.height * ratio);
        const ctx = canvas.getContext('2d');
        ctx.scale(ratio, ratio);
        const base = this.bases[g.batchId + ':' + code];
        drawFloor(
          ctx as unknown as Parameters<typeof drawFloor>[0],
          fit,
          g.zones.filter((z) => z.floorCode === code),
          g.markers.filter((m) => m.floorCode === code),
          base && base !== 'loading' && base !== 'failed' ? base : null,
        );
        if (!base) this.loadBase(canvas, code, floor.width, floor.height, g.batchId);
      });
  },

  loadBase(canvas: WechatMiniprogram.Canvas, code: string, width: number, height: number, batchId: number | null) {
    if (batchId === null) return;
    const key = batchId + ':' + code;
    this.bases[key] = 'loading';
    // 图回来时底图批次已经换了：不写进缓存、不重画
    const current = () => !!this.guide && this.guide.batchId === batchId;
    const img = canvas.createImage();
    img.onload = () => {
      if (!current()) return;
      this.bases[key] = { image: img, width, height };
      if (this.data.floor === code) this.draw();
    };
    img.onerror = () => {
      // 有的手机画布不认 SVG：只画色块
      if (current()) this.bases[key] = 'failed';
    };
    img.src = gatewayBase() + '/v1/guide/floors/' + encodeURIComponent(code) + '/svg?b=' + batchId;
  },

  onZoom() {
    if (!this.canvas) return;
    wx.canvasToTempFilePath({
      canvas: this.canvas,
      fileType: 'png',
      success: (r) => wx.previewImage({ urls: [r.tempFilePath], current: r.tempFilePath }),
      fail: () => wx.showToast({ title: '图片打不开，请稍后再试', icon: 'none' }),
    });
  },

  onShareAppMessage() {
    return { title: '汤崎 TOUCHILL · 楼层导览', path: '/pages/guide/index' };
  },
});
