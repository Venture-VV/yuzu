// 派对房看板（8.0.8，A03「新增派对房、宠物轰趴房房型选项……可正常开台、下单与结账」）：
// 开单即占用的业态（派对房、宠物轰趴房、娱乐室……）下在用、可售的房间，按业态分组，不需要底图（原来只有平面图上能开单）。
// 开单、结束计费、撤单都用平面图同一套对话框（「结果待确认」照旧）；房费按「派对房计费」里设的每小时价，账单名称带房型和房间。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PartyPopper } from 'lucide-react';
import { usageFee, usageMinutes, type UsageBoard, type UsageBoardSpace, type UsageDetail } from '@shared/usages';
import { api, errorMessage } from '../../lib/api';
import { cn, formatTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Badge, Button, Notice, Skeleton } from '../../components/ui';
import { CloseUsageFor, OpenUsageDialog } from './UsageDialogs';
import { roomsKey } from './queries';

export const usageBoardKey = ['usages', 'board'] as const;

export function PartyRoomsView({ canOperate }: { canOperate: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: usageBoardKey, queryFn: () => api.get<UsageBoard>('/api/usages/board'), refetchInterval: 15_000 });
  const [opening, setOpening] = useState<UsageBoardSpace | null>(null);
  const [closing, setClosing] = useState<{ usage: UsageDetail; mode: 'end' | 'cancel' } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: usageBoardKey });
    void qc.invalidateQueries({ queryKey: roomsKey });
    void qc.invalidateQueries({ queryKey: ['floormap'] });
  };

  if (q.isPending) return <Skeleton className="h-48" />;
  if (q.error) return <Notice tone="error" title={errorMessage(q.error)} />;
  const board = q.data!;
  if (board.spaces.length === 0) {
    return (
      <EmptyState
        art="calm"
        title="还没有派对房"
        description={`空间台账里把房间的业态设成「${board.businessTypes.join('」「') || '派对房'}」（开单即占用的业态在后台「客房 → 派对房等」里设），这里就能开单、结束计费。`}
      />
    );
  }
  const now = Date.now();
  return (
    <div className="space-y-5" data-testid="party-rooms">
      {board.businessTypes
        .map((type) => [type, board.spaces.filter((s) => s.businessType === type)] as const)
        .filter(([, list]) => list.length > 0)
        .map(([type, list]) => {
          const busy = list.filter((s) => s.usage).length;
          const priced = list[0]!.priced;
          return (
            <section key={type} aria-label={type} data-testid={`party-type-${type}`}>
              <h3 className="mb-2 flex flex-wrap items-center gap-2 text-[14px] font-bold text-ink-2">
                <PartyPopper className="size-4 text-pine" /> {type}
                <span className="text-[12.5px] font-normal text-ink-3">
                  使用中 {busy} / {list.length} 间
                  {list[0]!.pricing
                    ? ` · 每小时 ¥${list[0]!.pricing.hourPrice / 100}，起步 ${list[0]!.pricing.minMinutes} 分钟、每 ${list[0]!.pricing.stepMinutes} 分钟一档${list[0]!.pricing.openFee ? `，开台费 ¥${list[0]!.pricing.openFee / 100}` : ''}`
                    : ''}
                </span>
                {!priced && <Badge tone="clay">没设计费，结束不收房费</Badge>}
              </h3>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {list.map((s) => {
                  const u = s.usage;
                  const minutes = u ? usageMinutes(u, now) : 0;
                  const estimate = u && s.pricing ? usageFee(minutes, s.pricing, s.pricing.hourPrice).amount + s.pricing.openFee : null;
                  return (
                    <div
                      key={s.id}
                      className={cn('flex min-h-[124px] flex-col rounded-lg border px-3 py-2.5', u ? 'border-yuzu-deep/40 bg-yuzu-tint' : 'border-dashed border-line-strong bg-card')}
                      data-testid={`party-space-${s.code}`}
                      data-state={u ? 'busy' : 'free'}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="num text-[16px] font-bold">{s.code}</span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{s.displayName}</span>
                        <Badge tone={u ? 'yuzu' : 'neutral'}>{u ? '使用中' : '空闲'}</Badge>
                      </div>
                      <p className="text-[12px] text-ink-3">
                        {s.floorCode} 层{s.capacity ? ` · ${s.capacity} 人` : ''}
                      </p>
                      {u ? (
                        <>
                          <p className="mt-1 text-[13px]">
                            <span className="num font-bold">{u.tagCode}</span> · {u.guests} 人 · {formatTime(u.openedAt)} 开 · 已用 {minutes} 分钟
                          </p>
                          {estimate !== null && (
                            <p className="text-[12.5px] text-ink-2">
                              按现在结束约 <Money cents={estimate} className="font-bold" />
                            </p>
                          )}
                          {u.note && <p className="truncate text-[12px] text-ink-3">{u.note}</p>}
                          <span className="mt-auto flex gap-1.5 pt-2">
                            <Button size="sm" variant="primary" disabled={!canOperate} onClick={() => setClosing({ usage: u, mode: 'end' })} data-testid={`party-end-${s.code}`}>
                              {s.priced ? '结束计费' : '结束使用'}
                            </Button>
                            <Button size="sm" variant="ghost" disabled={!canOperate} onClick={() => setClosing({ usage: u, mode: 'cancel' })} data-testid={`party-cancel-${s.code}`}>
                              撤单
                            </Button>
                          </span>
                        </>
                      ) : (
                        <span className="mt-auto pt-2">
                          <Button size="sm" variant="secondary" disabled={!canOperate} onClick={() => setOpening(s)} data-testid={`party-open-${s.code}`}>
                            开单
                          </Button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      {opening && (
        <OpenUsageDialog
          space={{ id: opening.id, code: opening.code, displayName: opening.displayName, businessType: opening.businessType, capacity: opening.capacity }}
          priced={opening.priced}
          onClose={() => setOpening(null)}
          onDone={() => {
            setOpening(null);
            refresh();
          }}
        />
      )}
      {closing && (
        <CloseUsageFor
          usage={closing.usage}
          mode={closing.mode}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null);
            refresh();
          }}
        />
      )}
      <p className="text-[11.5px] text-ink-4">
        房间来自空间台账里业态是派对房、宠物轰趴房等的房间；房费按后台「客房 → 派对房等」里设的每小时价，结束时挂到使用人的手牌账单上，账单上写明房型和房间。
      </p>
    </div>
  );
}
