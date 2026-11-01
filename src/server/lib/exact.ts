// 精确的有理数运算（v0.7.10）：旧账的公式、Excel 里存的数换成分与千分之一时用，全程不经过二进制浮点数
// （AGENTS.md「金额一律整数分，不用浮点数算钱」）。只在最后一步四舍五入（.5 远离 0）。

/** 有理数：分子 / 分母（已约分，分母 > 0） */
export interface Exact {
  readonly n: bigint;
  readonly d: bigint;
}

const abs = (x: bigint) => (x < 0n ? -x : x);

function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function make(n: bigint, d: bigint): Exact {
  if (d === 0n) throw new RangeError('除数为 0');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
}

/** 指数太大（如 1E+999）不算：Excel 里本来也存不下 */
const MAX_EXP = 400;
const DECIMAL = /^([-+]?)(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/;

/** 十进制写法（「-1924.04」「.5」「1.5E-3」）→ 精确值；不是数返回 null */
export function parseExact(s: string): Exact | null {
  const m = DECIMAL.exec(s.trim());
  if (!m) return null;
  const int = m[2] ?? '';
  const frac = m[3] ?? '';
  if (int === '' && frac === '') return null;
  const exp = (m[4] ? Number(m[4]) : 0) - frac.length;
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > MAX_EXP) return null;
  let n = BigInt(int + frac);
  if (m[1] === '-') n = -n;
  return exp >= 0 ? make(n * 10n ** BigInt(exp), 1n) : make(n, 10n ** BigInt(-exp));
}

export const exactInt = (n: number | bigint): Exact => ({ n: BigInt(n), d: 1n });
export const neg = (a: Exact): Exact => ({ n: -a.n, d: a.d });
export const add = (a: Exact, b: Exact): Exact => make(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Exact, b: Exact): Exact => make(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Exact, b: Exact): Exact => make(a.n * b.n, a.d * b.d);
/** 除以 0 抛 RangeError */
export const div = (a: Exact, b: Exact): Exact => make(a.n * b.d, a.d * b.n);
/** a < b */
export const lessThan = (a: Exact, b: Exact): boolean => a.n * b.d < b.n * a.d;

/** num / den 四舍五入到整数（.5 远离 0；den > 0） */
function roundDiv(num: bigint, den: bigint): bigint {
  const q = abs(num) / den;
  const r = abs(num) % den;
  const rounded = 2n * r >= den ? q + 1n : q;
  return num < 0n ? -rounded : rounded;
}

/** x × scale 四舍五入到整数：元 → 分用 100，数量 → 千分之一用 1000 */
export function roundScaled(x: Exact, scale: bigint): bigint {
  return roundDiv(x.n * scale, x.d);
}

/** 向 0 取整（Excel 日期序号取整天用） */
export const truncExact = (x: Exact): bigint => x.n / x.d;

/** 保留 digits 位有效数字（四舍五入，.5 远离 0）。Excel 存数与显示的精度是 15 位有效数字 */
export function toSignificant(x: Exact, digits: number): Exact {
  if (x.n === 0n) return x;
  const a = abs(x.n);
  const lo = 10n ** BigInt(digits - 1);
  const hi = 10n ** BigInt(digits);
  // |x| × 10^k 的整数部分落在 [10^(digits-1), 10^digits) 里
  const floorScaled = (k: number) => (k >= 0 ? (a * 10n ** BigInt(k)) / x.d : a / (x.d * 10n ** BigInt(-k)));
  let k = digits - 1 - (a.toString().length - x.d.toString().length);
  while (floorScaled(k) >= hi) k--;
  while (floorScaled(k) < lo) k++;
  return k >= 0 ? make(roundDiv(x.n * 10n ** BigInt(k), x.d), 10n ** BigInt(k)) : make(roundDiv(x.n, x.d * 10n ** BigInt(-k)) * 10n ** BigInt(-k), 1n);
}
