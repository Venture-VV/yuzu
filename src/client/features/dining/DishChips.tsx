// 菜品管理里的状态小标签（8.1.15 新页面的规矩）：颜色加文字，能加图标的加图标；字 16 像素。
// 颜色只用样式变量里对比度核对过的那几对（tests/theme-contrast.test.ts），深浅两套主题都看得清。

import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

const TONES = {
  pine: 'bg-pine-soft text-pine',
  clay: 'bg-clay-soft text-clay',
  yuzu: 'bg-yuzu-soft text-yuzu-deep',
  lake: 'bg-lake-soft text-lake',
  ember: 'bg-ember-soft text-ember-deep',
  neutral: 'bg-paper-2 text-ink-2',
} as const;

export function StatusChip({ tone, icon, children, className, testId }: { tone: keyof typeof TONES; icon?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  return (
    <span
      className={cn('inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[16px] leading-none font-semibold whitespace-nowrap [&>svg]:size-4', TONES[tone], className)}
      data-testid={testId}
    >
      {icon}
      {children}
    </span>
  );
}
