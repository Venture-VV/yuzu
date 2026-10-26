import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { cn } from '../lib/utils';

// ───────────────────────── Button ─────────────────────────

type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger' | 'quiet';
type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-pine text-paper hover:bg-pine-hover shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] disabled:bg-ink-4',
  accent: 'bg-yuzu text-ink hover:bg-yuzu-hover shadow-[inset_0_-1px_0_rgb(0_0_0/0.06)] disabled:bg-paper-3 disabled:text-ink-3',
  secondary: 'bg-card text-ink border border-line-strong hover:border-ink-3 hover:bg-paper disabled:text-ink-4',
  ghost: 'text-ink-2 hover:bg-paper-2 hover:text-ink disabled:text-ink-4',
  danger: 'bg-clay text-paper hover:bg-clay-hover disabled:bg-ink-4',
  quiet: 'bg-paper-2 text-ink hover:bg-paper-3 disabled:text-ink-4',
};
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-sm',
  md: 'h-10 px-4 text-sm gap-2 rounded-md',
  lg: 'h-12 px-5 text-[15px] gap-2 rounded-md',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  kbd?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, kbd, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center font-semibold whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:translate-y-px',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
      {kbd && !loading && (
        <kbd
          className={cn(
            'ml-0.5 rounded-[5px] px-1.5 py-px text-[11px] font-semibold leading-4',
            variant === 'primary' || variant === 'danger' ? 'bg-white/14 text-paper/80' : 'bg-ink/6 text-ink-3',
          )}
        >
          {kbd}
        </kbd>
      )}
    </button>
  );
});

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-9 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink disabled:text-ink-4',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ───────────────────────── Form ─────────────────────────

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  aside,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-[13px] font-semibold text-ink-2">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {error ? (
        <p className="text-[12.5px] font-medium text-clay" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12.5px] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

const inputBase =
  'rounded-md border border-line-strong bg-card px-3.5 text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-4 hover:border-ink-4 focus:border-pine focus:shadow-[0_0_0_3px_rgb(36_73_58/0.12)] disabled:bg-paper-2 disabled:text-ink-3 aria-[invalid=true]:border-clay';

/** 默认撑满容器；需要固定宽度（如日期、并排的搜索框）时传 fullWidth={false} 再给宽度，否则 w-full 会盖过传入的宽度 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; fullWidth?: boolean }>(
  function Input({ className, invalid, fullWidth = true, ...rest }, ref) {
    return <input ref={ref} aria-invalid={invalid || undefined} className={cn(inputBase, 'h-11', fullWidth && 'w-full', className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cn(inputBase, 'min-h-20 w-full resize-none py-2.5', className)} {...rest} />;
});

export function Select({
  className,
  children,
  fullWidth = true,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { fullWidth?: boolean }) {
  return (
    <select
      className={cn(
        inputBase,
        fullWidth && 'w-full',
        'h-10 appearance-none bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20width%3D%2712%27%20height%3D%2712%27%20fill%3D%27none%27%20stroke%3D%27%23808780%27%20stroke-width%3D%272%27%3E%3Cpath%20d%3D%27M2%204l4%204%204-4%27/%3E%3C/svg%3E")] bg-[position:right_12px_center] bg-no-repeat pr-9',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

/** 金额输入：左侧 ¥，等宽数字，移动端弹出小数键盘 */
export const MoneyInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { invalid?: boolean; large?: boolean }
>(function MoneyInput({ className, invalid, large, ...rest }, ref) {
  return (
    <div className="relative">
      <span
        className={cn(
          'pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 font-semibold text-ink-3',
          large ? 'text-xl' : 'text-[15px]',
        )}
      >
        ¥
      </span>
      <input
        ref={ref}
        inputMode="decimal"
        autoComplete="off"
        aria-invalid={invalid || undefined}
        className={cn(inputBase, 'num w-full font-semibold', large ? 'h-14 pl-9 text-[26px]' : 'h-11 pl-8 text-[15px]', className)}
        {...rest}
      />
    </div>
  );
});

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md',
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; disabled?: boolean }[];
  className?: string;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('inline-flex rounded-md bg-paper-2 p-1', className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex-1 rounded-[9px] font-semibold whitespace-nowrap transition-all duration-150 disabled:opacity-40',
              size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-9 px-3.5 text-[13.5px]',
              active ? 'bg-card text-ink shadow-[0_1px_2px_rgb(28_35_31/0.1)]' : 'text-ink-3 hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** 大号确认勾选框（触控友好） */
export function ConfirmCheck({
  checked,
  onChange,
  children,
  tone = 'pine',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  tone?: 'pine' | 'clay';
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3.5 transition-colors',
        checked
          ? tone === 'pine'
            ? 'border-pine bg-pine-tint'
            : 'border-clay bg-clay-soft/50'
          : 'border-line-strong bg-card hover:border-ink-4',
      )}
    >
      <input id={id} type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className={cn(
          'mt-px flex size-[22px] shrink-0 items-center justify-center rounded-[7px] border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-pine/40',
          checked ? (tone === 'pine' ? 'border-pine bg-pine text-paper' : 'border-clay bg-clay text-paper') : 'border-ink-4 bg-card',
        )}
      >
        {checked && <Check className="size-3.5" strokeWidth={3.5} />}
      </span>
      <span className="text-[14px] leading-6 font-medium text-ink">{children}</span>
    </label>
  );
}

// ───────────────────────── Display ─────────────────────────

type Tone = 'neutral' | 'pine' | 'moss' | 'yuzu' | 'ember' | 'clay' | 'lake' | 'ink';
const TONES: Record<Tone, string> = {
  neutral: 'bg-paper-2 text-ink-2',
  pine: 'bg-pine-soft text-pine',
  moss: 'bg-moss-soft text-moss',
  yuzu: 'bg-yuzu-soft text-yuzu-deep',
  ember: 'bg-ember-soft text-ember',
  clay: 'bg-clay-soft text-clay',
  lake: 'bg-lake-soft text-lake',
  ink: 'bg-ink text-paper',
};

export function Badge({ tone = 'neutral', className, children, icon }: { tone?: Tone; className?: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2 text-[12px] leading-none font-semibold whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** 「待确认」标记：模拟规则统一使用 */
export function PendingBadge({ className, title }: { className?: string; title?: string }) {
  return (
    <span
      title={title ?? '经营规则尚待店主确认，当前为模拟规则'}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-dashed border-yuzu-deep/50 bg-yuzu-tint px-2 text-[11.5px] leading-none font-semibold text-yuzu-deep',
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-yuzu" />
      待确认
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line-strong bg-card px-1 text-[11px] font-semibold text-ink-3 shadow-[0_1px_0_var(--color-line-strong)]',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn('size-5 animate-spin text-ink-3', className)} aria-label="加载中" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-paper-3/70', className)} />;
}

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-lg border border-line bg-card shadow-card', className)} {...rest}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, aside, className }: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <h3 className="text-[13px] font-bold tracking-wide text-ink-2">{children}</h3>
      {aside}
    </div>
  );
}

/** 状态横幅：成功 / 警告 / 错误 / 提示，图文同时表达 */
export function Notice({
  tone,
  title,
  children,
  icon,
  action,
  className,
}: {
  tone: 'info' | 'success' | 'warning' | 'error';
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const styles = {
    info: 'border-lake/20 bg-lake-soft/60 text-lake',
    success: 'border-pine/20 bg-pine-tint text-pine',
    warning: 'border-yuzu-deep/25 bg-yuzu-tint text-yuzu-deep',
    error: 'border-clay/25 bg-clay-soft/60 text-clay',
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-lg border px-4 py-3', styles, className)}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        {title && <p className="text-[14px] font-bold">{title}</p>}
        {children && <div className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{children}</div>}
        {action && <div className="mt-2.5 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
}
