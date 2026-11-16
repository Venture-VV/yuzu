// 当前门店与换店（8.0.22，docs/MULTISTORE_V8022.md 第 2 节）：能进不止一家店的人在导航栏上看得到当前门店、点一下换店；
// 只能进一家店（含只有本店）的什么都不显示，与以往一样。换了以后整页重新加载（各页面的数据都换成那家店的）。

import { useEffect, useRef, useState } from 'react';
import { Check, Store } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { useExitGhost } from '../lib/motion';
import { cn } from '../lib/utils';
import { useToast } from './Toast';

export async function switchStore(storeId: number) {
  await api.post('/api/auth/store', { storeId });
  window.location.reload();
}

/** 导航栏底部（实例标识上面）：当前门店的代码；点开换店 */
export function StoreSwitcher() {
  const session = useSession();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (session.stores.length <= 1) return null;
  const pick = async (id: number) => {
    if (id === session.store.id) return setOpen(false);
    setBusy(id);
    try {
      await switchStore(id);
    } catch (e) {
      setBusy(null);
      toast({ tone: 'error', title: errorMessage(e) });
    }
  };
  return (
    <div ref={ref} className="relative mb-2 w-[64px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`当前门店：${session.store.name}（点一下换店）`}
        data-testid="store-switcher"
        className="flex w-full flex-col items-center gap-0.5 rounded-md bg-white/10 px-1 py-1.5 text-[11px] leading-tight font-bold text-paper transition hover:bg-white/18"
      >
        <Store className="size-4" />
        <span className="num w-full truncate" data-testid="store-current">
          {session.store.code}
        </span>
      </button>
      {open && (
        <StoreMenu>
          <p className="px-3 pt-2 pb-1.5 text-[12px] font-semibold text-ink-3">换门店</p>
          {session.stores.map((s) => (
            <button
              key={s.id}
              type="button"
              role="menuitem"
              disabled={busy !== null}
              onClick={() => void pick(s.id)}
              data-testid={`store-pick-${s.code}`}
              className={cn('flex h-10 w-full items-center gap-2.5 rounded-md px-3 text-left text-[14px] font-medium hover:bg-paper-2', s.id === session.store.id ? 'text-ink' : 'text-ink-2')}
            >
              <span className="num w-10 shrink-0 text-[12.5px] text-ink-3">{s.code}</span>
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              {s.id === session.store.id && <Check className="size-4 text-pine" />}
              {busy === s.id && <span className="text-[12px] text-ink-3">切换中…</span>}
            </button>
          ))}
        </StoreMenu>
      )}
    </div>
  );
}

function StoreMenu({ children }: { children: React.ReactNode }) {
  const ref = useExitGhost<HTMLDivElement>();
  return (
    <div
      ref={ref}
      role="menu"
      data-mo-out="menu"
      className="absolute bottom-0 left-[calc(100%+12px)] z-30 w-60 origin-bottom-left animate-menu-in rounded-lg border border-line bg-card p-1.5 text-ink shadow-pop"
    >
      {children}
    </div>
  );
}
