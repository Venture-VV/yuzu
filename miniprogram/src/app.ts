// 汤崎 TOUCHILL 微信小程序（小程序线，docs/MINIPROGRAM.md）。只连小程序网关；会员、余额、券都由门店系统（yuzu）算好，小程序只显示。
import type { AppData } from './utils/app-state';
import { ensureSession } from './utils/api';
import { installStudioPageHook, refreshStudio } from './utils/studio';

installStudioPageHook();

App<{ globalData: AppData }>({
  globalData: { pricesTab: null },
  onLaunch() {
    // 先在后台登录好；失败不要紧，用到会员功能时再登录
    ensureSession().catch(() => undefined);
    refreshStudio().catch(() => undefined);
  },
  onShow() {
    // 设计师可以定时发布：每次小程序切回前台都重新问一次当前已发布的版面
    refreshStudio().catch(() => undefined);
  },
});
