// 规则总表：散在各分区的设置列在一张表里——当前值、默认值、是否改过、谁在什么时候改的、去哪里改。只读。

import { useErpAccess } from '../erp/access';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Search } from 'lucide-react';
import { ADMIN_SECTIONS, RULE_GROUPS, type RuleEntry, type RuleGroup } from '@shared/admin';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { Badge, Card, Input, Notice, PendingBadge, Segmented, Skeleton } from '../../components/ui';
import { AdminPage, useAdminSections } from './AdminShell';

type Filter = 'all' | 'changed' | 'pending';

export function RuleCatalog() {
  const erp = useErpAccess();
  const session = useSession();
  const sections = useAdminSections();
  const q = useQuery({ queryKey: ['admin', 'rules'], queryFn: () => api.get<RuleEntry[]>('/api/admin/rules') });
  const [filter, setFilter] = useState<Filter>('all');
  const [text, setText] = useState('');
  const showPending = !session.rules.hidePendingMarks;
  const rows = useMemo(() => {
    const t = text.trim();
    return (q.data ?? []).filter(
      (r) =>
        (filter === 'all' || (filter === 'changed' ? !r.isDefault : r.pending && r.isDefault)) &&
        (!t || r.label.includes(t) || r.value.includes(t) || (r.hint ?? '').includes(t)),
    );
  }, [q.data, filter, text]);
  const groups = (Object.keys(RULE_GROUPS) as RuleGroup[]).map((g) => ({ g, items: rows.filter((r) => r.group === g) })).filter((x) => x.items.length > 0);

  return (
    <AdminPage section="settings" wide description="全店的规则一览：改动只影响之后的业务，已入账的单据按当时的规则记录。修改请点「去设置」。">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          ariaLabel="筛选规则"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'changed', label: '改过的' },
            ...(showPending ? [{ value: 'pending' as const, label: '待确认的默认做法' }] : []),
          ]}
        />
        <label className="relative min-w-[200px] flex-1 sm:max-w-[280px]">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="搜规则名称或取值" className="pl-9" aria-label="搜规则" />
        </label>
      </div>
      {q.isPending ? (
        <Skeleton className="h-96" />
      ) : q.error ? (
        <Notice tone="error" title={q.error.message} />
      ) : groups.length === 0 ? (
        <Notice tone="info" title="没有符合条件的规则" />
      ) : (
        <div className="space-y-4" data-testid="rule-catalog">
          {groups.map(({ g, items }) => (
            <Card key={g} className="overflow-hidden">
              <p className="border-b border-line bg-paper-2/60 px-4 py-2 text-[13px] font-bold text-ink-2">{RULE_GROUPS[g]}</p>
              <ul className="divide-y divide-line/70">
                {items.map((r) => (
                  <li key={r.key} className="grid gap-x-4 gap-y-1 px-4 py-3 md:grid-cols-[minmax(0,200px)_minmax(0,1fr)_auto]" data-testid={`rule-${r.key}`}>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-[14px] font-bold text-ink">
                        {r.label}
                        {r.pending && r.isDefault && <PendingBadge />}
                      </p>
                      {r.hint && <p className="text-[12px] text-ink-3">{r.hint}</p>}
                    </div>
                    <div className="min-w-0 text-[13.5px]">
                      <p className={cn('break-words', r.isDefault ? 'text-ink-2' : 'font-semibold text-ink')}>{r.value}</p>
                      {!r.isDefault && <p className="text-[12px] text-ink-3">默认：{r.defaultValue}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 md:max-w-[300px] md:justify-end">
                      {r.isDefault ? <Badge>默认</Badge> : <Badge tone="pine">已调整</Badge>}
                      {r.updatedBy && (
                        <span className="text-[11.5px] text-ink-3">
                          {r.updatedBy} · {formatDateTime(r.updatedAt!)}
                        </span>
                      )}
                      {r.href ? (
                        // ERP 的规则在「ERP 设置」里改（8.0.18）；能不能改由那一页按权限定
                        erp.canEnter && (
                          <Link to={r.href} className="text-[12.5px] font-semibold text-pine hover:underline" data-testid={`rule-go-${r.key}`}>
                            去 ERP 设置 →
                          </Link>
                        )
                      ) : (
                        sections.includes(r.section) && (
                          <Link to={ADMIN_SECTIONS[r.section].path} className="text-[12.5px] font-semibold text-pine hover:underline">
                            去设置 →
                          </Link>
                        )
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </AdminPage>
  );
}
