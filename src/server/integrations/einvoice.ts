// 开票服务商（docs/INTEGRATIONS_V8021.md 第 5 节）：开票申请「交给服务商开」时在事务外调用。
// 8.0.21 只有接口与模拟实现（CW22）：模拟直接给一个假号码（99 开头的 20 位）与一页写着「模拟」的 PDF；正式实现等数电票服务商的账号联调。

import { modeOf, type IntegrationsConfig } from './config';
import { mockPdf } from './mock-pdf';

export interface EInvoiceRequest {
  requestId: number;
  requestNo: string;
  titleType: 'personal' | 'company';
  title: string;
  taxNo: string;
  kind: 'normal' | 'special';
  amountCents: number;
}
export interface EInvoiceResult {
  invoiceNo: string;
  invoiceDate: string;
  pdf: Buffer;
  providerRef: string;
}
export interface EInvoice {
  provider: string;
  mode: 'mock' | 'live';
  issue(r: EInvoiceRequest, today: string): Promise<EInvoiceResult>;
}

const yuan = (cents: number) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

export const mockEInvoice: EInvoice = {
  provider: 'mock',
  mode: 'mock',
  async issue(r, today) {
    const invoiceNo = `99${today.replaceAll('-', '')}${String(r.requestId).padStart(10, '0')}`;
    const pdf = mockPdf([
      'MOCK E-INVOICE - NOT A REAL INVOICE',
      'This file was produced by the yuzu test adapter (INTEGRATIONS_MOCK=true).',
      '',
      `Invoice No: ${invoiceNo}`,
      `Date: ${today}`,
      `Kind: ${r.kind === 'special' ? 'VAT special' : 'VAT normal'}`,
      `Amount: CNY ${yuan(r.amountCents)}`,
      `Request: ${r.requestNo}`,
    ]);
    return { invoiceNo, invoiceDate: today, pdf, providerRef: `MOCK-${r.requestNo}` };
  },
};

/** 现在能用的开票服务商：模拟的；正式的没接（等联调）、没配置的都是空 */
export function eInvoiceAdapter(cfg: IntegrationsConfig): EInvoice | null {
  return modeOf(cfg, 'einvoice') === 'mock' ? mockEInvoice : null;
}
