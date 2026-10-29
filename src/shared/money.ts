// 金额统一以「分」为整数存储与计算，只在展示和输入时与「元」互转。

export type Cents = number;

const YUAN_PATTERN = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

/** 把用户输入的元（如 "128"、"99.5"、"1,280.00"）转成分；格式不合法时返回 null。 */
export function parseYuan(input: string): Cents | null {
  const text = input.trim().replace(/[,，\s]/g, '').replace(/^¥/, '');
  if (!text) return null;
  const match = YUAN_PATTERN.exec(text);
  if (!match) return null;
  const yuan = Number(match[1]);
  const fen = Number((match[2] ?? '').padEnd(2, '0'));
  return yuan * 100 + fen;
}

/** 分 → "1,280.00"（不带符号）。 */
export function formatAmount(cents: Cents): string {
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  return `${yuan.toLocaleString('en-US')}.${String(fen).padStart(2, '0')}`;
}

/** 分 → "¥1,280.00"，负数为 "-¥1,280.00"。 */
export function formatYuan(cents: Cents): string {
  return `${cents < 0 ? '-' : ''}¥${formatAmount(cents)}`;
}

/** 分 → 带正负号的变动金额："+¥100.00" / "−¥30.00" / "¥0.00"。 */
export function formatDelta(cents: Cents): string {
  if (cents === 0) return '¥0.00';
  return `${cents > 0 ? '+' : '−'}¥${formatAmount(cents)}`;
}

/** 分 → 输入框里使用的元字符串（"128" / "99.50"）。 */
export function centsToInput(cents: Cents): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function isSafeCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
