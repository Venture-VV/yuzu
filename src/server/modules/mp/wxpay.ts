// 微信支付 v3（JSAPI：小程序调起支付）的协议部分（小程序线第二期，docs/MP_RECHARGE.md 第 2 节）：
//   · 商户请求签名（Authorization: WECHATPAY2-SHA256-RSA2048）与微信应答的验签；
//   · 下单拿 prepay_id、按商户单号查单、关单；
//   · 到账通知：用微信支付公钥验签、时间戳 5 分钟内（防重放）、探测通知判失败、AEAD_AES_256_GCM 解密；
//   · 小程序 wx.requestPayment 要的参数与 paySign。
// 凭据只在门店 yuzu（MP17）：商户 API 私钥、APIv3 密钥、微信支付公钥。网关不放、不经手；网关被攻破也伪造不了到账。
// 这里只管协议，不碰数据库；单子、入账在调用方。

import { createDecipheriv, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes, type KeyObject } from 'node:crypto';
import { z } from 'zod';

export interface WxPayConfig {
  appId: string;
  mchId: string;
  /** 商户 API 证书的序列号 */
  merchantSerialNo: string;
  /** 商户 API 证书的私钥（PEM 或已读入的 KeyObject） */
  merchantPrivateKey: string | KeyObject;
  /** APIv3 密钥（商户平台设置，32 个字符） */
  apiV3Key: string;
  /** 微信支付公钥与它的编号（PUB_KEY_ID_ 开头）：验到账通知与应答 */
  wechatPayPublicKey: string | KeyObject;
  wechatPayPublicKeyId: string;
  /** 到账通知的地址：网关的 https://<域名>/v1/pay/notify */
  notifyUrl: string;
  /** 默认 https://api.mch.weixin.qq.com（测试用替身时改） */
  baseUrl?: string;
}

export class WxPayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** 应答与通知的时间戳和本机时间差超过 5 分钟就不认（防重放） */
const MAX_SKEW_SECONDS = 300;

const asPrivateKey = (k: string | KeyObject) => (typeof k === 'string' ? createPrivateKey(k) : k);
const asPublicKey = (k: string | KeyObject) => (typeof k === 'string' ? createPublicKey(k) : k);

export const randomNonce = () => randomBytes(16).toString('hex');
export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** SHA256 with RSA，Base64 */
export function rsaSign(key: string | KeyObject, message: string): string {
  return createSign('RSA-SHA256').update(message, 'utf8').sign(asPrivateKey(key), 'base64');
}

function rsaVerify(key: string | KeyObject, message: string, signature: string): boolean {
  try {
    return createVerify('RSA-SHA256').update(message, 'utf8').verify(asPublicKey(key), signature, 'base64');
  } catch {
    return false;
  }
}

/** 商户请求的签名串：请求方法、URL（路径加查询串）、时间戳、随机串、报文主体，各占一行（GET 的主体是空串） */
export function authorizationHeader(cfg: WxPayConfig, method: string, pathWithQuery: string, body: string, nonce = randomNonce(), timestamp = nowSeconds()): string {
  const signature = rsaSign(cfg.merchantPrivateKey, `${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${cfg.merchantSerialNo}"`;
}

export interface WxSignedHeaders {
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
  serial: string | null;
}

/** 从请求或应答的头里取微信的签名信息（名字大小写不论） */
export function wechatHeaders(get: (name: string) => string | null | undefined): WxSignedHeaders {
  const pick = (n: string) => {
    const v = get(n) ?? get(n.toLowerCase());
    return typeof v === 'string' && v ? v : null;
  };
  return { timestamp: pick('Wechatpay-Timestamp'), nonce: pick('Wechatpay-Nonce'), signature: pick('Wechatpay-Signature'), serial: pick('Wechatpay-Serial') };
}

/**
 * 验微信的签名（到账通知与应答都是这个格式）：签名串是时间戳、随机串、报文主体各占一行。
 * 只认配好的微信支付公钥（按编号）；时间差超过 5 分钟、探测通知（签名以 WECHATPAY/SIGNTEST/ 开头）都不认。
 */
export function verifyWechatSignature(cfg: WxPayConfig, h: WxSignedHeaders, body: string, now = nowSeconds()): void {
  if (!h.timestamp || !h.nonce || !h.signature || !h.serial) throw new WxPayError('WXPAY_UNSIGNED', '缺少微信支付的签名');
  if (h.signature.startsWith('WECHATPAY/SIGNTEST/')) throw new WxPayError('WXPAY_PROBE', '微信支付的签名探测');
  if (h.serial !== cfg.wechatPayPublicKeyId) throw new WxPayError('WXPAY_UNKNOWN_KEY', `不认识的微信支付公钥编号：${h.serial}`);
  const ts = Number(h.timestamp);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > MAX_SKEW_SECONDS) throw new WxPayError('WXPAY_STALE', '微信支付的签名时间不对（相差超过 5 分钟）');
  if (!rsaVerify(cfg.wechatPayPublicKey, `${h.timestamp}\n${h.nonce}\n${body}\n`, h.signature)) throw new WxPayError('WXPAY_BAD_SIGNATURE', '微信支付的签名不对');
}

const Resource = z.object({
  algorithm: z.literal('AEAD_AES_256_GCM'),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
  associated_data: z.string().optional().default(''),
});

/** 到账通知里加密的内容：AEAD_AES_256_GCM，密钥是 APIv3 密钥，密文的最后 16 字节是认证标签 */
export function decryptResource(apiV3Key: string, raw: unknown): string {
  const r = Resource.safeParse(raw);
  if (!r.success) throw new WxPayError('WXPAY_BAD_NOTIFY', '到账通知的加密内容格式不对');
  const key = Buffer.from(apiV3Key, 'utf8');
  if (key.length !== 32) throw new WxPayError('WXPAY_CONFIG', 'APIv3 密钥应为 32 个字符');
  const buf = Buffer.from(r.data.ciphertext, 'base64');
  if (buf.length <= 16) throw new WxPayError('WXPAY_DECRYPT', '到账通知解不开');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(r.data.nonce, 'utf8'));
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    decipher.setAAD(Buffer.from(r.data.associated_data, 'utf8'));
    return Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    throw new WxPayError('WXPAY_DECRYPT', '到账通知解不开（APIv3 密钥不对或内容被改过）');
  }
}

/** 微信支付的订单（查单的应答、到账通知解密后的内容）：只取用得到的字段 */
export interface WxTransaction {
  appId: string;
  mchId: string;
  outTradeNo: string;
  transactionId: string | null;
  /** SUCCESS 已付、NOTPAY 没付、CLOSED 已关、REFUND 转入退款、USERPAYING 付款中、PAYERROR 失败 */
  tradeState: string;
  /** 订单金额（分） */
  amountTotal: number | null;
  payerOpenid: string | null;
  successTime: string | null;
}

const Transaction = z.object({
  appid: z.string(),
  mchid: z.string(),
  out_trade_no: z.string(),
  transaction_id: z.string().optional(),
  trade_state: z.string(),
  success_time: z.string().optional(),
  payer: z.object({ openid: z.string().optional() }).optional(),
  amount: z.object({ total: z.number().int().optional() }).optional(),
});

export function parseTransaction(raw: unknown): WxTransaction {
  const r = Transaction.safeParse(raw);
  if (!r.success) throw new WxPayError('WXPAY_BAD_RESPONSE', '微信支付的订单内容格式不对');
  const t = r.data;
  return {
    appId: t.appid,
    mchId: t.mchid,
    outTradeNo: t.out_trade_no,
    transactionId: t.transaction_id ?? null,
    tradeState: t.trade_state,
    amountTotal: t.amount?.total ?? null,
    payerOpenid: t.payer?.openid ?? null,
    successTime: t.success_time ?? null,
  };
}

const Notification = z.object({
  id: z.string(),
  event_type: z.string(),
  resource_type: z.string().optional(),
  resource: z.unknown(),
});

/**
 * 到账通知（网关原样转来的头与报文主体）：验签 → 解密 → 订单内容。
 * 只有支付成功的通知（TRANSACTION.SUCCESS）会带订单；别的事件也照样验签解密，由调用方按 tradeState 处理。
 */
export function parseNotification(cfg: WxPayConfig, h: WxSignedHeaders, body: string, now = nowSeconds()): { id: string; eventType: string; transaction: WxTransaction } {
  verifyWechatSignature(cfg, h, body, now);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new WxPayError('WXPAY_BAD_NOTIFY', '到账通知不是 JSON');
  }
  const n = Notification.safeParse(json);
  if (!n.success) throw new WxPayError('WXPAY_BAD_NOTIFY', '到账通知的格式不对');
  let plain: unknown;
  try {
    plain = JSON.parse(decryptResource(cfg.apiV3Key, n.data.resource));
  } catch (error) {
    if (error instanceof WxPayError) throw error;
    throw new WxPayError('WXPAY_BAD_NOTIFY', '到账通知解密后不是 JSON');
  }
  return { id: n.data.id, eventType: n.data.event_type, transaction: parseTransaction(plain) };
}

/** 小程序 wx.requestPayment 的参数：签名串是 AppID、时间戳、随机串、package（prepay_id=…）各占一行，用商户私钥签 */
export function paymentParams(cfg: WxPayConfig, prepayId: string, nonce = randomNonce(), timestamp = nowSeconds()) {
  const pkg = `prepay_id=${prepayId}`;
  const timeStamp = String(timestamp);
  return { timeStamp, nonceStr: nonce, package: pkg, signType: 'RSA' as const, paySign: rsaSign(cfg.merchantPrivateKey, `${cfg.appId}\n${timeStamp}\n${nonce}\n${pkg}\n`) };
}

/** 商户单号：6–32 个字符，只能是数字、大小写字母、_ - | *（微信的规定） */
export const OUT_TRADE_NO = /^[0-9A-Za-z_\-|*]{6,32}$/;

export interface WxFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type WxFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<WxFetchResponse>;

export interface JsapiOrderInput {
  outTradeNo: string;
  /** 商品描述（顾客在微信账单里看到的），最多 127 字节 */
  description: string;
  amountCents: number;
  payerOpenid: string;
  /** 订单到期时间：过了这个时间微信不再收这一单的钱 */
  expiresAt: Date;
}

export interface WxPayClient {
  /** 下单：拿 prepay_id */
  jsapiOrder(o: JsapiOrderInput): Promise<{ prepayId: string }>;
  /** 按商户单号查单：微信那边没有这一单返回 null */
  queryOrder(outTradeNo: string): Promise<WxTransaction | null>;
  /** 关单：没付的单子到期后关掉（已付的关不了，微信会回错） */
  closeOrder(outTradeNo: string): Promise<void>;
}

/** 到期时间按北京时间写（RFC 3339，带 +08:00），不带毫秒 */
export function rfc3339Beijing(d: Date): string {
  const t = new Date(d.getTime() + 8 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, '');
  return `${t}+08:00`;
}

export function createWxPayClient(cfg: WxPayConfig, fetchImpl: WxFetch = fetch as unknown as WxFetch, timeoutMs = 10_000): WxPayClient {
  const base = (cfg.baseUrl ?? 'https://api.mch.weixin.qq.com').replace(/\/+$/, '');

  const call = async (method: 'GET' | 'POST', path: string, payload?: unknown): Promise<{ status: number; body: string }> => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    let res: WxFetchResponse;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Authorization: authorizationHeader(cfg, method, path, body),
          Accept: 'application/json',
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          'User-Agent': 'yuzu-miniprogram',
        },
        ...(payload === undefined ? {} : { body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new WxPayError('WXPAY_UNREACHABLE', '连不上微信支付');
    }
    const text = await res.text();
    if (res.status >= 200 && res.status < 300) {
      // 成功的应答也要验签：防止被冒充的「下单成功」「已支付」
      verifyWechatSignature(cfg, wechatHeaders((n) => res.headers.get(n)), text);
    }
    return { status: res.status, body: text };
  };

  const failure = (status: number, body: string): WxPayError => {
    let code = 'WXPAY_FAILED';
    let message = `微信支付返回 ${status}`;
    try {
      const e = JSON.parse(body) as { code?: unknown; message?: unknown };
      if (typeof e.code === 'string') code = e.code;
      if (typeof e.message === 'string') message = e.message;
    } catch {
      // 不是 JSON：用状态码
    }
    return new WxPayError(code, message, status);
  };

  return {
    async jsapiOrder(o) {
      if (!OUT_TRADE_NO.test(o.outTradeNo)) throw new WxPayError('WXPAY_BAD_INPUT', '商户单号不符合微信的格式');
      if (!Number.isInteger(o.amountCents) || o.amountCents <= 0) throw new WxPayError('WXPAY_BAD_INPUT', '金额应为正整数（分）');
      const r = await call('POST', '/v3/pay/transactions/jsapi', {
        appid: cfg.appId,
        mchid: cfg.mchId,
        description: o.description,
        out_trade_no: o.outTradeNo,
        time_expire: rfc3339Beijing(o.expiresAt),
        notify_url: cfg.notifyUrl,
        amount: { total: o.amountCents, currency: 'CNY' },
        payer: { openid: o.payerOpenid },
      });
      if (r.status !== 200) throw failure(r.status, r.body);
      const parsed = z.object({ prepay_id: z.string().min(1) }).safeParse(JSON.parse(r.body));
      if (!parsed.success) throw new WxPayError('WXPAY_BAD_RESPONSE', '微信支付下单的应答里没有 prepay_id');
      return { prepayId: parsed.data.prepay_id };
    },

    async queryOrder(outTradeNo) {
      if (!OUT_TRADE_NO.test(outTradeNo)) throw new WxPayError('WXPAY_BAD_INPUT', '商户单号不符合微信的格式');
      const r = await call('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(cfg.mchId)}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw failure(r.status, r.body);
      return parseTransaction(JSON.parse(r.body));
    },

    async closeOrder(outTradeNo) {
      if (!OUT_TRADE_NO.test(outTradeNo)) throw new WxPayError('WXPAY_BAD_INPUT', '商户单号不符合微信的格式');
      const r = await call('POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`, { mchid: cfg.mchId });
      if (r.status !== 204 && r.status !== 200) throw failure(r.status, r.body);
    },
  };
}
