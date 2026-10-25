import { useEffect, useRef, useState } from 'react';
import { formatAmount } from '@shared/money';
import { cn } from '../lib/utils';

/** 金额展示：¥ 符号缩小、分位弱化，便于一眼读出整数部分 */
export function Money({
  cents,
  className,
  signed,
  muted,
  symbolClassName,
}: {
  cents: number;
  className?: string;
  /** 显示 + / − 号 */
  signed?: boolean;
  muted?: boolean;
  symbolClassName?: string;
}) {
  const text = formatAmount(cents);
  const [int, dec] = text.split('.');
  const sign = signed ? (cents > 0 ? '+' : cents < 0 ? '−' : '') : cents < 0 ? '−' : '';
  return (
    <span className={cn('num inline-flex items-baseline whitespace-nowrap', muted && 'text-ink-3', className)}>
      {sign && <span className="mr-[0.08em]">{sign}</span>}
      <span className={cn('mr-[0.12em] text-[0.72em] font-semibold opacity-70', symbolClassName)}>¥</span>
      <span>{int}</span>
      <span className="text-[0.78em] opacity-70">.{dec}</span>
    </span>
  );
}

/** 数字从旧值平滑过渡到新值，帮助员工看清余额变化 */
export function AnimatedMoney({ from, to, className, duration = 700 }: { from: number; to: number; className?: string; duration?: number }) {
  const [value, setValue] = useState(from);
  const frame = useRef(0);
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || from === to) {
      setValue(to);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (to - from) * eased));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    const delay = setTimeout(() => (frame.current = requestAnimationFrame(tick)), 180);
    return () => {
      clearTimeout(delay);
      cancelAnimationFrame(frame.current);
    };
  }, [from, to, duration]);
  return <Money cents={value} className={className} />;
}
