import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';
import { IconButton } from './ui';

/** Esc 只关闭最上层的弹窗（例如账单抽屉上又打开了确认框时，只关确认框） */
function useEscape(onClose: () => void, enabled: boolean, panel: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const layers = document.querySelectorAll('[role="dialog"]');
      if (panel.current && layers.length && layers[layers.length - 1] !== panel.current) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, enabled, panel]);
}

/** 打开时把焦点移入面板，关闭时还给原来的元素 */
function useFocusReturn(open: boolean, panel: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = panel.current;
      if (el && !el.contains(document.activeElement)) {
        (el.querySelector<HTMLElement>('[data-autofocus]') ?? el).focus();
      }
    }, 30);
    return () => {
      clearTimeout(t);
      previous?.focus?.();
    };
  }, [open, panel]);
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-lg',
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  dismissible?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEscape(onClose, open && dismissible, panel);
  useFocusReturn(open, panel);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div className="absolute inset-0 animate-fade bg-ink/30 backdrop-blur-[2px]" onClick={dismissible ? onClose : undefined} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[92vh] w-full animate-rise flex-col overflow-hidden rounded-t-xl border border-line bg-card shadow-pop outline-none sm:rounded-xl',
          width,
        )}
      >
        <header className="flex items-start gap-4 border-b border-line px-6 pt-5 pb-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[17px] font-bold text-ink">
              {title}
            </h2>
            {description && <p className="mt-1 text-[13px] text-ink-3">{description}</p>}
          </div>
          {dismissible && (
            <IconButton label="关闭" onClick={onClose} className="-mt-1 -mr-2">
              <X className="size-[18px]" />
            </IconButton>
          )}
        </header>
        <div className="scroll-thin flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2.5 border-t border-line bg-paper/60 px-6 py-4">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** 右侧抽屉：平板上承载充值/消费流程，以及流水单据详情 */
export function Sheet({
  open,
  onClose,
  children,
  label,
  width = 'w-[min(460px,100vw)]',
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  label: string;
  width?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEscape(onClose, open, panel);
  useFocusReturn(open, panel);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 animate-fade bg-ink/25" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cn('relative flex h-full animate-slide-in flex-col bg-paper shadow-pop outline-none', width)}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
