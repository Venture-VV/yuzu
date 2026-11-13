import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import { dwellMs, useExitGhost } from '../lib/motion';
import { cn } from '../lib/utils';

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

const ToastContext = createContext<(t: Omit<ToastItem, 'id'>) => void>(() => {});
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = nextId++;
    setItems((list) => [...list.slice(-3), { ...t, id }]);
    // 停留多久按字数算（字多的看得完）：至少 3.6 秒，出错的至少 6 秒，最长 10 秒（8.0.16，UI7）
    setTimeout(() => setItems((list) => list.filter((x) => x.id !== id)), dwellMs(`${t.title}${t.body ?? ''}`, t.tone));
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <ToastCard key={t.id} item={t} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** 一条提示：从右边滑入；到时间卸掉时留一个影子往右滑出（8.0.16） */
function ToastCard({ item: t }: { item: ToastItem }) {
  const ref = useExitGhost<HTMLDivElement>();
  return (
    <div
      ref={ref}
      data-mo-out="toast"
      className={cn('pointer-events-auto z-[60] flex animate-toast-in gap-3 rounded-lg border bg-card px-4 py-3 shadow-pop', t.tone === 'error' ? 'border-clay/30' : 'border-line')}
    >
      {t.tone === 'success' && <CircleCheck className="mt-0.5 size-[18px] shrink-0 text-pine" />}
      {t.tone === 'error' && <CircleAlert className="mt-0.5 size-[18px] shrink-0 text-clay" />}
      {t.tone === 'info' && <Info className="mt-0.5 size-[18px] shrink-0 text-lake" />}
      <div className="min-w-0">
        <p className="text-[14px] font-bold">{t.title}</p>
        {t.body && <p className="mt-0.5 text-[13px] text-ink-2">{t.body}</p>}
      </div>
    </div>
  );
}

export const useToast = () => useContext(ToastContext);
