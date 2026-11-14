// 付款码支付（B 扫 C，docs/INTEGRATIONS_V8021.md 第 2 节）：收银员扫客人的付款码。
// 8.0.21 只有接口与模拟实现（CW22）；正式实现（微信付款码支付、支付宝当面付）等商户号联调时做。
// 模拟按付款码的尾号给结果（只在开发、测试实例里用，见 config.ts）：
//   · …0000 余额不足（失败）；
//   · …1111 要客人输密码：第一次查询还在等，第二次查询成功；
//   · …2222 一直在等（之后撤单）；
//   · …3333 退款失败（付款照常成功）；
//   · 其余直接成功。
// 支付方单号：模拟的是 MOCK 加本店单号。

import { modeOf, type IntegrationsConfig } from './config';

export type PayProvider = 'wechat' | 'alipay';
export interface PayResult {
  status: 'paid' | 'paying' | 'failed' | 'closed' | 'unknown';
  providerTradeNo?: string;
  paidAt?: Date;
  error?: string;
}
export interface RefundResult {
  status: 'done' | 'failed';
  providerRefundNo?: string;
  error?: string;
}
export interface PayTerminal {
  mode: 'mock' | 'live';
  pay(a: { provider: PayProvider; outTradeNo: string; amountCents: number; authCode: string; subject: string }): Promise<PayResult>;
  query(a: { provider: PayProvider; outTradeNo: string }): Promise<PayResult>;
  close(a: { provider: PayProvider; outTradeNo: string }): Promise<{ closed: boolean; error?: string }>;
  refund(a: { provider: PayProvider; outTradeNo: string; outRefundNo: string; amountCents: number; totalCents: number; reason: string }): Promise<RefundResult>;
}

interface MockState {
  tail: string;
  queries: number;
  closed: boolean;
}
const mockState = new Map<string, MockState>();

export const mockPayTerminal: PayTerminal = {
  mode: 'mock',
  async pay({ outTradeNo, authCode }) {
    const tail = authCode.slice(-4);
    mockState.set(outTradeNo, { tail, queries: 0, closed: false });
    if (tail === '0000') return { status: 'failed', error: '余额不足（模拟）' };
    if (tail === '1111' || tail === '2222') return { status: 'paying' };
    return { status: 'paid', providerTradeNo: `MOCK${outTradeNo}`, paidAt: new Date() };
  },
  async query({ outTradeNo }) {
    const s = mockState.get(outTradeNo);
    // 进程重启过（模拟的状态只在内存里）：按查不到处理
    if (!s) return { status: 'unknown', error: '支付方查不到这笔（模拟的状态已经没了）' };
    if (s.closed) return { status: 'closed' };
    s.queries += 1;
    if (s.tail === '0000') return { status: 'failed', error: '余额不足（模拟）' };
    if (s.tail === '2222') return { status: 'paying' };
    if (s.tail === '1111' && s.queries < 2) return { status: 'paying' };
    return { status: 'paid', providerTradeNo: `MOCK${outTradeNo}`, paidAt: new Date() };
  },
  async close({ outTradeNo }) {
    const s = mockState.get(outTradeNo);
    if (s) s.closed = true;
    return { closed: true };
  },
  async refund({ outTradeNo, outRefundNo }) {
    const s = mockState.get(outTradeNo);
    if (s?.tail === '3333') return { status: 'failed', error: '退款失败（模拟）' };
    return { status: 'done', providerRefundNo: `MOCKR${outRefundNo}` };
  },
};

/** 现在能用的付款码支付：模拟的；正式的没接（等联调）、没配置的都是空 */
export function payTerminalAdapter(cfg: IntegrationsConfig): PayTerminal | null {
  return modeOf(cfg, 'pay_terminal') === 'mock' ? mockPayTerminal : null;
}
