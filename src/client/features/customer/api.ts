import { useEffect, useState } from "react";
import { api } from "../../lib/api";

export function customerUrl(path: string, params: Record<string, string | number | undefined> = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
  return `/api/customer/${path}${search.size ? `?${search}` : ""}`;
}

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
    const timer = window.setInterval(() => void run(), 3000);
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
