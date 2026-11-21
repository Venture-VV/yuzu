// 组织架构与岗位（8.1.18，店主 2026-11-20《组织架构与岗位体系》表格；docs/POSITIONS_V8118.md，GW1–GW9）。
//
// 后台「添加员工」原来按九个内置岗位（店主、店总、值班经理……）加可叠加的职责建账号；8.1.18 起改成
// 「先选部门 → 再选岗位（负责人 / 员工）」，系统按岗位自动套用管理员级别与权限模板：
// - 超级管理员 = 总裁；高级管理员 = 总经办成员与各部门负责人；管理员 = 各部门员工（表 2「三级管理员权限总览」）。
// - 每个岗位的默认权限按表 3「分部门岗位职权配置」的八列（✔ / ✘）定：每项权限归到其中一列（PERMISSION_COLUMN），
//   岗位只拿打了 ✔ 的那几列里、与本部门业务相关的权限（POSITION_DEFAULTS）。tests/positions.test.ts 逐列核对。
// - 超级管理员可以在后台「岗位权限」按岗位逐项开关（settings.position_permissions，存相对默认的增减），
//   也可以在员工档案里给某一个人逐项微调（staff.permission_adjust）。
// - 权限检查照旧用 src/shared/permissions.ts 的权限项；岗位另外带一个「旧岗位」与职责（legacyRole、duties），
//   只给按旧岗位判断的几处用（审批的「店总」「财务」「法务」组、店主专属的操作、客户部的客户经理等），不决定权限。

import type { Duty, Permission, Role } from './permissions';

/** 组织 / 部门：总裁（公司）、总经办，以及十三个部门（表 1；大客户部 8.1.18 新增，库存、采购归外联部） */
export const ORG_DEPARTMENTS = [
  { key: 'company', name: '汤崎汤泉生活（公司）' },
  { key: 'gmo', name: '总经办' },
  { key: 'hr', name: '人力行政部' },
  { key: 'front', name: '前厅部' },
  { key: 'male', name: '男宾部' },
  { key: 'female', name: '女宾部' },
  { key: 'ent', name: '娱乐部' },
  { key: 'dining', name: '餐饮部' },
  { key: 'kangmei', name: '康美部' },
  { key: 'kitchen', name: '出品部' },
  { key: 'wellness', name: '保健部' },
  { key: 'eng', name: '工程部' },
  { key: 'finance', name: '财务部' },
  { key: 'outreach', name: '外联部' },
  { key: 'vip', name: '大客户部' },
] as const;
export type OrgDepartment = (typeof ORG_DEPARTMENTS)[number]['key'];
/** 下设负责人与员工的十三个部门 */
export type LinedDepartment = Exclude<OrgDepartment, 'company' | 'gmo'>;
export const LINED_DEPARTMENTS = ORG_DEPARTMENTS.map((d) => d.key).filter((k): k is LinedDepartment => k !== 'company' && k !== 'gmo');

export const ADMIN_LEVELS = ['super', 'senior', 'admin'] as const;
export type AdminLevel = (typeof ADMIN_LEVELS)[number];
export const ADMIN_LEVEL_LABELS: Record<AdminLevel, string> = { super: '超级管理员', senior: '高级管理员', admin: '管理员' };

export type PositionKey = 'president' | 'gmo' | `${LinedDepartment}.${'lead' | 'staff'}`;

/** 表 3 的八列 */
export const PERMISSION_COLUMNS = [
  { key: 'own', label: '本人经办记录' },
  { key: 'dept', label: '本部门台账 / 报表' },
  { key: 'cross', label: '跨部门数据' },
  { key: 'entry', label: '业务录入 / 下单' },
  { key: 'approve', label: '单据审核 / 审批' },
  { key: 'member', label: '会员与券管理' },
  { key: 'account', label: '账号与权限配置' },
  { key: 'base', label: '基础数据 / 价格配置' },
] as const;
export type PermissionColumn = (typeof PERMISSION_COLUMNS)[number]['key'];

/**
 * 每项权限归哪一列（后台「岗位权限」按这八列分组显示；tests/positions.test.ts 核对每项都归了列）。
 * 「查看当日流水与日结」归本人经办：收银员交班要看当班的流水（GW4 待确认）。
 */
export const PERMISSION_COLUMN: Record<Permission, PermissionColumn> = {
  // 本人经办记录
  'guide.view': 'own',
  'device.view': 'own',
  'print.network': 'own',
  'ledger.readToday': 'own',
  'member.lookup': 'own',
  // 业务录入 / 下单
  'customer.read': 'entry',
  'customer.operate': 'entry',
  'concierge.read': 'entry',
  'concierge.operate': 'entry',
  'member.read': 'entry',
  'member.write': 'entry',
  'recharge.create': 'entry',
  'consume.create': 'entry',
  'consume.customAmount': 'entry',
  'member.refund': 'entry',
  'member.card': 'entry',
  'countcard.sell': 'entry',
  'platform.redeem': 'entry',
  'benefit.use': 'entry',
  'frontdesk.read': 'entry',
  'frontdesk.operate': 'entry',
  'frontdesk.checkout': 'entry',
  'frontdesk.onAccount': 'entry',
  // 查看库存与物资单据：入库、采购、领料要先看得到库存（ERP 的库存、采购页都要它），算业务录入
  'inventory.read': 'entry',
  'inventory.operate': 'entry',
  'purchase.manage': 'entry',
  'supplierReturn.create': 'entry',
  'supplierReturn.answer': 'entry',
  'payable.manage': 'entry',
  'deptStock.operate': 'entry',
  'expense.manage': 'entry',
  'petty.manage': 'entry',
  'request.create': 'entry',
  'request.stock': 'entry',
  'contract.manage': 'entry',
  'payment.request': 'entry',
  'invoice.manage': 'entry',
  'invoice.issue': 'entry',
  'ar.manage': 'entry',
  // 布草、零采备用金的页面与列表接口都要「看」这一项，开单、申用离不开它：跟着录入走（Codex 审查 036b336）
  'linen.read': 'entry',
  'linen.manage': 'entry',
  'pool.read': 'entry',
  'pool.manage': 'entry',
  'asset.manage': 'entry',
  'technician.dispatch': 'entry',
  'technician.announce': 'entry',
  'dining.order': 'entry',
  'dining.kitchen': 'entry',
  'dining.orderRestaurant': 'entry',
  'dining.orderWater': 'entry',
  'dining.orderFruit': 'entry',
  // 退菜按出品口（8.1.17）：能挂账、点单的岗位照旧能退本人经手的菜（大额要当场授权），算业务录入
  'dining.voidRestaurant': 'entry',
  'dining.voidWater': 'entry',
  'dining.voidFruit': 'entry',
  'emenu.view': 'entry',
  'room.operate': 'entry',
  'room.housekeep': 'entry',
  'booking.manage': 'entry',
  'location.report': 'entry',
  'device.test': 'entry',
  'studio.edit': 'entry',
  // 本部门台账 / 报表
  'ledger.readHistory': 'dept',
  'ledger.export': 'dept',
  'report.technicians': 'dept',
  'report.members': 'dept',
  'inventory.export': 'dept',
  'payable.read': 'dept',
  'expense.read': 'dept',
  'expense.export': 'dept',
  'asset.read': 'dept',
  'contract.read': 'dept',
  'ar.read': 'dept',
  'gift.read': 'dept',
  'concierge.export': 'dept',
  'patrol.read': 'dept',
  'canteen.manage': 'dept',
  // 跨部门数据
  'erp.revenue': 'cross',
  'report.executive': 'cross',
  'report.commission': 'cross',
  'inventory.cost': 'cross',
  'deptStock.audit': 'cross',
  'audit.read': 'cross',
  'location.view': 'cross',
  'marketing.cost': 'cross',
  'member.retention': 'cross',
  // 单据审核 / 审批（含当场授权、作废与冲销：管理员不可审核、不可删除业务单据）
  'approval.act': 'approve',
  'inventory.approve': 'approve',
  'request.review': 'approve',
  'expense.approve': 'approve',
  'consume.reverse': 'approve',
  'frontdesk.correct': 'approve',
  'frontdesk.checkoutVoid': 'approve',
  'frontdesk.backfill': 'approve',
  'frontdesk.refund': 'approve',
  'countcard.refund': 'approve',
  'platform.void': 'approve',
  'platform.settle': 'approve',
  'inventory.void': 'approve',
  'finance.void': 'approve',
  'settlement.close': 'approve',
  'auth.overLimit': 'approve',
  'auth.memberRefund': 'approve',
  'auth.memberPhone': 'approve',
  'auth.vipOverride': 'approve',
  'auth.discount': 'approve',
  'auth.checkinRisk': 'approve',
  'gift.authorize': 'approve',
  'customer.manage': 'approve',
  'concierge.manage': 'approve',
  // 会员与券管理
  'coupon.issue': 'member',
  'coupon.void': 'member',
  'member.status': 'member',
  'member.merge': 'member',
  'member.phone': 'member',
  'member.adjust': 'member',
  'gift.issue': 'member',
  'recharge.customBonus': 'member',
  'mp.unbind': 'member',
  'frontdesk.blacklist': 'member',
  // 账号与权限配置
  'staff.manage': 'account',
  'staff.dept': 'account',
  'approval.rules': 'account',
  // 基础数据 / 价格配置
  'settings.manage': 'base',
  'catalog.manage': 'base',
  'member.rules': 'base',
  'coupon.manage': 'base',
  'benefit.publish': 'base',
  'gift.manage': 'base',
  'emenu.manage': 'base',
  'dish.restaurant': 'base',
  'dish.water': 'base',
  'dish.fruit': 'base',
  'dish.price': 'base',
  'technician.manage': 'base',
  'inventory.master': 'base',
  'purchase.rules': 'base',
  'budget.manage': 'base',
  'device.manage': 'base',
  'frontdesk.tags': 'base',
  'wallet.opening': 'base',
  'mp.content': 'base',
  'mp.recharge': 'base',
  'mp.coupon': 'base',
  'mp.reminder': 'base',
  'mp.invite': 'base',
  'mp.food': 'base',
  'mp.booking': 'base',
  'studio.publish': 'base',
  'patrol.manage': 'base',
};

export interface PositionDef {
  key: PositionKey;
  department: OrgDepartment;
  /** 岗位名称（表 1） */
  title: string;
  level: AdminLevel;
  /** 按旧岗位判断的几处用（见文件头）；不决定权限 */
  legacyRole: Role;
  duties: readonly Duty[];
  /** 表 3 这一行打了 ✔ 的列（总裁全部；总经办没有单独一行，按「高级管理员」跨部门：除账号与基础数据外都开） */
  columns: readonly PermissionColumn[];
  /** 表 3 那一格括号里的说明（只用来显示） */
  notes?: Partial<Record<PermissionColumn, string>>;
}

const BASE_OWN: Permission[] = ['guide.view', 'device.view', 'print.network'];
const FRONT_OP: Permission[] = [
  ...BASE_OWN,
  'ledger.readToday',
  'member.read',
  'member.write',
  'recharge.create',
  'consume.create',
  'consume.customAmount',
  'member.refund',
  'member.card',
  'countcard.sell',
  'platform.redeem',
  'benefit.use',
  'frontdesk.read',
  'frontdesk.operate',
  'frontdesk.checkout',
  'technician.dispatch',
  'technician.announce',
  'dining.order',
  'dining.orderRestaurant',
  'dining.orderWater',
  'dining.orderFruit',
  'dining.voidRestaurant',
  'dining.voidWater',
  'dining.voidFruit',
  'dining.kitchen',
  'emenu.view',
  'room.operate',
  'room.housekeep',
  'booking.manage',
];
/** 浴区（男宾、女宾）与娱乐部员工：在店客人的手牌挂账、点单、房态 */
const AREA_OP: Permission[] = [
  ...BASE_OWN,
  'frontdesk.read',
  'frontdesk.operate',
  'dining.order',
  'dining.orderRestaurant',
  'dining.orderWater',
  'dining.orderFruit',
  'dining.voidRestaurant',
  'dining.voidWater',
  'dining.voidFruit',
  'emenu.view',
  'room.housekeep',
];
/** 各部门负责人共有：本部门台账（当日流水）、审批中心、作废本部门员工登记错的明细、本部门员工账号 */
const LEAD_COMMON: Permission[] = ['ledger.readToday', 'approval.act', 'staff.dept'];
const DEPT_STOCK: Permission[] = ['deptStock.operate', 'request.create'];

/** 每个岗位的默认权限（总裁不在这里：总裁是店主，全部权限） */
export const POSITION_DEFAULTS: Record<Exclude<PositionKey, 'president'>, readonly Permission[]> = {
  // 总经办成员：高级管理员、跨部门；除「账号与权限配置」「基础数据 / 价格配置」以外各列都开（见 gmoDefaults）
  gmo: [],
  'hr.lead': [...BASE_OWN, ...LEAD_COMMON, 'patrol.read', 'canteen.manage', 'audit.read', 'request.create'],
  'hr.staff': [...BASE_OWN, 'request.create'],
  'front.lead': [
    ...FRONT_OP,
    ...LEAD_COMMON,
    'ledger.readHistory',
    'ledger.export',
    'location.view',
    'member.retention',
    'consume.reverse',
    'settlement.close',
    'frontdesk.correct',
    'frontdesk.checkoutVoid',
    'frontdesk.backfill',
    'frontdesk.refund',
    'frontdesk.onAccount',
    'countcard.refund',
    'platform.void',
    'auth.memberPhone',
    'auth.vipOverride',
    'auth.discount',
    'auth.checkinRisk',
    'gift.authorize',
    'device.test',
    'coupon.issue',
    'coupon.void',
    'member.phone',
    'member.status',
    'gift.issue',
    'mp.unbind',
    'frontdesk.blacklist',
  ],
  'front.staff': FRONT_OP,
  'male.lead': [...AREA_OP, ...LEAD_COMMON, 'frontdesk.correct', 'auth.vipOverride'],
  'male.staff': AREA_OP,
  'female.lead': [...AREA_OP, ...LEAD_COMMON, 'frontdesk.correct', 'auth.vipOverride'],
  'female.staff': AREA_OP,
  'ent.lead': [...AREA_OP, ...LEAD_COMMON, 'technician.dispatch', 'technician.announce', 'frontdesk.correct'],
  'ent.staff': [...AREA_OP, 'technician.dispatch', 'technician.announce'],
  'dining.lead': [
    ...BASE_OWN,
    ...LEAD_COMMON,
    ...DEPT_STOCK,
    'frontdesk.read',
    'frontdesk.operate',
    'dining.order',
    'dining.orderRestaurant',
    'dining.orderWater',
    'dining.orderFruit',
    'dining.voidRestaurant',
    'dining.voidWater',
    'dining.voidFruit',
    'dining.kitchen',
    'emenu.view',
    'frontdesk.correct',
    'inventory.read',
    'inventory.cost',
  ],
  'dining.staff': [
    ...BASE_OWN,
    'frontdesk.read',
    // 平板点单确认要「餐饮点单」+「前台挂账」（emenu/pins.ts），菜挂在手牌上（Codex 审查 4e118c1）
    'frontdesk.operate',
    'dining.order',
    'dining.orderRestaurant',
    'dining.orderWater',
    'dining.orderFruit',
    'dining.voidRestaurant',
    'dining.voidWater',
    'dining.voidFruit',
    'dining.kitchen',
    'emenu.view',
  ],
  'kangmei.lead': [
    ...BASE_OWN,
    ...LEAD_COMMON,
    'member.read',
    'frontdesk.read',
    'frontdesk.operate',
    'dining.order',
    'dining.orderWater',
    'dining.orderFruit',
    'dining.voidWater',
    'dining.voidFruit',
    'benefit.use',
    'frontdesk.correct',
    'coupon.issue',
  ],
  'kangmei.staff': [...BASE_OWN, 'member.read', 'frontdesk.read', 'frontdesk.operate', 'dining.order', 'dining.orderWater', 'dining.orderFruit', 'dining.voidWater', 'dining.voidFruit', 'benefit.use'],
  'kitchen.lead': [...BASE_OWN, ...LEAD_COMMON, ...DEPT_STOCK, 'dining.kitchen', 'inventory.read', 'inventory.cost', 'request.stock'],
  'kitchen.staff': [...BASE_OWN, 'dining.kitchen', 'deptStock.operate'],
  'wellness.lead': [
    ...BASE_OWN,
    ...LEAD_COMMON,
    'member.read',
    'frontdesk.read',
    'frontdesk.operate',
    'technician.dispatch',
    'technician.announce',
    'benefit.use',
    'report.technicians',
    'frontdesk.correct',
    'coupon.issue',
  ],
  'wellness.staff': [...BASE_OWN, 'member.read', 'frontdesk.read', 'frontdesk.operate', 'technician.dispatch', 'technician.announce', 'benefit.use'],
  'eng.lead': [...BASE_OWN, ...LEAD_COMMON, ...DEPT_STOCK, 'room.housekeep', 'device.test', 'asset.read', 'asset.manage', 'linen.read', 'location.view', 'inventory.read'],
  'eng.staff': [...BASE_OWN, 'room.housekeep', 'device.test', 'deptStock.operate'],
  'finance.lead': [
    ...BASE_OWN,
    // 财务部负责人：账号与权限配置 ✘（表 3），所以不带 staff.dept
    'ledger.readToday',
    'approval.act',
    'ledger.readHistory',
    'ledger.export',
    'expense.read',
    'expense.export',
    'payable.read',
    'inventory.read',
    'inventory.export',
    'linen.read',
    'asset.read',
    'contract.read',
    'ar.read',
    'report.members',
    'erp.revenue',
    'report.executive',
    'report.commission',
    'inventory.cost',
    'deptStock.audit',
    'expense.manage',
    'petty.manage',
    'payable.manage',
    'invoice.manage',
    'invoice.issue',
    'ar.manage',
    'payment.request',
    'expense.approve',
    'finance.void',
    'platform.settle',
    'settlement.close',
    'member.read',
    'coupon.void',
    'member.status',
  ],
  'finance.staff': [
    ...BASE_OWN,
    'ledger.readToday',
    'ledger.readHistory',
    'expense.read',
    'payable.read',
    'ar.read',
    'expense.manage',
    'petty.manage',
    'payable.manage',
    'invoice.manage',
    'invoice.issue',
    'ar.manage',
  ],
  'outreach.lead': [
    ...BASE_OWN,
    ...LEAD_COMMON,
    'inventory.read',
    'inventory.export',
    'payable.read',
    'linen.read',
    'asset.read',
    'pool.read',
    'contract.read',
    'expense.read',
    'inventory.cost',
    'deptStock.audit',
    'inventory.operate',
    'purchase.manage',
    'supplierReturn.create',
    'supplierReturn.answer',
    'request.stock',
    'linen.manage',
    'pool.manage',
    'asset.manage',
    'contract.manage',
    'payment.request',
    'inventory.approve',
    'request.review',
    'inventory.void',
  ],
  'outreach.staff': [
    ...BASE_OWN,
    'inventory.read',
    'inventory.operate',
    'purchase.manage',
    'supplierReturn.create',
    'supplierReturn.answer',
    'request.stock',
    'linen.read',
    'linen.manage',
    'pool.read',
    'pool.manage',
    'payment.request',
  ],
  'vip.lead': [
    ...BASE_OWN,
    ...LEAD_COMMON,
    'customer.read',
    'customer.operate',
    'concierge.read',
    'concierge.operate',
    'member.read',
    'member.write',
    'recharge.create',
    'member.card',
    'countcard.sell',
    'benefit.use',
    'report.members',
    'gift.read',
    'concierge.export',
    'member.retention',
    'customer.manage',
    'concierge.manage',
    'gift.authorize',
    'coupon.issue',
    'coupon.void',
    'gift.issue',
    'member.phone',
  ],
  'vip.staff': [...BASE_OWN, 'customer.read', 'customer.operate', 'concierge.read', 'concierge.operate', 'member.read', 'member.write', 'benefit.use', 'coupon.issue', 'gift.issue'],
};

const LEAD_NOTES: Partial<Record<LinedDepartment, Partial<Record<PermissionColumn, string>>>> = {
  hr: { cross: '人事行政范围', account: '本部门员工' },
  front: { cross: '接待 / 收银范围', account: '本部门员工' },
  dining: { cross: '出品 / 库存范围', account: '本部门员工' },
  kangmei: { member: '项目权益', account: '本部门员工' },
  kitchen: { cross: '库存 / 采购范围', account: '本部门员工' },
  wellness: { member: '保健项目权益', account: '本部门员工' },
  eng: { cross: '维修 / 资产范围', account: '本部门员工' },
  finance: { cross: '全店财务数据', approve: '财务审核' },
  outreach: { cross: '供应商 / 采购 / 库存范围', approve: '采购 / 库存审核', account: '本部门员工' },
  vip: { cross: '大客户 / 会员范围', member: '大客户权益', account: '本部门员工' },
};
const STAFF_NOTES: Partial<Record<LinedDepartment, Partial<Record<PermissionColumn, string>>>> = {
  front: { entry: '发卡台 / 收银操作' },
  dining: { entry: '点单 / 出品' },
  kangmei: { entry: '项目服务登记' },
  kitchen: { entry: '出品录入' },
  wellness: { entry: '服务登记' },
  eng: { entry: '维修工单' },
  finance: { dept: '本岗账务', entry: '账务录入' },
  outreach: { entry: '采购 / 库存 / 入库操作' },
  vip: { entry: '客户对接 / 登记', member: '权益登记' },
};

/** 表 3 每一行的 ✔ 列 */
const LEAD_COLUMNS: Record<LinedDepartment, PermissionColumn[]> = {
  hr: ['own', 'dept', 'cross', 'entry', 'approve', 'account'],
  front: ['own', 'dept', 'cross', 'entry', 'approve', 'member', 'account'],
  male: ['own', 'dept', 'entry', 'approve', 'account'],
  female: ['own', 'dept', 'entry', 'approve', 'account'],
  ent: ['own', 'dept', 'entry', 'approve', 'account'],
  dining: ['own', 'dept', 'cross', 'entry', 'approve', 'account'],
  kangmei: ['own', 'dept', 'entry', 'approve', 'member', 'account'],
  kitchen: ['own', 'dept', 'cross', 'entry', 'approve', 'account'],
  wellness: ['own', 'dept', 'entry', 'approve', 'member', 'account'],
  eng: ['own', 'dept', 'cross', 'entry', 'approve', 'account'],
  finance: ['own', 'dept', 'cross', 'entry', 'approve', 'member'],
  outreach: ['own', 'dept', 'cross', 'entry', 'approve', 'account'],
  vip: ['own', 'dept', 'cross', 'entry', 'approve', 'member', 'account'],
};
const STAFF_COLUMNS: Partial<Record<LinedDepartment, PermissionColumn[]>> = {
  finance: ['own', 'dept', 'entry'],
  vip: ['own', 'entry', 'member'],
};

/** 旧岗位（只给按旧岗位判断的几处用）与职责 */
const LEGACY: Record<LinedDepartment, { lead: [Role, Duty[]]; staff: [Role, Duty[]] }> = {
  hr: { lead: ['duty_manager', []], staff: ['backoffice', []] },
  front: { lead: ['duty_manager', []], staff: ['clerk', []] },
  male: { lead: ['duty_manager', []], staff: ['clerk', []] },
  female: { lead: ['duty_manager', []], staff: ['clerk', []] },
  ent: { lead: ['duty_manager', []], staff: ['clerk', []] },
  dining: { lead: ['duty_manager', []], staff: ['clerk', []] },
  kangmei: { lead: ['duty_manager', ['kangmei']], staff: ['clerk', ['kangmei']] },
  kitchen: { lead: ['backoffice', []], staff: ['backoffice', []] },
  wellness: { lead: ['duty_manager', []], staff: ['clerk', []] },
  eng: { lead: ['backoffice', []], staff: ['backoffice', []] },
  // 审批的「财务」组按对账付款、成本核算职责认人：只给负责人（员工不可审核）
  finance: { lead: ['backoffice', ['payable', 'cost']], staff: ['backoffice', []] },
  // 外联部员工同时做采购、库存、入库（表 4 后台配置说明第 4 条）：这是店主定的，不受「分岗不兼任」限制（GW5）
  outreach: { lead: ['backoffice', ['approve']], staff: ['backoffice', ['stock', 'purchase']] },
  vip: { lead: ['account_manager', ['concierge_manager']], staff: ['account_manager', ['concierge']] },
};

const deptName = (k: OrgDepartment) => ORG_DEPARTMENTS.find((d) => d.key === k)!.name;

export const POSITIONS: readonly PositionDef[] = [
  {
    key: 'president',
    department: 'company',
    title: '总裁',
    level: 'super',
    legacyRole: 'owner',
    duties: [],
    columns: PERMISSION_COLUMNS.map((c) => c.key),
  },
  {
    key: 'gmo',
    department: 'gmo',
    title: '总经办成员',
    level: 'senior',
    legacyRole: 'store_manager',
    duties: [],
    columns: ['own', 'dept', 'cross', 'entry', 'approve', 'member'],
    notes: { cross: '跨部门' },
  },
  ...LINED_DEPARTMENTS.flatMap((d): PositionDef[] => [
    {
      key: `${d}.lead`,
      department: d,
      title: `${deptName(d)}负责人`,
      level: 'senior',
      legacyRole: LEGACY[d].lead[0],
      duties: LEGACY[d].lead[1],
      columns: LEAD_COLUMNS[d],
      notes: LEAD_NOTES[d],
    },
    {
      key: `${d}.staff`,
      department: d,
      title: `${deptName(d)}员工`,
      level: 'admin',
      legacyRole: LEGACY[d].staff[0],
      duties: LEGACY[d].staff[1],
      columns: STAFF_COLUMNS[d] ?? ['own', 'entry'],
      notes: STAFF_NOTES[d],
    },
  ]),
];

export const POSITION_KEYS = POSITIONS.map((p) => p.key);
const BY_KEY = new Map<string, PositionDef>(POSITIONS.map((p) => [p.key, p]));

export function isPositionKey(value: unknown): value is PositionKey {
  return typeof value === 'string' && BY_KEY.has(value);
}
export function positionOf(key: PositionKey): PositionDef {
  return BY_KEY.get(key)!;
}
export function positionLabel(key: PositionKey | null | undefined): string {
  if (!key) return '';
  const p = BY_KEY.get(key);
  return p ? p.title : key;
}

/** 总经办成员的默认：除账号与基础数据外各列的全部权限，去掉只属于专用账号的几项 */
const GMO_EXCLUDE: readonly Permission[] = ['member.lookup', 'studio.edit', 'location.report'];
function gmoDefaults(all: readonly Permission[]): Permission[] {
  const cols = positionOf('gmo').columns;
  return all.filter((p) => cols.includes(PERMISSION_COLUMN[p]) && !GMO_EXCLUDE.includes(p));
}

/** 岗位的默认权限（总裁返回全部） */
export function positionDefaults(key: PositionKey, all: readonly Permission[]): Permission[] {
  if (key === 'president') return [...all];
  if (key === 'gmo') return gmoDefaults(all);
  const set = new Set(POSITION_DEFAULTS[key]);
  return all.filter((p) => set.has(p));
}

/** 岗位权限的后台调整（settings.position_permissions）与个人微调（staff.permission_adjust）：相对默认的增减 */
export interface PermissionAdjust {
  add: Permission[];
  remove: Permission[];
}
export type PositionOverrides = Partial<Record<Exclude<PositionKey, 'president'>, PermissionAdjust>>;

export function applyAdjust(base: Iterable<Permission>, adjust: PermissionAdjust | null | undefined, locked: readonly Permission[]): Set<Permission> {
  const out = new Set(base);
  if (adjust) {
    for (const p of adjust.remove) out.delete(p);
    for (const p of adjust.add) if (!locked.includes(p)) out.add(p);
  }
  return out;
}

/**
 * 老账号第一次登录自己选新岗位（GW7；店主 2026-11-20 定方案 B）时能选的范围：按原来的岗位与职责限定部门，选完立即生效。
 * 不按部门限定的话，前台店员能给自己选「财务部员工」，马上就有付款、回款登记（Codex 安全审查 02d66df）。
 * - 一线部门（前厅、男宾、女宾、娱乐、餐饮、康美、保健）：前台店员选员工，值班经理选负责人或员工；
 * - 后勤部门（人力行政、出品、工程）与浴区（男宾、女宾）的员工：后勤人员；
 * - 外联部（库存采购）：物资经办、采购经办选员工，库存采购负责人选负责人或员工；
 * - 财务部：对账付款、成本核算选员工（负责人只由总裁在后台定）；
 * - 大客户部：客户经理、管家员工选员工，管家经理选负责人或员工；
 * - 店总：总经办与一线、后勤、大客户部的负责人或员工（财务部、外联部要有对应职责）；
 * - 康美部职责选康美部员工，部门申购选一线与后勤部门的员工，法务选人力行政部员工。
 * 总裁只由店主账号承接（迁移时店主账号直接定成总裁，不用选）；选不到自己岗位的找总裁在后台改。
 */
const FRONT_LINE: readonly LinedDepartment[] = ['front', 'male', 'female', 'ent', 'dining', 'kangmei', 'wellness'];
const BACK_OFFICE: readonly LinedDepartment[] = ['hr', 'kitchen', 'eng'];
const staffOf = (ds: readonly LinedDepartment[]): PositionKey[] => ds.map((d) => `${d}.staff` as PositionKey);
const leadOf = (ds: readonly LinedDepartment[]): PositionKey[] => ds.map((d) => `${d}.lead` as PositionKey);

const BY_ROLE: Partial<Record<Role, readonly PositionKey[]>> = {
  clerk: staffOf(FRONT_LINE),
  duty_manager: [...leadOf(FRONT_LINE), ...staffOf(FRONT_LINE)],
  account_manager: ['vip.staff'],
  backoffice: staffOf([...BACK_OFFICE, 'male', 'female']),
  store_manager: ['gmo', ...leadOf([...FRONT_LINE, ...BACK_OFFICE, 'vip']), ...staffOf([...FRONT_LINE, ...BACK_OFFICE, 'vip'])],
};
const BY_DUTY: Partial<Record<Duty, readonly PositionKey[]>> = {
  stock: ['outreach.staff'],
  purchase: ['outreach.staff'],
  approve: ['outreach.lead', 'outreach.staff'],
  payable: ['finance.staff'],
  cost: ['finance.staff'],
  request: staffOf([...FRONT_LINE, ...BACK_OFFICE]),
  kangmei: ['kangmei.staff'],
  concierge: ['vip.staff'],
  concierge_manager: ['vip.lead', 'vip.staff'],
  legal: ['hr.staff'],
};

export function selfSelectablePositions(role: Role, duties: readonly Duty[]): PositionDef[] {
  if (role === 'owner') return [];
  const allowed = new Set<PositionKey>([...(BY_ROLE[role] ?? []), ...duties.flatMap((d) => BY_DUTY[d] ?? [])]);
  return POSITIONS.filter((p) => allowed.has(p.key));
}
