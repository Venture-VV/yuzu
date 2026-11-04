// 模拟微信支付（小程序线第二期 2a，docs/MP_RECHARGE.md 第 4 节）：只在 development、test 实例用（MP_PAY_MOCK=true）。
// 本机生成「商户」与「微信支付」的两对密钥和 APIv3 密钥，照真的协议回应下单、查单、关单：核对商户的签名、给应答签名。
// 顾客「付款」时造一条照真的签名、加密的到账通知，交给门店系统同一条验签、解密、入账的路。不连外网。

import { createCipheriv, createVerify, generateKeyPairSync, randomInt, randomUUID } from 'node:crypto';
import {
  createWxPayClient,
  rfc3339Beijing,
  rsaSign,
  type WxFetch,
  type WxFetchResponse,
  type WxPayClient,
  type WxPayConfig,
  type WxSignedHeaders,
} from './wxpay';

interface MockOrder {
  request: {
    appid: string;
    mchid: string;
    description: string;
    out_trade_no: string;
    time_expire: string;
    amount: { total: number };
    payer: { openid: string };
  };
  prepayId: string;
  state: 'NOTPAY' | 'SUCCESS' | 'CLOSED';
  transactionId: string | null;
  successTime: string | null;
}

export interface MockWxPay {
  config: WxPayConfig;
  client: WxPayClient;
  /** 顾客付了这一单：微信那边记已付，返回一条到账通知（与微信发来的一样：四个签名头与报文主体） */
  pay(outTradeNo: string, now?: Date): { headers: WxSignedHeaders; body: string };
  /** 照真的签名、加密一条到账通知（测试用：内容可以与单子对不上） */
  notification(transaction: Record<string, unknown>, now?: Date): { headers: WxSignedHeaders; body: string };
  /** 微信那边这一单的状态（测试用）；没有这一单为 null */
  state(outTradeNo: string): MockOrder['state'] | null;
  /** 模拟连不上微信支付（测试用） */
  setDown(down: boolean): void;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const randomText = (n: number) => Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join('');
const digits = (n: number) => Array.from({ length: n }, () => String(randomInt(10))).join('');

/** 北京时间的 RFC 3339（带 +08:00）读回时刻 */
const parseTime = (s: string) => new Date(s).getTime();

export function createMockWxPay(o: { appId?: string; mchId?: string; notifyUrl?: string } = {}): MockWxPay {
  const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wechat = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config: WxPayConfig = {
    appId: o.appId ?? 'wx0000000000mock',
    mchId: o.mchId ?? '1900000109',
    merchantSerialNo: 'MOCK0000000000000000000000000000000001',
    merchantPrivateKey: merchant.privateKey,
    apiV3Key: randomText(32),
    wechatPayPublicKey: wechat.publicKey,
    wechatPayPublicKeyId: 'PUB_KEY_ID_0000000000MOCK',
    notifyUrl: o.notifyUrl ?? 'https://mock.invalid/v1/pay/notify',
    baseUrl: 'https://mock-wxpay.invalid',
  };
  const orders = new Map<string, MockOrder>();
  let down = false;

  const signed = (status: number, payload?: unknown): WxFetchResponse => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomText(32);
    const headers: Record<string, string> = {
      'wechatpay-timestamp': ts,
      'wechatpay-nonce': nonce,
      'wechatpay-signature': rsaSign(wechat.privateKey, `${ts}\n${nonce}\n${body}\n`),
      'wechatpay-serial': config.wechatPayPublicKeyId,
    };
    return {
      status,
      headers: { get: (n) => headers[n.toLowerCase()] ?? null },
      text: async () => body,
    };
  };
  const error = (status: number, code: string, message: string) => signed(status, { code, message });

  /** 商户请求的签名：与真的微信支付一样核对（mchid、证书序列号、签名串） */
  const merchantSigned = (method: string, pathWithQuery: string, body: string, authorization: string | undefined): boolean => {
    const m = /^WECHATPAY2-SHA256-RSA2048 mchid="([^"]+)",nonce_str="([^"]+)",signature="([^"]+)",timestamp="([^"]+)",serial_no="([^"]+)"$/.exec(
      authorization ?? '',
    );
    if (!m || m[1] !== config.mchId || m[5] !== config.merchantSerialNo) return false;
    return createVerify('RSA-SHA256').update(`${method}\n${pathWithQuery}\n${m[4]}\n${m[2]}\n${body}\n`, 'utf8').verify(merchant.publicKey, m[3]!, 'base64');
  };

  const transactionOf = (no: string, x: MockOrder) => ({
    appid: x.request.appid,
    mchid: x.request.mchid,
    out_trade_no: no,
    ...(x.transactionId ? { transaction_id: x.transactionId } : {}),
    trade_type: 'JSAPI',
    trade_state: x.state,
    trade_state_desc: x.state === 'SUCCESS' ? '支付成功' : x.state === 'CLOSED' ? '订单已关闭' : '订单未支付',
    ...(x.successTime ? { success_time: x.successTime, bank_type: 'OTHERS' } : {}),
    payer: { openid: x.request.payer.openid },
    amount: {
      total: x.request.amount.total,
      payer_total: x.state === 'SUCCESS' ? x.request.amount.total : 0,
      currency: 'CNY',
      payer_currency: 'CNY',
    },
  });

  const fetchImpl: WxFetch = async (url, init) => {
    if (down) throw new Error('模拟的微信支付连不上');
    const u = new URL(url);
    const pathWithQuery = `${u.pathname}${u.search}`;
    const body = init.body ?? '';
    if (!merchantSigned(init.method, pathWithQuery, body, init.headers.Authorization)) return error(401, 'SIGN_ERROR', '签名错误');

    if (init.method === 'POST' && u.pathname === '/v3/pay/transactions/jsapi') {
      const req = JSON.parse(body) as MockOrder['request'];
      if (req.appid !== config.appId || req.mchid !== config.mchId) return error(400, 'APPID_MCHID_NOT_MATCH', 'appid 和 mch_id 不匹配');
      if (parseTime(req.time_expire) <= Date.now()) return error(400, 'PARAM_ERROR', '订单已过期');
      const had = orders.get(req.out_trade_no);
      if (had) {
        if (had.state === 'SUCCESS') return error(400, 'ORDERPAID', '该订单已支付');
        if (had.state === 'CLOSED') return error(400, 'ORDER_CLOSED', '订单已关闭');
        const same = JSON.stringify({ ...had.request, notify_url: undefined }) === JSON.stringify({ ...req, notify_url: undefined });
        if (!same) return error(400, 'INVALID_REQUEST', '201 商户订单号重复');
        return signed(200, { prepay_id: had.prepayId });
      }
      const prepayId = `wx${digits(14)}${randomText(18)}`;
      orders.set(req.out_trade_no, {
        request: req,
        prepayId,
        state: 'NOTPAY',
        transactionId: null,
        successTime: null,
      });
      return signed(200, { prepay_id: prepayId });
    }
    const q = /^\/v3\/pay\/transactions\/out-trade-no\/([^/]+)$/.exec(u.pathname);
    if (init.method === 'GET' && q) {
      if (u.searchParams.get('mchid') !== config.mchId) return error(400, 'PARAM_ERROR', 'mchid 不对');
      const x = orders.get(decodeURIComponent(q[1]!));
      if (!x) return error(404, 'ORDER_NOT_EXIST', '订单不存在');
      return signed(200, transactionOf(decodeURIComponent(q[1]!), x));
    }
    const c = /^\/v3\/pay\/transactions\/out-trade-no\/([^/]+)\/close$/.exec(u.pathname);
    if (init.method === 'POST' && c) {
      const x = orders.get(decodeURIComponent(c[1]!));
      if (!x) return error(404, 'ORDER_NOT_EXIST', '订单不存在');
      if (x.state === 'SUCCESS') return error(400, 'ORDERPAID', '订单已支付');
      x.state = 'CLOSED';
      return signed(204);
    }
    return error(404, 'NOT_FOUND', '接口不存在');
  };

  const notification = (transaction: Record<string, unknown>, now = new Date()) => {
    const nonce = randomText(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'));
    cipher.setAAD(Buffer.from('transaction', 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
    const body = JSON.stringify({
      id: randomUUID(),
      create_time: rfc3339Beijing(now),
      resource_type: 'encrypt-resource',
      event_type: 'TRANSACTION.SUCCESS',
      summary: '支付成功',
      resource: {
        original_type: 'transaction',
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext,
        associated_data: 'transaction',
        nonce,
      },
    });
    const ts = String(Math.floor(now.getTime() / 1000));
    const hNonce = randomText(32);
    return {
      headers: {
        timestamp: ts,
        nonce: hNonce,
        signature: rsaSign(wechat.privateKey, `${ts}\n${hNonce}\n${body}\n`),
        serial: config.wechatPayPublicKeyId,
      },
      body,
    };
  };

  return {
    config,
    client: createWxPayClient(config, fetchImpl),
    pay(outTradeNo, now = new Date()) {
      const x = orders.get(outTradeNo);
      if (!x) throw new Error(`模拟的微信支付里没有这一单：${outTradeNo}`);
      if (x.state === 'CLOSED') throw new Error('这一单已经关了，付不了');
      if (x.state === 'NOTPAY') {
        if (parseTime(x.request.time_expire) <= now.getTime()) throw new Error('这一单已经过期，付不了');
        x.state = 'SUCCESS';
        x.transactionId = `4200${digits(24)}`;
        x.successTime = rfc3339Beijing(now);
      }
      return notification(transactionOf(outTradeNo, x), now);
    },
    notification,
    state: (no) => orders.get(no)?.state ?? null,
    setDown(v) {
      down = v;
    },
  };
}
