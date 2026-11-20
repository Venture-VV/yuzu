import { Moon, Sun, SunMoon } from 'lucide-react';
import { setThemeChoice, THEME_LABELS, useThemeChoice, type ThemeChoice } from '../lib/theme';
import { cn } from '../lib/utils';

const ORDER: ThemeChoice[] = ['light', 'dark', 'system'];
const ICONS = { light: Sun, dark: Moon, system: SunMoon } as const;

/** 用户菜单里的「外观」一行：浅色 / 深色 / 跟随系统，点了马上换（8.1.15） */
export function ThemeMenuRow() {
  const choice = useThemeChoice();
  return (
    <div className="px-3 py-1.5" data-testid="theme-row">
      <p className="mb-1 text-[12px] font-semibold text-ink-3">外观</p>
      <div role="radiogroup" aria-label="外观" className="grid grid-cols-3 gap-1 rounded-md bg-paper-2 p-1">
        {ORDER.map((key) => {
          const Icon = ICONS[key];
          const on = choice === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`theme-${key}`}
              onClick={() => setThemeChoice(key)}
              className={cn(
                'flex h-11 flex-col items-center justify-center gap-0.5 rounded-[6px] text-[12px] font-semibold transition-colors',
                on ? 'bg-card text-ink shadow-card' : 'text-ink-3 hover:text-ink',
              )}
            >
              <Icon className="size-4" />
              {THEME_LABELS[key]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 深底顶栏（后台、ERP）上的一个小按钮：在浅色与深色之间换；选了「跟随系统」时点一下换成与现在相反的那一套 */
export function ThemeToggleButton({ className }: { className?: string }) {
  const choice = useThemeChoice();
  const dark = choice === 'dark' || (choice === 'system' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const Icon = dark ? Sun : Moon;
  const label = dark ? '换成浅色' : '换成深色';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid="theme-toggle"
      onClick={() => setThemeChoice(dark ? 'light' : 'dark')}
      className={cn('flex size-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-paper hover:bg-white/18', className)}
    >
      <Icon className="size-[18px]" />
    </button>
  );
}
