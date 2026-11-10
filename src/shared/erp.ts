// ERP 独立工作区（v0.7.3，店主 2026-10-30 定，见 docs/ERP.md）：财务、采购用的功能放在单独的 ERP 工作区，
// 门店主导航看不到；ERP 包含 SCM（供应商、采购、库存、应付货款）。模块按这张注册表配置、不写死：
// ERP 的导航与路由、服务端按接口前缀拦截关闭的模块、店主的模块开关都从这里来。以后同事提的新模块在这里加一条。

import type { Permission } from './permissions';

export const ERP_MODULE_KEYS = ['inventory', 'purchasing', 'requests', 'deptStock', 'payables', 'assets', 'approvals', 'contracts', 'payments', 'expenses', 'invoices', 'receivables', 'revenue', 'canteen'] as const;
export type ErpModuleKey = (typeof ERP_MODULE_KEYS)[number];

export interface ErpModuleDef {
  label: string;
  /** ERP 导航的分组 */
  group: '供应链' | '财务' | '法务' | '员工服务';
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
    // 补货建议、询价比价、价格曲线（v0.7.29 ERP 采购五项）也跟采购模块走
    // 供应商比价看板（8.0.1 采购组整改 07）也跟采购模块走
    apis: ['/api/purchase-orders', '/api/purchase-baseline', '/api/erp/images', '/api/purchase-suggestions', '/api/purchase-sourcing', '/api/purchase-price-history', '/api/purchase-compare'],
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
  assets: {
    label: '资产与易耗',
    group: '供应链',
    description: '资产卡片（固定资产、低值易耗）：从收货转资产建卡或手工建卡，调拨、改状态、报废都留记录；打印资产标签，扫码盘点（8.0.7）',
    path: '/erp/assets',
    pages: ['/erp/assets'],
    apis: ['/api/erp/assets'],
    perms: ['asset.read'],
    defaultEnabled: true,
    requires: ['inventory'],
  },
  approvals: {
    label: '审批中心',
    group: '供应链',
    description:
      '审批规则（单据类型 × 金额 × 部门 → 一到三级审批链）、待我审批、批量同意、超时提醒、代理人，手机上也能审；采购、报损、盘点差异、退货、付款、期初、报销都走这里（v0.7.30）。' +
      '旧的「审批待办」页照常在。关掉只是不显示这两页，各单据里的确认照常走审批规则',
    path: '/approvals',
    pages: ['/approvals', '/todo'],
    apis: ['/api/approvals'],
    perms: ['approval.act', 'inventory.approve', 'expense.approve'],
    defaultEnabled: true,
    requires: ['inventory'],
  },
  contracts: {
    label: '合同',
    group: '法务',
    description:
      '合同台账与四要素（单价表、付款节点、质保、验收标准），审查走审批中心（财务 → 法务 → 负责人，法务按审查清单逐条给意见），' +
      '签署、用印、归档，变更单，到期前 60 天提醒；采购单可以挂合同、按单价表核对（v0.7.31）',
    path: '/erp/contracts',
    pages: ['/erp/contracts'],
    apis: ['/api/erp/contracts'],
    perms: ['contract.read'],
    defaultEnabled: true,
    // 相对方、物料在库存模块的档案里；审查走审批中心的接口（审批中心关着时各单据照常走审批规则）
    requires: ['inventory'],
  },
  payments: {
    label: '付款',
    group: '财务',
    description:
      '付款申请（从合同的付款节点或没挂合同的应付发起，走审批中心：财务 → 负责人，提前付款多一级店主），批了以后按申请登记付款；' +
      '发票登记与三单匹配（差额默认超过 1% 或 ¥50 挂起、财务放行），质保金台账（默认到期前 30 天提醒），本周应付（默认四周、资金缺口、导出）（v0.7.32）；' +
      '这几个数、加店主一级的金额与「挂合同的货款要先提申请」在「付款规则」里改（8.0.6）',
    path: '/erp/payments',
    pages: ['/erp/payments'],
    apis: ['/api/erp/payments'],
    perms: ['payable.read', 'payment.request'],
    defaultEnabled: true,
    // 付款登记、供应商往来在应付货款模块里；合同的付款计划、验收在合同模块里（合同模块关着时只能对没挂合同的应付提申请）
    requires: ['inventory', 'payables'],
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
  // 进项发票台账（8.0.3，docs/BUDGET_INVOICES.md 第 3 节）：三单的供应商发票、报销的专票普票、直接登记的都在这里
  invoices: {
    label: '发票台账',
    group: '财务',
    description:
      '进项发票台账：三单匹配登记的供应商发票、报销单上的专票与普票、直接登记的；认证状态与所属期、认证期限到期前提醒、' +
      '异常票（重号、税额税率不符、过期、与报销金额不符）标记、拍照上传（8.0.3）',
    path: '/erp/invoices',
    pages: ['/erp/invoices'],
    apis: ['/api/erp/invoices'],
    perms: ['payable.read', 'expense.read', 'invoice.manage'],
    defaultEnabled: true,
    // 开票方可以是供应商档案里的供应商
    requires: ['inventory'],
  },
  receivables: {
    label: '应收与挂账',
    group: '财务',
    description: '协议单位与挂账额度，前台结账挂账、回款登记与核销、平台团购回款、账龄与逾期提醒（8.0.7）',
    path: '/erp/receivables',
    pages: ['/erp/receivables'],
    apis: ['/api/erp/receivables'],
    perms: ['ar.read'],
    defaultEnabled: true,
    requires: [],
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
  // 员工食堂 · 柚子饭堂（店主 2026-11-06，docs/CANTEEN.md）：默认关；关着时员工端口也回「饭堂还没开张」
  canteen: {
    label: '员工食堂',
    group: '员工服务',
    description: '员工手机上的「柚子饭堂」：看菜单、点赞、亮饭卡码；食堂负责人扫码打卡、厨师发布菜单。这里管员工名单、打印开通卡片、看用餐记录、设开饭时间',
    path: '/erp/canteen',
    pages: ['/erp/canteen'],
    apis: ['/api/erp/canteen'],
    perms: ['canteen.manage'],
    defaultEnabled: false,
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
  // 批量发券（8.0.4 需求表 06）：圈一批会员发券，没收到结果时查回、原样重提或确认作废
  'coupon_campaign',
  'coupon_issue',
  // 硬件连接（v0.7.21）：登记设备、打印任务（断网后刷新也要能查回、重提或作废）
  'device_create',
  'device_job',
  // 供应商付款、期初未付登记（v0.7.22）：原来只放在页面内存里，刷新就丢、服务端也不能作废
  'payment',
  'opening_payable',
  // 会员体系 v2（v0.7.23）：店主手动调整档阶（Codex 自动审查 43d53e9：超时、回复 500 后也要能查回、重提或作废）
  'grade_adjust',
  // 会员体系 v2 第二期（v0.7.24）：登记服务类权益的使用（数次数，重复登记会多占次数）
  'benefit_use',
  // 会员体系 v2 第三期（v0.7.25）：邀请体验、赠送会籍（占每月次数、QY-042 的次数，重复发起会被拒）
  'member_trial',
  // 会员体系收尾（v0.7.26）：退储值（动的是钱）、停用 / 启用、合并会员（重复提交会被拒）
  'member_refund',
  'member_status',
  'member_merge',
  // 次卡（v0.7.28）：售卡、退卡（动的是钱）
  'count_card_sale',
  'count_card_refund',
  // 平台核销补录（v0.7.28）：补登记、平台打款登记
  'platform_redemption',
  'platform_settlement',
  // 业务单据打到小票机（v0.7.28）
  'doc_print',
  // 会员实体卡：发卡、补卡（v0.7.28）
  'member_card',
  // 审批中心（v0.7.30）：新建审批规则、设代理人（Codex 自动审查 2cfd28b：没收到结果时刷新、关掉对话框后也要能查回、重提或作废）
  'approval_rule',
  'approval_delegation',
  // 合同与法务审查（v0.7.31）：新建合同、变更单、用印申请
  'contract_create',
  'contract_change',
  'contract_seal',
  // 付款流（v0.7.32）：付款申请、合同付款、验收登记、质量问题登记、登记发票（按申请登记的供应商往来付款用上面的 payment）
  'payment_request',
  'contract_payout',
  'contract_acceptance',
  'contract_quality',
  'supplier_invoice',
  // 员工食堂第二期：柚子信箱的回信（Codex 自动审查 3bc51e6：没收到结果时关掉对话框、刷新以后也要能查回、重提或作废）
  'canteen_reply',
  // 8.0.1 采购组整改：集采导入（06）、赠品登记（09）
  'request_import',
  'gift_receipt',
  // 8.0.7 ERP P2：回款登记（动的是钱）、资产建卡
  'ar_collection',
  'asset_card',
  'asset_stocktake',
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
  coupon_campaign: '批量发券',
  coupon_issue: '发券给会员',
  device_create: '登记设备',
  device_job: '测试打印',
  payment: '供应商付款',
  opening_payable: '期初未付登记',
  grade_adjust: '手动调整会员档阶',
  benefit_use: '登记权益使用',
  member_trial: '邀请体验 / 赠送会籍',
  member_refund: '退储值',
  member_status: '停用 / 启用会员',
  member_merge: '合并会员',
  count_card_sale: '售次卡',
  count_card_refund: '退次卡',
  platform_redemption: '平台核销补登记',
  platform_settlement: '平台打款登记',
  doc_print: '打印单据',
  member_card: '发卡、补卡',
  approval_rule: '新建审批规则',
  approval_delegation: '设代理人',
  contract_create: '新建合同',
  contract_change: '新建变更单',
  contract_seal: '用印申请',
  payment_request: '付款申请',
  contract_payout: '合同付款',
  contract_acceptance: '验收登记',
  contract_quality: '质量问题登记',
  supplier_invoice: '登记发票',
  canteen_reply: '柚子信箱回信',
  request_import: '集采导入',
  gift_receipt: '赠品登记',
  ar_collection: '回款登记',
  asset_card: '资产建卡',
  asset_stocktake: '开始扫码盘点',
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
  kpis: { receivable: number; discount: number; coupon: number; memberDiscount: number; refund: number; net: number; guests: number; checkouts: number; perGuest: number; rechargePaid: number; memberRefund: number };
  trend: { date: string; net: number; guests: number; rechargePaid: number }[];
  byMethod: { method: import('./checkout').CheckoutMethod; amount: number }[];
  departments: import('./reports').DepartmentRevenue[];
  /** 已确认日结的营业日 */
  settlements: { date: string; closedAt: string; closedByName: string }[];
}
