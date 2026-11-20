import { useEffect, useRef, useState } from 'react';
import { formatAmount } from '@shared/money';
import { cn } from '../lib/utils';

/**
 * 金额展示：¥ 符号缩小、分位弱化，便于一眼读出整数部分。
 * 8.1.17（《浴族系统需求汇总》系统整体，docs/YUZU_REQ_V8117.md YS-1、YS-2）：缩小的 ¥ 与分位也不小于 12 像素；
 * 关键金额（应收、实收、合计、找零、会员余额、交班与日结的合计）写 size="key"，不小于 16 像素（要更大照旧写在 className 里）
 */
export function Money({
  cents,
  className,
  signed,
  muted,
  symbolClassName,
  size,
}: {
  cents: number;
  className?: string;
  /** 显示 + / − 号 */
  signed?: boolean;
  muted?: boolean;
  symbolClassName?: string;
  /** 关键金额：不小于 16 像素、加粗；页面上用 [data-money="key"] 核对 */
  size?: 'key';
}) {
  const text = formatAmount(cents);
  const [int, dec] = text.split('.');
  const sign = signed ? (cents > 0 ? '+' : cents < 0 ? '−' : '') : cents < 0 ? '−' : '';
  return (
    <span className={cn('num inline-flex items-baseline whitespace-nowrap', size === 'key' && 'text-[16px] font-bold', muted && 'text-ink-3', className)} data-money={size}>
      {sign && <span className="mr-[0.08em]">{sign}</span>}
      <span className={cn('mr-[0.12em] text-[length:max(12px,0.72em)] font-semibold opacity-70', symbolClassName)}>¥</span>
      <span>{int}</span>
      <span className="text-[length:max(12px,0.78em)] opacity-70">.{dec}</span>
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
