// 顶上的网络提示（8.1.3，docs/RESILIENCE_V813.md 第 3.2、3.4 节，WL4、WL6）：盖在页面上、不挤动版面，打印时不显示。
// - 连不上服务器：写明数据截至几点、现在提交不会发出去（填的内容还在），可以「立即重试」、看「网络与同步」。
// - 刚恢复：「网络恢复了，页面数据已刷新」，4 秒后收起。
// - 系统更新过：请员工方便时刷新（不自动刷新，免得丢没提交的内容），可以先「稍后」。
// 电子菜单、对客导览大屏上缩成右下角一个小提示，不盖住版面。

import { useEffect, useState } from 'react';
import { CircleCheck, RefreshCw, Sparkles, WifiOff } from 'lucide-react';
import { probe, useConnection } from '../lib/connection';
import { cn } from '../lib/utils';

const RECOVERED_SHOW_MS = 4_000;
const COMPACT_PREFIXES = ['/emenu', '/guide/screen'];

const hhmm = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

/** path：当前地址；openNetwork：在页面里（不重新加载）打开「网络与同步」——断网时整页重新加载会打不开 */
export function NetworkBanner({ path, openNetwork }: { path: string; openNetwork: () => void }) {
  const conn = useConnection();
  const [now, setNow] = useState(() => Date.now());
  const [snoozedUpdate, setSnoozedUpdate] = useState(false);
  const [checking, setChecking] = useState(false);

  // 「刚恢复」那几秒到点收起
  useEffect(() => {
    if (!conn.recoveredAt) return;
    const left = conn.recoveredAt + RECOVERED_SHOW_MS - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), left + 50);
    return () => clearTimeout(t);
  }, [conn.recoveredAt]);

  // 打印页不显示；「网络与同步」页自己写着连接状态与版本，不再盖一条在标题上
  if (path.startsWith('/print') || path === '/network') return null;
  const compact = COMPACT_PREFIXES.some((p) => path.startsWith(p));
  const recovered = conn.state === 'online' && conn.recoveredAt !== null && Math.max(now, Date.now()) - conn.recoveredAt < RECOVERED_SHOW_MS;

  const retry = async () => {
    setChecking(true);
    await probe();
    setChecking(false);
  };

  if (conn.state === 'offline') {
    const since = conn.downSince ? hhmm(conn.downSince) : null;
    if (compact) {
      return (
        <div
          role="status"
          data-testid="network-banner"
          data-state="offline"
          className="fixed right-3 bottom-3 z-[80] flex items-center gap-2 rounded-full bg-clay px-3.5 py-2 text-[13px] font-bold text-paper shadow-pop print:hidden"
        >
          <WifiOff className="size-4" />
          网络断了，正在重新连接
        </div>
      );
    }
    return (
      <div
        role="alert"
        data-testid="network-banner"
        data-state="offline"
        className="fixed top-2 left-1/2 z-[80] w-max max-w-[min(94vw,760px)] -translate-x-1/2 animate-notice-in rounded-lg bg-clay px-4 py-2.5 text-paper shadow-pop print:hidden"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <WifiOff className="size-4 shrink-0" />
          <span className="text-[14px] font-bold">连不上服务器（网络断了或很慢），正在重新连接…</span>
          <button
            type="button"
            onClick={() => void retry()}
            disabled={checking}
            data-testid="network-retry"
            className="tap relative flex h-7 items-center gap-1 rounded-full bg-paper/15 px-3 text-[12.5px] font-bold hover:bg-paper/25 disabled:opacity-60"
          >
            <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
            立即重试
          </button>
          <button type="button" onClick={openNetwork} data-testid="network-open" className="text-[12.5px] font-semibold underline underline-offset-2 opacity-90 hover:opacity-100">
            网络与同步
          </button>
        </div>
        <p className="mt-1 text-[12.5px] opacity-90">{since ? `页面上的数据截至 ${since}。` : ''}现在提交不会发出去，填的内容还在；恢复以后页面会自己刷新。</p>
      </div>
    );
  }

  if (recovered) {
    return (
      <div
        role="status"
        data-testid="network-banner"
        data-state="recovered"
        className={cn(
          'fixed z-[80] flex animate-notice-in items-center gap-2 rounded-full bg-pine px-4 py-2 text-[13.5px] font-bold text-paper shadow-pop print:hidden',
          compact ? 'right-3 bottom-3' : 'top-2 left-1/2 -translate-x-1/2',
        )}
      >
        <CircleCheck className="size-4" />
        网络恢复了，页面数据已刷新
      </div>
    );
  }

  if (conn.updated && !snoozedUpdate && !compact) {
    return (
      <div
        role="status"
        data-testid="network-banner"
        data-state="updated"
        className="fixed top-2 left-1/2 z-[80] flex w-max max-w-[min(94vw,760px)] -translate-x-1/2 animate-notice-in flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-ink px-4 py-2.5 text-paper shadow-pop print:hidden"
      >
        <Sparkles className="size-4 shrink-0 text-yuzu" />
        <span className="text-[13.5px] font-bold">系统已更新{conn.server ? `到 ${conn.server.version}` : ''}，方便时点「刷新」换成新版（没提交的内容先提交）</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          data-testid="network-reload"
          className="tap relative flex h-7 items-center rounded-full bg-yuzu px-3 text-[12.5px] font-bold text-ink hover:bg-yuzu-hover"
        >
          刷新
        </button>
        <button type="button" onClick={() => setSnoozedUpdate(true)} className="tap relative h-7 rounded-full px-2 text-[12.5px] font-semibold text-paper/75 hover:text-paper">
          稍后
        </button>
      </div>
    );
  }
  return null;
}
