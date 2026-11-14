// 管理后台（v0.6.0）：后台与前台分开，规则设置集中在后台；每个分区按权限开放。
// 数据看板（店主 2026-11-10）：门店主导航原来的「看板」整合到后台，统一在后台查看、管理；原来能看看板的岗位照旧能看——
// 只有看板权限的岗位（值班经理、客户经理、收银）也能进后台，但只看得到「数据看板」这一个分区。

import type { ErpModuleKey } from './erp';
import type { InstanceKind } from './instance';
import type { EditableRole, Permission, Role, RoleOverrides } from './permissions';

/** 后台分区：路径、名称、所需权限（有其一即可） */
export const ADMIN_SECTIONS = {
  home: {
    path: '/admin',
    label: '后台首页',
    perms: ['settings.manage', 'catalog.manage', 'staff.manage', 'audit.read', 'wallet.opening', 'frontdesk.tags', 'technician.manage', 'coupon.manage', 'device.manage', 'member.rules', 'benefit.publish', 'emenu.manage'],
  },
  // 数据看板（原门店主导航的「看板」，店主 2026-11-10 整合到后台）：各页签照旧按权限显示——今日、经营总览、会员总览、会员体系、技师业绩、客房、营销成本
  dashboard: {
    path: '/admin/dashboard',
    label: '数据看板',
    // 8.0.18：ERP 的「营业数据」并进来（页签「营业数据」），带着原来的权限 erp.revenue
    perms: ['ledger.readToday', 'report.executive', 'report.members', 'member.retention', 'report.technicians', 'marketing.cost', 'erp.revenue'],
  },
  settings: { path: '/admin/settings', label: '规则总表', perms: ['settings.manage', 'audit.read'] },
  // 8.0.17（IA5）：原来叫「经营规则」，与「规则总表」分不清，改叫「门店基本规则」（路径不变）
  rules: { path: '/admin/rules', label: '门店基本规则', perms: ['settings.manage'] },
  // 会员体系（8.0.19，IA5）：原来的三个分区——会员规则（member.rules）、会员权益（benefit.publish）、渠道与标签（settings.manage）——
  // 合成一个，三个页签各自还是原来的权限（features/membership/MembershipSection）；有其中一项的就看得到这个分区。
  // 旧地址 /admin/benefits、/admin/members 跳过来
  membership: { path: '/admin/membership', label: '会员体系', perms: ['member.rules', 'benefit.publish', 'settings.manage'] },
  // 券与会员权益（v0.7.20，飞书 RQ-006 后半，见 docs/COUPONS.md）：券模板、发券规则、无记名券、统计；默认店主、店总
  coupons: { path: '/admin/coupons', label: '券', perms: ['coupon.manage'] },
  catalog: { path: '/admin/catalog', label: '价目与套餐', perms: ['catalog.manage'] },
  tags: { path: '/admin/tags', label: '手牌与前台', perms: ['frontdesk.tags', 'settings.manage'] },
  technicians: { path: '/admin/technicians', label: '技师', perms: ['technician.manage', 'settings.manage', 'catalog.manage', 'audit.read'] },
  dining: { path: '/admin/dining', label: '餐饮', perms: ['settings.manage', 'catalog.manage'] },
  // 电子菜单（8.0.10，docs/EMENU.md）：餐桌平板上的菜单——分类与版面、菜品图文、平板点餐的设置；默认店主、店总
  emenu: { path: '/admin/emenu', label: '电子菜单', perms: ['emenu.manage'] },
  rooms: { path: '/admin/rooms', label: '客房', perms: ['settings.manage', 'catalog.manage'] },
  // 预约（v0.7.28 ③）：能约的时段、小程序预约的限制、爽约规则
  bookings: { path: '/admin/bookings', label: '预约', perms: ['settings.manage'] },
  // 空间台账（RQ-004 第一段，v0.7.14）：店主、店总，与「客房」同一组权限
  spaces: { path: '/admin/spaces', label: '空间台账', perms: ['settings.manage', 'catalog.manage'] },
  // 对客导览（8.0.19）：原来是空间台账里的一个页签，是对客的内容（区域色块、设施图标、大屏轮播），单列出来；权限与空间台账相同
  guide: { path: '/admin/guide', label: '对客导览', perms: ['settings.manage', 'catalog.manage'] },
  // 设备（RQ-001，v0.7.21，见 docs/HARDWARE.md）：设备登记、按采购清单导入、打印任务与设备事件；默认店主、店总
  devices: { path: '/admin/devices', label: '设备', perms: ['device.manage'] },
  // 微信小程序（小程序线，docs/MINIPROGRAM.md 第 5 节）：开关、门店信息、首页轮播、项目介绍、会员的微信绑定与解绑。
  // 进后台的权限不变（客户经理照旧不进后台，v0.6.0）：能进后台、又有这两项之一的才看得到
  mp: { path: '/admin/mp', label: '微信小程序', perms: ['mp.content', 'mp.unbind', 'mp.recharge', 'mp.coupon', 'mp.reminder', 'mp.invite', 'mp.food', 'mp.booking'] },
  staff: { path: '/admin/staff', label: '员工账号', perms: ['staff.manage'] },
  permissions: { path: '/admin/permissions', label: '岗位权限', perms: ['settings.manage', 'audit.read'] },
  // 8.0.18（IA1，店主 2026-11-13）：员工食堂、安保巡场从 ERP 挪到后台「人员与行政」。页面、权限、接口都没变；
  // 开没开仍然按 ERP 的模块开关（ADMIN_SECTION_MODULES），员工手机端的入口不变
  canteen: { path: '/admin/canteen', label: '员工食堂', perms: ['canteen.manage'] },
  patrol: { path: '/admin/patrol', label: '安保巡场', perms: ['patrol.read', 'patrol.manage'] },
  opening: { path: '/admin/opening', label: '期初与旧账', perms: ['wallet.opening'] },
  audit: { path: '/admin/audit', label: '操作审计', perms: ['audit.read'] },
} as const satisfies Record<string, { path: string; label: string; perms: readonly Permission[] }>;

export type AdminSection = keyof typeof ADMIN_SECTIONS;

/**
 * 后台的一级分组（8.0.17，docs/IA_V8017.md 第 3.2 节）：侧栏、窄屏的横排、后台首页的分区卡片都按它排。
 * 每个分区必须在且只在一个分组里（tests/admin-ia.test.ts 核对）——8.0.16 以前分组写在侧栏的组件里，
 * 「设备」漏了，侧栏里一直没有它。
 */
export const ADMIN_GROUPS: readonly { key: string; title: string; items: readonly AdminSection[] }[] = [
  { key: 'overview', title: '概览', items: ['home', 'dashboard'] },
  { key: 'rules', title: '规则中心', items: ['settings', 'rules'] },
  { key: 'members', title: '会员与营销', items: ['membership', 'coupons'] },
  { key: 'business', title: '营业项目', items: ['catalog', 'tags', 'technicians', 'dining', 'emenu', 'rooms', 'bookings'] },
  { key: 'venue', title: '场地、设备与线上', items: ['spaces', 'guide', 'devices', 'mp'] },
  { key: 'staff', title: '人员与行政', items: ['staff', 'permissions', 'canteen', 'patrol'] },
  { key: 'data', title: '数据与审计', items: ['audit', 'opening'] },
];
/** 能进后台首页、看后台各个设置分区的权限（有其一即可） */
export const ADMIN_PERMISSIONS: readonly Permission[] = ADMIN_SECTIONS.home.perms;
/**
 * 不进后台首页也看得到的分区：数据看板（店主 2026-11-10），员工食堂、安保巡场（8.0.18，食堂负责人、安保主管原来只进 ERP）。
 * 只有这些分区的权限的岗位能进后台，但只看得到自己的这几个分区
 */
export const ADMIN_STANDALONE_SECTIONS: readonly AdminSection[] = ['dashboard', 'canteen', 'patrol'];
/** 跟着 ERP 模块开关走的分区：模块关着时只有能改模块开关的人还看得到（页面上提示去开启） */
export const ADMIN_SECTION_MODULES: Partial<Record<AdminSection, ErpModuleKey>> = { canteen: 'canteen', patrol: 'patrol' };
/** 能进后台的权限（有其一即可）：后台首页的权限，加上不进首页也看得到的那几个分区的权限 */
export const ADMIN_ENTRY_PERMISSIONS: readonly Permission[] = [
  ...new Set<Permission>([...ADMIN_SECTIONS.home.perms, ...ADMIN_STANDALONE_SECTIONS.flatMap((k) => ADMIN_SECTIONS[k].perms)]),
];

export const RULE_GROUPS = {
  store: '门店与营业',
  wallet: '储值与收款',
  members: '会员与渠道',
  frontdesk: '前台与结账',
  technicians: '技师',
  dining: '餐饮',
  emenu: '点餐系统（平板电子菜单）',
  rooms: '客房',
  bookings: '预约',
  floormap: '平面图与导览',
  locations: '实时位置',
  inventory: '库存与采购',
  erp: 'ERP（审批、合同、付款、报销）',
  workplace: '人员与行政（员工食堂、安保巡场）',
  staff: '岗位与权限',
} as const;
export type RuleGroup = keyof typeof RULE_GROUPS;

/** 规则总表的一行：当前值、默认值、是否改过、最近修改与去哪里改 */
export interface RuleEntry {
  key: string;
  group: RuleGroup;
  label: string;
  value: string;
  defaultValue: string;
  /** 与默认值相同（没改过，或改回了默认） */
  isDefault: boolean;
  /** 店主还没签认的默认做法（显示「待确认」；店主签认后隐藏标记） */
  pending: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  section: AdminSection;
  /** 在这个分区的哪个页签里改（8.0.19：会员体系的三个页签）；给了「去设置」就直达页签 */
  tab?: string;
  /**
   * 不在后台分区里改的规则去哪改（8.0.18）：ERP 的规则在「ERP 设置」的页签里（/erp/settings/purchase……）。
   * 给了就按它跳，没给的照旧去 section 那个分区
   */
  href?: string;
  hint?: string;
}

export interface AdminOverview {
  store: { name: string; instance: InstanceKind; version: string; commit: string; timezone: string; businessDayStartHour: number; businessHours: string };
  counts: {
    staffActive: number;
    staffByRole: Partial<Record<Role, number>>;
    members: number;
    membersNewToday: number;
    items: number;
    plans: number;
    tickets: number;
    tags: { active: number; locked: number; inactive: number };
    /** 在职技师人数（v0.7.0）与技师功能是否开启 */
    technicians: { active: number; enabled: boolean };
  };
  rules: { total: number; changed: number; pending: number };
  /** 最近的规则、价目、员工变动（没有查看审计权限时为 null） */
  recentChanges: { at: string; staffName: string | null; action: string; summary: string }[] | null;
}

/** 岗位权限：默认规则、店主的调整与生效结果 */
export interface RolePermissionMatrix {
  overrides: RoleOverrides;
  /** 各岗位（不含职责）生效的权限 */
  effective: Record<Role, Permission[]>;
  /** 各岗位的默认权限 */
  defaults: Record<Role, Permission[]>;
  updatedAt: string | null;
  updatedBy: string | null;
  /** 各岗位在职人数 */
  staffCount: Partial<Record<Role, number>>;
}

export type RolePermissionInput = Partial<Record<EditableRole, Permission[]>>;
