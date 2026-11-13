import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

/** 空状态：一枚线描小图形 + 一句话 + 可选操作 */
export function EmptyState({
  title,
  description,
  action,
  className,
  art = 'pool',
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  art?: 'pool' | 'leaf' | 'search' | 'calm';
}) {
  return (
    <div className={cn('flex animate-notice-in flex-col items-center justify-center px-6 py-10 text-center', className)}>
      <EmptyArt kind={art} />
      <p className="mt-4 text-[15px] font-bold text-ink">{title}</p>
      {description && <p className="mt-1.5 max-w-xs text-[13px] leading-relaxed text-ink-3">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function EmptyArt({ kind }: { kind: 'pool' | 'leaf' | 'search' | 'calm' }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <div className="relative flex size-20 items-center justify-center rounded-full bg-paper-2 text-ink-3">
      <span className="absolute top-3 right-3 size-3 rounded-full bg-yuzu/70" />
      <svg viewBox="0 0 48 48" className="size-10">
        {kind === 'pool' && (
          <>
            <path {...common} d="M8 30c4-3 8-3 12 0s8 3 12 0 8-3 8-3" />
            <path {...common} d="M12 37c3-2 6-2 9 0s6 2 9 0 6-2 6-2" opacity=".55" />
            <path {...common} d="M18 22c-3-4 3-6 0-10M26 22c-3-4 3-6 0-10" opacity=".7" />
          </>
        )}
        {kind === 'leaf' && (
          <>
            <path {...common} d="M12 36c0-14 10-24 26-24 0 16-10 26-24 26" />
            <path {...common} d="M12 36l14-14" />
          </>
        )}
        {kind === 'search' && (
          <>
            <circle {...common} cx="21" cy="21" r="10" />
            <path {...common} d="M29 29l8 8" />
          </>
        )}
        {kind === 'calm' && (
          <>
            <path {...common} d="M10 32l9-12 7 8 5-6 7 10" />
            <path {...common} d="M8 36h32" />
          </>
        )}
      </svg>
    </div>
  );
}
