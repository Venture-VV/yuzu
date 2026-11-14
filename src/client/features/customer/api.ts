import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";

export function customerUrl(path: string, params: Record<string, string | number | undefined> = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
  return `/api/customer/${path}${search.size ? `?${search}` : ""}`;
}

/**
 * 页面每 3 秒只问一次「有没有变化」（/api/customer/revision，很轻）；变了就调 onChange，由页面把各块的数据重读一遍。
 * 整合进主线时改的：原来每一块各自每 3 秒重读一遍较重的统计（做法同管家部，AGENTS.md）。
 * 页面在后台、断网时不问；回到页面、恢复联网时马上问一次。
 */
export function useCustomerRevision(onChange: () => void) {
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    let live = true, inFlight = false, last: string | null = null;
    const run = async () => {
      if (!live || inFlight || document.hidden || !navigator.onLine) return;
      inFlight = true;
      try {
        const { revision } = await api.get<{ revision: string }>("/api/customer/revision");
        if (!live) return;
        if (last !== null && revision !== last) changed.current();
        last = revision;
      } catch {
        // 问不到就等下一次；各块自己的读取会报出断网、出错
      } finally { inFlight = false; }
    };
    void run();
    const timer = window.setInterval(() => void run(), 3000);
    const wake = () => void run();
    for (const name of ["online", "focus"]) window.addEventListener(name, wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      live = false; clearInterval(timer);
      for (const name of ["online", "focus"]) window.removeEventListener(name, wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
}

/** 没有变化时的慢速刷新：会员改名、换岗这类不在「有没有变化」里的，最多这么久带出来 */
const SLOW_REFRESH_MS = 30_000;

/** One request at a time per view; responses from a previous filter/session are discarded. */
export function useCustomerRead<T>(url: string | null, revision = 0) {
  const [state, setState] = useState<{ url: string | null; data: T | null; error: string; loading: boolean; receivedAt: string }>(
    { url: null, data: null, error: "", loading: false, receivedAt: "" },
  );
  useEffect(() => {
    if (!url) return;
    let live = true, inFlight = false;
    setState((old) => old.url === url
      ? { ...old, error: "", loading: old.data == null }
      : { url, data: null, error: "", loading: true, receivedAt: "" });
    const run = async () => {
      if (!live || inFlight || document.hidden) return;
      if (!navigator.onLine) {
        setState((old) => ({ ...old, error: "设备离线，联网后会自动继续同步。", loading: false }));
        return;
      }
      inFlight = true;
      try {
        const next = await api.get<T>(url);
        if (live) setState((old) => ({ url, data: old.url === url && JSON.stringify(old.data) === JSON.stringify(next) ? old.data : next, error: "", loading: false, receivedAt: new Date().toISOString() }));
      } catch (error) {
        if (live) setState((old) => ({ ...old, error: error instanceof Error ? error.message : "读取失败，请重试。", loading: false }));
      } finally { inFlight = false; }
    };
    void run();
    // 有变化时页面会换 revision 让这里重读（useCustomerRevision）；这里只留慢速刷新
    const timer = window.setInterval(() => void run(), SLOW_REFRESH_MS);
    const wake = () => void run();
    for (const name of ["online", "focus"]) window.addEventListener(name, wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      live = false; clearInterval(timer);
      for (const name of ["online", "focus"]) window.removeEventListener(name, wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [url, revision]);
  return state.url === url ? state : { url, data: null, error: "", loading: Boolean(url), receivedAt: "" };
}
