// 岗位与职责权限（默认规则，待店主确认）。
// 所有接口与页面都从这里判断权限。
//
// 岗位决定会员业务权限；库存与采购权限来自可叠加的「职责」，一人可兼任多项。
// 增加库存职责不会带来会员钱包、充值撤销或全店财务查看权限。
// 「值班经理」「店总」为 2026-10-27 店主答复新增的内置岗位（#29）；「客户经理」为 v0.6.0 新增（储值会员的开发与维护），默认权限待确认。
// v0.6.0 起店主可以在管理后台按岗位增减权限（存为相对默认的增减，settings.role_permissions）：
// 店主一栏固定拥有全部权限；LOCKED_PERMISSIONS 只属于店主，不能授给其他岗位；库存职责的权限不在后台调整。
// v0.7.0 新增「维护技师名册」「看技师业绩」，默认值待确认。
// v0.7.3 ERP 独立工作区：库存、采购、货款的权限归入「ERP」一组；新增「ERP：看营业数据（只读）」，
// 默认店主与店总（职责不带：增加库存职责仍不会带来全店财务查看权限）。
// v0.7.17 新增「看实时位置」「上报位置」（第一级实时位置），默认值待确认。

export const ROLES = ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk', 'backoffice'] as const;
export type Role = (typeof ROLES)[number];

export const DUTIES = ['stock', 'purchase', 'payable', 'approve', 'cost', 'request'] as const;
export type Duty = (typeof DUTIES)[number];

/**
 * 分岗不兼任（#17 后半句，v0.7.12）：职责分五组，一名员工的职责只能在一组里；财务组内对账付款、成本核算可以同时有。
 * 店主不受限制。后台保存员工时校验；已有跨组的员工不自动改，后台员工页提示（不进自检）。
 */
export const DUTY_GROUPS: { key: 'stock' | 'purchase' | 'department' | 'finance' | 'approve'; label: string; duties: readonly Duty[] }[] = [
  { key: 'stock', label: '仓库', duties: ['stock'] },
  { key: 'purchase', label: '采购', duties: ['purchase'] },
  { key: 'department', label: '部门', duties: ['request'] },
  { key: 'finance', label: '财务（含成本）', duties: ['payable', 'cost'] },
  { key: 'approve', label: '负责人', duties: ['approve'] },
];

/** 职责跨组时返回涉及的组名（如「仓库、采购」），不跨组返回 null；店主不受限制 */
export function dutyConflict(role: Role, duties: readonly Duty[]): string | null {
  if (role === 'owner') return null;
  const groups = DUTY_GROUPS.filter((g) => g.duties.some((d) => duties.includes(d)));
  return groups.length > 1 ? groups.map((g) => g.label).join('、') : null;
}

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
  'inventory.read': { roles: ['owner'], duties: ['stock', 'purchase', 'payable', 'approve', 'cost'] },
  /** 期初录入、收货、领用、退回、直接耗用、报损申请、盘点录入 */
  'inventory.operate': { roles: ['owner'], duties: ['stock'] },
  /** 物料、供应商、部门档案 */
  'inventory.master': { roles: ['owner'], duties: ['purchase'] },
  /** 采购单 */
  'purchase.manage': { roles: ['owner'], duties: ['purchase'] },
  /** 退供应商申请（仓库或采购均可发起） */
  'supplierReturn.create': { roles: ['owner'], duties: ['stock', 'purchase'] },
  /** 登记供应商对退货的答复（同意 → 退货生效；不同意 → 撤回），采购与供应商沟通（#20，v0.7.12） */
  'supplierReturn.answer': { roles: ['owner'], duties: ['purchase'] },
  /** 查看供应商货款、付款与对账 */
  // 成本核算要冲销付款、期初未付（#21，v0.7.11），能看货款
  'payable.read': { roles: ['owner'], duties: ['purchase', 'payable', 'approve', 'cost'] },
  /** 期初未付、付款登记 */
  'payable.manage': { roles: ['owner'], duties: ['payable'] },
  /** 负责人确认：采购、报损、盘点调整、退货、付款、期初（v0.7.11 起冲销按 #21 分工，见下面两项） */
  'inventory.approve': { roles: ['owner'], duties: ['approve'] },
  /** 冲销库存单据（#21：仓库或财务成本岗；只限当月，v0.7.11） */
  'inventory.void': { roles: ['owner'], duties: ['stock', 'cost'] },
  /** 冲销付款、期初未付、费用报销、备用金单据（#21：账务冲销由财务负责；只限当月，v0.7.11） */
  'finance.void': { roles: ['owner'], duties: ['payable', 'cost'] },
  /** 本部门小仓：签收领料、登记急采与补单、耗用、报损、盘点（v0.7.11，只限员工档案里的所属部门） */
  'deptStock.operate': { roles: ['owner'], duties: ['request'] },
  /** 部门小仓（所有部门）：查看结存、盘点、登记耗用（#17：每月 1 号财务到部门盘点，v0.7.11） */
  'deptStock.audit': { roles: ['owner'], duties: ['cost'] },
  'inventory.export': { roles: ['owner'], duties: ['payable', 'approve'] },
  /** ERP 营业数据（只读）：每天的营业收入、收款与部门构成、日结情况（v0.7.3，待确认：默认店主与店总） */
  'erp.revenue': { roles: ['owner', 'store_manager'] },
  // ── 费用报销与备用金（v0.7.7，飞书需求 RQ-005；D10：按现有的岗位 + 职责，见 docs/EXPENSES.md）──
  /** 查看费用报销、备用金与每日平账（物资经办、采购经办、负责人只读） */
  'expense.read': { roles: ['owner'], duties: ['stock', 'purchase', 'payable', 'cost', 'approve'] },
  /** 登记费用报销（发票、税点、科目） */
  'expense.manage': { roles: ['owner'], duties: ['cost'] },
  /** 登记备用金打款、退回、补付 */
  'petty.manage': { roles: ['owner'], duties: ['payable', 'cost'] },
  /** 确认超门槛的报销（v0.7.11 起冲销归「finance.void」） */
  'expense.approve': { roles: ['owner'], duties: ['approve'] },
  /** 导出报销明细与每日平账 */
  'expense.export': { roles: ['owner'], duties: ['payable', 'cost', 'approve'] },
  // ── 部门采购需求单（v0.7.8，飞书需求 RQ-005 第二步；见 docs/REQUISITIONS.md）──
  /** 提部门需求单、改与撤回自己的单（只限员工档案里的所属部门） */
  'request.create': { roles: ['owner'], duties: ['request'] },
  /** 审核需求单、转采购单（看全部部门的需求单） */
  'request.review': { roles: ['owner'], duties: ['purchase', 'approve'] },
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
  /** 钟房：上牌、派钟、上钟、下钟、加钟、退钟（v0.7.1，待确认：前台岗位都能做；派钟、加钟、退钟还要能挂账） */
  'technician.dispatch': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 餐饮点单：按手牌给在店客人点菜（挂账）、催单、上菜（S5 第一步，待确认：前台岗位都能做；下单还要能挂账） */
  'dining.order': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 厨房出品屏：开始做、出餐、估清（S5 第一步，待确认：前台岗位与后勤人员；厨房可以用后勤账号） */
  'dining.kitchen': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk', 'backoffice'] },
  /** 客房：入住、续住、换房、退房、收退押金、撤销入住、夜审（S7，v0.7.4，待确认：前台岗位都能做） */
  'room.operate': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 客房：打扫、维修（房态）（S7，v0.7.4，待确认：前台岗位与后勤人员；客房服务员可以用后勤账号） */
  'room.housekeep': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk', 'backoffice'] },
  /** 实时位置（v0.7.17，待确认：前台岗位）：平面图上的在场人员、区域人数、轨迹；只显示手牌号与技师，不显示会员姓名、手机号 */
  'location.view': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 上报位置（v0.7.17，待确认：店主、店总）：后台模拟刷卡；RQ-001 的设备桥用只有这项权限的账号登录上报 */
  'location.report': { roles: ['owner', 'store_manager'] },
  'settings.manage': { roles: ['owner'] },
  'audit.read': { roles: ['owner', 'store_manager'] },
  // ── 数据看板（v0.6.0；当日看板仍按「查看当日流水与日结」）──
  /** 经营总览：任选时段的营业额、客流、客单价、收款与部门构成、环比（总经理看） */
  'report.executive': { roles: ['owner', 'store_manager'] },
  /** 会员总览：储值余额、新增与渠道、活跃与沉睡、等级分布、赠金到期（客户经理看） */
  'report.members': { roles: ['owner', 'store_manager', 'account_manager'] },
  /** 技师业绩：任选时段每位技师的钟数、点钟 / 轮钟与金额（v0.7.0，待确认：默认值班经理及以上） */
  'report.technicians': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 技师提成：按提成规则算出的每位技师提成与明细导出（v0.7.1，待确认：默认店主与店总） */
  'report.commission': { roles: ['owner', 'store_manager'] },
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
  'inventory.operate': '期初、收货、领料、退回、耗用、报损、盘点录入（总仓）',
  'inventory.master': '维护物料、供应商、部门档案',
  'purchase.manage': '编制与提交采购单',
  'supplierReturn.create': '发起退供应商',
  'supplierReturn.answer': '登记供应商对退货的答复',
  'payable.read': '查看供应商货款与对账',
  'payable.manage': '登记期初未付、付款、核销与供应商退款',
  'inventory.approve': '负责人确认（采购、报损、盘点调整、退货、付款）',
  'inventory.void': '冲销库存单据（只限当月）',
  'finance.void': '冲销付款、期初未付、报销与备用金（只限当月）',
  'deptStock.operate': '本部门小仓：签收领料、急采与补单、耗用、报损、盘点',
  'deptStock.audit': '部门小仓（所有部门）：查看、盘点、登记耗用',
  'inventory.export': '导出库存与对账',
  'erp.revenue': 'ERP：看营业数据（只读）',
  'expense.read': '查看费用报销、备用金与每日平账',
  'expense.manage': '登记费用报销（发票、税点、科目）',
  'petty.manage': '登记备用金打款、退回、补付',
  'expense.approve': '确认超门槛的报销',
  'expense.export': '导出报销明细与每日平账',
  'request.create': '提部门采购需求单（只限本部门）',
  'request.review': '审核需求单、转采购单',
  'auth.overLimit': '当场授权超过单笔上限的充值 / 消费',
  'auth.vipOverride': '当场授权散客或低等级会员使用 VIP 柜',
  'auth.discount': '当场授权优惠 / 免单、降低票种与免票',
  'staff.manage': '管理员工账号',
  'catalog.manage': '管理充值套餐与消费项目',
  'technician.manage': '维护技师名册',
  'technician.dispatch': '钟房派钟、上下钟、加钟、退钟、上牌',
  'dining.order': '餐饮点单、催单、上菜',
  'dining.kitchen': '厨房出品屏：开始做、出餐、估清',
  'room.operate': '客房入住、续住、换房、退房、押金、夜审',
  'room.housekeep': '客房打扫、维修（房态）',
  'location.view': '看实时位置（平面图上的在场人员与轨迹）',
  'location.report': '上报位置（模拟刷卡、设备桥）',
  'settings.manage': '修改经营规则设置',
  'audit.read': '查看操作审计',
  'report.executive': '看经营总览（任选时段、环比）',
  'report.members': '看会员总览（储值、新增、活跃、等级）',
  'report.technicians': '看技师业绩（钟数、点钟 / 轮钟、金额）',
  'report.commission': '看技师提成与导出提成明细',
};

export const PERMISSION_GROUPS: { title: string; items: Permission[] }[] = [
  {
    title: '会员与储值',
    items: ['member.read', 'member.write', 'recharge.create', 'recharge.customBonus', 'consume.create', 'consume.customAmount', 'consume.reverse', 'ledger.readToday', 'ledger.readHistory', 'ledger.export', 'settlement.close', 'wallet.opening'],
  },
  {
    title: '前台手牌与账单',
    items: ['frontdesk.read', 'frontdesk.operate', 'frontdesk.correct', 'frontdesk.tags', 'frontdesk.checkout', 'frontdesk.checkoutVoid', 'frontdesk.backfill', 'technician.dispatch', 'dining.order', 'dining.kitchen', 'room.operate', 'room.housekeep', 'location.view', 'location.report'],
  },
  {
    title: 'ERP（库存、采购、货款、费用、营业数据）',
    items: [
      'inventory.read', 'inventory.operate', 'inventory.master', 'purchase.manage', 'supplierReturn.create', 'supplierReturn.answer', 'payable.read', 'payable.manage', 'inventory.approve', 'inventory.void', 'inventory.export',
      'deptStock.operate', 'deptStock.audit',
      'expense.read', 'expense.manage', 'petty.manage', 'expense.approve', 'finance.void', 'expense.export', 'request.create', 'request.review', 'erp.revenue',
    ],
  },
  { title: '当场授权', items: ['auth.overLimit', 'auth.vipOverride', 'auth.discount'] },
  { title: '数据看板', items: ['report.executive', 'report.members', 'report.technicians', 'report.commission'] },
  { title: '管理后台', items: ['staff.manage', 'catalog.manage', 'technician.manage', 'settings.manage', 'audit.read'] },
];
