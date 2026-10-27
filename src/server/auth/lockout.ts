// 密码错误限流：登录与当场授权共用。同一账号 15 分钟内失败 5 次，锁定 5 分钟。
// 共用同一份计数：前台不能借「当场授权」弹窗反复试店总的密码。

import { AppError } from '../lib/errors';

const MAX_FAILURES = 5;
const failures = new Map<string, { count: number; first: number; lockedUntil: number }>();

export function checkLock(username: string) {
  const f = failures.get(username);
  if (f && f.lockedUntil > Date.now()) {
    const minutes = Math.ceil((f.lockedUntil - Date.now()) / 60_000);
    throw new AppError(429, 'LOGIN_LOCKED', `账号「${username}」密码错误次数过多，请 ${minutes} 分钟后再试或联系店主重置密码`);
  }
}

export function recordFailure(username: string) {
  const now = Date.now();
  const f = failures.get(username);
  if (!f || now - f.first > 15 * 60_000) {
    failures.set(username, { count: 1, first: now, lockedUntil: 0 });
    return;
  }
  f.count += 1;
  if (f.count >= MAX_FAILURES) f.lockedUntil = now + 5 * 60_000;
}

export function clearFailures(username: string) {
  failures.delete(username);
}
