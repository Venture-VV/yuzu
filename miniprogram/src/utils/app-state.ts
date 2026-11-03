// 页面之间传的小状态：切换到底部标签页（switchTab）不能带参数，先放在这里，目标页 onShow 时取走。

export interface AppData {
  /** 价目表要打开的分类（首页的 TASTE、WELLNESS 用） */
  pricesTab: string | null;
}

export function appData(): AppData {
  return getApp<{ globalData: AppData }>().globalData;
}
