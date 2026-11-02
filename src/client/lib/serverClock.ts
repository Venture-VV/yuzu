// 服务器时钟（v0.7.7；测试会话复测 v0.7.6 的 P2：前台电脑时钟不准时，转单窗口第一次显示按本机时间判断能不能转）。
// 前台、餐饮按服务器时间判断时限与在店时长，不信任本机时钟：
//   · 每个带 serverTime 的接口响应，在收到的那一刻记下「服务器时间 − 本机时间」（不是等页面显示时才算，缓存里的旧数据不会算偏）；
//   · 页面第一次显示就用这个时差，不先按本机时间；时差变了马上重新显示，不靠定时刷新。

import { useEffect, useState, useSyncExternalStore } from 'react';

let offsetMs: number | null = null;
const listeners = new Set<() => void>();

/** 接口响应收到时记下时差；变化不到半秒的不更新（避免每次请求都重新显示） */
export function noteServerTime(serverTime: string, receivedAt: number) {
  const t = Date.parse(serverTime);
  if (!Number.isFinite(t)) return;
  const next = t - receivedAt;
  if (offsetMs !== null && Math.abs(next - offsetMs) < 500) return;
  offsetMs = next;
  for (const l of listeners) l();
}

/** 以服务器时间为准的「现在」（毫秒，不订阅）：还没有接口带回服务器时间时按本机时间 */
export const serverNowMs = () => Date.now() + (offsetMs ?? 0);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => offsetMs;

/**
 * 以服务器时间为准的「现在」（毫秒）。第一次显示就按服务器时间；时差更新时马上校正；每 step 毫秒刷新一次显示。
 * serverTime：这份数据带回的服务器时间，只在还没有任何接口带回服务器时间时用来估算时差。
 */
export function useServerNow(serverTime: string | undefined, step = 30_000): number {
  const known = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), step);
    return () => clearInterval(t);
  }, [step]);
  const offset = known ?? (serverTime ? Date.parse(serverTime) - Date.now() : 0);
  return Date.now() + offset;
}
