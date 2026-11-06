// 柚子饭堂的小工具：接口、本机存储、离线生成饭卡码（WebCrypto）、提示音。

import { base32, CODE_MAC_LENGTH, codeMessage, codeStepOf, formatCanteenCode, type CanteenMe } from '@shared/canteen';

// ── 接口 ──

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** 没连上门店系统、超时，或服务器出错（结果不确定：可能已经办好了） */
export class NetworkError extends Error {
  readonly code = 'NETWORK';
  constructor(message = '网络不太好，连不上门店系统') {
    super(message);
  }
}

export async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, timeoutMs = 12_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 500 && res.status !== 503) throw new NetworkError('门店系统出了点问题，这一下可能办好了，也可能没有');
  const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? '出了点问题，请再试一次', e?.details);
  }
  return data as T;
}

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : '出了点问题，请再试一次');

// ── 本机存储（读写都可能失败：隐私模式、存储满了） ──

export function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** 写入并读回核对：写不进去返回 false */
export function writeJson(key: string, value: unknown): boolean {
  try {
    const raw = JSON.stringify(value);
    localStorage.setItem(key, raw);
    return localStorage.getItem(key) === raw;
  } catch {
    return false;
  }
}

export function removeKey(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

const ME_KEY = 'yuzu.canteen.me.v1';

/** 上次联网拿到的「我」：离线时用它亮码；offsetMs = 服务器时间 − 手机时间 */
export interface CachedMe {
  me: CanteenMe;
  offsetMs: number;
  savedAt: number;
}

export const loadCachedMe = () => readJson<CachedMe>(ME_KEY);
/**
 * 记下「我」：刚从门店系统拿到的（serverTime 是此刻）按它算时间差；只在本机改了一点（例如换头像）时传原来的时间差，
 * 不能拿旧的 serverTime 重算（否则过了几分钟再换头像，饭卡码就慢了几分钟、扫的时候提示过期）
 */
export function saveMe(me: CanteenMe, keepOffsetMs?: number): CachedMe {
  const cached = { me, offsetMs: keepOffsetMs ?? Date.parse(me.serverTime) - Date.now(), savedAt: Date.now() };
  writeJson(ME_KEY, cached);
  return cached;
}
export const clearCachedMe = () => removeKey(ME_KEY);

// ── 饭卡码（手机上离线生成，与服务端 src/server/modules/canteen/code.ts 同一个算法） ──

const keys = new Map<string, Promise<CryptoKey>>();

function importKey(b64url: string): Promise<CryptoKey> {
  let k = keys.get(b64url);
  if (!k) {
    const bin = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    k = crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keys.set(b64url, k);
  }
  return k;
}

export const secureContextOk = () => typeof crypto !== 'undefined' && !!crypto.subtle;

export async function makeCode(codeKey: string, employeeId: number, atMs: number): Promise<{ text: string; step: number }> {
  const step = codeStepOf(atMs);
  const sig = await crypto.subtle.sign('HMAC', await importKey(codeKey), new TextEncoder().encode(codeMessage(step)));
  return { text: formatCanteenCode(employeeId, step, base32(new Uint8Array(sig), CODE_MAC_LENGTH)), step };
}

// ── 提示音（负责人扫码：成功叮咚、已打过卡叮、出错嘟嘟） ──

let audio: AudioContext | null = null;
export function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    audio = null;
  }
}

export function beep(kind: 'ok' | 'already' | 'error' | 'queued') {
  if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 60 : kind === 'error' ? [80, 60, 80] : 40);
  if (!audio) return;
  const notes: Record<typeof kind, [number, number][]> = {
    ok: [
      [880, 0],
      [1320, 0.11],
    ],
    already: [[740, 0]],
    queued: [
      [660, 0],
      [660, 0.14],
    ],
    error: [
      [220, 0],
      [196, 0.16],
    ],
  };
  const now = audio.currentTime;
  for (const [freq, at] of notes[kind]) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = kind === 'error' ? 'square' : 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(kind === 'error' ? 0.08 : 0.2, now + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.16);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.18);
  }
}

// ── 时间的显示 ──

const hm = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const timeText = (iso: string) => hm.format(new Date(iso));

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function dayLabel(date: string, today: string): string {
  const diff = Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  return WEEK[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}
export const monthDay = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 门店此刻的「HH:MM」（按服务器时间差修正） */
export function storeNow(offsetMs: number): { date: string; minute: number } {
  const at = new Date(Date.now() + offsetMs);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '00';
  return { date: `${p('year')}-${p('month')}-${p('day')}`, minute: Number(p('hour')) * 60 + Number(p('minute')) };
}

export const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
        const r = (Math.random() * 16) | 0;
        return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
