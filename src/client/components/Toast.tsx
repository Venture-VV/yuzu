import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
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
    setTimeout(() => setItems((list) => list.filter((x) => x.id !== id)), t.tone === 'error' ? 6000 : 3600);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex animate-rise gap-3 rounded-lg border bg-card px-4 py-3 shadow-pop',
              t.tone === 'error' ? 'border-clay/30' : 'border-line',
            )}
          >
            {t.tone === 'success' && <CircleCheck className="mt-0.5 size-[18px] shrink-0 text-pine" />}
            {t.tone === 'error' && <CircleAlert className="mt-0.5 size-[18px] shrink-0 text-clay" />}
            {t.tone === 'info' && <Info className="mt-0.5 size-[18px] shrink-0 text-lake" />}
            <div className="min-w-0">
              <p className="text-[14px] font-bold">{t.title}</p>
              {t.body && <p className="mt-0.5 text-[13px] text-ink-2">{t.body}</p>}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
