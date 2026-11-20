// 钟房的搜索与筛选（8.1.15，《浴族系统需求汇总》技师 1，docs/TECHNICIANS_V8115.md 第 2 节）：
//   · 搜索：姓名、工号、花名，或姓名、花名的拼音首字母（打「zxm」找到「张小明」）；
//   · 筛选：状态（原来就有）、技师类型、可做的项目分类——几样叠加，类型与项目各自可以多选；
//   · 现在生效的条件列在下面一行，各自能单独去掉，也能一键清空；
//   · 排序：按排位（默认，与轮钟队列一致），或按状态（空闲、上钟、已派待上、休息、休假、停牌、未上牌）。
// 条件都只在这台终端的页面上（不存、不影响别人）；有任何条件或按状态排时，下面列的是技师卡片，全去掉回到钟房看板。
// 类型、项目两排平时收着（点「筛选」展开，选了的时候一直开着），不占看板的地方。

import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDownUp, Search, SlidersHorizontal, X } from 'lucide-react';
import {
  EMPTY_TECH_QUERY,
  TECH_FILTER_LABELS,
  TECH_FILTERS,
  TECH_SORT_LABELS,
  TECH_SORTS,
  techQueryActive,
  type ClockroomBoard,
  type TechFilter,
  type TechQuery,
  type TechSort,
} from '@shared/clockroom';
import { cn } from '../../lib/utils';
import { Button, Input, Segmented } from '../../components/ui';

/** 「没设类型」在筛选里的值（技师的类型为空） */
const NO_KIND = '';
const kindLabel = (kind: string) => (kind === NO_KIND ? '未设类型' : kind);

function Chip({ on, onClick, children, testId }: { on: boolean; onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn('h-9 rounded-full border px-3 text-[13px] font-semibold', on ? 'border-pine bg-pine text-paper' : 'border-line-strong bg-card text-ink-2 hover:border-ink-4')}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

/** 生效的一项条件：点一下去掉 */
function ActiveChip({ label, onRemove, testId }: { label: string; onRemove: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="inline-flex h-9 items-center gap-1 rounded-full border border-pine/40 bg-pine-tint pr-2 pl-3 text-[13px] font-semibold text-pine hover:border-pine"
      aria-label={`去掉条件：${label}`}
      data-testid={testId}
    >
      {label}
      <X className="size-3.5" aria-hidden />
    </button>
  );
}

const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

export function ClockFilters({
  board,
  query,
  onQuery,
  sort,
  onSort,
  counts,
  shown,
}: {
  board: ClockroomBoard;
  query: TechQuery;
  onQuery: (query: TechQuery) => void;
  sort: TechSort;
  onSort: (sort: TechSort) => void;
  /** 各状态的人数（在职的） */
  counts: Record<TechFilter, number>;
  /** 按现在的条件列出来几位 */
  shown: number;
}) {
  // 类型、项目的选项：清单里的，加上名册里实际在用的（清单里去掉了、还有技师是这一类的也列出来）
  const { kinds, categories } = useMemo(() => {
    const active = board.technicians.filter((t) => t.active);
    const kindSet = new Set([...board.kinds, ...active.map((t) => t.kind).filter(Boolean)]);
    const list = [...kindSet];
    if (active.some((t) => t.kind === NO_KIND)) list.push(NO_KIND);
    return { kinds: list, categories: [...new Set([...board.categories, ...active.flatMap((t) => t.skills)])] };
  }, [board]);
  const text = query.text.trim();
  const active = techQueryActive(query);
  const picked = query.kinds.length + query.categories.length;
  const [opened, setOpened] = useState(false);
  const more = opened || picked > 0;

  return (
    <div className="mx-auto max-w-[1280px] space-y-2.5 px-5 pt-4 md:px-7" data-testid="clock-filters">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-0 flex-1 basis-64">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input
            inputMode="search"
            value={query.text}
            onChange={(e) => onQuery({ ...query, text: e.target.value })}
            placeholder="搜姓名、工号、花名，或拼音首字母（如 zxm）"
            aria-label="搜索技师"
            className="pr-10 pl-10"
            maxLength={20}
            data-testid="clock-search"
          />
          {query.text && (
            <button
              type="button"
              onClick={() => onQuery({ ...query, text: '' })}
              className="absolute top-1/2 right-1.5 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink"
              aria-label="清空搜索"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <Button
          variant={more ? 'quiet' : 'secondary'}
          className="h-11"
          icon={<SlidersHorizontal className="size-4" />}
          onClick={() => setOpened(!more)}
          disabled={picked > 0}
          aria-expanded={more}
          data-testid="clock-more-filters"
        >
          类型 / 项目{picked > 0 ? ` ${picked}` : ''}
        </Button>
        <div className="flex items-center gap-1.5">
          <ArrowDownUp className="size-4 text-ink-3" aria-hidden />
          <Segmented ariaLabel="技师的排序" value={sort} onChange={onSort} options={TECH_SORTS.map((s) => ({ value: s, label: <span data-testid={`clock-sort-${s}`}>{TECH_SORT_LABELS[s]}</span> }))} />
        </div>
      </div>
      <FilterRow label="状态">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="按状态筛选技师" data-testid="clock-filter">
          {TECH_FILTERS.map((f) => (
            <Chip key={f} on={query.status === f} onClick={() => onQuery({ ...query, status: f })} testId={`clock-filter-${f}`}>
              {TECH_FILTER_LABELS[f]} <span className="num">{counts[f]}</span>
            </Chip>
          ))}
        </div>
      </FilterRow>
      {more && kinds.length > 0 && (
        <FilterRow label="类型">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="按技师类型筛选" data-testid="clock-kinds">
            {kinds.map((k) => (
              <Chip key={k || 'none'} on={query.kinds.includes(k)} onClick={() => onQuery({ ...query, kinds: toggle(query.kinds, k) })} testId={`clock-kind-${k || 'none'}`}>
                {kindLabel(k)}
              </Chip>
            ))}
          </div>
        </FilterRow>
      )}
      {more && categories.length > 0 && (
        <FilterRow label="项目">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="按可做的项目筛选" data-testid="clock-categories">
            {categories.map((c) => (
              <Chip key={c} on={query.categories.includes(c)} onClick={() => onQuery({ ...query, categories: toggle(query.categories, c) })} testId={`clock-category-${c}`}>
                {c}
              </Chip>
            ))}
          </div>
        </FilterRow>
      )}
      {(active || sort !== 'queue') && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-paper-2/60 px-3 py-2" data-testid="clock-active-filters">
          <span className="text-[13px] font-semibold text-ink-2">当前生效</span>
          {text && <ActiveChip label={`搜索「${text}」`} onRemove={() => onQuery({ ...query, text: '' })} testId="clock-active-text" />}
          {query.status !== 'all' && <ActiveChip label={`状态：${TECH_FILTER_LABELS[query.status]}`} onRemove={() => onQuery({ ...query, status: 'all' })} testId="clock-active-status" />}
          {query.kinds.map((k) => (
            <ActiveChip
              key={k || 'none'}
              label={`类型：${kindLabel(k)}`}
              onRemove={() => onQuery({ ...query, kinds: query.kinds.filter((x) => x !== k) })}
              testId={`clock-active-kind-${k || 'none'}`}
            />
          ))}
          {query.categories.map((c) => (
            <ActiveChip key={c} label={`项目：${c}`} onRemove={() => onQuery({ ...query, categories: query.categories.filter((x) => x !== c) })} testId={`clock-active-category-${c}`} />
          ))}
          {sort !== 'queue' && <ActiveChip label={TECH_SORT_LABELS[sort]} onRemove={() => onSort('queue')} testId="clock-active-sort" />}
          <span className="ml-auto text-[13px] text-ink-2" data-testid="clock-shown">
            共 <span className="num font-bold text-ink">{shown}</span> 位
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onQuery(EMPTY_TECH_QUERY);
              onSort('queue');
            }}
            data-testid="clock-filters-clear"
          >
            清空
          </Button>
        </div>
      )}
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center text-[13px] font-semibold text-ink-3">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
