// 登录后的首页落在哪（App.tsx 的 Home 与平板电子菜单的退出共用，8.1.15）。

import type { Permission } from '@shared/permissions';

/**
 * 这个账号登录后的首页是不是平板电子菜单：「点餐平板」设备账号（8.0.10）只能打开点餐页。
 * 这样的账号没有主系统可回——在电子菜单里只有「退出登录」，没有「返回工作台」（否则跳到首页又被带回菜单）。
 * 判断与 Home 里的先后一致：能看会员的进会员工作台；只做设计的进工作台；然后才轮到电子菜单。
 */
export function homeIsEmenu(can: (p: Permission) => boolean): boolean {
  if (can('member.read')) return false;
  if (can('studio.edit') && !can('frontdesk.read')) return false;
  return can('emenu.view') && !can('frontdesk.read');
}
