// 对外调用记录（docs/INTEGRATIONS_V8021.md 第 1 节）：每次调用记一行，只追加。请求、结果只存打码后的摘要。

import type { Db } from '../db';
import type { IntegrationKind } from './config';

export interface CallRecord {
  kind: IntegrationKind;
  provider: string;
  action: string;
  mode: 'mock' | 'live';
  refType?: string | null;
  refId?: number | null;
  request?: Record<string, unknown>;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string | null;
  durationMs: number;
  staffId?: number | null;
}

/** 手机号、付款码、银行账号这类：只留后四位 */
export function maskTail(value: string, keep = 4): string {
  const s = value.trim();
  if (s.length <= keep) return '*'.repeat(s.length);
  return `${'*'.repeat(Math.min(6, s.length - keep))}${s.slice(-keep)}`;
}

export async function recordCall(db: Db, c: CallRecord): Promise<void> {
  await db`
    INSERT INTO integration_calls (kind, provider, action, mode, ref_type, ref_id, request_summary, ok, result_summary, error, duration_ms, staff_id)
    VALUES (${c.kind}, ${c.provider}, ${c.action}, ${c.mode}, ${c.refType ?? null}, ${c.refId ?? null}, ${db.json((c.request ?? {}) as never)},
            ${c.ok}, ${db.json((c.result ?? {}) as never)}, ${c.error ? c.error.slice(0, 500) : null}, ${Math.max(0, Math.round(c.durationMs))}, ${c.staffId ?? null})`;
}

/** 调一次对外接口并记下来：失败也记，错误照原样抛出 */
export async function withCallLog<T>(
  db: Db,
  base: Omit<CallRecord, 'ok' | 'result' | 'error' | 'durationMs'>,
  fn: () => Promise<T>,
  summarize: (r: T) => Record<string, unknown> = () => ({}),
): Promise<T> {
  const started = Date.now();
  try {
    const r = await fn();
    await recordCall(db, { ...base, ok: true, result: summarize(r), durationMs: Date.now() - started });
    return r;
  } catch (error) {
    await recordCall(db, { ...base, ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started }).catch(() => undefined);
    throw error;
  }
}
