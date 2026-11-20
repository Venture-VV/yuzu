// 门店主导航的入口：主导航按它显示；ERP 顶栏的「返回门店」也按它判断门店那边有没有能用的页面、回到哪一页。
// 库存、采购、货款、待办在 ERP 工作区（v0.7.3，用户菜单「进入 ERP」），不在这里。

import {
  Banknote,
  BedDouble,
  CalendarCheck2,
  CalendarClock,
  ClipboardCheck,
  ConciergeBell,
  Hourglass,
  MapPinned,
  Printer,
  ReceiptText,
  ScanSearch,
  Settings2,
  UsersRound,
  UtensilsCrossed,
  HandHeart,
  BriefcaseBusiness,
} from 'lucide-react';
import { ADMIN_ENTRY_PERMISSIONS } from '@shared/admin';
import { deskEntries } from '@shared/frontdesk';
import type { Permission } from '@shared/permissions';
import { useCan, useSession } from '../lib/session';
import { DISH_PERMISSIONS } from '@shared/dishes';

export interface StoreNavItem {
  to: string;
  label: string;
  icon: typeof UsersRound;
  /** 拥有其中任一权限即显示 */
  perm: Permission | Permission[];
  end?: boolean;
  /** 额外条件，例如「钟房」只在技师功能开启后显示、「餐饮」「客房」只在对应功能开启后显示 */
  when?: (session: ReturnType<typeof useSession>) => boolean;
  /**
   * 对客页面（导览）：不算门店的工作页面。ERP 顶栏的「返回门店」不按它显示——所有岗位都能看导览，
   * 只用 ERP 的后勤照旧没有「返回门店」（v0.7.3 验收 E2）
   */
  guestFacing?: boolean;
}

// 前台与会员储值、管理后台是独立的业务组，导航中用分隔线区分
const STORE_NAV: StoreNavItem[][] = [
  [
    // 8.1.15（docs/DESKS_V8115.md）：原「前台」按业务环节拆成两个台——发卡台管入场（接待发牌、会员等级识别、换牌），
    // 收银台管离店结账（只读账单、预结账、结账、结账记录）。两个都按「查看在店手牌」显示，台里的操作照各自的权限
    // 8.1.15 前台 1 细化（YB2）：入口再按各自的权限分——有「接待发牌、挂账、换牌」的看得到发卡台，有「结账收款」的看得到收银台；
    // 两项都没有、只有查看的两个都看得到（进去只能看）。规则在 @shared/frontdesk 的 deskEntries
    { to: '/frontdesk', label: '发卡台', icon: ConciergeBell, perm: 'frontdesk.read', when: (s) => deskEntries(s.permissions).issue },
    { to: '/cashier', label: '收银台', icon: Banknote, perm: 'frontdesk.read', when: (s) => deskEntries(s.permissions).cashier },
    { to: '/clockroom', label: '钟房', icon: Hourglass, perm: 'technician.dispatch', when: (s) => s.technicians },
    // 8.0.8：看日结的（导出流水、经营总览）也能进来看「台账」「退菜记录」
    { to: '/dining', label: '餐饮', icon: UtensilsCrossed, perm: ['dining.order', 'dining.kitchen', 'frontdesk.checkout', 'ledger.export', 'report.executive'], when: (s) => s.dining },
    { to: '/rooms', label: '客房', icon: BedDouble, perm: ['room.operate', 'room.housekeep', 'frontdesk.checkout'], when: (s) => s.rooms },
    // 预约（v0.7.28 ③）：技师、派对房等、客房电话预订的预约看板；小程序的预约在这里确认
    { to: '/bookings', label: '预约', icon: CalendarClock, perm: 'booking.manage' },
    { to: '/', label: '会员', icon: UsersRound, end: true, perm: 'member.read' },
    { to: '/customer', label: '客户部', icon: BriefcaseBusiness, perm: 'customer.read' },
    // 管家部（8.0.12）：管家的日常工作页面（管家会员、人工余额、协调预约与接待、拍单、交班），与前台、预约、会员并列；
    // Codex 最初放在「管理后台」里，主线整改时挪到这里——后台是给店主、店总做设置与监管的，管家不该进后台
    { to: '/concierge', label: '管家', icon: HandHeart, perm: 'concierge.read' },
    { to: '/ledger', label: '流水', icon: ReceiptText, perm: 'ledger.readToday' },
    { to: '/settlement', label: '日结', icon: CalendarCheck2, perm: 'ledger.readToday' },
    { to: '/shift', label: '交班', icon: ClipboardCheck, perm: 'ledger.readToday' },
    // 看板 2026-11-10 起整合到后台「数据看板」（店主：统一在后台查看、管理）；门店的旧地址 /dashboard 跳过去
    // 他店查询（v0.7.23，会员体系 v2）：另一家店的同事按手机号或会员号查会员的档阶（只读）
    // 本店能看会员的岗位用会员工作台，不另显示
    { to: '/lookup', label: '会员查询', icon: ScanSearch, perm: 'member.lookup', when: (s) => !s.permissions.includes('member.read') },
    // 对客导览（v0.7.19）：所有岗位默认能看（区域导览图、大屏轮播）
    { to: '/guide', label: '导览', icon: MapPinned, perm: 'guide.view', guestFacing: true },
    // 设备（v0.7.21，RQ-001）：一屏看全部设备、本机终端
    { to: '/devices', label: '设备', icon: Printer, perm: 'device.view' },
    // 菜品管理（8.1.15，docs/DISHES_V8115.md，CP7）：平时是「餐饮」里的一个页签；只有菜品权限、进不了餐饮的岗位（少见）才显示这个入口
    { to: '/dishes', label: '菜品', icon: UtensilsCrossed, perm: [...DISH_PERMISSIONS], when: (s) => s.dining && !canEnter('/dining', s.permissions) },
  ],
  // 管理后台是单独的一套页面（规则、价目、手牌池、员工与权限、数据看板）；只有看板权限的岗位进去只看得到数据看板
  [{ to: '/admin', label: '后台', icon: Settings2, perm: [...ADMIN_ENTRY_PERMISSIONS] }],
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
  return STORE_NAV.map((group) => group.filter((n) => (Array.isArray(n.perm) ? n.perm : [n.perm]).some((p) => can(p)) && (!n.when || n.when(session)))).filter((group) => group.length > 0);
}

/** 这位账号的权限进不进得了主导航里的某个页面（只看权限，不看功能开没开） */
function canEnter(to: string, permissions: readonly Permission[]): boolean {
  const item = STORE_NAV.flat().find((n) => n.to === to);
  return !!item && (Array.isArray(item.perm) ? item.perm : [item.perm]).some((p) => permissions.includes(p));
}
