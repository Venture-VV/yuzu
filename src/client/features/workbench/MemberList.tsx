import { forwardRef, useEffect, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, UserPlus, X } from 'lucide-react';
import { maskPhone } from '@shared/labels';
import { looksLikeCardNo, type MemberCardLookup } from '@shared/member-cards';
import type { MemberSummary } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { memberCodeOf, useMembers } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { avatarTone, cn, relativeTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Button, Kbd, Notice, Select, Skeleton } from '../../components/ui';
import { groupTags, tagLabel } from '@shared/member-tags';
import { useMemberTags } from '../membership/TagPicker';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export const MemberList = forwardRef<
  HTMLInputElement,
  { selectedId: number | null; onSelect: (m: MemberSummary) => void; onCreate: (prefill: string) => void }
>(function MemberList({ selectedId, onSelect, onCreate }, inputRef) {
  const can = useCan();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 180);
  // 会员码扫进来就校验、不等防抖：扫码盒常在码后面跟一个回车，回车不能选中防抖之前的旧列表；
  // 校验完成之前列表是空的，回车、点选都选不到人（测试会话预检 a040d79）。
  // 清空查找框也立刻生效：认出会员、自动清空后马上再扫同一个码，同样重新校验，不沿用刚才那次的结果
  const query = memberCodeOf(q) || !q.trim() ? q.trim() : debounced;
  // 按会员标签筛（8.0.4 需求表 05）
  const [tagId, setTagId] = useState<number | null>(null);
  const tags = useMemberTags();
  const members = useMembers(query, memberCodeOf(query) ? null : tagId);
  const [cursor, setCursor] = useState(0);
  const list = members.data ?? [];
  // 扫到会员码（v0.7.25）：校验通过就直接打开这位会员，清空查找框（码 60 秒就换）
  const code = memberCodeOf(query);
  useEffect(() => {
    if (code && members.isSuccess && members.data.length === 1) {
      onSelect(members.data[0]!);
      setQ('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, members.isSuccess, members.data]);

  // 结果变化时高亮回到第一位，避免回车选中旧列表里鼠标悬停的位置
  useEffect(() => setCursor(0), [query, members.data]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(list.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter' && list.length > 0) {
      e.preventDefault();
      onSelect(list[Math.min(cursor, list.length - 1)]!);
    } else if (e.key === 'Escape' && q) {
      e.preventDefault();
      setQ('');
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-3 px-4 pt-4 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-ink-3" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="手机号 / 后四位 / 姓名 / 会员号 / 刷卡"
            aria-label="搜索会员"
            inputMode="search"
            className="h-12 w-full rounded-lg border border-line-strong bg-card pr-10 pl-10 text-[15px] shadow-card outline-none transition-[border-color,box-shadow] placeholder:text-ink-4 focus:border-pine focus:shadow-[0_0_0_3px_rgb(36_73_58/0.12)]"
          />
          {q ? (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => setQ('')}
              className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2"
            >
              <X className="size-4" />
            </button>
          ) : (
            <Kbd className="absolute top-1/2 right-3 -translate-y-1/2">/</Kbd>
          )}
        </div>
        {(tags.data ?? []).some((t) => t.active) && (
          <Select
            value={tagId ?? ''}
            onChange={(e) => setTagId(e.target.value ? Number(e.target.value) : null)}
            aria-label="按标签筛选"
            className="h-9 text-[13px]"
            data-testid="member-tag-filter"
          >
            <option value="">全部会员（不按标签）</option>
            {groupTags((tags.data ?? []).filter((t) => t.active)).flatMap((g) =>
              g.tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {tagLabel(t)}
                </option>
              )),
            )}
          </Select>
        )}
        <div className="flex items-center justify-between">
          <p className={cn('text-[12.5px] font-semibold', code && members.error ? 'text-clay' : 'text-ink-3')} data-testid="member-search-status">
            {code
              ? members.error
                ? errorMessage(members.error)
                : '核对会员码…'
              : query
                ? members.isFetching
                  ? '搜索中…'
                  : `找到 ${list.length} 位会员`
                : tagId
                  ? `这个标签下 ${list.length} 位（最近到店）`
                  : '最近到店'}
          </p>
          {can('member.write') && (
            <Button size="sm" variant="quiet" icon={<UserPlus className="size-4" />} onClick={() => onCreate(q.trim())}>
              新建会员
            </Button>
          )}
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2.5 pb-4" role="listbox" aria-label="会员列表">
        {members.isPending ? (
          <div className="space-y-2 px-1.5">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-[62px]" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <>
          {query && looksLikeCardNo(query) && <LostCardNotice cardNo={query} />}
          <EmptyState
            art="search"
            title={query ? '没有找到这位会员' : '还没有会员'}
            description={query ? '核对手机号，或为顾客新建会员档案。' : '新建第一位会员，开始接待。'}
            action={
              can('member.write') && (
                <Button variant="primary" size="sm" icon={<UserPlus className="size-4" />} onClick={() => onCreate(q.trim())}>
                  新建会员
                </Button>
              )
            }
          />
          </>
        ) : (
          list.map((m, i) => {
            const selected = m.id === selectedId;
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onSelect(m)}
                onPointerMove={(e) => e.pointerType === 'mouse' && setCursor(i)}
                className={cn(
                  'relative mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                  selected ? 'bg-card shadow-lift ring-1 ring-line' : i === cursor && query ? 'bg-paper-2' : 'hover:bg-paper-2/70',
                )}
              >
                {selected && <span className="absolute top-3 bottom-3 left-0 w-[3px] rounded-r-full bg-pine" />}
                <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full text-[15px] font-bold', avatarTone(m.id))}>
                  {m.name.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[14.5px] font-bold text-ink">{m.name}</span>
                    {m.grade > 0 && (
                      <span className={cn('shrink-0 rounded px-1 text-[11px] font-bold', m.graceUntil ? 'bg-ember-soft text-ember' : 'bg-yuzu-soft text-yuzu-deep')} title="会员档级">
                        L{m.grade}
                      </span>
                    )}
                    {m.mergedIntoId !== null ? (
                      <span className="shrink-0 rounded bg-paper-2 px-1 text-[11px] font-bold text-ink-3" title="这份档案已合并到另一位会员">
                        已合并
                      </span>
                    ) : (
                      m.status === 'frozen' && <span className="shrink-0 rounded bg-clay-soft px-1 text-[11px] font-bold text-clay">已停用</span>
                    )}
                  </span>
                  <span className="num block truncate text-[12.5px] text-ink-3">
                    {maskPhone(m.phone)} · {relativeTime(m.lastActivityAt)}
                  </span>
                </span>
                <span className="text-right">
                  <Money
                    cents={m.principalBalance + m.bonusBalance}
                    className={cn('text-[14px] font-bold', m.principalBalance + m.bonusBalance === 0 ? 'text-ink-4' : 'text-ink')}
                  />
                  {m.bonusBalance > 0 && (
                    <span className="block text-[11.5px] font-semibold text-yuzu-deep">
                      含赠 <Money cents={m.bonusBalance} />
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
});

/**
 * 刷到的卡号查不到人（v0.7.28 ⑦）：挂失的卡提醒扣下卡、核对身份（卡主是谁），换下的卡提醒已经不用了。
 * 在用的卡号查找框直接找到会员，不走这里
 */
function LostCardNotice({ cardNo }: { cardNo: string }) {
  const found = useQuery({
    queryKey: ['member-cards', 'lookup', cardNo],
    queryFn: () => api.get<MemberCardLookup>(`/api/member-cards/lookup?cardNo=${encodeURIComponent(cardNo)}`),
    staleTime: 0,
    retry: false,
  });
  const d = found.data;
  if (!d || d.status === 'unknown' || d.status === 'active' || !d.member) return null;
  return (
    <div className="px-1.5 pb-2" data-testid="member-card-alert">
      <Notice tone={d.status === 'lost' ? 'error' : 'warning'} title={d.status === 'lost' ? `这张卡已挂失（卡主 ${d.member.name} · ${d.member.memberNo}）` : `这张卡已换下（原卡主 ${d.member.name}）`}>
        {d.status === 'lost' ? '请扣下这张卡，核对客人身份后按手机号找会员办理；补卡在会员详情「会员卡」里。' : '这张卡已经不用了，请让客人出示新卡或报手机号。'}
      </Notice>
    </div>
  );
}
