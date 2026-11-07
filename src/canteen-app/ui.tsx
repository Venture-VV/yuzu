// 柚子饭堂的小组件：按钮、卡片、标签、底部弹层、提示条。汤崎的木色与米白（styles.css），
// 按钮像贴纸一样有一道错开的实色投影、按下去会压下来；卡片可以带一圈手抖的描边（sketch）。

import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

type Tone = 'wood' | 'yuzu' | 'leaf' | 'ghost' | 'peach' | 'ink';
const TONES: Record<Tone, string> = {
  wood: 'bg-wood-deep text-white shadow-[0_4px_0_var(--color-wood-ink)] active:shadow-[0_1px_0_var(--color-wood-ink)] active:translate-y-[3px]',
  yuzu: 'bg-yuzu text-ink shadow-[0_4px_0_#b8932c] active:shadow-[0_1px_0_#b8932c] active:translate-y-[3px]',
  leaf: 'bg-organic text-white shadow-[0_4px_0_#4a4529] active:shadow-[0_1px_0_#4a4529] active:translate-y-[3px]',
  peach: 'bg-energy text-white shadow-[0_4px_0_#7f3218] active:shadow-[0_1px_0_#7f3218] active:translate-y-[3px]',
  ink: 'bg-ink text-cream shadow-[0_4px_0_#1f1712] active:shadow-[0_1px_0_#1f1712] active:translate-y-[3px]',
  ghost: 'bg-card/80 text-ink-2 ring-1 ring-line-strong active:scale-[0.97]',
};

export function Button({ tone = 'wood', big, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; big?: boolean }) {
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

/** 卡片：sketch 时多一圈手抖的描边（像用笔描过），用在想让人注意的那几张上 */
export function Card({ className, children, sketch, ...rest }: { className?: string; children: ReactNode; sketch?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-[var(--radius-card)] bg-card p-4', sketch ? 'sketch shadow-[var(--shadow-sticker)]' : 'shadow-[var(--shadow-soft)] ring-1 ring-line/80', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Pill({ tone = 'yuzu', children, className }: { tone?: 'yuzu' | 'leaf' | 'peach' | 'sky' | 'ink' | 'berry' | 'wood'; children: ReactNode; className?: string }) {
  const t = {
    yuzu: 'bg-yuzu-soft text-yuzu-deep',
    leaf: 'bg-organic-soft text-leaf-deep',
    peach: 'bg-energy-soft text-energy',
    sky: 'bg-relax-soft text-relax',
    ink: 'bg-cream-2 text-ink-2',
    berry: 'bg-danger-soft text-danger',
    wood: 'bg-wood-6 text-wood-deep',
  }[tone];
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-bold whitespace-nowrap', t, className)}>{children}</span>;
}

/** 圆形章印（汤崎餐饮的版式：小标语、章印）：Energy 橙的双圈、歪一点盖上去 */
export function Stamp({ children, className, tone = 'energy' }: { children: ReactNode; className?: string; tone?: 'energy' | 'organic' | 'wood' | 'light' }) {
  const color = { energy: 'var(--color-energy)', organic: 'var(--color-organic)', wood: 'var(--color-wood-deep)', light: 'var(--color-yuzu-soft)' }[tone];
  // 两圈之间露出底色：盖在木色的条上（light）时是木色，盖在纸上时是纸色
  const gap = tone === 'light' ? 'var(--color-wood-deep)' : 'var(--color-card)';
  return (
    <span
      className={cn('inline-flex size-[54px] shrink-0 -rotate-[10deg] items-center justify-center rounded-full text-center text-[12.5px] leading-[1.15] font-black tracking-wider', className)}
      style={{ color, boxShadow: `inset 0 0 0 2px ${color}, inset 0 0 0 4px ${gap}, inset 0 0 0 5.5px ${color}` }}
    >
      {children}
    </span>
  );
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
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-line-strong" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[18px] font-extrabold">
            <span className="marker">{title}</span>
          </h2>
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
            t.tone === 'ok' ? 'bg-organic text-white' : t.tone === 'error' ? 'bg-danger text-white' : 'bg-wood-ink text-cream',
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
  'h-12 w-full rounded-2xl border-0 bg-white px-4 text-[16px] font-semibold text-ink ring-2 ring-line outline-none placeholder:font-normal placeholder:text-ink-4 focus:ring-wood';
