// 费用与备用金的二级页签（8.0.18，docs/IA_V8017.md 第 3.3 节）：原来报销页右上角一排按钮各开一个子页，
// 现在这几页顶上都是同一排页签，地址没变（/erp/petty、/erp/ledger……）。发票台账是单独的模块，不在这一排。

import { SubNav, type SubTab } from '../../components/SubNav';

export type ExpenseTabKey = 'claims' | 'petty' | 'budgets' | 'ledger' | 'audit' | 'legacy';

const TABS: readonly SubTab[] = [
  { key: 'claims', label: '报销', to: '/erp/expenses', testId: 'expenses-tab-claims' },
  { key: 'petty', label: '备用金与每日平账', to: '/erp/petty', testId: 'petty-link' },
  { key: 'budgets', label: '费用预算', to: '/erp/expenses/budgets', testId: 'budgets-link' },
  { key: 'ledger', label: '采购台账', to: '/erp/ledger', testId: 'ledger-link' },
  { key: 'audit', label: '账目自检', to: '/erp/audit', testId: 'audit-link' },
  { key: 'legacy', label: '旧账对照', to: '/erp/legacy', testId: 'legacy-link' },
];

export function ExpenseTabs({ active }: { active: ExpenseTabKey }) {
  return <SubNav tabs={TABS} base="/erp/expenses" active={active} label="费用与备用金的页签" className="mb-5" />;
}
