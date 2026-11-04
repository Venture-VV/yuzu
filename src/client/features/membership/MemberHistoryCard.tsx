// 会员详情「旧系统流水」（v0.7.28 ⑩，N12 待确认）：从旧 EBC 导入的逐笔流水，只读、不进正式账；
// 含合并进来的档案的；新的在前，一次 20 条，「更早的」往前翻。没有旧流水的会员不显示这一块。

import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { describeHistoryAmount, MEMBER_HISTORY_KIND_LABELS, type MemberHistoryKind, type MemberHistoryPage } from '@shared/member-history';
import type { MemberDetail } from '@shared/types';
import { api } from '../../lib/api';
import { cn, formatDateTime } from '../../lib/utils';
import { Badge, Button, Card, SectionTitle } from '../../components/ui';

const TONES: Record<MemberHistoryKind, 'pine' | 'clay' | 'yuzu' | 'ember' | 'lake' | 'neutral'> = {
  recharge: 'pine',
  consume: 'lake',
  bonus: 'yuzu',
  refund: 'clay',
  adjust: 'ember',
  other: 'neutral',
};

export function MemberHistoryCard({ member }: { member: MemberDetail }) {
  const [open, setOpen] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ['member', member.id, 'legacy-history'],
    queryFn: ({ pageParam }) => api.get<MemberHistoryPage>(`/api/members/${member.id}/legacy-history?limit=20${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const total = q.data?.pages[0]?.total ?? 0;
  if (q.isPending || q.error || total === 0) return null;
  const entries = q.data!.pages.flatMap((p) => p.entries);
  return (
    <Card className="p-5" data-testid="member-legacy-history">
      <SectionTitle
        aside={
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} data-testid="member-legacy-history-toggle">
            {open ? '收起' : `看 ${total} 笔`}
          </Button>
        }
      >
        <span className="flex items-center gap-2">
          <History className="size-4 text-ink-3" /> 旧系统流水
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">从旧系统（EBC）导入的逐笔记录，只读、不进正式账；余额以期初导入与上面的余额记录为准。</p>
      {open && (
        <>
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]" data-testid={`legacy-history-${e.id}`}>
                <span className="num w-[132px] shrink-0 text-[12.5px] text-ink-3">{formatDateTime(e.occurredAt)}</span>
                <span title={MEMBER_HISTORY_KIND_LABELS[e.kind]}>
                  <Badge tone={TONES[e.kind]}>{e.typeLabel}</Badge>
                </span>
                <span className={cn('num font-semibold', e.amount < 0 ? 'text-clay' : 'text-ink')}>{describeHistoryAmount(e.amount)}</span>
                {e.bonus !== null && e.bonus !== 0 && <span className="text-[12px] text-ink-3">赠金 {describeHistoryAmount(e.bonus)}</span>}
                {e.balance !== null && <span className="text-[12px] text-ink-3">余额 {describeHistoryAmount(e.balance)}</span>}
                <span className="flex-1" />
                <span className="text-[12px] text-ink-4">
                  {[e.docNo, e.store, e.operator, e.note].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
          {q.hasNextPage && (
            <Button className="mt-2" size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              更早的
            </Button>
          )}
        </>
      )}
    </Card>
  );
}
