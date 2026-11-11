// 巡场打卡（8.0.9，docs/PATROL_V809.md 第 3.2 节）：扫到的先记在这台手机上（读回核对，存不下就不发），再交给门店系统；
// 没收到明确结果的留着，之后按原来的操作编号原样补交，直到门店系统给出明确结果（与食堂负责人扫码的 queue.ts 同一个做法，XC7）。
// 另外：用手机相机、微信直接扫开的（#patrol=码），没登录时先把码记下来，登录好以后接着打卡。

import type { PatrolCheckinResult, PatrolVia } from '@shared/patrol';
import { ApiError, call, NetworkError, readJson, removeKey, writeJson } from './lib';

export interface PatrolScanBody {
  clientKey: string;
  /** 扫到的文字：整个地址或场所码 */
  code: string;
  /** 扫到的时间（按服务器时间差修正过） */
  scannedAt: string;
  via: PatrolVia;
}

export interface QueuedPatrolScan {
  body: PatrolScanBody;
  savedAt: number;
}

export type PatrolOutcome = { kind: 'done'; result: PatrolCheckinResult } | { kind: 'rejected'; error: ApiError } | { kind: 'queued' };

const key = (employeeId: number) => `yuzu.canteen.patrolq.v1.${employeeId}`;

export const loadPatrolQueue = (employeeId: number) => readJson<QueuedPatrolScan[]>(key(employeeId)) ?? [];

/** 先存下（存不下返回 false：调用方不得发出请求） */
export function enqueuePatrol(employeeId: number, item: QueuedPatrolScan): boolean {
  const list = loadPatrolQueue(employeeId).filter((x) => x.body.clientKey !== item.body.clientKey);
  return writeJson(key(employeeId), [...list, item]);
}

function dequeuePatrol(employeeId: number, clientKey: string) {
  writeJson(
    key(employeeId),
    loadPatrolQueue(employeeId).filter((x) => x.body.clientKey !== clientKey),
  );
}

/** 正在交的几笔（操作编号）：补交那一轮跳过，不把刚扫的这一笔当成补交再交一次 */
const inFlight = new Set<string>();

/**
 * 交一笔：明确结果（成功、刚打过卡、明确拒绝）就从本机删掉；结果不明就留着等补交。
 * 带上这一笔记在谁名下（employeeId，队列按员工分开存）：门店系统核对与登录的员工一致——同一台手机换了人登录（另一个标签页、
 * 开通卡片换人），上一位断网扫的不会记到这一位名下（Codex 审查 ae12728）
 */
export async function submitPatrol(employeeId: number, body: PatrolScanBody): Promise<PatrolOutcome> {
  inFlight.add(body.clientKey);
  try {
    const result = await call<PatrolCheckinResult>('POST', '/api/canteen/patrol/checkins', { ...body, employeeId }, 10_000);
    dequeuePatrol(employeeId, body.clientKey);
    return { kind: 'done', result };
  } catch (e) {
    // 没网、超时、服务器出错（结果不明），饭堂 / 巡场暂时没开、正忙、要重新登录、这台手机现在登录的是另一位：留着补交
    if (
      e instanceof NetworkError ||
      (e instanceof ApiError && (e.status === 503 || e.status === 401 || e.code === 'BUSY' || e.code === 'PATROL_OTHER_EMPLOYEE'))
    )
      return { kind: 'queued' };
    dequeuePatrol(employeeId, body.clientKey);
    return { kind: 'rejected', error: e as ApiError };
  } finally {
    inFlight.delete(body.clientKey);
  }
}

/** 按顺序补交本机留着的；正在交的、这一轮里已经交完的跳过；遇到还是结果不明的就停，等下一轮。返回还等着补交的笔数 */
export async function flushPatrol(employeeId: number, onSettled: (item: QueuedPatrolScan, outcome: PatrolOutcome) => void): Promise<number> {
  for (const item of loadPatrolQueue(employeeId)) {
    const k = item.body.clientKey;
    if (inFlight.has(k) || !loadPatrolQueue(employeeId).some((x) => x.body.clientKey === k)) continue;
    const outcome = await submitPatrol(employeeId, item.body);
    if (outcome.kind === 'queued') break;
    onSettled(item, outcome);
  }
  return loadPatrolQueue(employeeId).filter((x) => !inFlight.has(x.body.clientKey)).length;
}

// ── 直接扫开的码（#patrol=码）：没登录时先记下，登录好以后接着打卡 ──

const LINK_KEY = 'yuzu.canteen.patrolLink.v1';
/** 记下的码 10 分钟内有效（登录完一般用不了这么久；太久的就不替人打卡了） */
const LINK_TTL_MS = 10 * 60_000;

export interface PendingPatrolLink {
  token: string;
  /** 打开链接的时间（按手机时间）：打卡记的是这个时间 */
  at: number;
}

export function rememberPatrolLink(token: string) {
  writeJson(LINK_KEY, { token, at: Date.now() } satisfies PendingPatrolLink);
}

/** 有没有记下的码（不取走）：登录好以后要不要直接去巡场页 */
export function peekPatrolLink(): boolean {
  const v = readJson<PendingPatrolLink>(LINK_KEY);
  return !!v && typeof v.at === 'number' && Date.now() - v.at <= LINK_TTL_MS;
}

export function forgetPatrolLink() {
  removeKey(LINK_KEY);
}

export function takePatrolLink(): PendingPatrolLink | null {
  const v = readJson<PendingPatrolLink>(LINK_KEY);
  removeKey(LINK_KEY);
  if (!v || typeof v.token !== 'string' || typeof v.at !== 'number') return null;
  return Date.now() - v.at <= LINK_TTL_MS ? v : null;
}
