// 岗位与职责权限（模拟规则，待店主确认）。
// 所有接口与页面都从这里判断权限，确认后只需修改此文件。
//
// 岗位决定会员业务权限；库存与采购权限来自可叠加的「职责」，一人可兼任多项。
// 增加库存职责不会带来会员钱包、充值撤销或全店财务查看权限。
// 「值班经理」「店总」为 2026-10-27 店主答复新增的内置岗位（#29），默认权限待确认；
// Batch 4 改为后台可配置的「岗位 × 权限」矩阵。

export const ROLES = ['owner', 'store_manager', 'duty_manager', 'clerk', 'backoffice'] as const;
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
  'member.read': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  'member.write': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  'recharge.create': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 不按套餐、手动填写赠金 */
  'recharge.customBonus': { roles: ['owner', 'store_manager'] },
  'consume.create': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 不在项目列表里的手动金额 */
  'consume.customAmount': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  'consume.reverse': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 当前营业日的流水与日结汇总 */
  'ledger.readToday': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
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
  'settings.manage': { roles: ['owner'] },
  'audit.read': { roles: ['owner', 'store_manager'] },
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
  'settings.manage': '修改经营规则设置',
  'audit.read': '查看操作审计',
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
  { title: '管理', items: ['staff.manage', 'catalog.manage', 'settings.manage', 'audit.read'] },
];
