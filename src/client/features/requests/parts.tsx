// 需求单的小部件（8.0.1 采购组整改 02，CG02）：采购优先级红点（紧急）/ 绿点（普通）。

import { PRIORITY_LABELS, type RequestPriority } from '@shared/requests';
import { cn } from '../../lib/utils';

export function PriorityDot({ priority, className }: { priority: RequestPriority; className?: string }) {
  return (
    <span
      role="img"
      aria-label={PRIORITY_LABELS[priority]}
      title={PRIORITY_LABELS[priority]}
      className={cn('inline-block size-2.5 shrink-0 rounded-full', priority === 'urgent' ? 'bg-clay' : 'bg-pine', className)}
      data-testid={`priority-${priority}`}
    />
  );
}

/** 红点 / 绿点 + 文字 */
export function PriorityTag({ priority }: { priority: RequestPriority }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[12.5px] font-bold', priority === 'urgent' ? 'text-clay' : 'text-pine')}>
      <PriorityDot priority={priority} />
      {PRIORITY_LABELS[priority]}
    </span>
  );
}
