// 定时取数（8.1.3 整理，docs/RESILIENCE_V813.md 第 3.1 节第 5 条）：原来客户部、管家部各几处自己写一遍
// 「每几秒取一次、在后台不取、断网不取、回到页面与重新联网时马上取、同时只跑一个」，判断断网只看网卡。
// 收成一个：断网按连接状态判断（问服务器，lib/connection），网络恢复时马上取一次。

import { useEffect, useRef, type DependencyList } from 'react';
import { connectionSnapshot, onReconnect } from './connection';

export interface LivePollOptions {
  /** 页面在前台、连得上时每隔多久取一次；不填只在醒来时取 */
  intervalMs?: number;
  /** 第一次取之前等多久（输入框边打边查时用来去抖） */
  delayMs?: number;
  /** 连不上服务器、这一次没取时叫一下（页面写「离线」） */
  onOffline?: () => void;
  /** 另外的唤醒（例如管家部同步发的「有变化了」）；返回收尾函数 */
  subscribe?: (wake: () => void) => () => void;
}

/**
 * task(isLive)：取一次；isLive() 为假说明这一轮已经作废（依赖变了、页面卸了），取回来的不要再写进状态。
 * 依赖变了从头来（与 useEffect 一样）。同一时刻只跑一个；页面在后台不取。
 */
export function useLivePoll(task: (isLive: () => boolean) => Promise<void>, deps: DependencyList, opts: LivePollOptions = {}): void {
  const taskRef = useRef(task);
  taskRef.current = task;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    let live = true;
    let inFlight = false;
    const isLive = () => live;
    const run = async () => {
      if (!live || inFlight || document.hidden) return;
      if (connectionSnapshot().state === 'offline') {
        optsRef.current.onOffline?.();
        return;
      }
      inFlight = true;
      try {
        await taskRef.current(isLive);
      } finally {
        inFlight = false;
      }
    };
    const wake = () => void run();
    const { delayMs, intervalMs, subscribe } = optsRef.current;
    const first = delayMs ? window.setTimeout(wake, delayMs) : null;
    if (!delayMs) wake();
    const timer = intervalMs ? window.setInterval(wake, intervalMs) : null;
    const offReconnect = onReconnect(wake);
    const offExtra = subscribe?.(wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      live = false;
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      offReconnect();
      offExtra?.();
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
    // 依赖由调用方给（与 useEffect 一样）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
