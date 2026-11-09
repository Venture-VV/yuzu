// 前台会员工作台：充值记录与消费记录（8.0.4 需求表 07，docs/MEMBERSHIP_V804.md 第 7 节）。原来的「余额记录」拆成两块，
// 各自按种类、营业日起止查询，分别导出；最上面「收支比例」的数字就是两块当前查询条件下的合计（同一次查询算出来）。
// 两块默认展开、各列最近 20 笔（「显示全部」看这次查询的全部），与原来的余额记录一样打开会员就能看到、就地撤销消费；点标题可收起。
// 按种类、日期查询与导出收在每块的「查询与导出」里（种类按钮的名字是「撤销」「消费」等，平时不摆出来，免得和撤销、消费按钮混在一起）。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, SlidersHorizontal } from 'lucide-react';
import { ENTRY_TYPE_LABELS, type EntryType } from '@shared/labels';
import { RECORD_SECTION_LABELS, SECTION_TYPES, spendRatio, type MemberRecords, type RecordSection } from '@shared/member-records';
import type { MemberDetail } from '@shared/types';
import { api } from '../../lib/api';
import { cn, downloadUrl } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Button, Card, Input, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { ActivityRow } from './ActivityList';

interface Filter {
  types: EntryType[];
  from: string;
  to: string;
}
const ALL = (section: RecordSection): Filter => ({ types: [...SECTION_TYPES[section]], from: '', to: '' });
/** 按了种类或日期（不是「全部」） */
const narrowed = (section: RecordSection, f: Filter) => !!f.from || !!f.to || f.types.length !== SECTION_TYPES[section].length;
/** 展开时先列的笔数，再多的点「显示全部」 */
const PREVIEW_ROWS = 20;
const queryOf = (section: RecordSection, f: Filter) =>
  `section=${section}&types=${f.types.join(',')}${f.from ? `&from=${f.from}` : ''}${f.to ? `&to=${f.to}` : ''}`;

/** 挂在 ['activity', 会员] 下面：充值、消费、撤销、退储值以后原来刷新余额记录的地方一起刷新 */
function useRecords(memberId: number, section: RecordSection, f: Filter) {
  return useQuery({
    queryKey: ['activity', memberId, 'records', section, f] as const,
    queryFn: () => api.get<MemberRecords>(`/api/members/${memberId}/records?${queryOf(section, f)}`),
    enabled: f.types.length > 0 && (!f.from || !f.to || f.from <= f.to),
  });
}

export function MemberRecordsCard({ member, onReverse }: { member: MemberDetail; onReverse?: (consumptionId: number) => void }) {
  const [filters, setFilters] = useState<Record<RecordSection, Filter>>({ recharge: ALL('recharge'), consume: ALL('consume') });
  const [open, setOpen] = useState<Record<RecordSection, boolean>>({ recharge: true, consume: true });
  const recharge = useRecords(member.id, 'recharge', filters.recharge);
  const consume = useRecords(member.id, 'consume', filters.consume);
  const r = recharge.data?.totals;
  const c = consume.data?.totals;
  const ratio = r && c ? spendRatio(r.total, c.total) : null;
  const max = Math.max(r?.total ?? 0, c?.total ?? 0, 1);
  return (
    <Card className="p-2" data-testid="member-records">
      <SectionTitle className="px-3 pt-2.5 pb-1.5" aside={<span className="text-[12px] text-ink-3">本金 · 赠金分别记录</span>}>
        充值与消费记录
      </SectionTitle>
      {/* 收支比例：两块当前查询条件下的合计 */}
      <div className="mx-3 mb-2 rounded-lg bg-paper-2/60 px-4 py-3" data-testid="records-ratio">
        {!r || !c ? (
          <Skeleton className="h-12" />
        ) : (
          <>
            <Bar label="充值" total={r.total} principal={r.principal} bonus={r.bonus} max={max} tone="lake" testid="ratio-recharge" />
            <Bar label="消费" total={c.total} principal={c.principal} bonus={c.bonus} max={max} tone="yuzu" testid="ratio-consume" />
            <p className="mt-1.5 text-[12.5px] text-ink-2" data-testid="ratio-text">
              {ratio === null ? '这段时间没有充值' : `消费占充值 ${ratio}%`}
              <span className="text-ink-3"> · 按下面两块当前的查询条件（种类、日期）算，与明细合计一致</span>
            </p>
          </>
        )}
      </div>
      {(['recharge', 'consume'] as const).map((section) => (
        <Section
          key={section}
          section={section}
          memberId={member.id}
          data={section === 'recharge' ? recharge.data : consume.data}
          loading={(section === 'recharge' ? recharge : consume).isPending}
          error={(section === 'recharge' ? recharge : consume).error?.message ?? null}
          filter={filters[section]}
          onFilter={(f) => setFilters({ ...filters, [section]: f })}
          open={open[section]}
          onToggle={() => setOpen({ ...open, [section]: !open[section] })}
          onReverse={section === 'consume' ? onReverse : undefined}
        />
      ))}
    </Card>
  );
}

function Bar({ label, total, principal, bonus, max, tone, testid }: { label: string; total: number; principal: number; bonus: number; max: number; tone: 'lake' | 'yuzu'; testid: string }) {
  const w = (n: number) => `${Math.max(0, Math.min(100, (n / max) * 100))}%`;
  return (
    <div className="flex items-center gap-3 py-1" data-testid={testid}>
      <span className="w-8 shrink-0 text-[12.5px] font-semibold text-ink-2">{label}</span>
      <div className="flex h-3.5 min-w-0 flex-1 overflow-hidden rounded-full bg-card ring-1 ring-line" aria-hidden>
        <div className={cn('h-full', tone === 'lake' ? 'bg-lake' : 'bg-yuzu-deep')} style={{ width: w(Math.max(0, principal)) }} />
        <div className={cn('h-full', tone === 'lake' ? 'bg-lake/40' : 'bg-yuzu')} style={{ width: w(Math.max(0, bonus)) }} />
      </div>
      <span className="w-[210px] shrink-0 text-right text-[12.5px] text-ink-2">
        <Money cents={total} className="font-bold text-ink" />
        <span className="text-ink-3">
          {' '}
          （本金 <Money cents={principal} /> · 赠金 <Money cents={bonus} />）
        </span>
      </span>
    </div>
  );
}

function Section({
  section,
  memberId,
  data,
  loading,
  error,
  filter,
  onFilter,
  open,
  onToggle,
  onReverse,
}: {
  section: RecordSection;
  memberId: number;
  data: MemberRecords | undefined;
  loading: boolean;
  error: string | null;
  filter: Filter;
  onFilter: (f: Filter) => void;
  open: boolean;
  onToggle: () => void;
  onReverse?: (consumptionId: number) => void;
}) {
  const t = data?.totals;
  const [showAll, setShowAll] = useState(false);
  const [querying, setQuerying] = useState(false);
  const rows = data ? (showAll ? data.rows : data.rows.slice(0, PREVIEW_ROWS)) : [];
  // 按了条件的一直摆出查询栏，看得到是按什么查的
  const showBar = querying || narrowed(section, filter);
  return (
    <div className="mx-1 border-t border-line" data-testid={`records-${section}`}>
      <button type="button" className="flex w-full items-center gap-2 px-2 py-2.5 text-left hover:bg-paper-2/50" aria-expanded={open} onClick={onToggle} data-testid={`records-${section}-toggle`}>
        {open ? <ChevronDown className="size-4 text-ink-3" /> : <ChevronRight className="size-4 text-ink-3" />}
        <span className="text-[14px] font-bold text-ink">{RECORD_SECTION_LABELS[section]}</span>
        <span className="text-[12.5px] text-ink-3" data-testid={`records-${section}-summary`}>
          {t ? (
            <>
              {t.count} 笔 · 合计 <Money cents={t.total} className="font-semibold text-ink-2" />
              {section === 'recharge' && t.paid > 0 && (
                <>
                  {' '}
                  · 实收 <Money cents={t.paid} />
                </>
              )}
            </>
          ) : (
            '…'
          )}
          {narrowed(section, filter) && <span className="ml-1 text-ember">（已按条件筛选）</span>}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-3">
          {!showBar && (
            <Button size="sm" variant="ghost" icon={<SlidersHorizontal className="size-3.5" />} onClick={() => setQuerying(true)} data-testid={`records-${section}-filters`}>
              查询与导出
            </Button>
          )}
          {showBar && (
            <FilterBar
              section={section}
              memberId={memberId}
              totals={t}
              filter={filter}
              onFilter={onFilter}
              onClose={narrowed(section, filter) ? undefined : () => setQuerying(false)}
            />
          )}
          {error ? (
            <Notice tone="error" className="mt-2" title={error} />
          ) : filter.types.length === 0 ? (
            <p className="mt-3 text-[12.5px] text-ink-3">请至少选一种记录。</p>
          ) : loading ? (
            <Skeleton className="mt-2 h-24" />
          ) : !data?.rows.length ? (
            <EmptyState art="pool" title={`没有${RECORD_SECTION_LABELS[section]}`} description="换个日期或种类再查。" />
          ) : (
            <div className="mt-1 divide-y divide-line/70">
              {rows.map((row) => (
                <ActivityRow key={row.id} row={row} onReverse={onReverse} />
              ))}
              {rows.length < data.rows.length && (
                <div className="px-3 py-2">
                  <Button size="sm" variant="ghost" onClick={() => setShowAll(true)} data-testid={`records-${section}-all`}>
                    显示全部 {data.rows.length} 笔
                  </Button>
                </div>
              )}
              {showAll && data.truncated && <p className="px-3 py-2 text-[12px] text-ink-3">只列最近的 {data.rows.length} 笔，合计与导出包括全部。</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 按种类、营业日查询与导出（每块各一份；按了条件的一直摆着，看得到是按什么查的） */
function FilterBar({
  section,
  memberId,
  totals: t,
  filter,
  onFilter,
  onClose,
}: {
  section: RecordSection;
  memberId: number;
  totals: MemberRecords['totals'] | undefined;
  filter: Filter;
  onFilter: (f: Filter) => void;
  onClose?: () => void;
}) {
  const [from, setFrom] = useState(filter.from);
  const [to, setTo] = useState(filter.to);
  return (
    <div data-testid={`records-${section}-bar`}>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`${RECORD_SECTION_LABELS[section]}的种类`}>
        {SECTION_TYPES[section].map((type) => {
          const on = filter.types.includes(type);
          return (
            <button
              key={type}
              type="button"
              aria-pressed={on}
              onClick={() => onFilter({ ...filter, types: on ? filter.types.filter((x) => x !== type) : [...filter.types, type] })}
              className={cn('h-7 rounded-full px-2.5 text-[12.5px] font-semibold ring-1', on ? 'bg-pine text-paper ring-pine' : 'bg-card text-ink-3 ring-line hover:ring-ink-3')}
              data-testid={`records-${section}-type-${type}`}
            >
              {ENTRY_TYPE_LABELS[type]}
              {t?.byType[type] ? ` ${t.byType[type]!.count}` : ''}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        营业日
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} fullWidth={false} className="h-8 w-[150px] text-[12.5px]" aria-label={`${RECORD_SECTION_LABELS[section]}从`} />
        至
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} fullWidth={false} className="h-8 w-[150px] text-[12.5px]" aria-label={`${RECORD_SECTION_LABELS[section]}到`} />
        <Button size="sm" variant="secondary" onClick={() => onFilter({ ...filter, from, to })} disabled={!!from && !!to && from > to} data-testid={`records-${section}-query`}>
          查询
        </Button>
        {(filter.from || filter.to) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFrom('');
              setTo('');
              onFilter({ ...filter, from: '', to: '' });
            }}
          >
            全部日期
          </Button>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          icon={<Download className="size-3.5" />}
          disabled={!t?.count}
          onClick={() => downloadUrl(`/api/members/${memberId}/records.csv?${queryOf(section, filter)}`)}
          data-testid={`records-${section}-export`}
        >
          导出
        </Button>
        {onClose && (
          <Button size="sm" variant="ghost" onClick={onClose}>
            收起
          </Button>
        )}
      </div>
    </div>
  );
}
