// 审批链的时间线（8.0.17，docs/FLOW_V8017.md 第 4 节）：一级一个圆点连成一条线——已同意绿勾、审批中橙点带等了多久、
// 未到灰、退回红；右边是这一级谁同意或退回、什么时候、写了什么意见。单据详情的「审批进度」与审批中心详情的「审批链」共用。
// 内容与原来一样（每一级一块、谁审的、意见），只是换了图样；圆点与采购流程图是同一套（FlowDot）。

import type { ApprovalActionView } from '@shared/approvals';
import { cn, formatDateTime } from '../../lib/utils';
import { FlowDot } from '../../components/FlowTrack';

export interface TimelineLevel {
  level: number;
  label: string;
  /** 或签 / 会签（审批中心的详情才给） */
  mode?: string;
  state: 'done' | 'current' | 'pending' | 'returned';
  /** 会签时这一级还要谁同意 */
  waitingFor?: string[];
  actions: ApprovalActionView[];
}

export function ApprovalTimeline({ levels, waitedText, overdue, testIdPrefix, className }: { levels: readonly TimelineLevel[]; /** 当前这一级等了多久 */ waitedText: string; overdue?: boolean; testIdPrefix: string; className?: string }) {
  return (
    <ol className={className} data-testid={testIdPrefix === 'approval-chain' ? 'approval-chain' : undefined}>
      {levels.map((lv, i) => {
        const last = i === levels.length - 1;
        const dot = lv.state === 'returned' ? 'current' : lv.state;
        return (
          <li key={lv.level} className={cn('relative flex gap-2.5', !last && 'pb-2')} data-testid={`${testIdPrefix}-${lv.level}`} data-state={lv.state}>
            {/* 往下一级的线：这一级同意了是绿的 */}
            {!last && <span aria-hidden className={cn('absolute top-9 bottom-0 left-[15px] w-0.5', lv.state === 'done' ? 'bg-pine/35' : 'bg-line')} />}
            <span className="pt-1">
              <FlowDot state={dot} alert={lv.state === 'returned' || (lv.state === 'current' && overdue)} size="sm">
                <span className="num">{lv.level}</span>
              </FlowDot>
            </span>
            <div className={cn('min-w-0 flex-1 rounded-lg border px-3 py-2 text-[12.5px]', lv.state === 'current' ? 'border-yuzu-deep/40 bg-yuzu-tint' : lv.state === 'returned' ? 'border-clay/30 bg-clay-soft/40' : 'border-line bg-card')}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="num text-ink-3">第 {lv.level} 级</span>
                <span className="font-bold text-ink">{lv.label}</span>
                {lv.mode && <span className="text-[12px] text-ink-3">{lv.mode}</span>}
                <span className="ml-auto text-[12px] font-semibold">
                  {lv.state === 'returned' ? (
                    <span className="text-clay">已退回</span>
                  ) : lv.state === 'done' ? (
                    <span className="text-pine">已同意</span>
                  ) : lv.state === 'current' ? (
                    <span className={overdue ? 'text-clay' : 'text-yuzu-deep'}>审批中 · 等了 {waitedText}</span>
                  ) : (
                    <span className="text-ink-4">未到</span>
                  )}
                </span>
              </div>
              {!!lv.waitingFor?.length && <p className="mt-1 text-ink-2">还要 {lv.waitingFor.join('、')} 同意</p>}
              {lv.actions.map((a) => (
                <p key={a.id} className="mt-1 text-ink-2">
                  <span className={a.action === 'return' ? 'font-semibold text-clay' : 'font-semibold text-pine'}>{a.action === 'return' ? '退回' : '同意'}</span>
                  <span>
                    {' '}
                    · {a.actorName}
                    {a.onBehalfOfName ? `（代 ${a.onBehalfOfName}）` : ''}
                  </span>
                  {a.batch && <span className="text-ink-3"> · 批量</span>}
                  <span className="num text-ink-3"> · {formatDateTime(a.createdAt)}</span>
                  {a.comment && <span className="block text-ink">{a.comment}</span>}
                </p>
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
