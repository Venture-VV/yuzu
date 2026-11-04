// 门店 yuzu 里的微信支付（小程序线第二期 2a，docs/MP_RECHARGE.md 第 4 节）：凭据只放门店 yuzu 的 .env（MP17），网关一样都不放。
//   WXPAY_APPID、WXPAY_MCHID、WXPAY_SERIAL_NO（商户 API 证书序列号）、WXPAY_APIV3_KEY（32 个字符）、
//   WXPAY_PUBLIC_KEY_ID（PUB_KEY_ID_ 开头）、WXPAY_NOTIFY_URL（网关的 https://<域名>/v1/pay/notify），
//   以及两个证书文件：商户 API 证书私钥（apiclient_key.pem）、微信支付公钥（pub_key.pem），各给一种——
//   文件路径 WXPAY_PRIVATE_KEY_FILE / WXPAY_PUBLIC_KEY_FILE，或文件内容的 Base64（一行，放进 .env）WXPAY_PRIVATE_KEY_BASE64 / WXPAY_PUBLIC_KEY_BASE64。
// 一样都没配：线上充值不开（后台写「微信支付没有配好」）。配错了（只配了一部分、文件读不了、模拟开在别的环境）：线上充值也不开，
// 启动日志与后台都写原因；门店系统照常启动（不因为线上充值的配置停掉前台）。
// 模拟微信支付 MP_PAY_MOCK=true：只在 development、test 实例，其他环境不开，没有绕过开关；开了模拟就不能再配 WXPAY_*。

import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { AppEnv } from '../../config';
import { createMockWxPay, type MockWxPay } from './wxpay-mock';
import { createWxPayClient, type WxPayClient, type WxPayConfig } from './wxpay';

export interface PayRuntime {
  mode: 'real' | 'mock';
  config: WxPayConfig;
  client: WxPayClient;
  /** 模拟微信支付（只在 development、test）：「顾客付款」、造到账通知 */
  mock: MockWxPay | null;
}

const KEYS = ['WXPAY_APPID', 'WXPAY_MCHID', 'WXPAY_SERIAL_NO', 'WXPAY_APIV3_KEY', 'WXPAY_PUBLIC_KEY_ID', 'WXPAY_NOTIFY_URL'] as const;
/** 两个证书文件：给路径或给内容的 Base64，二选一 */
const PEMS = [
  ['WXPAY_PRIVATE_KEY_FILE', 'WXPAY_PRIVATE_KEY_BASE64'],
  ['WXPAY_PUBLIC_KEY_FILE', 'WXPAY_PUBLIC_KEY_BASE64'],
] as const;

/** 按环境变量建门店系统的微信支付；没配返回 null，配错抛错（buildMpApp 接住：不开线上充值、日志与后台写原因） */
export function loadPayRuntime(env: NodeJS.ProcessEnv, appEnv: AppEnv, instance?: string): PayRuntime | null {
  const v = (k: string) => env[k]?.trim() ?? '';
  const present = [...KEYS, ...PEMS.flat()].filter((k) => v(k));
  if (v('MP_PAY_MOCK') === 'true') {
    if (appEnv !== 'development' && appEnv !== 'test') throw new Error(`MP_PAY_MOCK=true 只能在 development、test 实例用（这里是 ${appEnv}）`);
    // 实例标识是正式服、影子运行、测试服（演练库）的也不开：只在演示库、本机开发
    if (instance && ['prod', 'shadow', 'test'].includes(instance)) throw new Error(`MP_PAY_MOCK=true 不能开在 ${instance} 实例上（只给演示库、本机开发）`);
    if (present.length) throw new Error('开了模拟微信支付（MP_PAY_MOCK=true）就不要再配 WXPAY_*');
    const mock = createMockWxPay();
    return { mode: 'mock', config: mock.config, client: mock.client, mock };
  }
  if (present.length === 0) return null;
  const missing = [...KEYS.filter((k) => !v(k)), ...PEMS.filter(([f, b]) => !v(f) && !v(b)).map(([f]) => `${f}（或 ${f.replace('_FILE', '_BASE64')}）`)];
  if (missing.length) throw new Error(`微信支付的配置不全，还缺 ${missing.join('、')}（一样都不配就是不开线上充值）`);
  if (!/^wx[0-9a-f]{16}$/.test(v('WXPAY_APPID'))) throw new Error('WXPAY_APPID 应为小程序的 AppID（wx 开头，18 个字符）');
  if (!/^[0-9]{6,12}$/.test(v('WXPAY_MCHID'))) throw new Error('WXPAY_MCHID 应为微信支付商户号（数字）');
  if (!/^[0-9A-Fa-f]{8,64}$/.test(v('WXPAY_SERIAL_NO'))) throw new Error('WXPAY_SERIAL_NO 应为商户 API 证书的序列号（十六进制）');
  if (Buffer.byteLength(v('WXPAY_APIV3_KEY'), 'utf8') !== 32) throw new Error('WXPAY_APIV3_KEY 应为 32 个字符（商户平台设置的 APIv3 密钥）');
  if (!/^PUB_KEY_ID_[0-9A-Za-z]+$/.test(v('WXPAY_PUBLIC_KEY_ID'))) throw new Error('WXPAY_PUBLIC_KEY_ID 应为 PUB_KEY_ID_ 开头的微信支付公钥编号');
  if (!/^https:\/\/[^/]+\/v1\/pay\/notify$/.test(v('WXPAY_NOTIFY_URL'))) throw new Error('WXPAY_NOTIFY_URL 应为网关的 https://<域名>/v1/pay/notify');
  /** 证书文件的内容：给了路径读文件，给了 Base64 就解出来；返回内容与用的是哪个变量 */
  const pem = ([file, b64]: readonly [string, string]): { text: string; key: string } => {
    if (v(file)) {
      try {
        return { text: readFileSync(v(file), 'utf8'), key: file };
      } catch {
        throw new Error(`${file} 指的文件读不了：${v(file)}`);
      }
    }
    return { text: Buffer.from(v(b64), 'base64').toString('utf8'), key: b64 };
  };
  const priv = pem(PEMS[0]);
  const pub = pem(PEMS[1]);
  let merchantPrivateKey;
  let wechatPayPublicKey;
  try {
    merchantPrivateKey = createPrivateKey(priv.text);
  } catch {
    throw new Error(`${priv.key} 不是商户 API 证书的私钥（apiclient_key.pem）`);
  }
  try {
    wechatPayPublicKey = createPublicKey(pub.text);
  } catch {
    throw new Error(`${pub.key} 不是微信支付公钥（pub_key.pem）`);
  }
  const config: WxPayConfig = {
    appId: v('WXPAY_APPID'),
    mchId: v('WXPAY_MCHID'),
    merchantSerialNo: v('WXPAY_SERIAL_NO'),
    merchantPrivateKey,
    apiV3Key: v('WXPAY_APIV3_KEY'),
    wechatPayPublicKey,
    wechatPayPublicKeyId: v('WXPAY_PUBLIC_KEY_ID'),
    notifyUrl: v('WXPAY_NOTIFY_URL'),
  };
  // 微信支付的请求 6 秒超时：建单时还要在网关等门店系统的 8 秒里回给小程序
  return { mode: 'real', config, client: createWxPayClient(config, undefined, 6_000), mock: null };
}

// 这个进程里小程序端口用的微信支付（小程序端口开着时由 buildMpApp 设好）：后台据此显示配没配好、配错了的原因
let active: PayRuntime | null = null;
let problem: string | null = null;
export const activePay = (): PayRuntime | null => active;
export const payProblem = (): string | null => problem;
export function setActivePay(rt: PayRuntime | null, why: string | null = null) {
  active = rt;
  problem = rt ? null : why;
}
