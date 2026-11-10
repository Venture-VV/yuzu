// 会员标签（8.0.4 需求表 05）：新建、编辑会员时挑标签；会员详情显示标签。
// 只能新挂启用的标签；已经挂着、后来停用的标签照样列出（可以摘掉，不能再挂回来）。

import { useQuery } from '@tanstack/react-query';
import { Tag } from 'lucide-react';
import { groupTags, MAX_MEMBER_TAGS, tagLabel, type MemberTag, type MemberTagBrief } from '@shared/member-tags';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

export const memberTagKeys = { all: ['member-tags'] as const };

export const useMemberTags = (enabled = true) =>
  useQuery({ queryKey: memberTagKeys.all, queryFn: () => api.get<MemberTag[]>('/api/member-tags'), enabled, staleTime: 60_000 });

export function TagPicker({ value, onChange, current = [] }: { value: number[]; onChange: (ids: number[]) => void; current?: MemberTagBrief[] }) {
  const tags = useMemberTags();
  const all = tags.data ?? [];
  const had = new Set(current.map((t) => t.id));
  // 能选的：启用的，加上这位会员已经挂着的（含停用的）
  const shown = all.filter((t) => t.active || had.has(t.id));
  if (tags.isPending) return <p className="text-[12.5px] text-ink-3">标签加载中…</p>;
  if (shown.length === 0) return <p className="text-[12.5px] text-ink-3">还没有会员标签，店主在「管理后台 → 会员与渠道 → 会员标签」里建。</p>;
  const toggle = (id: number) => {
    if (value.includes(id)) onChange(value.filter((x) => x !== id));
    else if (value.length < MAX_MEMBER_TAGS) onChange([...value, id]);
  };
  return (
    <div className="space-y-2" data-testid="member-tag-picker">
      {groupTags(shown).map((g) => (
        <div key={g.group || '-'} className="flex flex-wrap items-center gap-1.5">
          <span className="w-16 shrink-0 text-[12px] font-semibold text-ink-3">{g.group || '其他'}</span>
          {g.tags.map((t) => {
            const on = value.includes(t.id);
            const off = !t.active;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={on}
                disabled={off && !on}
                onClick={() => toggle(t.id)}
                title={off ? '这个标签已停用：可以摘掉，摘了不能再挂' : undefined}
                className={cn(
                  'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-semibold ring-1 transition-colors disabled:opacity-40',
                  on ? 'bg-pine text-paper ring-pine' : 'bg-card text-ink-2 ring-line hover:ring-ink-3',
                  off && 'line-through',
                )}
                data-testid={`tag-option-${t.id}`}
              >
                {t.name}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** 会员详情的标签一排 */
export function MemberTagChips({ tags }: { tags: MemberTagBrief[] }) {
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="member-tags">
      <Tag className="size-3.5 text-ink-3" />
      {tags.map((t) => (
        <span key={t.id} className={cn('rounded-full bg-paper-2 px-2 py-0.5 text-[12px] font-semibold text-ink-2', !t.active && 'text-ink-4 line-through')} title={t.active ? undefined : '已停用的标签'}>
          {tagLabel(t)}
        </span>
      ))}
    </div>
  );
}
