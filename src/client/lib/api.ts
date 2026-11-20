import type { ApiErrorBody } from '@shared/types';
import { NOT_APPLIED_CODES } from '@shared/resilience';
import { noteProblem } from './clientLog';
import { ensureReachable, noteNetworkFailure, noteResponse, requestSeq } from './connection';
import { noteServerTime } from './serverClock';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    /** 服务器说多久以后再试（Retry-After） */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/**
 * 结果不确定：请求超时、断网，或写请求遇到服务器出错（5xx）——服务端可能已经提交了事务、只是读结果或回复时出错，
 * 是否已处理未知，需要按操作编号查回结果，不能当作被拒绝（v0.7.23：Codex 在 main v0.7.22 上报的 P1）。
 */
export class UncertainError extends Error {
  constructor(readonly reason: 'timeout' | 'network' | 'server' | 'offline') {
    super(
      reason === 'timeout'
        ? '服务器长时间没有响应'
        : reason === 'network'
          ? '网络连接中断'
          : reason === 'offline'
            ? '连不上服务器（网络断了或很慢），这次没有发出去；填的内容还在，网络恢复后再提交'
            : '服务器出了点问题，这次提交可能已经生效，请刷新核对后再决定是否重做',
    );
  }
}

/**
 * 连不上服务器，这次请求**没有发出去**（8.1.3 WL4）。算作「结果不确定」的一种，没改过的页面照旧按待确认处理（不会出错）；
 * 第一次提交时调用方可以用 notSentAsRejection 改成「明确没处理」——但从「结果待确认」里重提时不行：之前那次可能已经生效。
 */
export class OfflineError extends UncertainError {
  constructor() {
    super('offline');
  }
}

/** 第一次提交（这个操作编号之前从没发出去过）被「没发出去」挡下：等同被明确拒绝，调用方删掉本机的待确认记录、留着填的内容 */
export function notSentAsRejection(error: unknown): unknown {
  return error instanceof OfflineError ? new ApiError(0, 'OFFLINE', error.message) : error;
}

/** 服务端明确没有处理（被拒绝，或系统忙、太频繁、过载这三种自动重发也没成）：本机的待确认记录可以删，表单留着 */
export function isRejected(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status < 500 || error.code === 'OVERLOADED');
}

/** 服务器明确没处理、可以原样自动重发的（8.1.3 WL5）：系统忙（等锁、死锁、串行化冲突）、请求太频繁、系统正忙 */
const NOT_APPLIED = new Set<string>(NOT_APPLIED_CODES);
const isNotApplied = (error: unknown): error is ApiError => error instanceof ApiError && NOT_APPLIED.has(error.code);
const MAX_RESENDS = 3;
const RESEND_BUDGET_MS = 12_000;

/** 页面数据（React Query）要不要再取：明确的拒绝不再取；上面那三种在请求里已经重发过，不再叠一层（只在一层重试） */
export function shouldRetryQuery(count: number, error: unknown): boolean {
  if (error instanceof ApiError && (error.status < 500 || isNotApplied(error))) return false;
  return count < 2;
}

/** 页面数据重试的间隔：1、2 秒……最多 15 秒，带随机（AWS《Exponential Backoff And Jitter》） */
export const queryRetryDelay = (attempt: number) => Math.round(Math.min(1000 * 2 ** attempt, 15_000) * (0.5 + Math.random() * 0.5));

type Listener = (error: ApiError) => void;
const authListeners = new Set<Listener>();
/** 会话失效（401）或需要修改密码时通知全局。 */
export function onAuthError(fn: Listener): () => void {
  authListeners.add(fn);
  return () => {
    authListeners.delete(fn);
  };
}

type RequestOptions = { timeoutMs?: number; keepalive?: boolean };

/**
 * 发一个请求。服务器明确没处理的三种（系统忙、请求太频繁、系统正忙）原样自动重发：照 Retry-After，没有就 0.5、1、2 秒左右，
 * 最多再发 3 次、总共 12 秒内；断网、超时、5xx 的写请求不自动重发（照旧「结果待确认」，由员工决定）。
 */
export async function request<T>(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
  /** keepalive：页面关掉、切走时发的请求也让浏览器发完（草稿自动保存用；请求体超过 64 KB 时浏览器会拒绝，当作没发出去） */
  options: RequestOptions = {},
): Promise<T> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce<T>(method, url, body, options);
    } catch (error) {
      if (!isNotApplied(error) || attempt >= MAX_RESENDS) throw error;
      const wait = error.retryAfterMs ?? Math.round(500 * 2 ** attempt * (0.5 + Math.random()));
      if (Date.now() - started + wait > RESEND_BUDGET_MS) throw error;
      noteProblem('retry', `${error.message}（${url.split('?')[0]}，${(wait / 1000).toFixed(1)} 秒后自动重发）`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function requestOnce<T>(method: 'GET' | 'POST' | 'PUT', url: string, body: unknown, options: RequestOptions): Promise<T> {
  // 已经判定连不上：当场再问一次，问不到就不发（明确告诉员工没发出去，不等满 15 秒）
  if (!(await ensureReachable())) throw new OfflineError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  // 发出去时的断网信号序号：回来时又有过断网信号的，回应不算连上的证据（connection.ts 的 signalSeq）
  const sentSeq = requestSeq();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      ...(options.keepalive ? { keepalive: true } : {}),
    });
  } catch {
    noteNetworkFailure();
    throw new UncertainError(controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) {
    noteResponse(sentSeq);
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
  const retryAfter = Number(res.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  // yuzu 自己的过载保护（8.1.3）：请求一进来就拒了，确定没处理
  if (res.status === 503 && payload?.error?.code === 'OVERLOADED') {
    noteResponse(sentSeq);
    throw new ApiError(503, 'OVERLOADED', payload.error.message, undefined, retryAfterMs);
  }
  // 网关、断网的 502 / 503 / 504 算网络问题；读请求遇到 yuzu 自己回的 503（带错误码，例如门店没配会员码）按错误显示原因（v0.7.25）
  if ((res.status === 502 || res.status === 503 || res.status === 504) && !(method === 'GET' && payload?.error?.code)) {
    noteNetworkFailure();
    throw new UncertainError('network');
  }
  noteResponse(sentSeq);
  // 写请求遇到服务器出错（500 等）：事务可能已经提交（例如登记后读结果失败），不能当作被拒绝。
  // 带操作编号的页面按「结果待确认」处理：保留原编号与原请求，查回、按原内容重新提交或确认作废
  if (method !== 'GET' && res.status >= 500) throw new UncertainError('server');
  const error = new ApiError(res.status, payload?.error.code ?? 'HTTP_ERROR', payload?.error.message ?? `请求失败（${res.status}）`, payload?.error.details, retryAfterMs);
  if (res.status === 401 || error.code === 'PASSWORD_CHANGE_REQUIRED' || error.code === 'POSITION_REQUIRED') {
    if (!url.startsWith('/api/auth/login')) authListeners.forEach((fn) => fn(error));
  }
  throw error;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown, options?: { timeoutMs?: number }) => request<T>('POST', url, body ?? {}, options),
  put: <T>(url: string, body: unknown, options?: { timeoutMs?: number; keepalive?: boolean }) => request<T>('PUT', url, body, options),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof UncertainError) return error.message;
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}
