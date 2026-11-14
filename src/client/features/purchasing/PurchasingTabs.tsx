// 采购的二级页签（8.0.18，docs/IA_V8017.md 第 3.3 节）：原来采购页右上角一排 9 个按钮，各开一个子页，
// 进了子页只能点「返回」再换一个。现在每个子页顶上都是同一排页签，地址没变（/purchasing/flow、/purchasing/sourcing……）。
// 采购规则不在这里：规则收进了「ERP 设置」。

import { useCan } from '../../lib/session';
import { SubNav, type SubTab } from '../../components/SubNav';
import { useSuggestions } from './queries';

export type PurchasingTabKey = 'orders' | 'flow' | 'sourcing' | 'suggestions' | 'ordered' | 'urgent' | 'compare' | 'scores' | 'import';

export function PurchasingTabs({ active }: { active: PurchasingTabKey }) {
  const can = useCan();
  // 补货建议（v0.7.29）：有要补的物料时页签上带数量
  const suggestions = useSuggestions(can('inventory.read'));
  // 标识沿用原来那排按钮的（自动化用例按它们找）
  const tabs: SubTab[] = [
    { key: 'orders', label: '采购单', to: '/purchasing', testId: 'purchasing-tab-orders' },
    { key: 'flow', label: '流程进度', to: '/purchasing/flow', testId: 'flow-link' },
    { key: 'sourcing', label: '询价比价', to: '/purchasing/sourcing', testId: 'sourcing-link' },
    { key: 'suggestions', label: '补货建议', to: '/purchasing/suggestions', testId: 'suggestions-link', badge: suggestions.data?.count },
    { key: 'ordered', label: '下单物料', to: '/purchasing/ordered', testId: 'ordered-link' },
    { key: 'urgent', label: '急采', to: '/purchasing/urgent', testId: 'urgent-link' },
    { key: 'compare', label: '供应商比价', to: '/purchasing/compare', testId: 'compare-link' },
    { key: 'scores', label: '供应商评分', to: '/purchasing/scores', testId: 'scores-link' },
    ...(can('request.review') ? [{ key: 'import', label: '集采导入', to: '/purchasing/import', testId: 'request-import-link' }] : []),
  ];
  return (
    <div className="shrink-0 px-5 md:px-7" data-testid="purchasing-tabs">
      <SubNav tabs={tabs} base="/purchasing" active={active} label="采购的页签" />
    </div>
  );
}
