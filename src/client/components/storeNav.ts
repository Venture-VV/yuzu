// 门店主导航的入口：主导航按它显示；ERP 顶栏的「返回门店」也按它判断门店那边有没有能用的页面、回到哪一页。
// 库存、采购、货款、待办在 ERP 工作区（v0.7.3，用户菜单「进入 ERP」），不在这里。
//
// 8.1.15（《浴族系统需求汇总》系统整体，docs/YUZU_REQ_V8115.md 3.G）：按业务域分成七组——前台、餐饮、房态、技师、
// 会员、财务、设置；每一组下面是二级入口。主导航展开时是带分组标题的侧栏（分组能折起来），收起时是一列业务域的
// 图标，点一下弹出这一组的二级入口（src/client/components/StoreRail.tsx）。新页面在对应的组里末尾加一行。

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
  Wallet,
  IdCard,
  Megaphone,
} from 'lucide-react';
import { ADMIN_ENTRY_PERMISSIONS } from '@shared/admin';
import { DISH_PERMISSIONS } from '@shared/dishes';
import { deskEntries } from '@shared/frontdesk';
import type { Permission } from '@shared/permissions';
import { useCan, useSession } from '../lib/session';

type Session = ReturnType<typeof useSession>;

export interface StoreNavItem {
  to: string;
  label: string;
  icon: typeof UsersRound;
  /** 拥有其中任一权限即显示 */
  perm: Permission | Permission[];
  end?: boolean;
  /** 额外条件，例如「钟房」只在技师功能开启后显示、「餐饮」「客房」只在对应功能开启后显示 */
  when?: (session: Session) => boolean;
  /**
   * 对客页面（导览）：不算门店的工作页面。ERP 顶栏的「返回门店」不按它显示——所有岗位都能看导览，
   * 只用 ERP 的后勤照旧没有「返回门店」（v0.7.3 验收 E2）
   */
  guestFacing?: boolean;
}

export type StoreNavDomainKey = 'frontdesk' | 'dining' | 'rooms' | 'technicians' | 'members' | 'finance' | 'settings';

export interface StoreNavDomain {
  key: StoreNavDomainKey;
  label: string;
  icon: typeof UsersRound;
  items: StoreNavItem[];
}

/** 房态中心里前台、钟房、收银那几样岗位的权限：有其中一样的不看客房功能开没开都有入口 */
const ROOM_CENTER_DESK_PERMISSIONS: readonly Permission[] = ['room.operate', 'technician.dispatch', 'frontdesk.checkout'];

const STORE_NAV: StoreNavDomain[] = [
  {
    key: 'frontdesk',
    label: '前台',
    icon: ConciergeBell,
    items: [
      // 8.1.15（docs/DESKS_V8115.md）：原「前台」按业务环节拆成两个台——发卡台管入场（接待发牌、会员等级识别、换牌），
      // 收银台管离店结账（只读账单、预结账、结账、结账记录）。两个都按「查看在店手牌」显示，台里的操作照各自的权限
      // 8.1.15 前台 1 细化（YB2）：入口再按各自的权限分——有「接待发牌、挂账、换牌」的看得到发卡台，有「结账收款」的看得到收银台；
      // 两项都没有、只有查看的两个都看得到（进去只能看）。规则在 @shared/frontdesk 的 deskEntries
      { to: '/frontdesk', label: '发卡台', icon: ConciergeBell, perm: 'frontdesk.read', when: (s) => deskEntries(s.permissions).issue },
      { to: '/cashier', label: '收银台', icon: Banknote, perm: 'frontdesk.read', when: (s) => deskEntries(s.permissions).cashier },
      // 预约（v0.7.28 ③）：技师、派对房等、客房电话预订的预约看板；小程序的预约在这里确认
      { to: '/bookings', label: '预约', icon: CalendarClock, perm: 'booking.manage' },
    ],
  },
  {
    key: 'dining',
    label: '餐饮',
    icon: UtensilsCrossed,
    items: [
      // 8.0.8：看日结的（导出流水、经营总览）也能进来看「台账」
      { to: '/dining', label: '餐饮', icon: UtensilsCrossed, perm: ['dining.order', 'dining.kitchen', 'frontdesk.checkout', 'ledger.export', 'report.executive'], when: (s) => s.dining },
      // 菜品管理（8.1.15，docs/DISHES_V8115.md，CP7）：平时是「餐饮」里的一个页签；只有菜品权限、进不了餐饮的岗位（少见）才显示这个入口
      { to: '/dishes', label: '菜品', icon: UtensilsCrossed, perm: [...DISH_PERMISSIONS], when: (s) => s.dining && !canEnter('/dining', s.permissions) },
    ],
  },
  {
    key: 'rooms',
    label: '房态',
    icon: BedDouble,
    items: [
      // 房态中心（8.1.16，docs/ROOM_CENTER_V8115.md）：按房型看全部房间的状态，原来的「客房」页（房态看板、平面图、派对房）并进来（/rooms 跳过去）。
      // 不看客房功能开没开：技师服务的房间、派对房、大厅都在这里；能看房态中心的岗位（客房、钟房、收银）都有入口。
      // 只有「客房打扫、维修」的（后勤账号，库存、采购、财务也是后勤）照 8.1.15 以前的「客房」入口，客房功能开着才有：
      // 不然只用 ERP 的人都多出门店主导航与「返回门店」（FT11 补充，待确认）
      {
        to: '/room-center',
        label: '房态中心',
        icon: BedDouble,
        perm: ['room.operate', 'room.housekeep', 'technician.dispatch', 'frontdesk.checkout'],
        when: (s) => s.rooms || ROOM_CENTER_DESK_PERMISSIONS.some((p) => s.permissions.includes(p)),
      },
    ],
  },
  {
    key: 'technicians',
    label: '技师',
    icon: Hourglass,
    items: [
      { to: '/clockroom', label: '钟房', icon: Hourglass, perm: 'technician.dispatch', when: (s) => s.technicians },
      // 排位播报（8.2.0 P03，回测 4-1）：从钟房里移出来，与钟房同级；权限单独授，排位员可以只有这一项
      { to: '/announcer', label: '排位播报', icon: Megaphone, perm: ['technician.announce', 'technician.dispatch'], when: (s) => s.technicians },
      // 技师管理（8.1.16 块 E，docs/TECHNICIANS_V8115.md）：技师名册、组别、班次与排班、休假；钟房的岗位能看、能替技师申请休假
      { to: '/technicians', label: '技师管理', icon: IdCard, perm: ['technician.manage', 'technician.dispatch'], when: (s) => s.technicians },
    ],
  },
  {
    key: 'members',
    label: '会员',
    icon: UsersRound,
    items: [
      { to: '/', label: '会员', icon: UsersRound, end: true, perm: 'member.read' },
      // 他店查询（v0.7.23，会员体系 v2）：另一家店的同事按手机号或会员号查会员的档阶（只读）；本店能看会员的岗位用会员工作台，不另显示
      { to: '/lookup', label: '会员查询', icon: ScanSearch, perm: 'member.lookup', when: (s) => !s.permissions.includes('member.read') },
      { to: '/customer', label: '客户部', icon: BriefcaseBusiness, perm: 'customer.read' },
      // 管家部（8.0.12）：管家的日常工作页面（管家会员、人工余额、协调预约与接待、拍单、交班）；后台是给店主、店总做设置与监管的，管家不进后台
      { to: '/concierge', label: '管家', icon: HandHeart, perm: 'concierge.read' },
    ],
  },
  {
    key: 'finance',
    label: '财务',
    icon: Wallet,
    items: [
      { to: '/ledger', label: '流水', icon: ReceiptText, perm: 'ledger.readToday' },
      { to: '/settlement', label: '日结', icon: CalendarCheck2, perm: 'ledger.readToday' },
      { to: '/shift', label: '交班', icon: ClipboardCheck, perm: 'ledger.readToday' },
      // 看板 2026-11-10 起整合到后台「数据看板」（店主：统一在后台查看、管理）；门店的旧地址 /dashboard 跳过去
    ],
  },
  {
    key: 'settings',
    label: '设置',
    icon: Settings2,
    items: [
      // 设备（v0.7.21，RQ-001）：一屏看全部设备、本机终端
      { to: '/devices', label: '设备', icon: Printer, perm: 'device.view' },
      // 对客导览（v0.7.19）：所有岗位默认能看（区域导览图、大屏轮播）
      { to: '/guide', label: '导览', icon: MapPinned, perm: 'guide.view', guestFacing: true },
      // 管理后台是单独的一套页面（规则、价目、手牌池、员工与权限、数据看板）；只有看板权限的岗位进去只看得到数据看板
      { to: '/admin', label: '后台', icon: Settings2, perm: [...ADMIN_ENTRY_PERMISSIONS] },
    ],
  },
];

const ALL_ITEMS = STORE_NAV.flatMap((d) => d.items.map((item) => ({ item, domain: d.key })));

/** 这位账号的权限进不进得了主导航里的某个页面（只看权限，不看功能开没开） */
function canEnter(to: string, permissions: readonly Permission[]): boolean {
  const item = ALL_ITEMS.find(({ item: n }) => n.to === to)?.item;
  return !!item && (Array.isArray(item.perm) ? item.perm : [item.perm]).some((p) => permissions.includes(p));
}

/** 一个入口管不管这个地址（会员工作台 / 只认它自己） */
function covers(item: StoreNavItem, pathname: string): boolean {
  if (item.to === '/') return pathname === '/';
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/**
 * 地址属于门店主导航里的哪个页面（会员工作台 / 除外：它是门店首页）。
 * 没有这个页面权限的人打开它时，门店外壳回到首页（与看板、后台一致；测试服 E2E 报告）。
 */
export function storePageOf(pathname: string): StoreNavItem | null {
  return ALL_ITEMS.find(({ item }) => item.to !== '/' && covers(item, pathname))?.item ?? null;
}

/** 地址属于哪个业务域（主导航里这一组标成当前、展开时默认打开）；不属于任何一组（改密码、网络与同步）为 null */
export function storeDomainOf(pathname: string): StoreNavDomainKey | null {
  return ALL_ITEMS.find(({ item }) => covers(item, pathname))?.domain ?? null;
}

/** 按权限与功能开关筛过的主导航：去掉看不到的入口与空了的组（纯函数，便于用例直接核对） */
export function visibleStoreNav(can: (p: Permission) => boolean, session: Session): StoreNavDomain[] {
  return STORE_NAV.map((d) => ({ ...d, items: d.items.filter((n) => (Array.isArray(n.perm) ? n.perm : [n.perm]).some((p) => can(p)) && (!n.when || n.when(session))) })).filter(
    (d) => d.items.length > 0,
  );
}

/** 当前账号在门店主导航里看得到的业务域与入口 */
export function useStoreNav(): StoreNavDomain[] {
  return visibleStoreNav(useCan(), useSession());
}

/**
 * 看得到的入口排成一列，按 8.1.15 分组以前的老顺序（发卡台、收银台、钟房、餐饮、客房〔8.1.16 起是房态中心〕、预约、会员……）。
 * ERP 顶栏的「返回门店」回到其中第一个能用的页面：分组以后各岗位回到哪一页照旧不变。
 */
const LEGACY_ORDER = [
  '/frontdesk',
  '/cashier',
  '/clockroom',
  '/announcer',
  '/dining',
  '/room-center',
  '/bookings',
  '/',
  '/customer',
  '/concierge',
  '/ledger',
  '/settlement',
  '/shift',
  '/lookup',
  '/guide',
  '/devices',
  '/dishes',
  '/admin',
];
const legacyRank = (to: string) => {
  const i = LEGACY_ORDER.indexOf(to);
  return i < 0 ? LEGACY_ORDER.length : i;
};

export function useStoreNavItems(): StoreNavItem[] {
  return useStoreNav()
    .flatMap((d) => d.items)
    .sort((a, b) => legacyRank(a.to) - legacyRank(b.to));
}
