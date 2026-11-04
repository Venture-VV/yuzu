// 微信支付 v3 的协议部分（小程序线第二期，docs/MP_RECHARGE.md 第 2 节）：用本机生成的商户密钥与「微信支付」密钥，
// 假的微信支付核对商户请求的签名、给应答签名。下单 / 查单 / 关单的请求格式与应答验签；到账通知的验签、防重放、
// 探测通知、解密；小程序调起支付的 paySign；交易账单（2b）；申请退款、查退款与退款通知（2d），模拟微信支付的退款。
// 不连数据库、不连真的微信支付。

import { createCipheriv, createHash, createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createWxPayClient,
  decryptResource,
  nowSeconds,
  OUT_REFUND_NO,
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
import { createMockWxPay } from '../src/server/modules/mp/wxpay-mock';

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

describe('退款（2d 原路退回）', () => {
  const refundBody = (over: Record<string, unknown> = {}) => ({
    refund_id: '50000000382019052709732678859',
    out_refund_no: 'MPRF000123',
    transaction_id: '4200000985202611040123456789',
    out_trade_no: 'MP20261104000001',
    channel: 'ORIGINAL',
    user_received_account: '支付用户零钱',
    create_time: '2026-11-05T10:00:00+08:00',
    status: 'PROCESSING',
    funds_account: 'AVAILABLE',
    amount: { total: 300000, refund: 50000, payer_total: 300000, payer_refund: 50000, settlement_refund: 50000, settlement_total: 300000, discount_refund: 0, currency: 'CNY', refund_fee: 0, from: [] },
    ...over,
  });
  const input = (over: Record<string, unknown> = {}) => ({ outTradeNo: 'MP20261104000001', outRefundNo: 'MPRF000123', reason: '会员储值退回', refundCents: 50000, totalCents: 300000, ...over });

  it('申请退款：带商户签名、按微信的格式（原商户单号、退款单号、退多少与原订单金额、通知地址）；拿到退款（多半处理中）', async () => {
    const { fetchImpl, calls } = fakeWxPay(() => ({ status: 200, body: refundBody() }));
    const r = await createWxPayClient(cfg, fetchImpl).refund(input());
    expect(r).toMatchObject({ refundId: '50000000382019052709732678859', outRefundNo: 'MPRF000123', status: 'PROCESSING', refund: 50000, total: 300000, transactionId: '4200000985202611040123456789', successTime: null });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v3/refund/domestic/refunds', signedByMerchant: true });
    expect(calls[0]!.body).toEqual({ out_trade_no: 'MP20261104000001', out_refund_no: 'MPRF000123', reason: '会员储值退回', notify_url: cfg.notifyUrl, amount: { refund: 50000, total: 300000, currency: 'CNY' } });
  });

  it('退款原因超过 80 个字截掉、空的不带；金额、单号不对的不发；微信拒绝的带回错误码（例如商户号余额不够）', async () => {
    const { fetchImpl, calls } = fakeWxPay((c) =>
      (c.body as { out_refund_no?: string } | null)?.out_refund_no === 'MPRF-POOR' ? { status: 403, body: { code: 'NOT_ENOUGH', message: '基本账户余额不足' } } : { status: 200, body: refundBody() },
    );
    const client = createWxPayClient(cfg, fetchImpl);
    await client.refund(input({ reason: '退'.repeat(100) }));
    expect([...(calls[0]!.body as { reason: string }).reason]).toHaveLength(80);
    await client.refund(input({ reason: '  ' }));
    expect(calls[1]!.body).not.toHaveProperty('reason');
    for (const bad of [{ refundCents: 0 }, { refundCents: 300001 }, { refundCents: 1.5 }, { outRefundNo: '退款单' }, { outRefundNo: 'x'.repeat(65) }, { outTradeNo: 'a' }]) {
      await expect(client.refund(input(bad))).rejects.toMatchObject({ code: 'WXPAY_BAD_INPUT' });
    }
    expect(calls).toHaveLength(2);
    await expect(client.refund(input({ outRefundNo: 'MPRF-POOR' }))).rejects.toMatchObject({ code: 'NOT_ENOUGH', status: 403 });
    expect(OUT_REFUND_NO.test('MPRF20261105-0001@A|*_')).toBe(true);
    expect(OUT_REFUND_NO.test('')).toBe(false);
  });

  it('查退款：路径里是商户退款单号、也在签名里；没有这一笔返回 null；应答不是微信支付签的不认', async () => {
    const { fetchImpl, calls } = fakeWxPay((c) =>
      c.path.endsWith('/MPRF-NONE')
        ? { status: 404, body: { code: 'RESOURCE_NOT_EXISTS', message: '退款单不存在' } }
        : { status: 200, body: refundBody({ status: 'SUCCESS', success_time: '2026-11-05T10:00:05+08:00' }) },
    );
    const client = createWxPayClient(cfg, fetchImpl);
    expect(await client.queryRefund('MPRF000123')).toMatchObject({ status: 'SUCCESS', successTime: '2026-11-05T10:00:05+08:00', userReceivedAccount: '支付用户零钱' });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/v3/refund/domestic/refunds/MPRF000123', signedByMerchant: true });
    expect(await client.queryRefund('MPRF-NONE')).toBeNull();
    await expect(client.queryRefund('退款单')).rejects.toMatchObject({ code: 'WXPAY_BAD_INPUT' });
    const forged = createWxPayClient(cfg, fakeWxPay(() => ({ status: 200, body: refundBody() }), stranger.privateKey).fetchImpl);
    await expect(forged.queryRefund('MPRF000123')).rejects.toMatchObject({ code: 'WXPAY_BAD_SIGNATURE' });
  });

  it('退款通知：验签、解密（附加数据是 refund）后拿到退款，状态字段是 refund_status；支付以外的事件不当作订单，也不报错', () => {
    const plain = {
      mchid: cfg.mchId,
      transaction_id: '4200000985202611040123456789',
      out_trade_no: 'MP20261104000001',
      refund_id: '50000000382019052709732678859',
      out_refund_no: 'MPRF000123',
      refund_status: 'SUCCESS',
      success_time: '2026-11-05T10:00:05+08:00',
      user_received_account: '支付用户零钱',
      amount: { total: 300000, refund: 50000, payer_total: 300000, payer_refund: 50000 },
    };
    const resource = { ...encrypt(JSON.stringify(plain), API_V3_KEY, 'refundnonce1', 'refund'), original_type: 'refund' };
    const body = JSON.stringify({ id: 'EV-REFUND-1', create_time: '2026-11-05T10:00:06+08:00', event_type: 'REFUND.SUCCESS', resource_type: 'encrypt-resource', resource, summary: '退款成功' });
    expect(parseNotification(cfg, wechatSign(body), body)).toMatchObject({
      eventType: 'REFUND.SUCCESS',
      transaction: null,
      refund: { outRefundNo: 'MPRF000123', outTradeNo: 'MP20261104000001', status: 'SUCCESS', refund: 50000, total: 300000 },
    });
    const other = JSON.stringify({ id: 'EV-OTHER-1', create_time: '2026-11-05T10:00:06+08:00', event_type: 'SOMETHING.ELSE', resource_type: 'encrypt-resource', resource: encrypt('{"hello":1}'), summary: '' });
    expect(parseNotification(cfg, wechatSign(other), other)).toMatchObject({ eventType: 'SOMETHING.ELSE', transaction: null, refund: null });
    const broken = JSON.stringify({ ...JSON.parse(body), resource: { ...encrypt('{"refund_id":"x"}', API_V3_KEY, 'refundnonce2', 'refund'), original_type: 'refund' } });
    expect(() => parseNotification(cfg, wechatSign(broken), broken)).toThrow(expect.objectContaining({ code: 'WXPAY_BAD_RESPONSE' }));
  });

  it('模拟微信支付：同一个退款单号同样内容回同一笔、内容不同拒绝；退超了、没付的、余额不够都拒；处理中到有结果发退款通知；账单记付款与退款两行', async () => {
    const mock = createMockWxPay();
    const c = mock.client;
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    await c.jsapiOrder({ outTradeNo: 'MPR20261105AAAAAAAAAA', description: '会员充值', amountCents: 300000, payerOpenid: 'openid-refund-1', expiresAt });
    await c.jsapiOrder({ outTradeNo: 'MPR20261105BBBBBBBBBB', description: '会员充值', amountCents: 10000, payerOpenid: 'openid-refund-2', expiresAt });
    await expect(c.refund({ outTradeNo: 'MPR20261105BBBBBBBBBB', outRefundNo: 'RF-UNPAID', reason: '', refundCents: 100, totalCents: 10000 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(c.refund({ outTradeNo: 'MPR20261105CCCCCCCCCC', outRefundNo: 'RF-NONE', reason: '', refundCents: 100, totalCents: 10000 })).rejects.toMatchObject({ code: 'RESOURCE_NOT_EXISTS', status: 404 });
    mock.pay('MPR20261105AAAAAAAAAA');
    const first = await c.refund({ outTradeNo: 'MPR20261105AAAAAAAAAA', outRefundNo: 'RF-0001', reason: '储值退回', refundCents: 100000, totalCents: 300000 });
    expect(first).toMatchObject({ status: 'PROCESSING', refund: 100000, total: 300000 });
    expect((await c.refund({ outTradeNo: 'MPR20261105AAAAAAAAAA', outRefundNo: 'RF-0001', reason: '储值退回', refundCents: 100000, totalCents: 300000 })).refundId).toBe(first.refundId);
    await expect(c.refund({ outTradeNo: 'MPR20261105AAAAAAAAAA', outRefundNo: 'RF-0001', reason: '', refundCents: 200000, totalCents: 300000 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(c.refund({ outTradeNo: 'MPR20261105AAAAAAAAAA', outRefundNo: 'RF-0002', reason: '', refundCents: 200001, totalCents: 300000 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(c.refund({ outTradeNo: 'MPR20261105AAAAAAAAAA', outRefundNo: 'RF-0002', reason: '', refundCents: 100, totalCents: 299999 })).rejects.toMatchObject({ code: 'PARAM_ERROR' });
    mock.setNotEnough(true);
    await expect(c.refund({ outTradeNo: 'MPR20261105AAAAAAAAAA', outRefundNo: 'RF-0002', reason: '', refundCents: 100, totalCents: 300000 })).rejects.toMatchObject({ code: 'NOT_ENOUGH', status: 403 });
    mock.setNotEnough(false);
    expect(await c.queryRefund('RF-0002')).toBeNull();
    expect((await c.queryOrder('MPR20261105AAAAAAAAAA'))!.tradeState).toBe('REFUND');
    // 处理中 → 成功：退款通知照真的签名、加密，门店系统同一个验签解密的路认得
    const notice = mock.settleRefund('RF-0001', 'SUCCESS');
    const n = parseNotification(mock.config, notice.headers, notice.body);
    expect(n).toMatchObject({ eventType: 'REFUND.SUCCESS', transaction: null, refund: { outRefundNo: 'RF-0001', status: 'SUCCESS', refund: 100000 } });
    expect(mock.refundState('RF-0001')).toBe('SUCCESS');
    expect(await c.queryRefund('RF-0001')).toMatchObject({ status: 'SUCCESS', refundId: first.refundId });
    expect(() => mock.settleRefund('RF-0001', 'CLOSED')).toThrow();
    // 马上成功的一笔；处理中后来关闭的一笔不占可退金额；异常的占着（要到商户平台处理）
    mock.setRefundMode('success');
    expect(await c.refund({ outTradeNo: 'MPR20261105AAAAAAAAAA', outRefundNo: 'RF-0003', reason: '', refundCents: 50000, totalCents: 300000 })).toMatchObject({ status: 'SUCCESS' });
    mock.setRefundMode('processing');
    await c.refund({ outTradeNo: 'MPR20261105AAAAAAAAAA', outRefundNo: 'RF-0004', reason: '', refundCents: 100000, totalCents: 300000 });
    const closed = mock.settleRefund('RF-0004', 'CLOSED');
    expect(parseNotification(mock.config, closed.headers, closed.body)).toMatchObject({ eventType: 'REFUND.CLOSED', refund: { status: 'CLOSED' } });
    await c.refund({ outTradeNo: 'MPR20261105AAAAAAAAAA', outRefundNo: 'RF-0005', reason: '', refundCents: 100000, totalCents: 300000 });
    const abnormal = mock.settleRefund('RF-0005', 'ABNORMAL');
    expect(parseNotification(mock.config, abnormal.headers, abnormal.body)).toMatchObject({ eventType: 'REFUND.ABNORMAL', refund: { status: 'ABNORMAL' } });
    await c.refund({ outTradeNo: 'MPR20261105AAAAAAAAAA', outRefundNo: 'RF-0006', reason: '', refundCents: 50000, totalCents: 300000 });
    mock.settleRefund('RF-0006', 'SUCCESS');
    await expect(c.refund({ outTradeNo: 'MPR20261105AAAAAAAAAA', outRefundNo: 'RF-0007', reason: '', refundCents: 1, totalCents: 300000 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    // 交易账单：付款那天一行「支付成功」（之后退了也照样有）；每笔退款成功的那天一行「转入退款」，关闭、异常的不出现
    const payDay = (await c.queryOrder('MPR20261105AAAAAAAAAA'))!.successTime!.slice(0, 10);
    expect((await c.tradeBill(payDay)).filter((r) => r.outTradeNo === 'MPR20261105AAAAAAAAAA' && r.tradeState === 'SUCCESS')).toHaveLength(1);
    for (const [no, cents] of [['RF-0001', 100000], ['RF-0003', 50000], ['RF-0006', 50000]] as const) {
      const day = (await c.queryRefund(no))!.successTime!.slice(0, 10);
      expect((await c.tradeBill(day)).find((r) => r.outRefundNo === no)).toMatchObject({ tradeState: 'REFUND', outTradeNo: 'MPR20261105AAAAAAAAAA', refundAmount: cents, refundStatus: 'SUCCESS' });
    }
    const days = new Set([payDay, rfc3339Beijing(new Date()).slice(0, 10)]);
    for (const day of days) expect((await c.tradeBill(day)).some((r) => r.outRefundNo === 'RF-0004' || r.outRefundNo === 'RF-0005')).toBe(false);
  });
});
