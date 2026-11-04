// 微信支付 v3（JSAPI：小程序调起支付）的协议部分（小程序线第二期，docs/MP_RECHARGE.md 第 2 节）：
//   · 商户请求签名（Authorization: WECHATPAY2-SHA256-RSA2048）与微信应答的验签；
//   · 下单拿 prepay_id、按商户单号查单、关单；
//   · 到账通知：用微信支付公钥验签、时间戳 5 分钟内（防重放）、探测通知判失败、AEAD_AES_256_GCM 解密；
//   · 小程序 wx.requestPayment 要的参数与 paySign。
// 凭据只在门店 yuzu（MP17）：商户 API 私钥、APIv3 密钥、微信支付公钥。网关不放、不经手；网关被攻破也伪造不了到账。
// 这里只管协议，不碰数据库；单子、入账在调用方。

import { createDecipheriv, createHash, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes, type KeyObject } from 'node:crypto';
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

/** 商户退款单号：1–64 个字符，只能是数字、大小写字母、_ - | * @（微信的规定） */
export const OUT_REFUND_NO = /^[0-9A-Za-z_\-|*@]{1,64}$/;

/** 微信支付的退款（申请退款、查退款的应答，退款通知解密后的内容）：只取用得到的字段 */
export interface WxRefund {
  /** 微信退款单号 */
  refundId: string;
  outRefundNo: string;
  transactionId: string | null;
  outTradeNo: string | null;
  /** SUCCESS 退款成功、PROCESSING 处理中、ABNORMAL 退款异常（例如顾客的卡注销了，要到商户平台手动处理）、CLOSED 退款关闭 */
  status: string;
  /** 这笔退了多少（分） */
  refund: number;
  /** 原订单金额（分） */
  total: number;
  /** 退到哪（例如「支付用户零钱」「招商银行信用卡0403」） */
  userReceivedAccount: string | null;
  successTime: string | null;
}

const Refund = z.object({
  refund_id: z.string().min(1),
  out_refund_no: z.string().min(1),
  transaction_id: z.string().optional(),
  out_trade_no: z.string().optional(),
  // 申请、查询的应答里是 status，退款通知里是 refund_status
  status: z.string().optional(),
  refund_status: z.string().optional(),
  user_received_account: z.string().optional(),
  success_time: z.string().optional(),
  amount: z.object({ refund: z.number().int(), total: z.number().int() }),
});

export function parseRefund(raw: unknown): WxRefund {
  const r = Refund.safeParse(raw);
  const status = r.success ? (r.data.status ?? r.data.refund_status) : undefined;
  if (!r.success || !status) throw new WxPayError('WXPAY_BAD_RESPONSE', '微信支付的退款内容格式不对');
  const x = r.data;
  return {
    refundId: x.refund_id,
    outRefundNo: x.out_refund_no,
    transactionId: x.transaction_id ?? null,
    outTradeNo: x.out_trade_no ?? null,
    status,
    refund: x.amount.refund,
    total: x.amount.total,
    userReceivedAccount: x.user_received_account ?? null,
    successTime: x.success_time ?? null,
  };
}

const Notification = z.object({
  id: z.string(),
  event_type: z.string(),
  resource_type: z.string().optional(),
  resource: z.unknown(),
});

/** 微信支付发来的通知：支付的（TRANSACTION.*）带订单，退款的（REFUND.*）带退款，别的事件两样都没有 */
export interface WxNotification {
  id: string;
  eventType: string;
  transaction: WxTransaction | null;
  refund: WxRefund | null;
}

/**
 * 微信支付的通知（网关原样转来的头与报文主体）：验签 → 解密 → 按事件类型取订单或退款。
 * 别的事件也照样验签解密、不报错：调用方回「收到」就行，免得微信一直重发（例如商户平台把退款通知也配到了这个地址）。
 */
export function parseNotification(cfg: WxPayConfig, h: WxSignedHeaders, body: string, now = nowSeconds()): WxNotification {
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
  const type = n.data.event_type;
  return {
    id: n.data.id,
    eventType: type,
    transaction: type.startsWith('TRANSACTION.') ? parseTransaction(plain) : null,
    refund: type.startsWith('REFUND.') ? parseRefund(plain) : null,
  };
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
  /** 下载账单时按原始字节核对摘要（有就用；没有按 text() 的 UTF-8 字节算） */
  arrayBuffer?(): Promise<ArrayBuffer>;
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

export interface RefundInput {
  /** 原来那笔支付的商户单号 */
  outTradeNo: string;
  /** 商户退款单号：同一笔退款重复申请用同一个，微信只退一次 */
  outRefundNo: string;
  /** 退款原因（顾客在微信的退款消息里看得到），超过 80 个字截掉 */
  reason: string;
  /** 这次退多少（分） */
  refundCents: number;
  /** 原订单金额（分），要与微信那边的一致 */
  totalCents: number;
}

export interface WxPayClient {
  /** 下单：拿 prepay_id */
  jsapiOrder(o: JsapiOrderInput): Promise<{ prepayId: string }>;
  /** 按商户单号查单：微信那边没有这一单返回 null */
  queryOrder(outTradeNo: string): Promise<WxTransaction | null>;
  /** 关单：没付的单子到期后关掉（已付的关不了，微信会回错） */
  closeOrder(outTradeNo: string): Promise<void>;
  /** 某一天（北京时间，YYYY-MM-DD）的交易账单：申请 → 下载 → 按摘要核对 → 解析；那天没有交易返回空数组 */
  tradeBill(billDate: string): Promise<WxTradeBillRow[]>;
  /**
   * 申请退款（原路退回，2d）：同一个商户退款单号、同样的内容再申请，微信回同一笔退款、不会退两次。
   * 应答里的状态多半是「处理中」，结果看退款通知或查退款
   */
  refund(r: RefundInput): Promise<WxRefund>;
  /** 按商户退款单号查退款：微信那边没有这一笔返回 null */
  queryRefund(outRefundNo: string): Promise<WxRefund | null>;
}

/** 交易账单的一行（2b 对账用到的字段；金额都是分） */
export interface WxTradeBillRow {
  /** 交易时间（北京时间，例如 2026-11-03 14:05:09） */
  time: string;
  appId: string;
  mchId: string;
  transactionId: string;
  outTradeNo: string;
  openid: string;
  /** SUCCESS 支付成功、REFUND 退款、REVOKED 已撤销 */
  tradeState: string;
  /** 应结订单金额 */
  amount: number;
  refundId: string | null;
  outRefundNo: string | null;
  refundAmount: number | null;
  refundStatus: string | null;
}

/** 账单里的金额：「`500.00」→ 50000 分（按字符串转成分，不用浮点数）；空的为 null */
function billCents(raw: string | undefined): number | null {
  const t = (raw ?? '').replace(/^`/, '').trim();
  if (!t) return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) throw new WxPayError('WXPAY_BAD_BILL', `账单里的金额认不出：${t}`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

/**
 * 解析交易账单（CSV）：第一行是表头；之后每一行的每个字段前都有一个 ` 号（所以按「,`」切，字段里有逗号也不乱）；
 * 「总交易单数」开头的是汇总，到那里为止。按表头的名字取列，不靠列的先后
 */
export function parseTradeBill(text: string): WxTradeBillRow[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0]!.split(',').map((h) => h.replace(/^`/, '').trim());
  const at = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new WxPayError('WXPAY_BAD_BILL', `账单里没有「${name}」这一列`);
    return i;
  };
  const c = {
    time: at('交易时间'),
    appId: at('公众账号ID'),
    mchId: at('商户号'),
    transactionId: at('微信订单号'),
    outTradeNo: at('商户订单号'),
    openid: at('用户标识'),
    tradeState: at('交易状态'),
    amount: at('应结订单金额'),
    refundId: at('微信退款单号'),
    outRefundNo: at('商户退款单号'),
    refundAmount: at('退款金额'),
    refundStatus: at('退款状态'),
  };
  const rows: WxTradeBillRow[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('总交易单数')) break;
    if (!line.startsWith('`')) throw new WxPayError('WXPAY_BAD_BILL', '账单的格式认不出');
    const f = line.slice(1).split(',`');
    if (f.length !== header.length) throw new WxPayError('WXPAY_BAD_BILL', `账单的一行有 ${f.length} 个字段，表头有 ${header.length} 个`);
    const v = (i: number) => (f[i] ?? '').trim();
    const amount = billCents(v(c.amount));
    rows.push({
      time: v(c.time),
      appId: v(c.appId),
      mchId: v(c.mchId),
      transactionId: v(c.transactionId),
      outTradeNo: v(c.outTradeNo),
      openid: v(c.openid),
      tradeState: v(c.tradeState),
      amount: amount ?? 0,
      refundId: v(c.refundId) || null,
      outRefundNo: v(c.outRefundNo) || null,
      refundAmount: billCents(v(c.refundAmount)),
      refundStatus: v(c.refundStatus) || null,
    });
  }
  return rows;
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

    async tradeBill(billDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate)) throw new WxPayError('WXPAY_BAD_INPUT', '账单日期应为 YYYY-MM-DD');
      const r = await call('GET', `/v3/bill/tradebill?bill_date=${billDate}&bill_type=ALL`);
      if (r.status !== 200) {
        const e = failure(r.status, r.body);
        // 那天没有交易：微信不出账单
        if (e.code === 'NO_STATEMENT_EXIST') return [];
        throw e;
      }
      const meta = z.object({ hash_type: z.string(), hash_value: z.string().min(1), download_url: z.string().url() }).safeParse(JSON.parse(r.body));
      if (!meta.success) throw new WxPayError('WXPAY_BAD_RESPONSE', '申请账单的应答格式不对');
      const url = new URL(meta.data.download_url);
      const pathWithQuery = `${url.pathname}${url.search}`;
      let res: WxFetchResponse;
      try {
        // 下载也要商户签名（签名串里是下载地址的路径与查询串）；下载的应答不签名，靠摘要核对
        res = await fetchImpl(url.toString(), {
          method: 'GET',
          headers: { Authorization: authorizationHeader(cfg, 'GET', pathWithQuery, ''), 'User-Agent': 'yuzu-miniprogram' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new WxPayError('WXPAY_UNREACHABLE', '连不上微信支付');
      }
      if (res.status !== 200) throw failure(res.status, await res.text());
      const bytes = res.arrayBuffer ? Buffer.from(await res.arrayBuffer()) : Buffer.from(await res.text(), 'utf8');
      if (meta.data.hash_type.toUpperCase() !== 'SHA1') throw new WxPayError('WXPAY_BAD_BILL', `账单的摘要算法认不出：${meta.data.hash_type}`);
      if (createHash('sha1').update(bytes).digest('hex') !== meta.data.hash_value.toLowerCase()) {
        throw new WxPayError('WXPAY_BAD_BILL', '下载的账单与微信给的摘要对不上（文件不完整或被改过）');
      }
      return parseTradeBill(bytes.toString('utf8'));
    },

    async refund(r) {
      if (!OUT_TRADE_NO.test(r.outTradeNo)) throw new WxPayError('WXPAY_BAD_INPUT', '商户单号不符合微信的格式');
      if (!OUT_REFUND_NO.test(r.outRefundNo)) throw new WxPayError('WXPAY_BAD_INPUT', '商户退款单号不符合微信的格式');
      if (!Number.isInteger(r.refundCents) || r.refundCents <= 0 || !Number.isInteger(r.totalCents) || r.refundCents > r.totalCents) {
        throw new WxPayError('WXPAY_BAD_INPUT', '退款金额应为正整数（分），且不超过原订单金额');
      }
      const res = await call('POST', '/v3/refund/domestic/refunds', {
        out_trade_no: r.outTradeNo,
        out_refund_no: r.outRefundNo,
        ...(r.reason.trim() ? { reason: [...r.reason.trim()].slice(0, 80).join('') } : {}),
        notify_url: cfg.notifyUrl,
        amount: { refund: r.refundCents, total: r.totalCents, currency: 'CNY' },
      });
      if (res.status !== 200) throw failure(res.status, res.body);
      return parseRefund(JSON.parse(res.body));
    },

    async queryRefund(outRefundNo) {
      if (!OUT_REFUND_NO.test(outRefundNo)) throw new WxPayError('WXPAY_BAD_INPUT', '商户退款单号不符合微信的格式');
      const res = await call('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`);
      if (res.status === 404) return null;
      if (res.status !== 200) throw failure(res.status, res.body);
      return parseRefund(JSON.parse(res.body));
    },
  };
}
