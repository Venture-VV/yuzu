// 发布以后在哪里换、什么时候换（工作台首页、发布与版本弹窗、提示里的说明；8.1.2 起不只平板）
import type { StudioSurface } from '@shared/studio';

export const SHOWN_ON: Record<StudioSurface, { where: string; when: string }> = {
  emenu: { where: '平板', when: '各台平板在停在起始页、或空闲回到起始页时换成新样子（客人点菜中途不换）' },
  mp: { where: '小程序', when: '客人下次打开小程序时换成新样子（小程序里的样子以小程序线照这份版面画的为准）' },
  canteen: { where: '员工手机', when: '员工下次打开员工食堂（或从别的应用切回来）时换成新样子' },
};
