// 本机最近的问题与页面报错（8.1.3，docs/RESILIENCE_V813.md 第 3.4、3.6 节，WL7、WL12）。
// 最近的问题（断网、恢复、自动重发、页面报错）只记在这一页的内存里，「网络与同步」页列出来；
// 页面报错另外报给服务器（写进日志、店主看得到），只带错误本身、地址（去掉查询参数）与这一页的入口文件，不带填的内容。

import { useSyncExternalStore } from 'react';

export type ProblemKind = 'offline' | 'online' | 'retry' | 'error' | 'update';

export interface Problem {
  at: number;
  kind: ProblemKind;
  text: string;
}

const KEEP = 30;
let problems: Problem[] = [];
const listeners = new Set<() => void>();

export function noteProblem(kind: ProblemKind, text: string): void {
  problems = [{ at: Date.now(), kind, text }, ...problems].slice(0, KEEP);
  listeners.forEach((fn) => fn());
}

export function useProblems(): Problem[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => problems,
  );
}

/** 这一页的入口文件（构建好的 /assets/index-xxxx.js，和服务器 /api/ping 回的比，不一样就是系统更新过）；开发模式下没有 */
export const PAGE_ENTRY: string | null =
  typeof document === 'undefined' ? null : (document.querySelector<HTMLScriptElement>('script[type="module"][src^="/assets/"]')?.getAttribute('src') ?? null);

type ReportKind = 'render' | 'chunk' | 'error' | 'rejection';

/** 同一句错误一分钟内只报一次，一页最多报 20 次（出错的页面一直刷不会把服务器日志刷满） */
const recentlySent = new Map<string, number>();
let sentCount = 0;

export function reportClientError(kind: ReportKind, error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error ?? '')).slice(0, 500) || '（没有说明）';
  noteProblem('error', message);
  const now = Date.now();
  const last = recentlySent.get(message);
  if ((last !== undefined && now - last < 60_000) || sentCount >= 20) return;
  recentlySent.set(message, now);
  sentCount += 1;
  const stack = error instanceof Error && error.stack ? error.stack.slice(0, 4000) : undefined;
  const body = JSON.stringify({ kind, message, stack, path: location.pathname.slice(0, 300), entry: PAGE_ENTRY ?? undefined });
  // 页面马上要刷新、关掉时也让浏览器发完；不等结果、失败了不管
  try {
    void fetch('/api/client-errors', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => undefined);
  } catch {
    /* 发不出去就算了 */
  }
}
