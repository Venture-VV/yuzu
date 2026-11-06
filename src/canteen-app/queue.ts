// 负责人扫到的码先记在这台手机上（读回核对，存不下就不发），再交给门店系统；没收到明确结果的留着，
// 之后按原来的操作编号原样补交，直到门店系统给出明确结果（docs/CANTEEN.md 第 6 节「断网补登」）。

import type { CheckinResult } from '@shared/canteen';
import { ApiError, call, NetworkError, readJson, writeJson } from './lib';

export interface ScanBody {
  clientKey: string;
  code?: string;
  employeeId?: number;
  /** 扫到的时间（按服务器时间差修正过） */
  scannedAt: string;
  note?: string;
}

export interface QueuedScan {
  body: ScanBody;
  /** 给人看的：手动登记时是姓名 */
  label: string;
  savedAt: number;
}

export type Outcome = { kind: 'done'; result: CheckinResult } | { kind: 'rejected'; error: ApiError } | { kind: 'queued' };

const key = (managerId: number) => `yuzu.canteen.scanq.v1.${managerId}`;

export const loadQueue = (managerId: number) => readJson<QueuedScan[]>(key(managerId)) ?? [];

function save(managerId: number, list: QueuedScan[]): boolean {
  return writeJson(key(managerId), list);
}

/** 先存下（存不下返回 false：调用方不得发出请求） */
export function enqueue(managerId: number, item: QueuedScan): boolean {
  const list = loadQueue(managerId).filter((x) => x.body.clientKey !== item.body.clientKey);
  return save(managerId, [...list, item]);
}

export function dequeue(managerId: number, clientKey: string) {
  save(
    managerId,
    loadQueue(managerId).filter((x) => x.body.clientKey !== clientKey),
  );
}

/** 交一笔：明确结果（成功、已打过卡、明确拒绝）就从本机删掉；结果不明就留着等补交 */
export async function submit(managerId: number, body: ScanBody): Promise<Outcome> {
  try {
    const result = await call<CheckinResult>('POST', '/api/canteen/checkins', body, 10_000);
    dequeue(managerId, body.clientKey);
    return { kind: 'done', result };
  } catch (e) {
    // 503 饭堂没开张、409 正忙：也当作结果不明，留着补交
    if (e instanceof NetworkError || (e instanceof ApiError && (e.status === 503 || e.code === 'BUSY'))) return { kind: 'queued' };
    if (e instanceof ApiError && e.status === 401) return { kind: 'queued' };
    dequeue(managerId, body.clientKey);
    return { kind: 'rejected', error: e as ApiError };
  }
}

/** 按顺序补交本机留着的；遇到还是结果不明的就停，等下一轮 */
export async function flush(managerId: number, onSettled: (item: QueuedScan, outcome: Outcome) => void): Promise<number> {
  for (const item of loadQueue(managerId)) {
    const outcome = await submit(managerId, item.body);
    if (outcome.kind === 'queued') break;
    onSettled(item, outcome);
  }
  return loadQueue(managerId).length;
}
