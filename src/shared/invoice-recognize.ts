// 8.0.21 发票识别（docs/FINANCE_V8021.md 第 2 节，CW-A / CW1）：浏览器本机读二维码、读文字，结果只是填进表单，人核对后才保存。
// 这里是纯函数（前端识别、单元测试共用），不碰图片。

export const INVOICE_ENTRY_METHODS = ['manual', 'qr', 'ocr'] as const;
export type InvoiceEntryMethod = (typeof INVOICE_ENTRY_METHODS)[number];
export const INVOICE_ENTRY_LABELS: Record<InvoiceEntryMethod, string> = { manual: '手填', qr: '二维码识别', ocr: '文字识别' };

export interface RecognizedInvoice {
  method: 'qr' | 'ocr';
  /** 发票号码：老票 8 位，数电票 20 位 */
  invoiceNo?: string;
  /** 发票代码（老票 10 或 12 位；数电票没有） */
  invoiceCode?: string;
  /** YYYY-MM-DD */
  invoiceDate?: string;
  /** 不含税金额（二维码里只有这一个金额） */
  amountExTaxCents?: number;
  /** 价税合计 */
  totalCents?: number;
  taxCents?: number;
  /** 销售方名称（开票方） */
  issuerName?: string;
  issuerTaxId?: string;
  /** 从票种代码推出来的：专票 / 普票 */
  kindHint?: 'special' | 'normal';
  /** 数电票（全面数字化的电子发票） */
  digital?: boolean;
}

/** 二维码里的票种代码 → 专票 / 普票（认不出的不猜） */
const SPECIAL_CODES = new Set(['01', '08', '31']);
const NORMAL_CODES = new Set(['04', '10', '11', '14', '32']);
const DIGITAL_CODES = new Set(['31', '32']);

/** 「1,234.50」→ 123450 分；不是两位以内小数的金额返回 null（不用浮点数） */
export function yuanTextToCents(raw: string): number | null {
  const s = raw.replace(/[,，\s¥￥]/g, '');
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

function isRealDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100;
}
const dateText = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * 增值税发票（含数电票）票面左上角的二维码：逗号分隔——
 * 版本(01), 票种代码, 发票代码, 发票号码, 不含税金额, 开票日期(YYYYMMDD), 校验码, 随机串…
 * 数电票发票代码为空、号码 20 位。认不出返回 null。
 */
export function parseInvoiceQr(raw: string): RecognizedInvoice | null {
  const parts = raw.trim().split(/[,，]/).map((p) => p.trim());
  if (parts.length < 6 || parts[0] !== '01') return null;
  const [, kindCode = '', code = '', no = '', amount = '', date = ''] = parts;
  if (!/^(\d{8}|\d{20})$/.test(no)) return null;
  if (code && !/^\d{10,12}$/.test(code)) return null;
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(date);
  if (!dm || !isRealDate(Number(dm[1]), Number(dm[2]), Number(dm[3]))) return null;
  const out: RecognizedInvoice = { method: 'qr', invoiceNo: no, invoiceDate: dateText(Number(dm[1]), Number(dm[2]), Number(dm[3])) };
  if (code) out.invoiceCode = code;
  const cents = amount ? yuanTextToCents(amount) : null;
  if (cents !== null) out.amountExTaxCents = cents;
  if (SPECIAL_CODES.has(kindCode)) out.kindHint = 'special';
  else if (NORMAL_CODES.has(kindCode)) out.kindHint = 'normal';
  if (DIGITAL_CODES.has(kindCode) || (no.length === 20 && !code)) out.digital = true;
  return out;
}

const MONEY = String.raw`(\d[\d,]{0,15}\.\d{2})`;

/**
 * 票面文字（PDF 里取出来的文字，或本机文字识别的结果）：按版式找发票号码、开票日期、价税合计、合计金额与税额、销售方名称与税号。
 * 找不到的不填；什么都没找到返回 null。
 */
export function parseInvoiceText(text: string): RecognizedInvoice | null {
  // 文字识别常把字拆开：去掉字与字之间的空白再找；冒号统一成半角
  const flat = text.replace(/：/g, ':').replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/[ \t　]+/g, '');
  const out: RecognizedInvoice = { method: 'ocr' };
  const no = /发票号码:?(\d{20}|\d{8})(?!\d)/.exec(flat);
  if (no) out.invoiceNo = no[1]!;
  const code = /发票代码:?(\d{10,12})(?!\d)/.exec(flat);
  if (code) out.invoiceCode = code[1]!;
  const date = /开票日期:?(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(flat) ?? /开票日期:?(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(flat);
  if (date && isRealDate(Number(date[1]), Number(date[2]), Number(date[3]))) out.invoiceDate = dateText(Number(date[1]), Number(date[2]), Number(date[3]));
  const total = new RegExp(String.raw`\(小写\)[¥￥]?${MONEY}`).exec(flat) ?? new RegExp(String.raw`价税合计[^¥￥\d]*?(?:[一-龥]+)?[¥￥]${MONEY}`).exec(flat);
  if (total) {
    const c = yuanTextToCents(total[1]!);
    if (c !== null) out.totalCents = c;
  }
  // 「合计 ¥100.00 ¥6.00」（不是「价税合计」）：不含税金额与税额
  const sums = new RegExp(String.raw`(?<!价税)合计[¥￥]${MONEY}[¥￥]${MONEY}`).exec(flat);
  if (sums) {
    const ex = yuanTextToCents(sums[1]!);
    const tax = yuanTextToCents(sums[2]!);
    if (ex !== null) out.amountExTaxCents = ex;
    if (tax !== null) out.taxCents = tax;
    if (out.totalCents === undefined && ex !== null && tax !== null) out.totalCents = ex + tax;
  }
  // 名称、税号：第一个是购买方，第二个是销售方（只找到一个的分不清，不填）
  const names = [...text.replace(/：/g, ':').matchAll(/名\s*称\s*:\s*([^\n:]{2,60}?)(?=\s{2,}|\s*(?:统一社会信用代码|纳税人识别号)|\n|$)/g)].map((m) => m[1]!.trim());
  if (names.length >= 2) out.issuerName = names[1]!.slice(0, 60);
  const ids = [...flat.matchAll(/(?:统一社会信用代码\/纳税人识别号|纳税人识别号):?([0-9A-Z]{15,20})(?![0-9A-Z])/g)].map((m) => m[1]!);
  if (ids.length >= 2) out.issuerTaxId = ids[1]!;
  if (/电子发票\(增值税专用发票\)|增值税专用发票/.test(flat)) out.kindHint = 'special';
  else if (/电子发票\(普通发票\)|增值税(?:电子)?普通发票/.test(flat)) out.kindHint = 'normal';
  if (/电子发票\((?:增值税专用|普通)发票\)/.test(flat) || out.invoiceNo?.length === 20) out.digital = true;
  const found = out.invoiceNo || out.invoiceDate || out.totalCents !== undefined;
  return found ? out : null;
}

/** 按税率把不含税金额换成价税合计与税额（四舍五入到分；二维码只有不含税金额时用） */
export function totalFromExTax(amountExTaxCents: number, taxRateBp: number): { totalCents: number; taxCents: number } {
  const taxCents = Math.round((amountExTaxCents * taxRateBp) / 10000);
  return { totalCents: amountExTaxCents + taxCents, taxCents };
}
