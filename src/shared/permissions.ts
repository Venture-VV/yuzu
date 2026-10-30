// 岗位与职责权限（默认规则，待店主确认）。
// 所有接口与页面都从这里判断权限。
//
// 岗位决定会员业务权限；库存与采购权限来自可叠加的「职责」，一人可兼任多项。
// 增加库存职责不会带来会员钱包、充值撤销或全店财务查看权限。
// 「值班经理」「店总」为 2026-10-27 店主答复新增的内置岗位（#29）；「客户经理」为 v0.6.0 新增（储值会员的开发与维护），默认权限待确认。
// v0.6.0 起店主可以在管理后台按岗位增减权限（存为相对默认的增减，settings.role_permissions）：
// 店主一栏固定拥有全部权限；LOCKED_PERMISSIONS 只属于店主，不能授给其他岗位；库存职责的权限不在后台调整。
// v0.7.0 新增「维护技师名册」「看技师业绩」，默认值待确认。

export const ROLES = ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk', 'backoffice'] as const;
export type Role = (typeof ROLES)[number];

export const DUTIES = ['stock', 'purchase', 'payable', 'approve'] as const;
export type Duty = (typeof DUTIES)[number];

export interface PermissionSubject {
  role: Role;
  duties?: readonly Duty[];
  /** 已按后台的岗位权限算好的权限（登录会话、授权人都带）；没有时按默认规则判断 */
  permissions?: readonly Permission[];
}

interface Rule {
  roles: readonly Role[];
  duties?: readonly Duty[];
}

export const PERMISSIONS = {
  // ── 会员与储值 ──
  'member.read': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk'] },
  'member.write': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk'] },
  'recharge.create': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk'] },
  /** 不按套餐、手动填写赠金 */
  'recharge.customBonus': { roles: ['owner', 'store_manager'] },
  'consume.create': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 不在项目列表里的手动金额 */
  'consume.customAmount': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  'consume.reverse': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 当前营业日的流水与日结汇总 */
  'ledger.readToday': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk'] },
  /** 历史营业日的流水与日结 */
  'ledger.readHistory': { roles: ['owner', 'store_manager', 'duty_manager'] },
  'ledger.export': { roles: ['owner', 'store_manager', 'duty_manager'] },
  'settlement.close': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 导入旧系统（EBC）的会员余额作为期初，作废导入错误的期初 */
  'wallet.opening': { roles: ['owner'] },
  // ── 前台手牌与共同账单 ──
  /** 查看在店手牌状态板与手牌账单 */
  'frontdesk.read': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 接待发牌、同行绑牌、挂账、换牌、锁定异常手牌；本人刚登记的明细可在规定时间内自行作废 */
  'frontdesk.operate': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 作废他人或超时的明细、撤销他人或超时开的牌 */
  'frontdesk.correct': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 维护手牌池：批量建牌、改分区、解锁、停用 */
  'frontdesk.tags': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 结账收款（单牌或同行合并）、登记团购券；用会员储值支付还需要「登记消费扣款」 */
  'frontdesk.checkout': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 反结账：撤销一张结账单，账单恢复为在店未结（待确认：默认值班经理及以上） */
  'frontdesk.checkoutVoid': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 按纸质应急单上的实际时间补录接待、挂账与结账（R1.9，待确认：默认值班经理及以上；收银员不能，避免把时间往前填少收门票） */
  'frontdesk.backfill': { roles: ['owner', 'store_manager', 'duty_manager'] },
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
  // ── 当场授权（主管在弹窗里输入自己的账号密码确认）──
  /** 授权超过单笔上限的充值 / 消费 */
  'auth.overLimit': { roles: ['owner', 'store_manager'] },
  /** 授权散客或等级不够的会员使用 VIP 柜（经营规则开启后才可用） */
  'auth.vipOverride': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 授权结账的「优惠 / 免单」、降低票种与免票（R1.2，店主 2026-10-29 签认） */
  'auth.discount': { roles: ['owner', 'store_manager', 'duty_manager'] },
  'staff.manage': { roles: ['owner'] },
  'catalog.manage': { roles: ['owner', 'store_manager'] },
  /** 技师名册：新建、编辑、停用技师（v0.7.0，待确认：默认店主与店总） */
  'technician.manage': { roles: ['owner', 'store_manager'] },
  'settings.manage': { roles: ['owner'] },
  'audit.read': { roles: ['owner', 'store_manager'] },
  // ── 数据看板（v0.6.0；当日看板仍按「查看当日流水与日结」）──
  /** 经营总览：任选时段的营业额、客流、客单价、收款与部门构成、环比（总经理看） */
  'report.executive': { roles: ['owner', 'store_manager'] },
  /** 会员总览：储值余额、新增与渠道、活跃与沉睡、等级分布、赠金到期（客户经理看） */
  'report.members': { roles: ['owner', 'store_manager', 'account_manager'] },
  /** 技师业绩：任选时段每位技师的钟数、点钟 / 轮钟与金额（v0.7.0，待确认：默认值班经理及以上） */
  'report.technicians': { roles: ['owner', 'store_manager', 'duty_manager'] },
} as const satisfies Record<string, Rule>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** 只属于店主、不能在后台授给其他岗位的权限：管理员工账号、修改经营规则（含岗位权限本身）、导入期初余额 */
export const LOCKED_PERMISSIONS: readonly Permission[] = ['staff.manage', 'settings.manage', 'wallet.opening'];

/** 可以在后台调整权限的岗位（店主固定拥有全部权限） */
export const EDITABLE_ROLES = ROLES.filter((r): r is Exclude<Role, 'owner'> => r !== 'owner');
export type EditableRole = (typeof EDITABLE_ROLES)[number];

/** 后台对岗位权限的调整：相对默认规则增加、去掉的权限（以后新增的权限仍按默认，不会被旧的调整挡住） */
export type RoleOverrides = Partial<Record<EditableRole, { add: Permission[]; remove: Permission[] }>>;

/** 默认规则下岗位本身（不含职责）是否有这项权限 */
export function roleDefault(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as Rule).roles.includes(role);
}

/** 按后台调整后，岗位本身（不含职责）是否有这项权限 */
export function roleHas(role: Role, permission: Permission, overrides?: RoleOverrides | null): boolean {
  if (role === 'owner') return true;
  if (LOCKED_PERMISSIONS.includes(permission)) return false;
  const o = overrides?.[role];
  if (o?.remove.includes(permission)) return false;
  if (o?.add.includes(permission)) return true;
  return roleDefault(role, permission);
}

/** 岗位权限（按后台调整）与职责权限（固定）的并集 */
export function permissionsOf(subject: PermissionSubject, overrides?: RoleOverrides | null): Permission[] {
  return ALL_PERMISSIONS.filter(
    (p) => roleHas(subject.role, p, overrides) || !!(PERMISSIONS[p] as Rule).duties?.some((d) => subject.duties?.includes(d)),
  );
}

export function can(subject: PermissionSubject, permission: Permission): boolean {
  if (subject.permissions) return subject.permissions.includes(permission);
  const rule = PERMISSIONS[permission] as Rule;
  if (rule.roles.includes(subject.role)) return true;
  return !!rule.duties?.some((d) => subject.duties?.includes(d));
}

/** 把后台提交的「各岗位应有的权限」换算成相对默认的增减；店主专属的权限不能授出 */
export function overridesFrom(target: Partial<Record<EditableRole, readonly Permission[]>>): RoleOverrides {
  const out: RoleOverrides = {};
  for (const role of EDITABLE_ROLES) {
    const want = target[role];
    if (!want) continue;
    const add = ALL_PERMISSIONS.filter((p) => want.includes(p) && !roleDefault(role, p) && !LOCKED_PERMISSIONS.includes(p));
    const remove = ALL_PERMISSIONS.filter((p) => !want.includes(p) && roleDefault(role, p));
    if (add.length || remove.length) out[role] = { add, remove };
  }
  return out;
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
  'wallet.opening': '导入旧系统会员余额（期初）与作废期初',
  'frontdesk.read': '查看在店手牌与手牌账单',
  'frontdesk.operate': '接待发牌、同行绑牌、挂账、换牌',
  'frontdesk.correct': '作废他人或超时明细、撤销来访',
  'frontdesk.tags': '维护手牌池（建牌、解锁、停用）',
  'frontdesk.checkout': '结账收款、登记团购券',
  'frontdesk.checkoutVoid': '反结账（撤销结账单）',
  'frontdesk.backfill': '按实际时间补录纸质单',
  'inventory.read': '查看库存与物资单据',
  'inventory.operate': '期初、收货、领用、退回、耗用、报损、盘点录入',
  'inventory.master': '维护物料、供应商、部门档案',
  'purchase.manage': '编制与提交采购单',
  'supplierReturn.create': '发起退供应商',
  'payable.read': '查看供应商货款与对账',
  'payable.manage': '登记期初未付与付款',
  'inventory.approve': '负责人确认（采购、报损、盘点调整、退货、付款、冲销）',
  'inventory.export': '导出库存与对账',
  'auth.overLimit': '当场授权超过单笔上限的充值 / 消费',
  'auth.vipOverride': '当场授权散客或低等级会员使用 VIP 柜',
  'auth.discount': '当场授权优惠 / 免单、降低票种与免票',
  'staff.manage': '管理员工账号',
  'catalog.manage': '管理充值套餐与消费项目',
  'technician.manage': '维护技师名册',
  'settings.manage': '修改经营规则设置',
  'audit.read': '查看操作审计',
  'report.executive': '看经营总览（任选时段、环比）',
  'report.members': '看会员总览（储值、新增、活跃、等级）',
  'report.technicians': '看技师业绩（钟数、点钟 / 轮钟、金额）',
};

export const PERMISSION_GROUPS: { title: string; items: Permission[] }[] = [
  {
    title: '会员与储值',
    items: ['member.read', 'member.write', 'recharge.create', 'recharge.customBonus', 'consume.create', 'consume.customAmount', 'consume.reverse', 'ledger.readToday', 'ledger.readHistory', 'ledger.export', 'settlement.close', 'wallet.opening'],
  },
  {
    title: '前台手牌与账单',
    items: ['frontdesk.read', 'frontdesk.operate', 'frontdesk.correct', 'frontdesk.tags', 'frontdesk.checkout', 'frontdesk.checkoutVoid', 'frontdesk.backfill'],
  },
  {
    title: '库存与采购',
    items: ['inventory.read', 'inventory.operate', 'inventory.master', 'purchase.manage', 'supplierReturn.create', 'payable.read', 'payable.manage', 'inventory.approve', 'inventory.export'],
  },
  { title: '当场授权', items: ['auth.overLimit', 'auth.vipOverride', 'auth.discount'] },
  { title: '数据看板', items: ['report.executive', 'report.members', 'report.technicians'] },
  { title: '管理后台', items: ['staff.manage', 'catalog.manage', 'technician.manage', 'settings.manage', 'audit.read'] },
];
