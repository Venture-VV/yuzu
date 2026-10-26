// 岗位与职责权限（模拟规则，待店主确认）。
// 所有接口与页面都从这里判断权限，确认后只需修改此文件。
//
// 岗位决定会员业务权限；库存与采购权限来自可叠加的「职责」，一人可兼任多项。
// 增加库存职责不会带来会员钱包、充值撤销或全店财务查看权限。

export const ROLES = ['owner', 'clerk', 'backoffice'] as const;
export type Role = (typeof ROLES)[number];

export const DUTIES = ['stock', 'purchase', 'payable', 'approve'] as const;
export type Duty = (typeof DUTIES)[number];

export interface PermissionSubject {
  role: Role;
  duties?: readonly Duty[];
}

interface Rule {
  roles: readonly Role[];
  duties?: readonly Duty[];
}

export const PERMISSIONS = {
  // ── 会员与储值 ──
  'member.read': { roles: ['owner', 'clerk'] },
  'member.write': { roles: ['owner', 'clerk'] },
  'recharge.create': { roles: ['owner', 'clerk'] },
  /** 不按套餐、手动填写赠金 */
  'recharge.customBonus': { roles: ['owner'] },
  'consume.create': { roles: ['owner', 'clerk'] },
  /** 不在项目列表里的手动金额 */
  'consume.customAmount': { roles: ['owner', 'clerk'] },
  'consume.reverse': { roles: ['owner'] },
  /** 当前营业日的流水与日结汇总 */
  'ledger.readToday': { roles: ['owner', 'clerk'] },
  /** 历史营业日的流水与日结 */
  'ledger.readHistory': { roles: ['owner'] },
  'ledger.export': { roles: ['owner'] },
  'settlement.close': { roles: ['owner'] },
  // ── 库存与采购 ──
  /** 查看库存数量、物料档案与库存单据 */
  'inventory.read': { roles: ['owner'], duties: ['stock', 'purchase', 'payable', 'approve'] },
  /** 期初录入、收货、领用、退回、直接耗用、报损申请、盘点录入 */
  'inventory.operate': { roles: ['owner'], duties: ['stock'] },
  /** 物料、供应商、部门档案 */
  'inventory.master': { roles: ['owner'], duties: ['purchase'] },
  /** 采购单 */
  'purchase.manage': { roles: ['owner'], duties: ['purchase'] },
  /** 退供应商申请（仓库或采购均可发起） */
  'supplierReturn.create': { roles: ['owner'], duties: ['stock', 'purchase'] },
  /** 查看供应商货款、付款与对账 */
  'payable.read': { roles: ['owner'], duties: ['purchase', 'payable', 'approve'] },
  /** 期初未付、付款登记 */
  'payable.manage': { roles: ['owner'], duties: ['payable'] },
  /** 负责人确认：采购、报损、盘点调整、退货、付款、期初、冲销 */
  'inventory.approve': { roles: ['owner'], duties: ['approve'] },
  'inventory.export': { roles: ['owner'], duties: ['payable', 'approve'] },
  // ── 管理 ──
  'staff.manage': { roles: ['owner'] },
  'catalog.manage': { roles: ['owner'] },
  'settings.manage': { roles: ['owner'] },
  'audit.read': { roles: ['owner'] },
} as const satisfies Record<string, Rule>;

export type Permission = keyof typeof PERMISSIONS;

export function can(subject: PermissionSubject, permission: Permission): boolean {
  const rule = PERMISSIONS[permission] as Rule;
  if (rule.roles.includes(subject.role)) return true;
  return !!rule.duties?.some((d) => subject.duties?.includes(d));
}

export function permissionsOf(subject: PermissionSubject): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(subject, p));
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
  'inventory.read': '查看库存与物资单据',
  'inventory.operate': '期初、收货、领用、退回、耗用、报损、盘点录入',
  'inventory.master': '维护物料、供应商、部门档案',
  'purchase.manage': '编制与提交采购单',
  'supplierReturn.create': '发起退供应商',
  'payable.read': '查看供应商货款与对账',
  'payable.manage': '登记期初未付与付款',
  'inventory.approve': '负责人确认（采购、报损、盘点调整、退货、付款、冲销）',
  'inventory.export': '导出库存与对账',
  'staff.manage': '管理员工账号',
  'catalog.manage': '管理充值套餐与消费项目',
  'settings.manage': '修改经营规则设置',
  'audit.read': '查看操作审计',
};

export const PERMISSION_GROUPS: { title: string; items: Permission[] }[] = [
  {
    title: '会员与储值',
    items: ['member.read', 'member.write', 'recharge.create', 'recharge.customBonus', 'consume.create', 'consume.customAmount', 'consume.reverse', 'ledger.readToday', 'ledger.readHistory', 'ledger.export', 'settlement.close'],
  },
  {
    title: '库存与采购',
    items: ['inventory.read', 'inventory.operate', 'inventory.master', 'purchase.manage', 'supplierReturn.create', 'payable.read', 'payable.manage', 'inventory.approve', 'inventory.export'],
  },
  { title: '管理', items: ['staff.manage', 'catalog.manage', 'settings.manage', 'audit.read'] },
];
