// 排位播报（8.2.0 P03，回测 4-1，docs/YUZU_REQ_V820.md 第 4 节）：从钟房里移出来的独立页面，「技师」组里与钟房同级。
//   · 原有能力一样不少：自动叫号（派钟时记、本页念）、重播上一条、手动叫号、音量、一键静音、播报记录（播报条 Announcer.tsx 原样搬来）；
//   · 与钟房共用同一份排位数据（/api/clockroom 看板，同一个查询缓存），钟房那边派钟、上下钟，这里马上看得到；
//   · 权限单独授（technician.announce），排位员可以只有这一项；钟房的岗位照旧能进；
//   · 钟房里原来的播报条下线；从老地址（/clockroom/announcer）来的跳到这里，顶上提示位置换了。

import { useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone } from 'lucide-react';
import type { BoardTechnician, ClockroomBoard } from '@shared/clockroom';
import { CALL_KIND_LABELS } from '@shared/technician-admin';
import { api, errorMessage } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { useCan, useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { useToast } from '../../components/Toast';
import { Button, Card, Notice, Skeleton } from '../../components/ui';
import { AnnouncerBar } from './Announcer';
import { clockKey } from './ClockroomPage';

/** 播报页念得要及时：比钟房的 10 秒刷得勤一点 */
const ANNOUNCER_REFRESH_MS = 5_000;

const STATE_TEXT = (t: BoardTechnician) => (t.busy?.status === 'serving' ? '上钟中' : t.busy?.status === 'waiting' ? '已派待上' : '空闲待钟');

export function AnnouncerPage() {
  const can = useCan();
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const moved = params.get('moved') === '1';
  const q = useQuery({ queryKey: clockKey, queryFn: () => api.get<ClockroomBoard>('/api/clockroom') });
  // 比钟房刷得勤一点；页面在后台、断网时不取，回来马上取（lib/livePoll）
  useLivePoll(
    async (isLive) => {
      const next = await api.get<ClockroomBoard>('/api/clockroom');
      if (isLive()) qc.setQueryData(clockKey, next);
    },
    [qc],
    { intervalMs: ANNOUNCER_REFRESH_MS },
  );
  const [busy, setBusy] = useState<number | null>(null);
  const d = q.data;
  // 排在队列里的技师（在岗、按轮钟顺序）；派了钟还没上的排最前，方便叫
  const queue = useMemo(
    () =>
      (d?.technicians ?? [])
        .filter((t) => t.position !== null || t.busy)
        .sort((a, b) => (a.busy?.status === 'waiting' ? 0 : 1) - (b.busy?.status === 'waiting' ? 0 : 1) || (a.position ?? 999) - (b.position ?? 999)),
    [d],
  );
  if (!session.technicians) return <Navigate to="/" replace />;
  if (!can('technician.announce') && !can('technician.dispatch')) return <Navigate to="/" replace />;

  const call = async (t: BoardTechnician) => {
    setBusy(t.id);
    try {
      const sessionId = t.busy?.sessionId;
      qc.setQueryData(clockKey, await api.post<ClockroomBoard>('/api/clockroom/calls', { technicianId: t.id, ...(sessionId ? { sessionId } : {}) }));
      toast({ tone: 'success', title: `已叫 ${t.techNo} 号` });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const sessionOf = (t: BoardTechnician) => (t.busy ? (d?.sessions.find((s) => s.id === t.busy!.sessionId) ?? null) : null);
  const calls = [...(d?.calls ?? [])].reverse();

  return (
    <>
      <PageHeader title="排位播报" subtitle="自动叫号、重播、手动叫号、音量与静音；和钟房用同一份排位，钟房派钟这里马上念" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="announcer-page">
        <div className="mx-auto max-w-[1280px] space-y-4 px-5 py-5 md:px-7">
          {moved && (
            <Notice tone="info" title="排位播报换了地方" data-testid="announcer-moved">
              排位播报从钟房里移到了「技师 → 排位播报」，就是这一页；以后从左边导航直接进。
              <button type="button" className="ml-2 font-bold text-lake hover:underline" onClick={() => setParams({}, { replace: true })}>
                知道了
              </button>
            </Notice>
          )}
          {!d ? (
            q.error ? (
              <Notice tone="error" title={`排位取不到：${errorMessage(q.error)}`}>
                <Button className="mt-2" onClick={() => void q.refetch()}>
                  重试
                </Button>
              </Notice>
            ) : (
              <Skeleton className="h-64" />
            )
          ) : (
            <>
              <AnnouncerBar board={d} onBoard={(b) => qc.setQueryData(clockKey, b)} />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
                <Card className="min-w-0 p-0" data-testid="announcer-queue">
                  <div className="flex flex-wrap items-baseline gap-x-2 border-b border-line px-4 py-3">
                    <h2 className="text-[15px] font-bold">排位与手动叫号</h2>
                    <span className="text-[12.5px] text-ink-3">已派待上的在最前，其余按轮钟顺序</span>
                  </div>
                  {queue.length === 0 ? (
                    <p className="px-4 py-6 text-center text-[13px] text-ink-3">现在没有在岗的技师</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {queue.map((t) => {
                        const s = sessionOf(t);
                        return (
                          <li key={t.id} className="flex items-center gap-3 px-4 py-2.5" data-testid={`announcer-tech-${t.techNo}`}>
                            <span className="num w-8 shrink-0 text-center text-[15px] font-bold text-ink-3">{t.position ?? '—'}</span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[14px] font-bold">
                                {t.techNo} 号 {t.name}
                              </span>
                              <span className="block truncate text-[12.5px] text-ink-3">
                                {STATE_TEXT(t)}
                                {s ? ` · ${s.itemName}${s.space ? ` · ${s.space.code}` : ''} · 手牌 ${s.tagCode}` : ''}
                              </span>
                            </span>
                            <Button variant="secondary" icon={<Megaphone className="size-4" />} loading={busy === t.id} onClick={() => void call(t)} data-testid={`announcer-call-${t.techNo}`}>
                              叫号
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Card>
                <Card className="min-w-0 p-0" data-testid="announcer-log">
                  <div className="flex flex-wrap items-baseline gap-x-2 border-b border-line px-4 py-3">
                    <h2 className="text-[15px] font-bold">播报记录</h2>
                    <span className="text-[12.5px] text-ink-3">最近的在上</span>
                  </div>
                  {calls.length === 0 ? (
                    <p className="px-4 py-6 text-center text-[13px] text-ink-3">今天还没有叫号</p>
                  ) : (
                    <ul className="max-h-[520px] divide-y divide-line overflow-y-auto">
                      {calls.map((c) => (
                        <li key={c.id} className="px-4 py-2 text-[13px]" data-testid="announcer-log-row">
                          <span className="num text-ink-3">{formatTime(c.at)}</span>
                          <span className={cn('ml-2 rounded px-1.5 py-0.5 text-[12px] font-semibold', c.kind === 'manual' ? 'bg-ember-soft text-ember-deep' : 'bg-paper-2 text-ink-2')}>
                            {CALL_KIND_LABELS[c.kind]}
                          </span>
                          <span className="ml-2 font-semibold text-ink">{c.text}</span>
                          <span className="ml-2 text-ink-3">{c.staffName}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
              {can('technician.dispatch') && (
                <p className="text-[12.5px] text-ink-3">
                  派钟、上钟、下钟在{' '}
                  <Link to="/clockroom" className="font-semibold text-lake hover:underline">
                    钟房
                  </Link>
                  ；两边是同一份排位。
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
