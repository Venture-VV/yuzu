import { useEffect, useState } from 'react';
import { cn } from '../lib/utils';

/**
 * 数量输入（店主 2026-11-14 的需求 1）：加减按钮中间的数可以直接点进去输，手机上弹数字键盘——
 * 把 1 改成 20 不用点 19 下加号。只收 min–max 的整数：
 *   · 输空了、输 0 先不动原来的数，离开输入框时回到原来的数并提示；
 *   · 超过上限按上限算并提示（上限可以是 99，也可以是今天还剩的份数）。
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
  // 只在输到一半（空的、比下限小）时才有草稿；别处改了数量（点加减）草稿作废
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  const range = `${min}–${max}`;
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      aria-label={label}
      disabled={disabled}
      value={draft ?? String(value)}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const text = e.target.value.replace(/\D/g, '').slice(0, 4);
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
        if (draft === null) return;
        setDraft(null);
        onHint?.(`数量请填 ${range} 的整数，已保留原来的 ${value}`);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={cn('num bg-transparent text-center font-bold outline-none focus:bg-yuzu-tint/60 disabled:opacity-60', className)}
      data-testid={testId}
    />
  );
}
