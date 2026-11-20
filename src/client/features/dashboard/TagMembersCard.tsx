// 数据看板「会员总览 → 按标签」（8.0.4 需求表 05，docs/MEMBERSHIP_V804.md 第 5 节）：选几个会员标签（任一 / 同时有），
// 列出人数与名单（最多 200 位），导出 CSV（不限，最多 5,000 位，导出留审计）。定向营销、客群分层用。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Tags } from 'lucide-react';
import { groupTags, type TagMatchMode, type TagMemberReport } from '@shared/member-tags';
import { api } from '../../lib/api';
import { cn, downloadUrl, relativeTime } from '../../lib/utils';
import { DataTable } from '../../components/DataTable';
import { Money } from '../../components/Money';
import { Button, Card, Notice, SectionTitle, Segmented, Skeleton } from '../../components/ui';
import { useMemberTags } from '../membership/TagPicker';

export function TagMembersCard() {
  const tags = useMemberTags();
  const [picked, setPicked] = useState<number[]>([]);
  const [mode, setMode] = useState<TagMatchMode>('any');
  const query = `tagIds=${picked.join(',')}&mode=${mode}`;
  const report = useQuery({
    queryKey: ['member-tags', 'report', picked, mode],
    queryFn: () => api.get<TagMemberReport>(`/api/member-tags/members?${query}`),
    enabled: picked.length > 0,
  });
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <Card className="p-5" data-testid="tag-members">
      <SectionTitle aside={<Tags className="size-4 text-ink-3" />}>按标签</SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">选几个会员标签，列出这些客群的会员；导出 CSV 做定向营销。标签在「管理后台 → 会员与渠道」维护，前台编辑会员时挂。</p>
      {tags.isPending ? (
        <Skeleton className="mt-3 h-16" />
      ) : (tags.data ?? []).length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-3">还没有会员标签。</p>
      ) : (
        <div className="mt-3 space-y-1.5">
          {groupTags(tags.data ?? []).map((g) => (
            <div key={g.group || '-'} className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 shrink-0 text-[12px] font-semibold text-ink-3">{g.group || '其他'}</span>
              {g.tags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={picked.includes(t.id)}
                  onClick={() => toggle(t.id)}
                  className={cn(
                    'tap relative inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-semibold ring-1',
                    picked.includes(t.id) ? 'bg-pine text-paper ring-pine' : 'bg-card text-ink-2 ring-line hover:ring-ink-3',
                    !t.active && 'opacity-60',
                  )}
                  data-testid={`tag-filter-${t.id}`}
                >
                  {t.name}
                  <span className="num text-[12px] opacity-70">{t.memberCount}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {picked.length > 0 && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              ariaLabel="怎么匹配"
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'any', label: '有其中一个' },
                { value: 'all', label: '同时都有' },
              ]}
            />
            <span className="text-[13px] text-ink-2" data-testid="tag-members-count">
              {report.data ? `共 ${report.data.count} 位会员` : '统计中…'}
            </span>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="secondary"
              icon={<Download className="size-4" />}
              disabled={!report.data?.count}
              onClick={() => downloadUrl(`/api/member-tags/members.csv?${query}`)}
              data-testid="tag-members-export"
            >
              导出名单
            </Button>
          </div>
          {report.error && <Notice tone="error" title={report.error.message} />}
          {report.data && report.data.rows.length > 0 && (
            <div>
              <DataTable
                variant="plain"
                tableClassName="min-w-[640px]"
                rows={report.data.rows}
                rowKey={(r) => r.id}
                columns={[
                  {
                    key: 'member',
                    header: '会员',
                    cellClassName: 'font-semibold text-ink',
                    cell: (r) => (
                      <>
                        {r.name} <span className="num font-normal text-ink-3">{r.memberNo}</span>
                      </>
                    ),
                  },
                  { key: 'grade', header: '档阶', cellClassName: 'whitespace-nowrap text-ink-2', cell: (r) => r.gradeLabel },
                  { key: 'balance', header: '余额', numeric: true, cell: (r) => <Money cents={r.principalBalance + r.bonusBalance} /> },
                  { key: 'last', header: '最近', cellClassName: 'whitespace-nowrap text-ink-3', cell: (r) => relativeTime(r.lastActivityAt) },
                  { key: 'tags', header: '标签', cellClassName: 'text-[12px] text-ink-3', cell: (r) => r.tags.join('、') },
                ]}
              />
              {report.data.count > report.data.rows.length && <p className="mt-2 text-[12px] text-ink-3">页面只列最近活动的 {report.data.rows.length} 位，导出不受这个限制。</p>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
