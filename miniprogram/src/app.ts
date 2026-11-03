// 汤崎 TOUCHILL 微信小程序（小程序线，docs/MINIPROGRAM.md）。只连小程序网关；会员、余额、券都由门店系统（yuzu）算好，小程序只显示。
import type { AppData } from './utils/app-state';
import { ensureSession } from './utils/api';

App<{ globalData: AppData }>({
  globalData: { pricesTab: null },
  onLaunch() {
    // 先在后台登录好；失败不要紧，用到会员功能时再登录
    ensureSession().catch(() => undefined);
  },
});
