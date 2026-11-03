// 首页用自定义导航栏（版头大图铺到状态栏下面）：按右上角胶囊按钮的位置算导航栏高度，标志与胶囊上下居中。

export interface NavMetrics {
  /** 状态栏高度（px） */
  statusBar: number;
  /** 导航栏（不含状态栏）高度（px） */
  bar: number;
  /** 胶囊左边到屏幕右边的距离（px）：标题不要压到胶囊 */
  capsuleRight: number;
}

let cached: NavMetrics | null = null;

export function navMetrics(): NavMetrics {
  if (cached) return cached;
  let statusBar = 20;
  let width = 375;
  try {
    const w = wx.getWindowInfo();
    statusBar = w.statusBarHeight || statusBar;
    width = w.windowWidth || width;
  } catch {
    // 老版本微信：用默认值
  }
  let bar = 44;
  let capsuleRight = 96;
  try {
    const c = wx.getMenuButtonBoundingClientRect();
    if (c && c.height) {
      bar = (c.top - statusBar) * 2 + c.height;
      capsuleRight = width - c.left + 8;
    }
  } catch {
    // 拿不到胶囊位置：用默认值
  }
  cached = { statusBar, bar, capsuleRight };
  return cached;
}
