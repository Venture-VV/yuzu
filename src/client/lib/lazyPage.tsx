// 按需加载的页面（v0.7.22 代码整理）：管理后台、ERP、打印、看板等页面第一次打开时才下载代码，
// 前台收银、会员工作台打开得更快。
// 下载失败（网络不稳，或者系统刚更新过、旧页面要的文件已经换掉）时（8.1.3，docs/RESILIENCE_V813.md 第 3.4 节，WL6）：
// 1. 1 秒后再导入一次（有的浏览器不记住失败的下载，再导入就会重新去取）；
// 2. 还不行（Chrome 会记住这次失败，再导入也不去取）：连得上服务器时整页重新加载这一页一次——这时上一页已经离开、
//    这一页还没打开，不会丢填的内容；「结果待确认」的记录在本机存储里，重新加载也在。连不上时等网络恢复再加载
//    （最多等 5 分钟）。同一页 1 分钟内只自动重新加载一次，免得一直刷；
// 3. 再不行才给「重新加载」按钮（系统更新过时写明「系统已更新」）。下载失败报给服务器。

import { Component, lazy, Suspense, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { Button, Spinner } from '../components/ui';
import { noteProblem, reportClientError } from './clientLog';
import { connectionSnapshot, onReconnect, probe } from './connection';

/** 页面代码没下载下来的几种浏览器提示（Chrome / Firefox / Safari），以及 Vite 的样式表预加载失败 */
export const isChunkError = (e: unknown) =>
  e instanceof Error && /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(e.message);

/** 正在重新下载的页面：'retry' 再导入一次、'reload' 马上重新加载、'wait' 等网络恢复再加载（转圈处写一句话） */
type RetryPhase = 'retry' | 'reload' | 'wait' | null;
let phase: RetryPhase = null;
const phaseListeners = new Set<() => void>();
const setPhase = (next: RetryPhase) => {
  phase = next;
  phaseListeners.forEach((fn) => fn());
};
const useRetryPhase = () =>
  useSyncExternalStore(
    (fn) => {
      phaseListeners.add(fn);
      return () => phaseListeners.delete(fn);
    },
    () => phase,
  );

const RELOAD_GUARD_KEY = 'yuzu.chunkReload.v1';
const RELOAD_GUARD_MS = 60_000;
const WAIT_ONLINE_MS = 5 * 60_000;

/** 这一页 1 分钟内没自动重新加载过（本机存储用不了时不自动加载，免得一直刷） */
function reloadAllowed(): boolean {
  try {
    const raw = sessionStorage.getItem(RELOAD_GUARD_KEY);
    const last = raw ? (JSON.parse(raw) as { path?: string; at?: number }) : null;
    return !(last && last.path === location.pathname && typeof last.at === 'number' && Date.now() - last.at < RELOAD_GUARD_MS);
  } catch {
    return false;
  }
}

function markReload(): boolean {
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, JSON.stringify({ path: location.pathname, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

/** 连得上服务器：现在问一次，问不到就等网络恢复（最多等 waitMs） */
async function reachableSoon(waitMs: number): Promise<boolean> {
  if (await probe()) return true;
  setPhase('wait');
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, waitMs);
    const off = onReconnect(() => {
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

/** 下载失败的：再导入一次；还不行就在连得上服务器时整页重新加载一次（见文件开头） */
export async function loadWithRetry<T>(load: () => Promise<T>, opts: { retryDelayMs?: number; waitOnlineMs?: number } = {}): Promise<T> {
  try {
    return await load();
  } catch (first) {
    if (!isChunkError(first)) throw first;
    const path = location.pathname;
    setPhase('retry');
    try {
      noteProblem('retry', '这一页的代码没下载下来，1 秒后再试');
      await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 1_000));
      try {
        return await load();
      } catch (e) {
        if (!isChunkError(e)) throw e;
      }
      if (reloadAllowed() && (await reachableSoon(opts.waitOnlineMs ?? WAIT_ONLINE_MS)) && location.pathname === path && reloadAllowed() && markReload()) {
        setPhase('reload');
        noteProblem('retry', '浏览器记住了这次下载失败，重新加载这一页');
        window.location.reload();
        return await new Promise<T>(() => undefined); // 页面马上重新加载
      }
      throw first;
    } finally {
      setPhase(null);
    }
  }
}

class ChunkErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown) {
    if (isChunkError(error)) reportClientError('chunk', error);
  }

  // 只处理页面代码没下载下来的情况，别的错误照旧往外抛（交给外层的错误边界）
  override render() {
    const { error } = this.state;
    if (error && !isChunkError(error)) throw error;
    if (error) {
      const updated = connectionSnapshot().updated;
      return (
        <div className="flex flex-col items-center gap-3 px-6 py-16 text-center" data-testid="page-load-failed">
          <p className="text-[15px] font-bold text-ink">{updated ? '系统已更新，这一页要刷新一下才能打开' : '这一页没有加载出来'}</p>
          <p className="max-w-sm text-[13px] text-ink-3">
            {updated ? '刷新以后换成新版本。' : '已经自动重新下载了几次，网络不通或者系统刚更新过。网络正常后点「重新加载」。'}没提交的内容请先记下；「结果待确认」的记录存在这台电脑上，刷新不会丢。
          </p>
          <Button variant="primary" onClick={() => window.location.reload()}>
            {updated ? '刷新，换成新版本' : '重新加载'}
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

function PageSpinner() {
  const now = useRetryPhase();
  return (
    <div className="flex flex-col items-center gap-2 py-16">
      <Spinner />
      {now && (
        <p className="text-[13px] text-ink-3" data-testid="page-load-retrying">
          {now === 'wait' ? '网络断了，恢复以后自动重新加载这一页…' : now === 'reload' ? '正在重新加载这一页…' : '网络不稳，正在重新下载这一页…'}
        </p>
      )}
    </div>
  );
}

/** load 返回页面组件（命名导出）；第一次渲染时才下载那一页的代码，下载失败自动再试（见文件开头） */
export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const Page = lazy(async () => ({ default: await loadWithRetry(load) }));
  function LazyPage(props: P) {
    return (
      <ChunkErrorBoundary>
        <Suspense fallback={<PageSpinner />}>
          <Page {...props} />
        </Suspense>
      </ChunkErrorBoundary>
    );
  }
  return LazyPage;
}
