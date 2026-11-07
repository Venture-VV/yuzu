// 密码错误限流（Z4，店主 2026-11-07 按默认，8.0.1）：登录与当场授权共用。
//   · 按来源：同一来源 IP 10 分钟内失败 30 次，这个地址拦 15 分钟，任何账号都登不了；
//   · 按账号 + 来源：同一账号在同一来源 15 分钟内失败 5 次，这个账号在这个地址锁 5 分钟，别的地址照常。
//     原来只按账号计，正式服放到公网后，别人能反复把店主的账号锁住。
// 共用同一份计数：前台不能借「当场授权」弹窗反复试店总的密码。来源地址是 req.ip（反向代理后面按 TRUST_PROXY 算，8.0.0）。
// 只存在内存里，重启后清零（与原来一样）；过期的条目随手清掉，最多存 MAX_KEYS 条。

import { AppError } from '../lib/errors';

const ACCOUNT_MAX = 5;
const ACCOUNT_WINDOW_MS = 15 * 60_000;
const ACCOUNT_LOCK_MS = 5 * 60_000;
const SOURCE_MAX = 30;
const SOURCE_WINDOW_MS = 10 * 60_000;
const SOURCE_BLOCK_MS = 15 * 60_000;
const MAX_KEYS = 20_000;

interface Counter {
  count: number;
  first: number;
  lockedUntil: number;
}

/** 账号 + 来源 → 计数 */
const accounts = new Map<string, Counter>();
/** 来源 → 计数 */
const sources = new Map<string, Counter>();

const accountKey = (username: string, source: string) => `${source}\u0000${username}`;
const minutesLeft = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 60_000));

/** 记一次失败：窗口过了从 1 重新数；到上限就锁 */
function bump(map: Map<string, Counter>, key: string, now: number, max: number, windowMs: number, lockMs: number) {
  const c = map.get(key);
  if (!c || now - c.first > windowMs) {
    map.delete(key);
    map.set(key, { count: 1, first: now, lockedUntil: max <= 1 ? now + lockMs : 0 });
    prune(map, now, windowMs);
    return;
  }
  c.count += 1;
  if (c.count >= max) c.lockedUntil = now + lockMs;
}

/** 条目太多时先删窗口与锁都过了的，还多就从最早的删起（Map 按插入顺序） */
function prune(map: Map<string, Counter>, now: number, windowMs: number) {
  if (map.size <= MAX_KEYS) return;
  for (const [k, c] of map) if (now - c.first > windowMs && c.lockedUntil <= now) map.delete(k);
  for (const k of map.keys()) {
    if (map.size <= MAX_KEYS) break;
    map.delete(k);
  }
}

/** 登录、当场授权核对密码之前：这个来源被拦了，或这个账号在这个来源锁着，直接拒绝（不核对密码） */
export function checkLock(username: string, source: string) {
  const now = Date.now();
  const s = sources.get(source);
  if (s && s.lockedUntil > now) {
    throw new AppError(429, 'LOGIN_SOURCE_BLOCKED', `这台设备登录失败的次数太多，请 ${minutesLeft(s.lockedUntil, now)} 分钟后再试；一直登不上请找店主`);
  }
  const a = accounts.get(accountKey(username, source));
  if (a && a.lockedUntil > now) {
    throw new AppError(429, 'LOGIN_LOCKED', `账号「${username}」密码错误次数过多，请 ${minutesLeft(a.lockedUntil, now)} 分钟后再试或联系店主重置密码`);
  }
}

/** 密码错、账号不存在或已停用：账号 + 来源、来源各记一次 */
export function recordFailure(username: string, source: string) {
  const now = Date.now();
  bump(accounts, accountKey(username, source), now, ACCOUNT_MAX, ACCOUNT_WINDOW_MS, ACCOUNT_LOCK_MS);
  bump(sources, source, now, SOURCE_MAX, SOURCE_WINDOW_MS, SOURCE_BLOCK_MS);
}

/** 登录成功：清掉这个账号在这个来源的计数（来源的计数不清：别的账号在这台设备上试错的照样算） */
export function clearFailures(username: string, source: string) {
  accounts.delete(accountKey(username, source));
}

/** 只给测试用：清空所有计数 */
export function resetLoginThrottle() {
  accounts.clear();
  sources.clear();
}
