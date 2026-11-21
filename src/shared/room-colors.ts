// 房态四色（8.2.0 P01，《浴族系统 8.1.15–8.1.18 回测问题汇总》3-2，docs/YUZU_REQ_V820.md 第 2 节）：
// 空闲 绿、在用 蓝、待清 黄、维修 红，色相与明度都拉开。房态中心的卡片（底色、左侧色条、状态点）、数量与筛选、房型汇总、
// 房态图与图例都从这一张表取色；样式表里的 --color-room-* 是同一组值（浅色主题，tests/room-colors.test.ts 逐个核对），
// 深色主题另有一组。其他业务状态不用这四色（同一个测试查页面代码里只有房态的几个文件用到 room-*）。

export const ROOM_COLOR_STATES = ['free', 'in_use', 'dirty', 'maintenance'] as const;
export type RoomColorState = (typeof ROOM_COLOR_STATES)[number];

export interface RoomColor {
  /** 主色：左侧色条、状态点、房态图的轮廓 */
  solid: string;
  /** 卡片底色、选中的筛选项底色 */
  soft: string;
  /** 写在浅底上的字（对比度 ≥ 4.5 : 1） */
  ink: string;
  /** 房态图上的填充（白底画布，比卡片底色深一档才看得出） */
  map: string;
}

/** 浅色主题（房态图的画布在深色主题里照旧是白底，也用这一组） */
export const ROOM_COLORS: Record<RoomColorState, RoomColor> = {
  free: { solid: '#2e9d58', soft: '#e2f4e8', ink: '#1a6b3a', map: '#a5dbb8' },
  in_use: { solid: '#2563d0', soft: '#e1eafb', ink: '#1d4ea6', map: '#a3c0f2' },
  dirty: { solid: '#e3b000', soft: '#fcf1c6', ink: '#735400', map: '#f6dc7a' },
  maintenance: { solid: '#d43c3c', soft: '#fbe2e2', ink: '#a32727', map: '#f2a7a7' },
};
