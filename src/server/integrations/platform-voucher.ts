// 平台验券（docs/INTEGRATIONS_V8021.md 第 3 节）：美团团购、抖音来客各一个适配器，验券即核销。
// 8.0.21 只有接口与模拟实现（CW22）；正式实现等平台应用联调时做。
// 模拟按券码尾号给结果（只在开发、测试实例里用，见 config.ts）：
//   · …0000 券不存在或已使用；
//   · …2222 两份（面值 ¥199 × 2）；其余一份：美团面值 ¥99.00、应结 ¥92.00，抖音面值 ¥88.00、应结 ¥82.00；
//   · …9999 已过了能撤销的时间（撤销失败）；
//   · …7777 平台对账单上没有这一张（模拟「系统有、平台没有」）。
// 对账单（bill）是模拟在这个进程里核销过的（重启就没了）。

import { modeOf, type IntegrationsConfig } from './config';

export type VoucherPlatform = 'meituan' | 'douyin';
export interface VoucherInfo {
  dealName: string;
  faceCents: number;
  settleCents: number;
  quantity: number;
}
export interface VoucherBillLine {
  code: string;
  verifyNo: string;
  dealName: string;
  faceCents: number;
  settleCents: number;
}
export interface PlatformVoucher {
  mode: 'mock' | 'live';
  prepare(a: { platform: VoucherPlatform; code: string }): Promise<{ ok: true; info: VoucherInfo } | { ok: false; error: string }>;
  verify(a: { platform: VoucherPlatform; code: string; quantity: number; outNo: string; businessDate: string }): Promise<{ status: 'verified'; verifyNo: string } | { status: 'failed' | 'unknown'; error: string }>;
  cancel(a: { platform: VoucherPlatform; code: string; verifyNo: string }): Promise<{ ok: boolean; error?: string }>;
  bill(a: { platform: VoucherPlatform; businessDate: string }): Promise<VoucherBillLine[]>;
}

const mockVerified = new Map<string, VoucherBillLine & { platform: VoucherPlatform; businessDate: string; cancelled: boolean }>();

function mockInfo(platform: VoucherPlatform, code: string): VoucherInfo | null {
  if (code.endsWith('0000')) return null;
  if (code.endsWith('2222')) return { dealName: '双人浴资（模拟）', faceCents: 39_800, settleCents: 36_600, quantity: 2 };
  return platform === 'meituan' ? { dealName: '单人浴资（模拟）', faceCents: 9_900, settleCents: 9_200, quantity: 1 } : { dealName: '单人浴资·抖音（模拟）', faceCents: 8_800, settleCents: 8_200, quantity: 1 };
}

export const mockPlatformVoucher: PlatformVoucher = {
  mode: 'mock',
  async prepare({ platform, code }) {
    const k = `${platform}:${code}`;
    const info = mockInfo(platform, code);
    if (!info || (mockVerified.has(k) && !mockVerified.get(k)!.cancelled)) return { ok: false, error: '券不存在或已经用过（模拟）' };
    return { ok: true, info };
  },
  async verify({ platform, code, outNo, businessDate }) {
    const k = `${platform}:${code}`;
    const info = mockInfo(platform, code);
    if (!info || (mockVerified.has(k) && !mockVerified.get(k)!.cancelled)) return { status: 'failed', error: '券不存在或已经用过（模拟）' };
    const verifyNo = `MOCKV${outNo}`;
    mockVerified.set(k, { platform, code, verifyNo, dealName: info.dealName, faceCents: info.faceCents, settleCents: info.settleCents, businessDate, cancelled: false });
    return { status: 'verified', verifyNo };
  },
  async cancel({ platform, code }) {
    if (code.endsWith('9999')) return { ok: false, error: '已过了平台允许撤销的时间（模拟）' };
    const v = mockVerified.get(`${platform}:${code}`);
    if (v) v.cancelled = true;
    return { ok: true };
  },
  async bill({ platform, businessDate }) {
    return [...mockVerified.values()]
      .filter((v) => v.platform === platform && v.businessDate === businessDate && !v.cancelled && !v.code.endsWith('7777'))
      .map(({ code, verifyNo, dealName, faceCents, settleCents }) => ({ code, verifyNo, dealName, faceCents, settleCents }));
  },
};

/** 用例：在模拟的对账单上加一张（模拟「平台有、系统没有」） */
export function mockPlatformBillAdd(line: VoucherBillLine & { platform: VoucherPlatform; businessDate: string }) {
  mockVerified.set(`${line.platform}:${line.code}`, { ...line, cancelled: false });
}

export function platformVoucherAdapter(cfg: IntegrationsConfig): PlatformVoucher | null {
  return modeOf(cfg, 'platform_voucher') === 'mock' ? mockPlatformVoucher : null;
}
