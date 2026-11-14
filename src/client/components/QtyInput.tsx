import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

/**
 * 数量输入（店主 2026-11-14 的需求 1）：加减按钮中间的数可以直接点进去输，手机上弹数字键盘——
 * 把 1 改成 20 不用点 19 下加号。只收 min–max 的整数：
 *   · 输空了、输 0 先不动原来的数，离开输入框时回到原来的数并提示；
 *   · 超过上限按上限算并提示（上限可以是 99，也可以是今天还剩的份数）；
 *   · 带了小数点、负号、字母这些：整个不采用，数量回到点进来之前的数并提示，框里照样显示输的东西（标红），
 *     改成整数就采用、离开输入框就恢复。不能把这些字符删掉再算——「1.5」会变成 15、「-3」会变成 3，
 *     数量被悄悄改掉（测试会话 2026-11-14 在 5545835 上报的）。
 * 提示交给外面显示（onHint：有话说时给文字，输对了给 null）；数量的规矩（1–99、余量、服务端核对）都不变。
 */
export function QtyInput({
  value,
  min = 1,
  max = 99,
  onChange,
  onHint,
  label,
  disabled,
  className,
  testId,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (next: number) => void;
  onHint?: (text: string | null) => void;
  /** 读屏与用例用，例如「足疗 45 分钟 的数量」 */
  label: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  // 输到一半（空的、比下限小）时的草稿；别处改了数量（点加减）草稿作废
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  // 带了数字以外字符的那一串：只是显示着，不算数
  const [bad, setBad] = useState<string | null>(null);
  /** 点进输入框时的数量：输了不算数的东西就回到它 */
  const start = useRef(value);
  const range = `${min}–${max}`;
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      aria-label={label}
      aria-invalid={bad !== null}
      disabled={disabled}
      value={bad ?? draft ?? String(value)}
      onFocus={(e) => {
        start.current = value;
        e.target.select();
      }}
      onChange={(e) => {
        const raw = e.target.value.trim();
        if (/[^0-9]/.test(raw)) {
          setBad(raw.slice(0, 8));
          if (value !== start.current) onChange(start.current);
          onHint?.(`数量只能填 ${range} 的整数，「${raw.slice(0, 8)}」没有采用，仍按 ${start.current} 算`);
          return;
        }
        setBad(null);
        const text = raw.slice(0, 4);
        if (text === '') return setDraft('');
        const n = Number(text);
        if (n < min) return setDraft(text);
        setDraft(null);
        // 先改数、再给提示：外面改数的时候可能顺手把旧提示清掉，提示要留到最后
        if (n > max) {
          onChange(max);
          onHint?.(`数量最多 ${max}，已按 ${max} 算`);
          return;
        }
        onChange(n);
        onHint?.(null);
      }}
      onBlur={() => {
        // 不算数的那一串：离开就恢复成数量（提示留着，说明刚才那一串没有采用）
        if (bad !== null) return setBad(null);
        if (draft === null) return;
        setDraft(null);
        onHint?.(`数量请填 ${range} 的整数，已保留原来的 ${value}`);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={cn('num bg-transparent text-center font-bold outline-none focus:bg-yuzu-tint/60 disabled:opacity-60', bad !== null && 'text-clay', className)}
      data-testid={testId}
    />
  );
}
