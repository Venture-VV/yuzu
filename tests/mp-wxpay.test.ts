// 微信支付 v3 的协议部分（小程序线第二期，docs/MP_RECHARGE.md 第 2 节）：用本机生成的商户密钥与「微信支付」密钥，
// 假的微信支付核对商户请求的签名、给应答签名。下单 / 查单 / 关单的请求格式与应答验签；到账通知的验签、防重放、
// 探测通知、解密；小程序调起支付的 paySign。不连数据库、不连真的微信支付。

import { createCipheriv, createHash, createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createWxPayClient,
  decryptResource,
  nowSeconds,
  OUT_TRADE_NO,
  parseNotification,
  parseTradeBill,
  paymentParams,
  randomNonce,
  rfc3339Beijing,
  type WxFetch,
  type WxPayConfig,
  type WxSignedHeaders,
} from '../src/server/modules/mp/wxpay';

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wechat = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const API_V3_KEY = '0123456789abcdef0123456789ABCDEF';
const KEY_ID = 'PUB_KEY_ID_0114200000000000000000000000';

const cfg: WxPayConfig = {
  appId: 'wx1234567890abcdef',
  mchId: '1900000109',
  merchantSerialNo: '5157F09EFDC096DE15EBE81A47057A72',
  merchantPrivateKey: merchant.privateKey,
  apiV3Key: API_V3_KEY,
  wechatPayPublicKey: wechat.publicKey,
  wechatPayPublicKeyId: KEY_ID,
  notifyUrl: 'https://api-test.example.com/v1/pay/notify',
  baseUrl: 'https://wxpay.test',
};

/** 「微信支付」给一段报文签名（应答、到账通知同一个格式） */
function wechatSign(body: string, o: { ts?: number; key?: typeof wechat.privateKey; serial?: string } = {}): WxSignedHeaders {
  const ts = o.ts ?? nowSeconds();
  const nonce = randomNonce();
  const signature = createSign('RSA-SHA256').update(`${ts}\n${nonce}\n${body}\n`).sign(o.key ?? wechat.privateKey, 'base64');
  return { timestamp: String(ts), nonce, signature, serial: o.serial ?? KEY_ID };
}

/** 「微信支付」加密到账通知里的订单 */
function encrypt(plain: string, key = API_V3_KEY, nonce = 'fdasfwerfdsa', ad = 'transaction') {
  const c = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
  c.setAAD(Buffer.from(ad));
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final(), c.getAuthTag()]);
  return { algorithm: 'AEAD_AES_256_GCM', ciphertext: enc.toString('base64'), nonce, associated_data: ad, original_type: 'transaction' };
}

const transaction = (over: Record<string, unknown> = {}) => ({
  appid: cfg.appId,
  mchid: cfg.mchId,
  out_trade_no: 'MP20261104000001',
  transaction_id: '4200000985202611040123456789',
  trade_type: 'JSAPI',
  trade_state: 'SUCCESS',
  trade_state_desc: '支付成功',
  success_time: '2026-11-04T12:31:05+08:00',
  payer: { openid: 'oUpF8uMuAJO_M2pxb1Q9zNjWeS6o' },
  amount: { total: 300000, payer_total: 300000, currency: 'CNY', payer_currency: 'CNY' },
  ...over,
});

interface Call {
  method: string;
  path: string;
  body: unknown;
  signedByMerchant: boolean;
  auth: Record<string, string>;
}

/** 假的微信支付：核对商户签名，按 handler 回应，应答由「微信支付」签名（signWith 换成别人的钥匙模拟被冒充） */
function fakeWxPay(handler: (c: Call) => { status: number; body?: unknown }, signWith = wechat.privateKey) {
  const calls: Call[] = [];
  const fetchImpl: WxFetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    const raw = init.body ?? '';
    const m = /^WECHATPAY2-SHA256-RSA2048 (.+)$/.exec(init.headers.Authorization ?? '');
    const auth: Record<string, string> = {};
    for (const part of (m?.[1] ?? '').split(',')) {
      const kv = /^(\w+)="(.*)"$/.exec(part.trim());
      if (kv) auth[kv[1]!] = kv[2]!;
    }
    const signedByMerchant = createVerify('RSA-SHA256')
      .update(`${init.method}\n${path}\n${auth.timestamp}\n${auth.nonce_str}\n${raw}\n`)
      .verify(merchant.publicKey, auth.signature ?? '', 'base64');
    const call: Call = { method: init.method, path, body: raw ? JSON.parse(raw) : null, signedByMerchant, auth };
    calls.push(call);
    const r = handler(call);
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    const h = wechatSign(text, { key: signWith });
    const headers: Record<string, string> = {
      'wechatpay-timestamp': h.timestamp!,
      'wechatpay-nonce': h.nonce!,
      'wechatpay-signature': h.signature!,
      'wechatpay-serial': h.serial!,
    };
    return { status: r.status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => text };
  };
  return { fetchImpl, calls };
}

describe('商户请求：下单、查单、关单', () => {
  it('下单带商户签名、按微信的格式；拿到 prepay_id；调起支付的 paySign 用商户私钥签', async () => {
    const wx = fakeWxPay(() => ({ status: 200, body: { prepay_id: 'wx04123056789abcdef' } }));
    const client = createWxPayClient(cfg, wx.fetchImpl);
    const expiresAt = new Date('2026-11-04T04:45:00Z');
    const r = await client.jsapiOrder({ outTradeNo: 'MP20261104000001', description: '汤崎 TOUCHILL 会员充值', amountCents: 300000, payerOpenid: 'oUpF8u-openid', expiresAt });
    expect(r).toEqual({ prepayId: 'wx04123056789abcdef' });
    const c = wx.calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.path).toBe('/v3/pay/transactions/jsapi');
    expect(c.signedByMerchant).toBe(true);
    expect(c.auth).toMatchObject({ mchid: cfg.mchId, serial_no: cfg.merchantSerialNo });
    expect(c.body).toEqual({
      appid: cfg.appId,
      mchid: cfg.mchId,
      description: '汤崎 TOUCHILL 会员充值',
      out_trade_no: 'MP20261104000001',
      time_expire: '2026-11-04T12:45:00+08:00',
      notify_url: cfg.notifyUrl,
      amount: { total: 300000, currency: 'CNY' },
      payer: { openid: 'oUpF8u-openid' },
    });

    const p = paymentParams(cfg, r.prepayId, 'nonce123', 1793770000);
    expect(p).toMatchObject({ timeStamp: '1793770000', nonceStr: 'nonce123', package: 'prepay_id=wx04123056789abcdef', signType: 'RSA' });
    const ok = createVerify('RSA-SHA256').update(`${cfg.appId}\n1793770000\nnonce123\nprepay_id=wx04123056789abcdef\n`).verify(merchant.publicKey, p.paySign, 'base64');
    expect(ok).toBe(true);
  });

  it('查单：已付的返回订单；微信那边没有这一单返回 null；查询串也在签名里', async () => {
    const wx = fakeWxPay((c) => (c.path.includes('MP20261104000002') ? { status: 404, body: { code: 'ORDER_NOT_EXIST', message: '订单不存在' } } : { status: 200, body: transaction() }));
    const client = createWxPayClient(cfg, wx.fetchImpl);
    expect(await client.queryOrder('MP20261104000001')).toEqual({
      appId: cfg.appId,
      mchId: cfg.mchId,
      outTradeNo: 'MP20261104000001',
      transactionId: '4200000985202611040123456789',
      tradeState: 'SUCCESS',
      amountTotal: 300000,
      payerOpenid: 'oUpF8uMuAJO_M2pxb1Q9zNjWeS6o',
      successTime: '2026-11-04T12:31:05+08:00',
    });
    expect(wx.calls[0]!.path).toBe(`/v3/pay/transactions/out-trade-no/MP20261104000001?mchid=${cfg.mchId}`);
    expect(wx.calls[0]!.signedByMerchant).toBe(true);
    expect(await client.queryOrder('MP20261104000002')).toBeNull();
  });

  it('关单：204 算成功；已付的单子关不了，带回微信的错误码', async () => {
    let paid = false;
    const wx = fakeWxPay(() => (paid ? { status: 400, body: { code: 'ORDERPAID', message: '订单已支付' } } : { status: 204 }));
    const client = createWxPayClient(cfg, wx.fetchImpl);
    await client.closeOrder('MP20261104000001');
    expect(wx.calls[0]).toMatchObject({ method: 'POST', path: '/v3/pay/transactions/out-trade-no/MP20261104000001/close', body: { mchid: cfg.mchId }, signedByMerchant: true });
    paid = true;
    await expect(client.closeOrder('MP20261104000001')).rejects.toMatchObject({ code: 'ORDERPAID', status: 400 });
  });

  it('应答不是微信支付签的（被冒充）、连不上、单号格式不对：都不认', async () => {
    const forged = fakeWxPay(() => ({ status: 200, body: transaction() }), stranger.privateKey);
    await expect(createWxPayClient(cfg, forged.fetchImpl).queryOrder('MP20261104000001')).rejects.toMatchObject({ code: 'WXPAY_BAD_SIGNATURE' });
    const down: WxFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(createWxPayClient(cfg, down).queryOrder('MP20261104000001')).rejects.toMatchObject({ code: 'WXPAY_UNREACHABLE' });
    await expect(createWxPayClient(cfg, forged.fetchImpl).queryOrder('bad no!')).rejects.toMatchObject({ code: 'WXPAY_BAD_INPUT' });
    expect(OUT_TRADE_NO.test('MP20261104000001')).toBe(true);
    expect(OUT_TRADE_NO.test('short')).toBe(false);
    expect(OUT_TRADE_NO.test('MP-2026_11|04*01')).toBe(true);
  });

  it('到期时间按北京时间写', () => {
    expect(rfc3339Beijing(new Date('2026-11-04T16:30:00.123Z'))).toBe('2026-11-05T00:30:00+08:00');
  });
});

describe('到账通知', () => {
  const notifyBody = (resource: unknown) =>
    JSON.stringify({ id: 'EV-2026110412310500001', create_time: '2026-11-04T12:31:06+08:00', event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource', resource, summary: '支付成功' });

  it('验签、解密后拿到订单', () => {
    const body = notifyBody(encrypt(JSON.stringify(transaction())));
    const n = parseNotification(cfg, wechatSign(body), body);
    expect(n.id).toBe('EV-2026110412310500001');
    expect(n.eventType).toBe('TRANSACTION.SUCCESS');
    expect(n.transaction).toMatchObject({ outTradeNo: 'MP20261104000001', tradeState: 'SUCCESS', amountTotal: 300000, transactionId: '4200000985202611040123456789' });
  });

  it('报文被改过、签名不是微信支付的、公钥编号不认识、时间差超过 5 分钟、探测通知、缺签名：都不认', () => {
    const body = notifyBody(encrypt(JSON.stringify(transaction())));
    const h = wechatSign(body);
    const tampered = body.replace('TRANSACTION.SUCCESS', 'TRANSACTION.SUCCESZ');
    expect(() => parseNotification(cfg, h, tampered)).toThrow(expect.objectContaining({ code: 'WXPAY_BAD_SIGNATURE' }));
    expect(() => parseNotification(cfg, wechatSign(body, { key: stranger.privateKey }), body)).toThrow(expect.objectContaining({ code: 'WXPAY_BAD_SIGNATURE' }));
    expect(() => parseNotification(cfg, wechatSign(body, { serial: 'PUB_KEY_ID_OTHER' }), body)).toThrow(expect.objectContaining({ code: 'WXPAY_UNKNOWN_KEY' }));
    expect(() => parseNotification(cfg, wechatSign(body, { ts: nowSeconds() - 301 }), body)).toThrow(expect.objectContaining({ code: 'WXPAY_STALE' }));
    expect(() => parseNotification(cfg, { ...h, signature: 'WECHATPAY/SIGNTEST/abc' }, body)).toThrow(expect.objectContaining({ code: 'WXPAY_PROBE' }));
    expect(() => parseNotification(cfg, { ...h, signature: null }, body)).toThrow(expect.objectContaining({ code: 'WXPAY_UNSIGNED' }));
  });

  it('APIv3 密钥不对、密文被改过：解不开', () => {
    const resource = encrypt(JSON.stringify(transaction()), 'ffffffffffffffffffffffffffffffff');
    const body = notifyBody(resource);
    expect(() => parseNotification(cfg, wechatSign(body), body)).toThrow(expect.objectContaining({ code: 'WXPAY_DECRYPT' }));
    const good = encrypt(JSON.stringify(transaction()));
    const bytes = Buffer.from(good.ciphertext, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    expect(() => decryptResource(API_V3_KEY, { ...good, ciphertext: bytes.toString('base64') })).toThrow(expect.objectContaining({ code: 'WXPAY_DECRYPT' }));
    expect(() => decryptResource(API_V3_KEY, { ...good, algorithm: 'AES_128' })).toThrow(expect.objectContaining({ code: 'WXPAY_BAD_NOTIFY' }));
    expect(() => decryptResource('short-key', good)).toThrow(expect.objectContaining({ code: 'WXPAY_CONFIG' }));
  });
});

describe('交易账单（2b 对账）', () => {
  const header =
    '交易时间,公众账号ID,商户号,特约商户号,设备号,微信订单号,商户订单号,用户标识,交易类型,交易状态,付款银行,货币种类,应结订单金额,代金券金额,' +
    '微信退款单号,商户退款单号,退款金额,充值券退款金额,退款类型,退款状态,商品名称,商户数据包,手续费,费率,订单金额,申请退款金额,费率备注';
  const line = (f: string[]) => f.map((x) => '`' + x).join(',');
  const pay = ['2026-11-03 14:05:09', cfg.appId, cfg.mchId, '0', '', '4200000985202611030000000001', 'MPR20261103AAAAAAAAAA', 'oUpF8u-openid', 'JSAPI', 'SUCCESS', 'OTHERS', 'CNY', '1000.50', '0.00', '0', '0', '0.00', '0.00', '', '', '汤崎宝安店 会员充值 1,000.50元', '', '6.00', '0.60%', '1000.50', '0.00', ''];
  const refund = ['2026-11-03 18:00:00', cfg.appId, cfg.mchId, '0', '', '4200000985202611030000000001', 'MPR20261103AAAAAAAAAA', 'oUpF8u-openid', 'JSAPI', 'REFUND', 'OTHERS', 'CNY', '0.00', '0.00', '50300000000000001', 'TC20261103001', '100.00', '0.00', 'ORIGINAL', 'SUCCESS', '会员充值', '', '-0.60', '0.60%', '0.00', '100.00', ''];
  const csv = '﻿' + [header, line(pay), line(refund), '总交易单数,应结订单总金额,退款总金额,充值券退款总金额,手续费总金额,订单总金额,申请退款总金额', line(['2', '1000.50', '100.00', '0.00', '5.40', '1000.50', '100.00'])].join('\r\n');

  /** 假的微信支付：申请账单回下载地址与摘要（签名），下载回原文（不签名） */
  function billWx(o: { hash?: string; noStatement?: boolean } = {}) {
    const paths: { path: string; signedByMerchant: boolean }[] = [];
    const fetchImpl: WxFetch = async (url, init) => {
      const u = new URL(url);
      const path = u.pathname + u.search;
      const auth = Object.fromEntries([...(init.headers.Authorization ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
      const signedByMerchant = createVerify('RSA-SHA256').update(`GET\n${path}\n${auth.timestamp}\n${auth.nonce_str}\n\n`).verify(merchant.publicKey, auth.signature ?? '', 'base64');
      paths.push({ path, signedByMerchant });
      if (u.pathname === '/v3/billdownload/file') {
        const bytes = Buffer.from(csv, 'utf8');
        return { status: 200, headers: { get: () => null }, text: async () => csv, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
      }
      const body = o.noStatement
        ? JSON.stringify({ code: 'NO_STATEMENT_EXIST', message: '账单不存在' })
        : JSON.stringify({ hash_type: 'SHA1', hash_value: o.hash ?? createHash('sha1').update(Buffer.from(csv, 'utf8')).digest('hex'), download_url: 'https://wxpay.test/v3/billdownload/file?token=t0k3n' });
      const h = wechatSign(body);
      const headers: Record<string, string> = { 'wechatpay-timestamp': h.timestamp!, 'wechatpay-nonce': h.nonce!, 'wechatpay-signature': h.signature!, 'wechatpay-serial': h.serial! };
      return { status: o.noStatement ? 400 : 200, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => body };
    };
    return { fetchImpl, paths };
  }

  it('申请账单 → 带商户签名下载 → 按摘要核对 → 解析成分（描述里有逗号、开头有 BOM 也不乱；退款单列）', async () => {
    const wx = billWx();
    const rows = await createWxPayClient(cfg, wx.fetchImpl).tradeBill('2026-11-03');
    expect(wx.paths).toEqual([
      { path: '/v3/bill/tradebill?bill_date=2026-11-03&bill_type=ALL', signedByMerchant: true },
      { path: '/v3/billdownload/file?token=t0k3n', signedByMerchant: true },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ outTradeNo: 'MPR20261103AAAAAAAAAA', transactionId: '4200000985202611030000000001', tradeState: 'SUCCESS', amount: 100050, refundAmount: 0 }),
      expect.objectContaining({ tradeState: 'REFUND', amount: 0, refundId: '50300000000000001', outRefundNo: 'TC20261103001', refundAmount: 10000, refundStatus: 'SUCCESS' }),
    ]);
  });

  it('下载的文件与摘要对不上不认；那天没有交易回空；日期格式不对不发', async () => {
    await expect(createWxPayClient(cfg, billWx({ hash: 'deadbeef' }).fetchImpl).tradeBill('2026-11-03')).rejects.toMatchObject({ code: 'WXPAY_BAD_BILL' });
    expect(await createWxPayClient(cfg, billWx({ noStatement: true }).fetchImpl).tradeBill('2026-11-03')).toEqual([]);
    const wx = billWx();
    await expect(createWxPayClient(cfg, wx.fetchImpl).tradeBill('2026/11/03')).rejects.toMatchObject({ code: 'WXPAY_BAD_INPUT' });
    expect(wx.paths).toEqual([]);
  });

  it('解析：表头按名字取列；字段数对不上、金额认不出都报错；到汇总行为止', () => {
    expect(parseTradeBill(csv)).toHaveLength(2);
    expect(() => parseTradeBill([header, '`2026-11-03 14:05:09,`only-two'].join('\n'))).toThrow('字段');
    expect(() => parseTradeBill([header, line(pay.map((f, i) => (i === 12 ? '1,000.50' : f)))].join('\n'))).toThrow();
    expect(() => parseTradeBill('交易时间,商户号\n')).toThrow('公众账号ID');
    expect(parseTradeBill('')).toEqual([]);
  });
});
