import type { ApiErrorBody } from '@shared/types';
import { noteServerTime } from './serverClock';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** 请求超时或断网：服务端是否已处理未知，需要按操作编号查回结果。 */
export class UncertainError extends Error {
  constructor(readonly reason: 'timeout' | 'network') {
    super(reason === 'timeout' ? '服务器长时间没有响应' : '网络连接中断');
  }
}

type Listener = (error: ApiError) => void;
const authListeners = new Set<Listener>();
/** 会话失效（401）或需要修改密码时通知全局。 */
export function onAuthError(fn: Listener): () => void {
  authListeners.add(fn);
  return () => {
    authListeners.delete(fn);
  };
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new UncertainError(controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) {
    // 带服务器时间的响应：在收到的这一刻记下时差（前台、餐饮按服务器时间判断时限）
    const receivedAt = Date.now();
    const data = (await res.json()) as T;
    const serverTime = (data as { serverTime?: unknown } | null)?.serverTime;
    if (typeof serverTime === 'string') noteServerTime(serverTime, receivedAt);
    return data;
  }

  let payload: ApiErrorBody | null = null;
  try {
    payload = (await res.json()) as ApiErrorBody;
  } catch {
    /* 非 JSON 响应 */
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new UncertainError('network');
  const error = new ApiError(
    res.status,
    payload?.error.code ?? 'HTTP_ERROR',
    payload?.error.message ?? `请求失败（${res.status}）`,
    payload?.error.details,
  );
  if (res.status === 401 || error.code === 'PASSWORD_CHANGE_REQUIRED') {
    if (!url.startsWith('/api/auth/login')) authListeners.forEach((fn) => fn(error));
  }
  throw error;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown, options?: { timeoutMs?: number }) => request<T>('POST', url, body ?? {}, options),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof UncertainError) return error.message;
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}
