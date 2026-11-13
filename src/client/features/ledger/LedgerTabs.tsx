// 流水页最上面的页签（8.0.15）：余额流水（原来的页面）与订单查询。选的是哪一个记在地址栏的 tab 里。

import { useSearchParams } from 'react-router';
import { Segmented } from '../../components/ui';

export type LedgerTab = 'ledger' | 'orders';

export function LedgerTabs({ value }: { value: LedgerTab }) {
  const [params, setParams] = useSearchParams();
  const change = (tab: LedgerTab) => {
    if (tab === value) return;
    // 两个页签各有各的筛选：换页签时只留营业日
    const next = new URLSearchParams();
    const date = params.get('date');
    if (date) next.set('date', date);
    if (tab === 'orders') next.set('tab', 'orders');
    setParams(next, { replace: true });
  };
  return (
    <div className="flex shrink-0 items-center border-b border-line px-5 py-2 md:px-7" data-testid="ledger-tabs">
      <Segmented<LedgerTab>
        value={value}
        onChange={change}
        ariaLabel="流水页签"
        options={[
          { value: 'ledger', label: '余额流水' },
          { value: 'orders', label: '订单查询' },
        ]}
      />
    </div>
  );
}
