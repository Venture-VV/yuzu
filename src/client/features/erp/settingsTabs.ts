// 「ERP 设置」有哪些页签、谁看得到（8.0.18，docs/IA_V8017.md 第 3.3 节）。
// ERP 的规则原来散在六处：ERP「模块设置」、采购「采购规则」、审批中心「审批规则」、付款「付款规则」、
// 后台「门店基本规则 → 库存与采购」「可调的数值」。现在收在这一页，各自还是原来那张卡片、原来的权限；
// 原来的地址都跳到对应的页签。

import type { ErpModuleKey } from '@shared/erp';
import type { Permission } from '@shared/permissions';

export interface ErpSettingsTab {
  key: 'modules' | 'purchase' | 'inventory' | 'approvals' | 'payments' | 'expenses' | 'tunables';
  label: string;
  /** 一句话说明这一页签管什么（ERP 设置页的标题下面、规则总表里用） */
  hint: string;
}

const ALL: readonly (ErpSettingsTab & { perms: readonly Permission[]; module?: ErpModuleKey })[] = [
  { key: 'modules', label: '模块开关', hint: '开关 ERP 的模块（含已经挪到后台的员工食堂、安保巡场、营业数据）', perms: ['settings.manage'] },
  { key: 'purchase', label: '采购规则', hint: '截单、需求单转采购单、部门主管确认、急采分级审批、询价门槛、补货与到货超期', perms: ['inventory.read'], module: 'purchasing' },
  { key: 'inventory', label: '库存与审批开关', hint: '盘点日、称重容差、按批次对账宽限、哪些单据要负责人确认', perms: ['settings.manage'], module: 'inventory' },
  { key: 'approvals', label: '审批规则与代理人', hint: '单据类型 × 金额 × 部门 → 一到三级审批链；谁替谁审', perms: ['approval.act', 'inventory.approve', 'expense.approve', 'approval.rules'], module: 'approvals' },
  { key: 'payments', label: '付款规则', hint: '三单比对的容差、本周应付、固定付款日、质保金提醒、挂合同的货款先提申请', perms: ['payable.read', 'payment.request'], module: 'payments' },
  { key: 'expenses', label: '报销与备用金', hint: '报销门槛、发票类型与税率、预算预警；部门备用金定额与预算额度的入口', perms: ['settings.manage'], module: 'expenses' },
  { key: 'tunables', label: '其他数值', hint: '审批超时、合同提醒、附件大小、供应商证照与评分、呆滞与效期、应收提醒、企业微信推送', perms: ['settings.manage'] },
];

/** 这个人看得到的页签（按顺序）：有权限，而且那个模块开着 */
export function erpSettingsTabs(can: (p: Permission) => boolean, modules: readonly ErpModuleKey[]): ErpSettingsTab[] {
  return ALL.filter((t) => t.perms.some((p) => can(p)) && (!t.module || modules.includes(t.module))).map(({ key, label, hint }) => ({ key, label, hint }));
}

/** 某个页签的地址（第一个页签的地址就是 /erp/settings；这里一律带上页签，认不得时由页面跳回第一个） */
export const erpSettingsPath = (key: ErpSettingsTab['key']) => `/erp/settings/${key}`;
