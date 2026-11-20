// 连接状态（8.1.3，docs/RESILIENCE_V813.md 第 3.2 节，WL3、WL4）。
//
// 浏览器自己的「在线 / 离线」只看网卡：连着 Wi-Fi 但到不了服务器时照样说在线，页面一次次等满 15 秒。这里改成问服务器：
// - 平时不额外发请求：每个请求收到服务器的回应就记「刚连上过」（noteResponse）；发不出去、超时时马上问一次（noteNetworkFailure）。
// - 问的是 GET /api/ping（不查数据库、不读会话），5 秒超时；连续两次问不到才算断了，之后 2、4、8、15 秒（带随机）再问；
//   网卡恢复、切回这个页面、点「立即重试」马上问；页面开着、在前台时每 60 秒问一次（顺便看系统有没有更新）。
// - 断了告诉 React Query 离线（数据先停着不取，不一次次报错，照 TanStack Query 的 onlineManager）；恢复后随机等 0–2 秒
//   （几十台终端不同时涌进来）再告诉它在线，开着的页面马上重新取数据，各处「结果待确认」马上查回（onReconnect）。

import { useEffect, useState, useSyncExternalStore } from 'react';
import { onlineManager } from '@tanstack/react-query';
import type { PingReply } from '@shared/resilience';
import { noteProblem, PAGE_ENTRY } from './clientLog';

export type LinkState = 'online' | 'checking' | 'offline';

export interface ConnectionSnapshot {
  state: LinkState;
  /** 最近一次问到服务器的时间 */
  lastOkAt: number | null;
  /** 从什么时候开始连不上 */
  downSince: number | null;
  /** 断了以后已经重新问了几次 */
  attempts: number;
  /** 最近一次问服务器的往返时间（毫秒） */
  rttMs: number | null;
  /** 服务器的版本（最近一次问到的） */
  server: { version: string; commit: string; client: string | null } | null;
  /** 系统更新过：服务器上这一版页面的入口和这一页的不一样（提示条请员工方便时刷新） */
  updated: boolean;
  /** 刚恢复的时间（提示条显示几秒「网络恢复了」） */
  recoveredAt: number | null;
}

const PROBE_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000];
const HEARTBEAT_MS = 60_000;
/** 恢复以后最多随机等这么久再让页面重新取数据 */
const RECONNECT_SPREAD_MS = 2_000;

let snap: ConnectionSnapshot = { state: 'online', lastOkAt: null, downSince: null, attempts: 0, rttMs: null, server: null, updated: false, recoveredAt: null };
const listeners = new Set<() => void>();
const reconnectListeners = new Set<() => void>();
let failures = 0;
/** 最近一次收到服务器回应的时间（每个请求都会更新，不通知页面；断开时记成「数据截至」） */
let lastContact: number | null = null;
let probing: Promise<boolean> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let rqSetOnline: ((online: boolean) => void) | null = null;
/**
 * 断网信号的序号：请求发不出去、网卡断了、检查问不到，各加一。页面请求发出去时记下当时的序号，
 * 回来时序号已经变了，说明它是信号以前发出去的：在「检查中 / 断了」的时候不拿它当连上了的证据——
 * 断网时还在路上的回应可能这时才送到，当成连上会把计数清零、取消重试，要等 60 秒的心跳才发现断了。
 */
let signalSeq = 0;
let started = false;

function set(patch: Partial<ConnectionSnapshot>) {
  snap = { ...snap, ...patch };
  listeners.forEach((fn) => fn());
}

const jitter = (ms: number) => Math.round(ms * (0.7 + Math.random() * 0.6));

function scheduleRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  const delay = jitter(RETRY_DELAYS_MS[Math.min(snap.attempts, RETRY_DELAYS_MS.length - 1)]!);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void probe();
  }, delay);
}

function markReachable(reply?: PingReply, rttMs?: number) {
  failures = 0;
  const now = Date.now();
  lastContact = now;
  const wasOffline = snap.state === 'offline';
  const patch: Partial<ConnectionSnapshot> = { state: 'online', lastOkAt: now, attempts: 0, downSince: null };
  if (reply) {
    patch.server = { version: reply.version, commit: reply.commit, client: reply.client };
    if (rttMs !== undefined) patch.rttMs = rttMs;
    if (!snap.updated && reply.client && PAGE_ENTRY && reply.client !== PAGE_ENTRY) {
      patch.updated = true;
      noteProblem('update', `系统已更新到 ${reply.version}（这一页还是更新前打开的）`);
    }
  }
  if (wasOffline) {
    patch.recoveredAt = now;
    const downFor = snap.downSince ? Math.round((now - snap.downSince) / 1000) : 0;
    noteProblem('online', `网络恢复了（断了约 ${downFor} 秒）`);
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  set(patch);
  if (wasOffline) {
    // 错开一点再让页面重新取数据、查回待确认（几十台终端同时恢复时不一起涌进来）
    setTimeout(() => {
      if (snap.state !== 'online') return;
      rqSetOnline?.(true);
      reconnectListeners.forEach((fn) => fn());
    }, Math.random() * RECONNECT_SPREAD_MS);
  }
}

function markUnreachable() {
  signalSeq += 1;
  failures += 1;
  if (failures >= 2 && snap.state !== 'offline') {
    set({ state: 'offline', downSince: lastContact ?? Date.now(), attempts: 0 });
    rqSetOnline?.(false);
    noteProblem('offline', '连不上服务器（网络断了或很慢）');
  } else if (snap.state === 'offline') {
    set({ attempts: snap.attempts + 1 });
  } else {
    set({ state: 'checking' });
  }
  scheduleRetry();
}

/**
 * 现在问一次服务器（同时只问一次，几处一起叫共用一个结果）。
 * fresh：断网、恢复、请求发不出去这几个信号之后，要的是信号以后的答案。这时还在路上的那一次是信号以前发出去的，
 * 等它回来再问一次。不然它在断网以后才回来、还是成功的话，会把断网吞掉，要等 60 秒的心跳才发现（8.1.5）。
 */
export function probe(opts: { fresh?: boolean } = {}): Promise<boolean> {
  if (probing) return opts.fresh ? probing.then(() => probe()) : probing;
  probing = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const started = performance.now();
    try {
      const res = await fetch('/api/ping', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      const reply = res.ok ? ((await res.json()) as PingReply) : null;
      if (!reply?.ok) throw new Error(`ping ${res.status}`);
      markReachable(reply, Math.round(performance.now() - started));
      return true;
    } catch {
      markUnreachable();
      return false;
    } finally {
      clearTimeout(timer);
      probing = null;
    }
  })();
  return probing;
}

/** 页面请求发出去时记下的断网信号序号（交给 noteResponse） */
export const requestSeq = (): number => signalSeq;

/**
 * 请求收到了服务器的回应（任何状态码，只要是服务器回的）。sentSeq：发出去时的 requestSeq()；
 * 发出去以后又有过断网信号的，在「检查中 / 断了」时不算连上（见 signalSeq），等下一次检查。
 */
export function noteResponse(sentSeq?: number): void {
  if (snap.state === 'online') {
    lastContact = Date.now();
    return;
  }
  if (sentSeq !== undefined && sentSeq !== signalSeq) return;
  markReachable();
}

/** 最近一次收到服务器回应的时间（「网络与同步」页显示） */
export const lastContactAt = (): number | null => lastContact;

/** 请求发不出去、超时、网关说连不上后面：马上问一次服务器 */
export function noteNetworkFailure(): void {
  signalSeq += 1;
  if (snap.state === 'online') set({ state: 'checking' });
  void probe({ fresh: true });
}

/**
 * 发写请求之前：已经判定断了的，当场再问一次（最多等 5 秒）；问不到就不发（调用方明确告诉员工这次没发出去）。
 * 在线或正在确认时照常发，交给请求自己的超时与「结果待确认」。
 */
export async function ensureReachable(): Promise<boolean> {
  if (snap.state !== 'offline') return true;
  return probe();
}

export const connectionSnapshot = (): ConnectionSnapshot => snap;

export function useConnection(): ConnectionSnapshot {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => snap,
  );
}

/** 网络恢复（页面开始重新取数据）时叫一下 */
export function onReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}

/** 「网络与同步」页的「重新查回」：不等网络恢复，现在就让各处待确认的再查一次 */
export function requestRecheck(): void {
  reconnectListeners.forEach((fn) => fn());
}

/** 每次网络恢复加一：放进 effect 的依赖里，恢复后重跑（例如重新查回待确认的） */
export function useReconnectTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => onReconnect(() => setTick((n) => n + 1)), []);
  return tick;
}

/** 开始看连接（只做一次）：接管 React Query 的在线判断，听网卡、切回页面，前台时每 60 秒问一次 */
export function startConnectionWatch(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  onlineManager.setEventListener((setOnline) => {
    rqSetOnline = setOnline;
    setOnline(snap.state !== 'offline');
    return () => {
      rqSetOnline = null;
    };
  });
  window.addEventListener('online', () => void probe({ fresh: true }));
  window.addEventListener('offline', () => {
    signalSeq += 1;
    if (snap.state === 'online') set({ state: 'checking' });
    void probe({ fresh: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (snap.state !== 'online' || !lastContact || Date.now() - lastContact > 30_000)) void probe();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && snap.state === 'online') void probe();
  }, HEARTBEAT_MS);
  // 打开页面先问一次：拿到服务器版本，顺带确认连得上
  void probe();
}
