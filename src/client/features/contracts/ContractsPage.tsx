// 合同台账（v0.7.31，docs/CONTRACTS.md 第 1、7 节）：按状态、类型筛选，搜合同号、标题、相对方；
// 顶部是到期提醒（已签署、已归档，结束日在 60 天内、还没有续签的，C11），可以直接去续签。

import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { CalendarClock, FilePlus2, Plus, RefreshCw } from 'lucide-react';
import { CONTRACT_CATEGORIES, CONTRACT_CATEGORY_LABELS, CONTRACT_EXPIRY_REMIND_DAYS, type ContractCategory } from '@shared/contracts';
import { errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Money } from '../../components/Money';
import { Badge, Button, Card, Input, Notice, Select, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { ContractStatusBadge, daysLeftText } from './parts';
import { useContractExpiring, useContracts, type ContractFilter } from './queries';

const FILTERS: { value: ContractFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'drafting', label: '起草中' },
  { value: 'reviewing', label: '审查中' },
  { value: 'effective', label: '生效中' },
  { value: 'expiring', label: '快到期' },
  { value: 'closed', label: '已结束' },
];

export function ContractsPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filter = FILTERS.find((f) => f.value === params.get('filter'))?.value ?? 'all';
  const [category, setCategory] = useState<ContractCategory | ''>('');
  const [q, setQ] = useState('');
  const list = useContracts(filter, category, q);
  const expiring = useContractExpiring();
  const manage = can('contract.manage');
  // 还没续签的才提醒；已经在续签（新合同没作废）的列在后面、标出续签的合同号
  const due = (expiring.data ?? []).filter((x) => !x.renewal);
  const renewing = (expiring.data ?? []).filter((x) => x.renewal);

  return (
    <ErpPage
      title="合同"
      description="合同台账与四要素（单价、付款节点、质保、验收），法务按审查清单逐条审；签署、用印、扫描件归档；采购单可以挂合同、按单价表核对。"
      actions={
        manage && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate('/erp/contracts/new')} data-testid="contract-new">
            新建合同
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {manage && <ErpPendingPanel types={['contract_create']} onFound={(_, ref) => navigate(`/erp/contracts/${ref.refId}`)} />}

        {(due.length > 0 || renewing.length > 0) && (
          <Notice
            tone={due.some((x) => x.daysLeft < 0) ? 'error' : 'warning'}
            icon={<CalendarClock className="size-5" />}
            title={due.length > 0 ? `${due.length} 份合同 ${CONTRACT_EXPIRY_REMIND_DAYS} 天内到期，还没有续签` : `快到期的合同都在续签`}
            data-testid="contract-expiring"
          >
            <ul className="mt-1 space-y-1">
              {[...due, ...renewing].map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid={`contract-expiring-${x.contractNo}`}>
                  <Link to={`/erp/contracts/${x.id}`} className="num font-semibold text-ink hover:underline">
                    {x.contractNo}
                  </Link>
                  <span className="min-w-0 text-ink">
                    {x.title} · {x.counterparty}
                  </span>
                  <span className={cn('num font-semibold', x.daysLeft < 0 ? 'text-clay' : 'text-yuzu-deep')}>
                    {x.endDate} {daysLeftText(x.daysLeft)}
                  </span>
                  <span className="text-ink-3">经办 {x.handlerName}</span>
                  {x.renewal ? (
                    <Link to={`/erp/contracts/${x.renewal.id}`} className="font-semibold text-lake hover:underline">
                      续签中：{x.renewal.contractNo}
                    </Link>
                  ) : (
                    manage && (
                      <Link
                        to={`/erp/contracts/new?renew=${x.id}`}
                        className="inline-flex items-center gap-1 font-semibold text-lake hover:underline"
                        data-testid={`contract-renew-${x.contractNo}`}
                      >
                        <RefreshCw className="size-3.5" />
                        续签
                      </Link>
                    )
                  )}
                </li>
              ))}
            </ul>
          </Notice>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="状态">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                role="radio"
                aria-checked={filter === f.value}
                onClick={() => setParams(f.value === 'all' ? {} : { filter: f.value }, { replace: true })}
                className={cn('h-8 rounded-full px-3 text-[13px] font-semibold', filter === f.value ? 'bg-ink text-paper' : 'bg-paper-2 text-ink-2 hover:bg-paper-3')}
                data-testid={`contract-filter-${f.value}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Select aria-label="合同类型" value={category} fullWidth={false} onChange={(e) => setCategory(e.target.value as ContractCategory | '')} className="h-9 w-32" data-testid="contract-category-filter">
            <option value="">全部类型</option>
            {CONTRACT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CONTRACT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
          <Input
            aria-label="搜索合同"
            value={q}
            maxLength={32}
            onChange={(e) => setQ(e.target.value)}
            placeholder="合同号、标题、相对方"
            fullWidth={false}
            className="h-9 w-56"
            data-testid="contract-search"
          />
        </div>

        {list.isPending ? (
          <Skeleton className="h-48" />
        ) : list.error ? (
          <Notice tone="error" title={errorMessage(list.error)} />
        ) : list.data!.length === 0 ? (
          <EmptyState
            art="search"
            title={filter === 'all' && !category && !q ? '还没有合同' : '没有符合条件的合同'}
            description={manage ? '新建合同：选相对方、填四要素和单价表，提交后走审批中心，法务按审查清单逐条审。' : '合同由采购或法务起草。'}
            action={
              manage && filter === 'all' && !category && !q ? (
                <Button variant="secondary" icon={<FilePlus2 className="size-4" />} onClick={() => navigate('/erp/contracts/new')}>
                  新建合同
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line/70" data-testid="contract-list">
              {list.data!.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/erp/contracts/${c.id}`}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 hover:bg-paper-2 md:grid-cols-[170px_minmax(0,1fr)_130px_150px]"
                    data-testid={`contract-row-${c.contractNo}`}
                  >
                    <span className="num text-[13.5px] font-bold">
                      {c.contractNo}
                      <span className="block font-sans text-[12px] font-medium text-ink-3">
                        {CONTRACT_CATEGORY_LABELS[c.category]}
                        {c.currentVersion > 1 && ` · 第 ${c.currentVersion} 版`}
                      </span>
                    </span>
                    <span className="min-w-0 text-[12.5px]">
                      <span className="block truncate text-[13.5px] font-semibold">{c.title}</span>
                      <span className="block truncate text-ink-3">
                        {c.counterparty}
                        {c.departmentName && ` · ${c.departmentName}`} · 经办 {c.handlerName}
                        {c.startDate && ` · ${c.startDate} 至 ${c.endDate ?? '不定期'}`}
                      </span>
                    </span>
                    <span className="text-right md:self-center">
                      <Money cents={c.totalCents} className="text-[14px] font-bold" />
                    </span>
                    <span className="flex flex-wrap items-center justify-end gap-1.5 md:self-center">
                      {c.openChangeNo && <Badge tone="yuzu">变更中</Badge>}
                      {c.daysLeft !== null && c.daysLeft <= CONTRACT_EXPIRY_REMIND_DAYS && !c.renewal && (
                        <Badge tone={c.daysLeft < 0 ? 'clay' : 'ember'}>{daysLeftText(c.daysLeft)}</Badge>
                      )}
                      {c.renewal && <Badge tone="lake">已续签</Badge>}
                      <ContractStatusBadge status={c.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </ErpPage>
  );
}
