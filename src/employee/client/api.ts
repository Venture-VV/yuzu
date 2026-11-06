import { useEffect, useState } from 'react';

export class EmployeeApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
let expectedEmployeeId: string | null = null;
/** cookie 在标签页之间共享；请求同时携带本页面看到的身份，防止其他标签页换号后串写。 */
export function setEmployeeIdentity(id: string | null) { expectedEmployeeId = id; }

export async function employeeApi<T>(path: string, body?: unknown): Promise<T> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 20_000);
  try {
    const response = await fetch(`/api/employee${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: abort.signal,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(expectedEmployeeId && path !== '/session' && path !== '/login' ? { 'x-employee-id': expectedEmployeeId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    if (!response.ok) throw new EmployeeApiError(response.status, data?.error?.code ?? 'REQUEST_FAILED', data?.error?.message ?? '服务暂时无法响应，请稍后重试');
    return data as T;
  } catch (error) {
    if (error instanceof EmployeeApiError) throw error;
    throw new EmployeeApiError(0, 'NETWORK', '没有收到服务器确认，请检查网络后重试');
  } finally { clearTimeout(timeout); }
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请稍后重试';
export const isUncertain = (error: unknown) => !(error instanceof EmployeeApiError) || error.status === 0 || error.status >= 500;
export const chinaDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const timeOf = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return online;
}

export interface PendingWrite<T> { requestId: string; value: T; uncertain: boolean }
export function readPending<T>(key: string): PendingWrite<T> | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as PendingWrite<T>;
  if (!parsed || typeof parsed.requestId !== 'string' || !Object.hasOwn(parsed, 'value')) throw new Error('待确认记录无法读取，请联系管理员核对');
  // 刷新前可能在请求发出后、响应写回前中断，恢复时一律按结果不确定处理。
  return { ...parsed, uncertain: true };
}
export function storePending<T>(key: string, value: PendingWrite<T>) {
  const raw = JSON.stringify(value);
  sessionStorage.setItem(key, raw);
  if (sessionStorage.getItem(key) !== raw) throw new Error('无法保存待确认记录，本次未发送，请检查浏览器存储权限');
}
export function clearPending(key: string) {
  sessionStorage.removeItem(key);
  if (sessionStorage.getItem(key) !== null) throw new Error('服务器已确认，但本机记录未清除，请刷新后查回');
}
