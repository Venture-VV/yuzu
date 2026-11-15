// 8.0.21 发票识别（docs/FINANCE_V8021.md 第 2 节，CW-A）：二维码与票面文字的解析（纯函数）
import { describe, expect, it } from 'vitest';
import { parseInvoiceQr, parseInvoiceText, totalFromExTax, yuanTextToCents } from '../src/shared/invoice-recognize';

describe('发票二维码', () => {
  it('老版专票：代码 + 8 位号码、不含税金额、开票日', () => {
    expect(parseInvoiceQr('01,01,4400191130,12345678,1000.00,20261102,12345678901234567890,A1B2,')).toEqual({
      method: 'qr',
      invoiceNo: '12345678',
      invoiceCode: '4400191130',
      invoiceDate: '2026-11-02',
      amountExTaxCents: 100000,
      kindHint: 'special',
    });
  });
  it('数电普票：没有代码、20 位号码', () => {
    expect(parseInvoiceQr('01,32,,26442000000123456789,88.5,20261113,,E3F4')).toEqual({
      method: 'qr',
      invoiceNo: '26442000000123456789',
      invoiceDate: '2026-11-13',
      amountExTaxCents: 8850,
      kindHint: 'normal',
      digital: true,
    });
  });
  it('认不出的：不是 01 开头、号码位数不对、日期不存在', () => {
    expect(parseInvoiceQr('https://example.com/x')).toBeNull();
    expect(parseInvoiceQr('02,01,4400191130,12345678,1.00,20261102')).toBeNull();
    expect(parseInvoiceQr('01,01,4400191130,1234567,1.00,20261102')).toBeNull();
    expect(parseInvoiceQr('01,01,4400191130,12345678,1.00,20260230')).toBeNull();
  });
});

describe('票面文字', () => {
  it('数电票 PDF 取出来的文字：号码、日期、价税合计、合计与税额、销售方', () => {
    const text = [
      '电子发票（增值税专用发票）',
      '发票号码：26442000000123456789',
      '开票日期：2026年11月02日',
      '购买方信息 名称：浴族城市汤泉有限公司  统一社会信用代码/纳税人识别号：91440300MA5XXXXX1A',
      '销售方信息 名称：鲜果供应链有限公司  统一社会信用代码/纳税人识别号：91440300MA5YYYYY2B',
      '合 计 ¥1,000.00 ¥130.00',
      '价税合计（大写） 壹仟壹佰叁拾圆整 （小写）¥1,130.00',
    ].join('\n');
    expect(parseInvoiceText(text)).toEqual({
      method: 'ocr',
      invoiceNo: '26442000000123456789',
      invoiceDate: '2026-11-02',
      totalCents: 113000,
      amountExTaxCents: 100000,
      taxCents: 13000,
      issuerName: '鲜果供应链有限公司',
      issuerTaxId: '91440300MA5YYYYY2B',
      kindHint: 'special',
      digital: true,
    });
  });
  it('文字识别把字拆开了也认；只有一个名称时不猜开票方', () => {
    const r = parseInvoiceText('发 票 号 码 : 1 2 3 4 5 6 7 8\n开票日期:2026年1月5日\n名称:某某公司\n价税合计 ( 小写 ) ￥ 56.00');
    expect(r).toMatchObject({ invoiceNo: '12345678', invoiceDate: '2026-01-05', totalCents: 5600 });
    expect(r?.issuerName).toBeUndefined();
  });
  it('什么都没找到返回空', () => {
    expect(parseInvoiceText('一张小票\n谢谢惠顾')).toBeNull();
  });
});

describe('金额', () => {
  it('不用浮点数：元转分、不含税换价税合计', () => {
    expect(yuanTextToCents('1,234.5')).toBe(123450);
    expect(yuanTextToCents('0.07')).toBe(7);
    expect(yuanTextToCents('1.234')).toBeNull();
    expect(totalFromExTax(100000, 1300)).toEqual({ totalCents: 113000, taxCents: 13000 });
    expect(totalFromExTax(8850, 600)).toEqual({ totalCents: 9381, taxCents: 531 });
  });
});
