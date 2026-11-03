// ERP 独立工作区（v0.7.3，店主 2026-10-30 定，见 docs/ERP.md）：财务、采购用的功能放在单独的 ERP 工作区，
// 门店主导航看不到；ERP 包含 SCM（供应商、采购、库存、应付货款）。模块按这张注册表配置、不写死：
// ERP 的导航与路由、服务端按接口前缀拦截关闭的模块、店主的模块开关都从这里来。以后同事提的新模块在这里加一条。

import type { Permission } from './permissions';

export const ERP_MODULE_KEYS = ['inventory', 'purchasing', 'requests', 'deptStock', 'payables', 'approvals', 'expenses', 'revenue'] as const;
export type ErpModuleKey = (typeof ERP_MODULE_KEYS)[number];

export interface ErpModuleDef {
  label: string;
  /** ERP 导航的分组 */
  group: '供应链' | '财务';
  description: string;
  /** 模块的入口页面 */
  path: string;
  /** 属于这个模块的页面（路径前缀）：在 ERP 外壳里打开，模块关闭时不能打开 */
  pages: readonly string[];
  /** 属于这个模块的接口（路径前缀）：模块关闭时一律拒绝（`ERP_MODULE_DISABLED`） */
  apis: readonly string[];
  /** 看得到这个模块要有的权限（有其中一个即可） */
  perms: readonly Permission[];
  /** 新装的门店默认开不开 */
  defaultEnabled: boolean;
  /** 依赖的模块：被依赖的模块关着时，这个模块也用不了 */
  requires: readonly ErpModuleKey[];
}

export const ERP_MODULES: Record<ErpModuleKey, ErpModuleDef> = {
  inventory: {
    label: '库存',
    group: '供应链',
    description: '物料、供应商、部门档案；总仓与部门小仓两级库存；期初、收货、领料、退回、报损、盘点；库存报表',
    path: '/inventory',
    pages: ['/inventory'],
    apis: ['/api/inventory'],
    perms: ['inventory.read'],
    defaultEnabled: true,
    requires: [],
  },
  purchasing: {
    label: '采购',
    group: '供应链',
    description: '采购单的编制、确认、修订与按单收货',
    path: '/purchasing',
    pages: ['/purchasing'],
    // 图片（v0.7.8）：采购单与需求单的行都用，跟采购模块走（需求单依赖采购）
    apis: ['/api/purchase-orders', '/api/purchase-baseline', '/api/erp/images'],
    // 物资经办要看采购单、按单收货（采购单的读接口按「查看库存与物资单据」开放）
    perms: ['inventory.read', 'purchase.manage', 'inventory.approve', 'payable.read'],
    defaultEnabled: true,
    requires: ['inventory'],
  },
  requests: {
    label: '采购需求单',
    group: '供应链',
    description: '部门提采购需求（链接、详情、图片），采购审核后一键转采购单，下单 / 到货 / 退货自动回写（v0.7.8，飞书需求 RQ-005）',
    path: '/erp/requests',
    pages: ['/erp/requests'],
    apis: ['/api/erp/requests'],
    perms: ['request.create', 'request.review'],
    defaultEnabled: true,
    requires: ['inventory', 'purchasing'],
  },
  deptStock: {
    label: '本部门小仓',
    group: '供应链',
    description: '部门自己的小仓：结存、签收仓库登记的领料、急采与补采购单、本部门的期初、耗用、报损、盘点；财务成本岗可看所有部门、给部门盘点（v0.7.11，飞书需求 RQ-002）',
    path: '/erp/dept-stock',
    pages: ['/erp/dept-stock'],
    apis: ['/api/erp/dept-stock'],
    perms: ['deptStock.operate', 'deptStock.audit'],
    defaultEnabled: true,
    // 补采购单另要采购模块开着（接口里核对）
    requires: ['inventory'],
  },
  payables: {
    label: '应付货款',
    group: '供应链',
    description: '供应商应付、期初未付、付款登记与对账单',
    path: '/payables',
    pages: ['/payables'],
    apis: ['/api/payables'],
    perms: ['payable.read'],
    defaultEnabled: true,
    requires: ['inventory'],
  },
  approvals: {
    label: '审批待办',
    group: '供应链',
    description: '待办汇总：负责人要确认的采购、报损、盘点调整、退货、付款、期初集中在一页。关掉只是不显示这一页，各单据里的确认照常',
    path: '/todo',
    pages: ['/todo'],
    apis: [],
    perms: ['inventory.approve'],
    defaultEnabled: true,
    requires: ['inventory'],
  },
  expenses: {
    label: '费用与备用金',
    group: '财务',
    description: '费用报销（按采购单或按次；发票、税点、科目、用途）、备用金打款与退回、每日平账（v0.7.7，飞书需求 RQ-005）',
    path: '/erp/expenses',
    // 旧账对照（v0.7.10）：8–10 月旧账只读，不进正式账
    pages: ['/erp/expenses', '/erp/petty', '/erp/ledger', '/erp/audit', '/erp/legacy'],
    apis: ['/api/erp/expenses', '/api/erp/petty', '/api/erp/ledger', '/api/erp/audit', '/api/erp/legacy'],
    perms: ['expense.read'],
    defaultEnabled: true,
    // 部门、供应商档案在库存模块里；按采购单报销读采购单（采购模块关着时只能按次报销）
    requires: ['inventory'],
  },
  revenue: {
    label: '营业数据',
    group: '财务',
    description: '只读：每天的营业收入、收款构成、部门构成与日结情况（门店的流水、日结、交班仍在门店办理）',
    path: '/erp/revenue',
    pages: ['/erp/revenue'],
    apis: ['/api/erp/revenue'],
    perms: ['erp.revenue'],
    defaultEnabled: true,
    requires: [],
  },
};

/** 店主保存的模块开关（只存改过的；没存的按默认） */
export type ErpModuleSwitches = Partial<Record<ErpModuleKey, boolean>>;

export interface ErpModuleState {
  key: ErpModuleKey;
  label: string;
  group: ErpModuleDef['group'];
  description: string;
  /** 店主的开关 */
  switchedOn: boolean;
  /** 实际能不能用：开关打开、依赖的模块也都能用 */
  enabled: boolean;
  requires: ErpModuleKey[];
}

export interface ErpModulesInfo {
  modules: ErpModuleState[];
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 按开关与依赖算出实际能用的模块（依赖只指向排在前面的模块，按注册顺序算一遍即可） */
export function effectiveErpModules(switches: ErpModuleSwitches): Set<ErpModuleKey> {
  const on = new Set<ErpModuleKey>();
  for (const key of ERP_MODULE_KEYS) {
    const def = ERP_MODULES[key];
    if ((switches[key] ?? def.defaultEnabled) && def.requires.every((r) => on.has(r))) on.add(key);
  }
  return on;
}

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);

/** 这个接口属于哪个 ERP 模块（不属于 ERP 的返回 null） */
export function erpModuleOfApi(url: string): ErpModuleKey | null {
  return ERP_MODULE_KEYS.find((k) => ERP_MODULES[k].apis.some((p) => under(url, p))) ?? null;
}

/** 这个页面属于哪个 ERP 模块 */
export function erpModuleOfPage(path: string): ErpModuleKey | null {
  return ERP_MODULE_KEYS.find((k) => ERP_MODULES[k].pages.some((p) => under(path, p))) ?? null;
}

/** 能进 ERP 的权限（有其一即可）：任一模块的权限，或店主的模块设置 */
export const ERP_PERMISSIONS: readonly Permission[] = [...new Set<Permission>([...ERP_MODULE_KEYS.flatMap((k) => ERP_MODULES[k].perms), 'settings.manage'])];

/**
 * ERP 单据的「结果待确认」（v0.7.8）：页面提交前把操作编号和原请求存在本机，断网后按编号查回，
 * 或在服务端确认作废（原请求晚到也不会登记）后再重新填写。
 */
export const ERP_OP_TYPES = [
  'expense_claim',
  'petty_advance',
  'petty_settlement',
  'purchase_request',
  'ap_offset',
  'supplier_refund',
  'erp_import',
  'supplier_recon',
  'supplier_recon_void',
  // 后台「空间台账」的导入（v0.7.14）与模拟刷卡（v0.7.17）：不属于 ERP 模块，借用同一套「结果待确认」
  'space_import',
  'location_report',
  // 券与会员权益（v0.7.20）：新建券模板、发券规则，生成无记名券，发券给会员（Codex 复审 6c3765c：断网后刷新也要能查回、重提或作废）
  'coupon_template',
  'coupon_rule',
  'coupon_batch',
  'coupon_issue',
  // 硬件连接（v0.7.21）：登记设备、打印任务（断网后刷新也要能查回、重提或作废）
  'device_create',
  'device_job',
  // 供应商付款、期初未付登记（v0.7.22）：原来只放在页面内存里，刷新就丢、服务端也不能作废
  'payment',
  'opening_payable',
  // 会员体系 v2（v0.7.23）：店主手动调整档阶（Codex 自动审查 43d53e9：超时、回复 500 后也要能查回、重提或作废）
  'grade_adjust',
] as const;
export type ErpOpType = (typeof ERP_OP_TYPES)[number];
export const ERP_OP_LABELS: Record<ErpOpType, string> = {
  expense_claim: '费用报销',
  petty_advance: '备用金打款',
  petty_settlement: '备用金退回 / 补付',
  purchase_request: '部门需求单',
  ap_offset: '核销',
  supplier_refund: '供应商退款',
  erp_import: '批量导入',
  supplier_recon: '对账登记',
  supplier_recon_void: '撤销对账登记',
  space_import: '空间台账导入',
  location_report: '模拟刷卡',
  coupon_template: '新建券模板',
  coupon_rule: '加发券规则',
  coupon_batch: '生成无记名券',
  coupon_issue: '发券给会员',
  device_create: '登记设备',
  device_job: '测试打印',
  payment: '供应商付款',
  opening_payable: '期初未付登记',
  grade_adjust: '手动调整会员档阶',
};
export interface ErpOpLookup {
  /** 已经登记成功：refId 是那张单据（退回 / 补付另给所在的打款） */
  found: boolean;
  /** 已在服务端确认作废，原请求不会再登记 */
  abandoned: boolean;
  refId?: number;
  advanceId?: number;
}

/** 营业数据（只读）：任选时段 */
export interface ErpRevenue {
  from: string;
  to: string;
  days: number;
  /** 净营业额 = 应收 − 优惠；结账客人、客单价、充值收款（与经营总览同一口径） */
  kpis: { receivable: number; discount: number; coupon: number; refund: number; net: number; guests: number; checkouts: number; perGuest: number; rechargePaid: number };
  trend: { date: string; net: number; guests: number; rechargePaid: number }[];
  byMethod: { method: import('./checkout').CheckoutMethod; amount: number }[];
  departments: import('./reports').DepartmentRevenue[];
  /** 已确认日结的营业日 */
  settlements: { date: string; closedAt: string; closedByName: string }[];
}
