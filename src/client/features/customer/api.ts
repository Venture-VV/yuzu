import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';

export function customerUrl(path: string, params: Record<string, string | number | undefined> = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  return `/api/customer/${path}${search.size ? `?${search}` : ''}`;
}

/**
 * 页面每 3 秒只问一次「有没有变化」（/api/customer/revision，很轻）；变了就调 onChange，由页面把各块的数据重读一遍。
 * 整合进主线时改的：原来每一块各自每 3 秒重读一遍较重的统计（做法同管家部，AGENTS.md）。
 * 页面在后台、连不上服务器时不问；回到页面、网络恢复时马上问一次（lib/livePoll，8.1.3）。
 */
export function useCustomerRevision(onChange: () => void) {
  const changed = useRef(onChange);
  changed.current = onChange;
  const last = useRef<string | null>(null);
  useLivePoll(
    async (isLive) => {
      try {
        const { revision } = await api.get<{ revision: string }>('/api/customer/revision');
        if (!isLive()) return;
        if (last.current !== null && revision !== last.current) changed.current();
        last.current = revision;
      } catch {
        // 问不到就等下一次；各块自己的读取会报出断网、出错
      }
    },
    [],
    { intervalMs: 3000 },
  );
}

/** 没有变化时的慢速刷新：会员改名、换岗这类不在「有没有变化」里的，最多这么久带出来 */
const SLOW_REFRESH_MS = 30_000;

type ReadState<T> = { url: string | null; data: T | null; error: string; loading: boolean; receivedAt: string };

/** One request at a time per view; responses from a previous filter/session are discarded. */
export function useCustomerRead<T>(url: string | null, revision = 0) {
  const [state, setState] = useState<ReadState<T>>({ url: null, data: null, error: '', loading: false, receivedAt: '' });
  useEffect(() => {
    if (!url) return;
    setState((old) => (old.url === url ? { ...old, error: '', loading: old.data == null } : { url, data: null, error: '', loading: true, receivedAt: '' }));
  }, [url, revision]);
  // 有变化时页面会换 revision 让这里重读（useCustomerRevision）；这里只留慢速刷新
  useLivePoll(
    async (isLive) => {
      if (!url) return;
      try {
        const next = await api.get<T>(url);
        if (isLive())
          setState((old) => ({
            url,
            data: old.url === url && JSON.stringify(old.data) === JSON.stringify(next) ? old.data : next,
            error: '',
            loading: false,
            receivedAt: new Date().toISOString(),
          }));
      } catch (error) {
        if (isLive()) setState((old) => ({ ...old, error: error instanceof Error ? error.message : '读取失败，请重试。', loading: false }));
      }
    },
    [url, revision],
    { intervalMs: SLOW_REFRESH_MS, onOffline: () => url && setState((old) => ({ ...old, error: '设备离线，联网后会自动继续同步。', loading: false })) },
  );
  return state.url === url ? state : { url, data: null, error: '', loading: Boolean(url), receivedAt: '' };
}
