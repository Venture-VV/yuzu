// 管理后台（v0.6.0）：后台与前台分开，规则设置集中在后台；每个分区按权限开放。
// 数据看板（店主 2026-11-10）：门店主导航原来的「看板」整合到后台，统一在后台查看、管理；原来能看看板的岗位照旧能看——
// 只有看板权限的岗位（值班经理、客户经理、收银）也能进后台，但只看得到「数据看板」这一个分区。

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
    perms: ['ledger.readToday', 'report.executive', 'report.members', 'member.retention', 'report.technicians', 'marketing.cost'],
  },
  settings: { path: '/admin/settings', label: '规则总表', perms: ['settings.manage', 'audit.read'] },
  // 8.0.17（IA5）：原来叫「经营规则」，与「规则总表」分不清，改叫「门店基本规则」（路径不变）
  rules: { path: '/admin/rules', label: '门店基本规则', perms: ['settings.manage'] },
  members: { path: '/admin/members', label: '渠道与标签', perms: ['settings.manage'] },
  // 会员体系 v2（v0.7.23，docs/MEMBERSHIP.md）：会员规则（店主、店总）；看板与到期提醒名单在「数据看板 → 会员体系」（客户经理不进后台）
  membership: { path: '/admin/membership', label: '会员规则', perms: ['member.rules'] },
  // 会员体系 v2 第二期（v0.7.24，docs/BENEFITS.md）：本店权益清单的导入、修改、发布与暂缓，本月发放与使用
  benefits: { path: '/admin/benefits', label: '会员权益', perms: ['benefit.publish'] },
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
  // 设备（RQ-001，v0.7.21，见 docs/HARDWARE.md）：设备登记、按采购清单导入、打印任务与设备事件；默认店主、店总
  devices: { path: '/admin/devices', label: '设备', perms: ['device.manage'] },
  // 微信小程序（小程序线，docs/MINIPROGRAM.md 第 5 节）：开关、门店信息、首页轮播、项目介绍、会员的微信绑定与解绑。
  // 进后台的权限不变（客户经理照旧不进后台，v0.6.0）：能进后台、又有这两项之一的才看得到
  mp: { path: '/admin/mp', label: '微信小程序', perms: ['mp.content', 'mp.unbind', 'mp.recharge', 'mp.coupon', 'mp.reminder', 'mp.invite', 'mp.food', 'mp.booking'] },
  staff: { path: '/admin/staff', label: '员工账号', perms: ['staff.manage'] },
  permissions: { path: '/admin/permissions', label: '岗位权限', perms: ['settings.manage', 'audit.read'] },
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
  { key: 'members', title: '会员与营销', items: ['membership', 'benefits', 'members', 'coupons'] },
  { key: 'business', title: '营业项目', items: ['catalog', 'tags', 'technicians', 'dining', 'emenu', 'rooms', 'bookings'] },
  { key: 'venue', title: '场地、设备与线上', items: ['spaces', 'devices', 'mp'] },
  { key: 'staff', title: '人员与权限', items: ['staff', 'permissions'] },
  { key: 'data', title: '数据与审计', items: ['audit', 'opening'] },
];
/** 能进后台首页、看后台各个设置分区的权限（有其一即可） */
export const ADMIN_PERMISSIONS: readonly Permission[] = ADMIN_SECTIONS.home.perms;
/** 能进后台的权限（有其一即可）：后台首页的权限，加上数据看板的权限（只有看板权限的只看得到数据看板） */
export const ADMIN_ENTRY_PERMISSIONS: readonly Permission[] = [...new Set<Permission>([...ADMIN_SECTIONS.home.perms, ...ADMIN_SECTIONS.dashboard.perms])];

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
  erp: 'ERP（审批中心、合同）',
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
