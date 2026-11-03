// 会员码（MP9）：门店系统签发，每 60 秒换一次（前一分钟的也认）；到前台出示，扫码盒扫一下就认出会员，不用报手机号。
// 只用来认人，不代替用储值付款时的核对。门店连不上时拿不到新码，请到前台报手机号。打开时调亮屏幕、不息屏，离开时恢复。
import type { MpMe, MpMemberCode } from '../../../../src/shared/mp';
import { isApiError, isOffline, member, messageOf } from '../../utils/api';
import { groupCode } from '../../utils/format';
import { drawQr, encodeDigits } from '../../utils/qr';

const QR_RPX = 440;

Page({
  data: {
    state: 'loading' as 'loading' | 'ready' | 'unbound' | 'offline' | 'error',
    message: '',
    digits: '',
    left: 60,
    who: '',
    qrPx: 220,
  },
  timer: 0 as unknown as ReturnType<typeof setInterval> | 0,
  refreshAt: 0,
  busy: false,
  brightness: -1,
  /** 页面在前台：离开以后才回来的亮度回调不再调亮（否则离开后屏幕一直最亮） */
  visible: false,

  onLoad() {
    let width = 375;
    try {
      width = wx.getWindowInfo().windowWidth || width;
    } catch {
      // 用默认宽度
    }
    this.setData({ qrPx: Math.round((QR_RPX * width) / 750) });
    member<MpMe>('GET', '/v1/me')
      .then((me) => {
        if (me.member) this.setData({ who: me.member.name + ' · ' + me.member.grade.label });
      })
      .catch(() => undefined);
  },

  onShow() {
    this.visible = true;
    this.screen(true);
    this.refresh();
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
  },

  onHide() {
    this.stop();
  },

  onUnload() {
    this.stop();
  },

  stop() {
    this.visible = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
    this.screen(false);
  },

  /** 调亮屏幕、不息屏；离开时恢复原来的亮度 */
  screen(on: boolean) {
    wx.setKeepScreenOn({ keepScreenOn: on }).catch(() => undefined);
    if (on) {
      wx.getScreenBrightness({
        success: (r) => {
          // 读到亮度时已经离开了页面：不调亮（这时也没有要恢复的）
          if (!this.visible) return;
          if (this.brightness < 0) this.brightness = r.value;
          wx.setScreenBrightness({ value: 1 }).catch(() => undefined);
        },
      });
    } else if (this.brightness >= 0) {
      wx.setScreenBrightness({ value: this.brightness }).catch(() => undefined);
      this.brightness = -1;
    }
  },

  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      const c = await member<MpMemberCode>('POST', '/v1/code', {});
      // 按网关给的到期时间换码；手机时间不准时按 60 秒
      let ms = Date.parse(c.expiresAt) - Date.now();
      if (!isFinite(ms) || ms < 5000 || ms > c.refreshSeconds * 1000) ms = c.refreshSeconds * 1000;
      this.refreshAt = Date.now() + ms;
      this.setData({ state: 'ready', digits: groupCode(c.code), left: Math.ceil(ms / 1000) }, () => this.draw(c.code));
    } catch (e) {
      this.refreshAt = Date.now() + 15000;
      if (isApiError(e) && e.code === 'MP_NOT_BOUND') this.setData({ state: 'unbound' });
      else this.setData({ state: isOffline(e) ? 'offline' : 'error', message: messageOf(e) });
    }
    this.busy = false;
  },

  tick() {
    const left = Math.max(0, Math.ceil((this.refreshAt - Date.now()) / 1000));
    if (left !== this.data.left && this.data.state === 'ready') this.setData({ left });
    if (left <= 0) this.refresh();
  },

  draw(code: string) {
    this.createSelectorQuery()
      .select('#qr')
      .fields({ node: true, size: true })
      .exec((res: { node?: WechatMiniprogram.Canvas; width?: number }[]) => {
        const r = res && res[0];
        if (!r || !r.node) return;
        let dpr = 2;
        try {
          dpr = wx.getWindowInfo().pixelRatio || 2;
        } catch {
          // 用 2 倍
        }
        const px = r.width || this.data.qrPx;
        r.node.width = Math.round(px * dpr);
        r.node.height = Math.round(px * dpr);
        const ctx = r.node.getContext('2d');
        ctx.scale(dpr, dpr);
        drawQr(ctx as unknown as Parameters<typeof drawQr>[0], encodeDigits(code), px);
      });
  },

  onBind() {
    wx.switchTab({ url: '/pages/me/index' });
  },
});
