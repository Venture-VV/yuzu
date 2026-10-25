import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// 使用 Node 内置 scrypt，避免原生依赖，Apple Silicon 与 Linux 容器表现一致。
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = PARAMS;
  const key = await scrypt(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 密码规则：至少 8 位，同时包含字母和数字。返回 null 表示通过。 */
export function checkPasswordStrength(password: string): string | null {
  if (password.length < 8) return '密码至少 8 位';
  if (password.length > 72) return '密码最多 72 位';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return '密码需同时包含字母和数字';
  return null;
}

/** 生成便于口头告知的临时密码，如 "yuzu-4827-km"。 */
export function generateTempPassword(): string {
  const digits = String(randomBytes(2).readUInt16BE() % 10000).padStart(4, '0');
  const letters = Array.from(randomBytes(2), (b) => 'abcdefghjkmnpqrstuvwxyz'[b % 23]).join('');
  return `yuzu-${digits}-${letters}`;
}
