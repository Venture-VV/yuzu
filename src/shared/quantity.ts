// 物资数量统一以「千分之一库存单位」(milli) 的整数存储与计算，与金额按分处理同理，避免浮点误差。
// 例：800 双 → 800000；1.25 kg → 1250。
// 采购单位换算同样用千分之一精度：1 箱 = 100 双 → factorMilli = 100000。

export type Milli = number;
export const MILLI = 1000;

const QTY_PATTERN = /^(\d{1,9})(?:\.(\d{1,3}))?$/;

/** 把输入的数量文本转成 milli；小数位超过 decimals 或格式不对时返回 null。 */
export function parseQty(input: string, decimals = 3): Milli | null {
  const text = input.trim().replace(/[,，\s]/g, '');
  if (!text) return null;
  const m = QTY_PATTERN.exec(text);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.replace(/0+$/, '').length > decimals) return null;
  return Number(m[1]) * MILLI + Number(frac.padEnd(3, '0'));
}

/** milli → "1,280" / "1.25"（去掉多余的 0）。 */
export function formatQty(milli: Milli): string {
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  const int = Math.floor(abs / MILLI);
  const frac = String(abs % MILLI).padStart(3, '0').replace(/0+$/, '');
  return `${sign}${int.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

/** milli → 输入框里的文本（不带千分位）。 */
export function qtyToInput(milli: Milli): string {
  return formatQty(milli).replace(/,/g, '');
}

/** 数量是否符合物料允许的小数位 */
export function fitsDecimals(milli: Milli, decimals: number): boolean {
  return milli % 10 ** (3 - decimals) === 0;
}

/** 采购单位数量 → 库存单位数量；结果超出千分之一精度时返回 null（例如 1/3 箱）。 */
export function toBaseQty(purchaseQtyMilli: Milli, factorMilli: Milli): Milli | null {
  const product = BigInt(purchaseQtyMilli) * BigInt(factorMilli);
  if (product % 1000n !== 0n) return null;
  return Number(product / 1000n);
}

/** 库存单位数量 → 采购单位数量（仅在整除时返回，用于「= 8 箱」的提示）。 */
export function toPurchaseQty(baseMilli: Milli, factorMilli: Milli): Milli | null {
  const scaled = BigInt(baseMilli) * 1000n;
  if (scaled % BigInt(factorMilli) !== 0n) return null;
  return Number(scaled / BigInt(factorMilli));
}

/** 「9 箱 + 67 双」：按整包装拆分，不足一个包装时返回 null（用于提示，不用于计算） */
export function packText(baseMilli: Milli, factorMilli: Milli, purchaseUnit: string, inventoryUnit: string): string | null {
  if (purchaseUnit === inventoryUnit || factorMilli <= MILLI || baseMilli < factorMilli) return null;
  const packs = Math.floor(baseMilli / factorMilli);
  const rest = baseMilli - packs * factorMilli;
  return rest === 0 ? `${packs} ${purchaseUnit}` : `${packs} ${purchaseUnit} + ${formatQty(rest)} ${inventoryUnit}`;
}

/**
 * 行金额（分）= 库存单位数量 × 每采购单位价格 ÷ 换算，四舍五入到分。
 * 用整数有理数计算，例：800 双 × 180 元/箱 ÷ 100 双/箱 = 1,440.00 元。
 */
export function lineAmountCents(baseMilli: Milli, priceCentsPerPurchaseUnit: number, factorMilli: Milli): number {
  const num = BigInt(baseMilli) * BigInt(priceCentsPerPurchaseUnit);
  const den = BigInt(factorMilli);
  const q = num / den;
  const r = num % den;
  return Number(r * 2n >= den ? q + 1n : q);
}

/** 价格变化百分比，保留两位小数（同规格、同单位才可比较）。 */
export function priceChangePercent(oldCents: number, newCents: number): number | null {
  if (oldCents <= 0) return null;
  return Math.round(((newCents - oldCents) / oldCents) * 10000) / 100;
}

/** 「1 箱 = 100 双」 */
export function conversionText(purchaseUnit: string, factorMilli: Milli, inventoryUnit: string): string {
  return `1 ${purchaseUnit} = ${formatQty(factorMilli)} ${inventoryUnit}`;
}
