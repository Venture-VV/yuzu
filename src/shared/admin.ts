// 管理后台（v0.6.0）：后台与前台分开，规则设置集中在后台；每个分区按权限开放。

import type { InstanceKind } from './instance';
import type { EditableRole, Permission, Role, RoleOverrides } from './permissions';

/** 后台分区：路径、名称、所需权限（有其一即可） */
export const ADMIN_SECTIONS = {
  home: { path: '/admin', label: '后台首页', perms: ['settings.manage', 'catalog.manage', 'staff.manage', 'audit.read', 'wallet.opening', 'frontdesk.tags', 'technician.manage'] },
  settings: { path: '/admin/settings', label: '规则总表', perms: ['settings.manage', 'audit.read'] },
  rules: { path: '/admin/rules', label: '经营规则', perms: ['settings.manage'] },
  members: { path: '/admin/members', label: '会员与渠道', perms: ['settings.manage'] },
  catalog: { path: '/admin/catalog', label: '价目与套餐', perms: ['catalog.manage'] },
  tags: { path: '/admin/tags', label: '手牌与前台', perms: ['frontdesk.tags', 'settings.manage'] },
  technicians: { path: '/admin/technicians', label: '技师', perms: ['technician.manage', 'settings.manage', 'catalog.manage', 'audit.read'] },
  staff: { path: '/admin/staff', label: '员工账号', perms: ['staff.manage'] },
  permissions: { path: '/admin/permissions', label: '岗位权限', perms: ['settings.manage', 'audit.read'] },
  opening: { path: '/admin/opening', label: '期初导入', perms: ['wallet.opening'] },
  audit: { path: '/admin/audit', label: '操作审计', perms: ['audit.read'] },
} as const satisfies Record<string, { path: string; label: string; perms: readonly Permission[] }>;

export type AdminSection = keyof typeof ADMIN_SECTIONS;
/** 能进后台的权限（有其一即可） */
export const ADMIN_PERMISSIONS: readonly Permission[] = ADMIN_SECTIONS.home.perms;

export const RULE_GROUPS = {
  store: '门店与营业',
  wallet: '储值与收款',
  members: '会员与渠道',
  frontdesk: '前台与结账',
  technicians: '技师',
  inventory: '库存与采购',
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
