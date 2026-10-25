// 岗位权限矩阵（模拟规则，待店主确认）。
// 所有接口与页面都从这里判断权限，确认后只需修改此文件。

export const ROLES = ['owner', 'clerk'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  'member.read': ['owner', 'clerk'],
  'member.write': ['owner', 'clerk'],
  'recharge.create': ['owner', 'clerk'],
  /** 不按套餐、手动填写赠金 */
  'recharge.customBonus': ['owner'],
  'consume.create': ['owner', 'clerk'],
  /** 不在项目列表里的手动金额 */
  'consume.customAmount': ['owner', 'clerk'],
  'consume.reverse': ['owner'],
  /** 当前营业日的流水与日结汇总 */
  'ledger.readToday': ['owner', 'clerk'],
  /** 历史营业日的流水与日结 */
  'ledger.readHistory': ['owner'],
  'ledger.export': ['owner'],
  'settlement.close': ['owner'],
  'staff.manage': ['owner'],
  'catalog.manage': ['owner'],
  'settings.manage': ['owner'],
  'audit.read': ['owner'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function permissionsOf(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}

export const PERMISSION_LABELS: Record<Permission, string> = {
  'member.read': '查找与查看会员',
  'member.write': '新建与编辑会员',
  'recharge.create': '确认充值入账',
  'recharge.customBonus': '自定义赠金（不按套餐）',
  'consume.create': '登记消费扣款',
  'consume.customAmount': '手动输入消费金额',
  'consume.reverse': '撤销消费（整单）',
  'ledger.readToday': '查看当日流水与日结',
  'ledger.readHistory': '查看历史营业日',
  'ledger.export': '导出流水与日结',
  'settlement.close': '确认日结',
  'staff.manage': '管理员工账号',
  'catalog.manage': '管理充值套餐与消费项目',
  'settings.manage': '修改经营规则设置',
  'audit.read': '查看操作审计',
};
