// 网关会话（MP11）：小程序登录后发给小程序，里面只有 openid 与到期时间，不放手机号；HMAC-SHA256 签名，密钥只在网关。
// 格式：v1.<payload base64url>.<签名 base64url>

import { createHmac, timingSafeEqual } from 'node:crypto';

const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(`v1.${payload}`).digest('base64url');

export function issueSession(secret: string, openid: string, days: number, now = Date.now()): { token: string; expiresAt: string } {
  const exp = Math.floor(now / 1000) + days * 86_400;
  const payload = Buffer.from(JSON.stringify({ o: openid, e: exp })).toString('base64url');
  return { token: `v1.${payload}.${sign(secret, payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** 签名对、没过期返回 openid；否则 null */
export function verifySession(secret: string, token: string, now = Date.now()): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, sig] = parts as [string, string, string];
  const expected = Buffer.from(sign(secret, payload));
  const got = Buffer.from(sig);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const { o, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { o?: unknown; e?: unknown };
    if (typeof o !== 'string' || typeof e !== 'number' || e * 1000 <= now) return null;
    return o;
  } catch {
    return null;
  }
}
