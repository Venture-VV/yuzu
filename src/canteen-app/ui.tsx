// 柚子饭堂的小组件：按钮、卡片、标签、底部弹层、提示条。大圆角、软阴影、按下去会缩一下。

import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

type Tone = 'yuzu' | 'leaf' | 'ghost' | 'peach' | 'ink';
const TONES: Record<Tone, string> = {
  yuzu: 'bg-yuzu text-ink shadow-[0_4px_0_#e0a91c] active:shadow-[0_1px_0_#e0a91c] active:translate-y-[3px]',
  leaf: 'bg-leaf text-white shadow-[0_4px_0_#2f7d3e] active:shadow-[0_1px_0_#2f7d3e] active:translate-y-[3px]',
  peach: 'bg-peach text-white shadow-[0_4px_0_#d9584a] active:shadow-[0_1px_0_#d9584a] active:translate-y-[3px]',
  ink: 'bg-ink text-cream shadow-[0_4px_0_#1e1714] active:shadow-[0_1px_0_#1e1714] active:translate-y-[3px]',
  ghost: 'bg-white/70 text-ink-2 ring-1 ring-line active:scale-[0.97]',
};

export function Button({ tone = 'yuzu', big, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; big?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 rounded-2xl font-bold transition-all duration-100 disabled:opacity-50 disabled:shadow-none disabled:translate-y-0',
        big ? 'h-14 px-6 text-[17px]' : 'h-11 px-4 text-[15px]',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-[var(--radius-card)] bg-card p-4 shadow-[var(--shadow-soft)] ring-1 ring-line/70', className)} {...rest}>
      {children}
    </div>
  );
}

export function Pill({ tone = 'yuzu', children, className }: { tone?: 'yuzu' | 'leaf' | 'peach' | 'sky' | 'ink' | 'berry'; children: ReactNode; className?: string }) {
  const t = {
    yuzu: 'bg-yuzu-soft text-yuzu-deep',
    leaf: 'bg-leaf-soft text-leaf-deep',
    peach: 'bg-peach-soft text-[#c4473a]',
    sky: 'bg-sky-soft text-[#1f6fa8]',
    ink: 'bg-cream-2 text-ink-2',
    berry: 'bg-berry-soft text-berry',
  }[tone];
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-bold whitespace-nowrap', t, className)}>{children}</span>;
}

/** 从底部弹出的面板（手机上好按）；点背景或「关闭」收起 */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-label={title}
        aria-modal="true"
        className="safe-bottom max-h-[88dvh] w-full max-w-[480px] animate-rise overflow-y-auto rounded-t-[28px] bg-cream px-5 pt-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-line" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[18px] font-extrabold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1 text-[14px] font-bold text-ink-2 active:bg-cream-2">
            关闭
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export interface ToastMsg {
  id: number;
  text: string;
  tone: 'ok' | 'error' | 'info';
}

let toastId = 0;
const listeners = new Set<(t: ToastMsg) => void>();
export function toast(text: string, tone: ToastMsg['tone'] = 'info') {
  const msg = { id: ++toastId, text, tone };
  listeners.forEach((fn) => fn(msg));
}

export function Toasts() {
  const [items, setItems] = useState<ToastMsg[]>([]);
  useEffect(() => {
    const on = (t: ToastMsg) => {
      setItems((xs) => [...xs.slice(-2), t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 3200);
    };
    listeners.add(on);
    return () => void listeners.delete(on);
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4 pt-[max(12px,env(safe-area-inset-top))]" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            'max-w-[440px] animate-pop rounded-2xl px-4 py-2.5 text-[14px] font-bold shadow-[var(--shadow-pop)]',
            t.tone === 'ok' ? 'bg-leaf text-white' : t.tone === 'error' ? 'bg-berry text-white' : 'bg-ink text-cream',
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-bold text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-ink-3">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'h-12 w-full rounded-2xl border-0 bg-white px-4 text-[16px] font-semibold text-ink ring-2 ring-line outline-none placeholder:font-normal placeholder:text-ink-3 focus:ring-yuzu';
