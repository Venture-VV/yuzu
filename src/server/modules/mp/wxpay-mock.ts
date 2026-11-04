// 模拟微信支付（小程序线第二期 2a，docs/MP_RECHARGE.md 第 4 节）：只在 development、test 实例用（MP_PAY_MOCK=true）。
// 本机生成「商户」与「微信支付」的两对密钥和 APIv3 密钥，照真的协议回应下单、查单、关单、交易账单、申请退款与查退款：
// 核对商户的签名、给应答签名。顾客「付款」时造一条照真的签名、加密的到账通知，交给门店系统同一条验签、解密、入账的路；
// 退款有了结果时同样造一条退款通知（2d）。不连外网。

import { createCipheriv, createHash, createVerify, generateKeyPairSync, randomInt, randomUUID } from 'node:crypto';
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
  state: 'NOTPAY' | 'SUCCESS' | 'CLOSED' | 'REFUND' | 'PAYERROR';
  transactionId: string | null;
  successTime: string | null;
}

interface MockRefund {
  outTradeNo: string;
  refundId: string;
  outRefundNo: string;
  refund: number;
  total: number;
  status: 'PROCESSING' | 'SUCCESS' | 'ABNORMAL' | 'CLOSED';
  createTime: string;
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
  /** 店里在商户平台把这一单退了（测试用）：之后查单是 REFUND */
  refund(outTradeNo: string): void;
  /** 这一次付款失败（例如银行拒了，测试用）：查单是 PAYERROR，之后还能再付 */
  payError(outTradeNo: string): void;
  /** 交易账单里不出现这一单（测试用：模拟「门店记了、微信账单里没有」） */
  hideFromBill(outTradeNo: string): void;
  /** 往某一天的交易账单里加一行（测试用：例如门店系统没有的一笔、金额不一样的一笔） */
  addBillRow(billDate: string, row: { outTradeNo: string; transactionId: string; amount: number; openid?: string; tradeState?: string; time?: string }): void;
  /** 申请退款时新的退款先「处理中」（默认，与真的一样多半先处理中）还是马上「成功」（测试用） */
  setRefundMode(mode: 'processing' | 'success'): void;
  /** 商户号的余额不够（测试用）：申请退款回 NOT_ENOUGH，退款不建 */
  setNotEnough(v: boolean): void;
  /** 处理中的退款有了结果（测试用）：成功、异常或关闭，返回一条退款通知 */
  settleRefund(outRefundNo: string, status: 'SUCCESS' | 'ABNORMAL' | 'CLOSED', now?: Date): { headers: WxSignedHeaders; body: string };
  /** 微信那边这笔退款的状态（测试用）；没有这一笔为 null */
  refundState(outRefundNo: string): MockRefund['status'] | null;
}

/** 交易账单的表头（微信支付「全部」账单的 27 列） */
const BILL_HEADER =
  '交易时间,公众账号ID,商户号,特约商户号,设备号,微信订单号,商户订单号,用户标识,交易类型,交易状态,付款银行,货币种类,应结订单金额,代金券金额,' +
  '微信退款单号,商户退款单号,退款金额,充值券退款金额,退款类型,退款状态,商品名称,商户数据包,手续费,费率,订单金额,申请退款金额,费率备注';
const billYuan = (cents: number) => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

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
  const refunds = new Map<string, MockRefund>();
  let refundMode: 'processing' | 'success' = 'processing';
  let notEnough = false;
  const extraBillRows = new Map<string, string[][]>();
  const hiddenFromBill = new Set<string>();
  const bills = new Map<string, string>();
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
    trade_state_desc: x.state === 'SUCCESS' ? '支付成功' : x.state === 'CLOSED' ? '订单已关闭' : x.state === 'REFUND' ? '转入退款' : '订单未支付',
    ...(x.successTime ? { success_time: x.successTime, bank_type: 'OTHERS' } : {}),
    payer: { openid: x.request.payer.openid },
    amount: {
      total: x.request.amount.total,
      payer_total: x.state === 'SUCCESS' || x.state === 'REFUND' ? x.request.amount.total : 0,
      currency: 'CNY',
      payer_currency: 'CNY',
    },
  });

  const refundOf = (r: MockRefund) => ({
    refund_id: r.refundId,
    out_refund_no: r.outRefundNo,
    transaction_id: orders.get(r.outTradeNo)?.transactionId ?? undefined,
    out_trade_no: r.outTradeNo,
    channel: 'ORIGINAL',
    user_received_account: '支付用户零钱',
    ...(r.successTime ? { success_time: r.successTime } : {}),
    create_time: r.createTime,
    status: r.status,
    funds_account: 'AVAILABLE',
    amount: { total: r.total, refund: r.refund, payer_total: r.total, payer_refund: r.refund, settlement_total: r.total, settlement_refund: r.refund, discount_refund: 0, currency: 'CNY', refund_fee: 0, from: [] },
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
        if (had.state === 'SUCCESS' || had.state === 'REFUND') return error(400, 'ORDERPAID', '该订单已支付');
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
      if (x.state === 'SUCCESS' || x.state === 'REFUND') return error(400, 'ORDERPAID', '订单已支付');
      x.state = 'CLOSED';
      return signed(204);
    }
    if (init.method === 'POST' && u.pathname === '/v3/refund/domestic/refunds') {
      const req = JSON.parse(body) as { out_trade_no?: string; transaction_id?: string; out_refund_no: string; amount: { refund: number; total: number } };
      const no = req.out_trade_no ?? [...orders].find(([, x]) => x.transactionId === req.transaction_id)?.[0];
      const x = no === undefined ? undefined : orders.get(no);
      if (no === undefined || !x) return error(404, 'RESOURCE_NOT_EXISTS', '订单不存在');
      const had = refunds.get(req.out_refund_no);
      if (had) {
        // 同一个商户退款单号：内容一样回同一笔，不一样拒绝
        if (had.outTradeNo !== no || had.refund !== req.amount.refund || had.total !== req.amount.total) return error(400, 'INVALID_REQUEST', '商户退款单号重复，退款内容不一致');
        return signed(200, refundOf(had));
      }
      if (x.state !== 'SUCCESS' && x.state !== 'REFUND') return error(400, 'INVALID_REQUEST', '订单未支付，不能退款');
      if (req.amount.total !== x.request.amount.total) return error(400, 'PARAM_ERROR', '订单金额与原订单不一致');
      const refunded = [...refunds.values()].filter((r) => r.outTradeNo === no && r.status !== 'CLOSED').reduce((a, r) => a + r.refund, 0);
      if (refunded + req.amount.refund > x.request.amount.total) return error(400, 'INVALID_REQUEST', '申请退款金额超过订单可退金额');
      if (notEnough) return error(403, 'NOT_ENOUGH', '基本账户余额不足，请充值后重新发起');
      const at = rfc3339Beijing(new Date());
      const r: MockRefund = {
        outTradeNo: no,
        refundId: `50${digits(27)}`,
        outRefundNo: req.out_refund_no,
        refund: req.amount.refund,
        total: req.amount.total,
        status: refundMode === 'success' ? 'SUCCESS' : 'PROCESSING',
        createTime: at,
        successTime: refundMode === 'success' ? at : null,
      };
      refunds.set(r.outRefundNo, r);
      x.state = 'REFUND';
      return signed(200, refundOf(r));
    }
    const rq = /^\/v3\/refund\/domestic\/refunds\/([^/]+)$/.exec(u.pathname);
    if (init.method === 'GET' && rq) {
      const r = refunds.get(decodeURIComponent(rq[1]!));
      if (!r) return error(404, 'RESOURCE_NOT_EXISTS', '退款单不存在');
      return signed(200, refundOf(r));
    }
    if (init.method === 'GET' && u.pathname === '/v3/bill/tradebill') {
      const date = u.searchParams.get('bill_date') ?? '';
      const rows: string[][] = [];
      for (const [no, x] of orders) {
        // 付款那天记一行「支付成功」（之后退了的也照样有这一行）；退款成功那天另记一行「转入退款」
        if ((x.state !== 'SUCCESS' && x.state !== 'REFUND') || !x.successTime || x.successTime.slice(0, 10) !== date || hiddenFromBill.has(no)) continue;
        const total = billYuan(x.request.amount.total);
        rows.push([
          x.successTime.slice(0, 19).replace('T', ' '), x.request.appid, x.request.mchid, '0', '', x.transactionId!, no, x.request.payer.openid,
          'JSAPI', 'SUCCESS', 'OTHERS', 'CNY', total, '0.00', '0', '0', '0.00', '0.00', '', '', x.request.description, '', '0.00', '0.60%', total, '0.00', '',
        ]);
      }
      for (const r of refunds.values()) {
        const x = orders.get(r.outTradeNo)!;
        if (r.status !== 'SUCCESS' || !r.successTime || r.successTime.slice(0, 10) !== date) continue;
        rows.push([
          r.successTime.slice(0, 19).replace('T', ' '), x.request.appid, x.request.mchid, '0', '', x.transactionId!, r.outTradeNo, x.request.payer.openid,
          'JSAPI', 'REFUND', 'OTHERS', 'CNY', '0.00', '0.00', r.refundId, r.outRefundNo, billYuan(r.refund), '0.00', 'ORIGINAL', 'SUCCESS', x.request.description, '', '0.00', '0.60%',
          billYuan(r.total), billYuan(r.refund), '',
        ]);
      }
      rows.push(...(extraBillRows.get(date) ?? []));
      if (!rows.length) return error(400, 'NO_STATEMENT_EXIST', '账单不存在');
      const csv = [BILL_HEADER, ...rows.map((r) => r.map((f) => `\`${f}`).join(',')), '总交易单数,应结订单总金额,退款总金额,充值券退款总金额,手续费总金额,订单总金额,申请退款总金额', `\`${rows.length},\`0.00,\`0.00,\`0.00,\`0.00,\`0.00,\`0.00`].join('\r\n');
      const token = randomText(24);
      bills.set(token, csv);
      return signed(200, { hash_type: 'SHA1', hash_value: createHash('sha1').update(csv, 'utf8').digest('hex'), download_url: `${config.baseUrl}/v3/billdownload/file?token=${token}` });
    }
    if (init.method === 'GET' && u.pathname === '/v3/billdownload/file') {
      const csv = bills.get(u.searchParams.get('token') ?? '');
      if (csv === undefined) return error(404, 'NOT_FOUND', '账单不存在');
      const bytes = Buffer.from(csv, 'utf8');
      return { status: 200, headers: { get: () => null }, text: async () => csv, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    }
    return error(404, 'NOT_FOUND', '接口不存在');
  };

  /** 照真的签名、加密一条通知：支付的 original_type 是 transaction，退款的是 refund（解密时的附加数据也是它） */
  const signedNotice = (eventType: string, summary: string, originalType: 'transaction' | 'refund', payload: Record<string, unknown>, now: Date) => {
    const nonce = randomText(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'));
    cipher.setAAD(Buffer.from(originalType, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
    const body = JSON.stringify({
      id: randomUUID(),
      create_time: rfc3339Beijing(now),
      resource_type: 'encrypt-resource',
      event_type: eventType,
      summary,
      resource: {
        original_type: originalType,
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext,
        associated_data: originalType,
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
  const notification = (transaction: Record<string, unknown>, now = new Date()) => signedNotice('TRANSACTION.SUCCESS', '支付成功', 'transaction', transaction, now);
  /** 退款通知的内容（解密后）：与查退款的应答不一样，状态字段叫 refund_status */
  const refundNotice = (r: MockRefund, now: Date) => {
    const x = orders.get(r.outTradeNo)!;
    return signedNotice(`REFUND.${r.status}`, r.status === 'SUCCESS' ? '退款成功' : r.status === 'ABNORMAL' ? '退款异常' : '退款关闭', 'refund', {
      mchid: config.mchId,
      transaction_id: x.transactionId,
      out_trade_no: r.outTradeNo,
      refund_id: r.refundId,
      out_refund_no: r.outRefundNo,
      refund_status: r.status,
      ...(r.successTime ? { success_time: r.successTime } : {}),
      user_received_account: '支付用户零钱',
      amount: { total: r.total, refund: r.refund, payer_total: r.total, payer_refund: r.refund },
    }, now);
  };

  return {
    config,
    client: createWxPayClient(config, fetchImpl),
    pay(outTradeNo, now = new Date()) {
      const x = orders.get(outTradeNo);
      if (!x) throw new Error(`模拟的微信支付里没有这一单：${outTradeNo}`);
      if (x.state === 'CLOSED') throw new Error('这一单已经关了，付不了');
      if (x.state === 'NOTPAY' || x.state === 'PAYERROR') {
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
    hideFromBill(no) {
      hiddenFromBill.add(no);
    },
    payError(no) {
      const x = orders.get(no);
      if (!x || x.state !== 'NOTPAY') throw new Error(`模拟的微信支付里这一单不是待支付：${no}`);
      x.state = 'PAYERROR';
    },
    refund(no) {
      const x = orders.get(no);
      if (!x || x.state !== 'SUCCESS') throw new Error(`模拟的微信支付里这一单没付，退不了：${no}`);
      x.state = 'REFUND';
    },
    setRefundMode(mode) {
      refundMode = mode;
    },
    setNotEnough(v) {
      notEnough = v;
    },
    settleRefund(outRefundNo, status, now = new Date()) {
      const r = refunds.get(outRefundNo);
      if (!r) throw new Error(`模拟的微信支付里没有这笔退款：${outRefundNo}`);
      if (r.status !== 'PROCESSING') throw new Error(`这笔退款已经有结果了：${r.status}`);
      r.status = status;
      if (status === 'SUCCESS') r.successTime = rfc3339Beijing(now);
      return refundNotice(r, now);
    },
    refundState: (no) => refunds.get(no)?.status ?? null,
    addBillRow(billDate, r) {
      const yuan = billYuan(r.amount);
      const row = [
        r.time ?? `${billDate} 12:00:00`, config.appId, config.mchId, '0', '', r.transactionId, r.outTradeNo, r.openid ?? 'openid-bill-extra',
        'JSAPI', r.tradeState ?? 'SUCCESS', 'OTHERS', 'CNY', yuan, '0.00', '0', '0', '0.00', '0.00', '', '', '会员充值', '', '0.00', '0.60%', yuan, '0.00', '',
      ];
      extraBillRows.set(billDate, [...(extraBillRows.get(billDate) ?? []), row]);
    },
  };
}
