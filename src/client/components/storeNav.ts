// 门店主导航的入口：主导航按它显示；ERP 顶栏的「返回门店」也按它判断门店那边有没有能用的页面、回到哪一页。
// 库存、采购、货款、待办在 ERP 工作区（v0.7.3，用户菜单「进入 ERP」），不在这里。

import { BedDouble, CalendarCheck2, ClipboardCheck, ConciergeBell, Hourglass, LayoutDashboard, ReceiptText, Settings2, UsersRound, UtensilsCrossed } from 'lucide-react';
import { ADMIN_PERMISSIONS } from '@shared/admin';
import type { Permission } from '@shared/permissions';
import { useCan, useSession } from '../lib/session';

export interface StoreNavItem {
  to: string;
  label: string;
  icon: typeof UsersRound;
  /** 拥有其中任一权限即显示 */
  perm: Permission | Permission[];
  end?: boolean;
  /** 额外条件，例如「钟房」只在技师功能开启后显示、「餐饮」「客房」只在对应功能开启后显示 */
  when?: (session: ReturnType<typeof useSession>) => boolean;
}

// 前台与会员储值、管理后台是独立的业务组，导航中用分隔线区分
const STORE_NAV: StoreNavItem[][] = [
  [
    { to: '/frontdesk', label: '前台', icon: ConciergeBell, perm: 'frontdesk.read' },
    { to: '/clockroom', label: '钟房', icon: Hourglass, perm: 'technician.dispatch', when: (s) => s.technicians },
    { to: '/dining', label: '餐饮', icon: UtensilsCrossed, perm: ['dining.order', 'dining.kitchen', 'frontdesk.checkout'], when: (s) => s.dining },
    { to: '/rooms', label: '客房', icon: BedDouble, perm: ['room.operate', 'room.housekeep', 'frontdesk.checkout'], when: (s) => s.rooms },
    { to: '/', label: '会员', icon: UsersRound, end: true, perm: 'member.read' },
    { to: '/ledger', label: '流水', icon: ReceiptText, perm: 'ledger.readToday' },
    { to: '/settlement', label: '日结', icon: CalendarCheck2, perm: 'ledger.readToday' },
    { to: '/shift', label: '交班', icon: ClipboardCheck, perm: 'ledger.readToday' },
    { to: '/dashboard', label: '看板', icon: LayoutDashboard, perm: ['ledger.readToday', 'report.executive', 'report.members', 'report.technicians'] },
  ],
  // 管理后台是单独的一套页面（规则、价目、手牌池、员工与权限）
  [{ to: '/admin', label: '后台', icon: Settings2, perm: [...ADMIN_PERMISSIONS] }],
];

/**
 * 地址属于门店主导航里的哪个页面（会员工作台 / 除外：它是门店首页）。
 * 没有这个页面权限的人打开它时，门店外壳回到首页（与看板、后台一致；测试服 E2E 报告）。
 */
export function storePageOf(pathname: string): StoreNavItem | null {
  return STORE_NAV.flat().find((n) => n.to !== '/' && (pathname === n.to || pathname.startsWith(`${n.to}/`))) ?? null;
}

/** 当前账号在门店主导航里看得到的入口（按分组，去掉空的分组） */
export function useStoreNav(): StoreNavItem[][] {
  const can = useCan();
  const session = useSession();
  return STORE_NAV.map((group) => group.filter((n) => (Array.isArray(n.perm) ? n.perm : [n.perm]).some((p) => can(p)) && (!n.when || n.when(session)))).filter(
    (group) => group.length > 0,
  );
}
