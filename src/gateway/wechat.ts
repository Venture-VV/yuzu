// 微信接口（小程序线）：wx.login 的 code 换 openid（code2Session），手机号快速验证的 code 换手机号（getuserphonenumber），
// 发订阅消息（subscribeMessage.send，第三期 3a 到期提醒）。
// AppSecret 只在网关的 .env；接口调用凭据（stable_token）缓存到快过期前 5 分钟，微信说凭据失效时重取一次。
// 模拟微信（MP_MOCK_WECHAT=true）：code 写成 mock-<名字>、手机号 code 写成 mock-phone-<11 位手机号>，只给本机与测试服的演示库用；
// 模拟的订阅消息记在 sent 里，openid 带 refuse 的当顾客拒收、带 busy 的当微信忙。

export class WechatError extends Error {
  constructor(readonly code: 'WX_LOGIN_FAILED' | 'WX_PHONE_FAILED', message: string) {
    super(message);
  }
}

/** 一条订阅消息：发给谁、哪个模板、点开进哪一页、各个字段；state 是跳到正式版、体验版还是开发版 */
export interface SubscribeMessage {
  touser: string;
  templateId: string;
  page: string;
  data: Record<string, { value: string }>;
  state: 'formal' | 'trial' | 'developer';
}

/**
 * 发送结果：sent 发出；failed 微信明确拒绝（顾客拒收或次数用完、openid / 模板 / 字段 / 页面不对），不再发；
 * retry 没发出去（微信忙、频率限制、拿不到接口凭据、连不上），可以再试；unknown 发了没收到回音（超时），不再发
 */
export interface SubscribeResult {
  outcome: 'sent' | 'failed' | 'retry' | 'unknown';
  errcode: number | null;
  errmsg: string | null;
}

export interface WechatClient {
  /** 小程序登录：返回 openid */
  login(code: string): Promise<{ openid: string }>;
  /** 手机号快速验证：返回中国大陆的 11 位手机号 */
  phoneNumber(phoneCode: string): Promise<{ phone: string }>;
  /** 发一条订阅消息（不抛错，结果见 SubscribeResult） */
  sendSubscribe(msg: SubscribeMessage): Promise<SubscribeResult>;
  readonly mock: boolean;
}

/** 微信明确拒绝、不要再发的错误码：顾客拒收或没有次数、openid 不对、模板不对、字段不对、页面不对、模板不能用、内容里有敏感词 */
const SUBSCRIBE_FINAL = new Set([43101, 40003, 40037, 47003, 41030, 43107, 47001, 45168]);
/** 请求还没到微信的几种连接错误 */
const NOT_REACHED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const causeCode = (error: unknown) => String((error as { cause?: { code?: unknown }; code?: unknown }).cause?.code ?? (error as { code?: unknown }).code ?? '');
/** 接口凭据失效：重取一次再发 */
const TOKEN_INVALID = new Set([40001, 40014, 42001]);

export function classifySubscribe(errcode: number, errmsg: string | null): SubscribeResult {
  if (errcode === 0) return { outcome: 'sent', errcode: null, errmsg: null };
  return { outcome: SUBSCRIBE_FINAL.has(errcode) ? 'failed' : 'retry', errcode, errmsg };
}

export interface MockWechatClient extends WechatClient {
  /** 模拟发出去的订阅消息（测试与演示库看） */
  readonly sent: SubscribeMessage[];
}

export function createMockWechat(): MockWechatClient {
  const sent: SubscribeMessage[] = [];
  return {
    mock: true,
    sent,
    async sendSubscribe(msg) {
      if (msg.touser.includes('refuse')) return { outcome: 'failed', errcode: 43101, errmsg: 'user refuse to accept the msg' };
      if (msg.touser.includes('busy')) return { outcome: 'retry', errcode: -1, errmsg: 'system error' };
      sent.push(msg);
      return { outcome: 'sent', errcode: null, errmsg: null };
    },
    async login(code) {
      const m = /^mock-([A-Za-z0-9_-]{1,40})$/.exec(code);
      if (!m) throw new WechatError('WX_LOGIN_FAILED', '微信登录没成功，请重新打开小程序');
      return { openid: `mock_${m[1]}` };
    },
    async phoneNumber(phoneCode) {
      const m = /^mock-phone-(1\d{10})$/.exec(phoneCode);
      if (!m) throw new WechatError('WX_PHONE_FAILED', '手机号验证没成功，请再试一次');
      return { phone: m[1]! };
    },
  };
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const WX = 'https://api.weixin.qq.com';

export function createWechat(appId: string, appSecret: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): WechatClient {
  let token: { value: string; until: number } | null = null;
  const getJson = async (url: string, init?: Parameters<FetchLike>[1]) => {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8_000) });
    return (await res.json()) as Record<string, unknown>;
  };
  const accessToken = async (fresh = false) => {
    if (!fresh && token && token.until > Date.now()) return token.value;
    const r = await getJson(`${WX}/cgi-bin/stable_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credential', appid: appId, secret: appSecret }),
    });
    if (typeof r.access_token !== 'string') throw new WechatError('WX_PHONE_FAILED', '微信接口暂时不可用，请稍后再试');
    token = { value: r.access_token, until: Date.now() + (Number(r.expires_in ?? 7200) - 300) * 1000 };
    return token.value;
  };
  return {
    mock: false,
    async sendSubscribe(msg) {
      const body = JSON.stringify({ touser: msg.touser, template_id: msg.templateId, page: msg.page, data: msg.data, miniprogram_state: msg.state, lang: 'zh_CN' });
      for (let attempt = 0; attempt < 2; attempt++) {
        let at: string;
        try {
          at = await accessToken(attempt > 0);
        } catch {
          // 拿不到接口凭据：这条还没发
          return { outcome: 'retry', errcode: null, errmsg: '拿不到微信的接口凭据' };
        }
        let r: Record<string, unknown>;
        try {
          r = await getJson(`${WX}/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(at)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });
        } catch (error) {
          // 连不上（请求还没到微信：域名解析不了、连接被拒）的可以再试；其余（超时、半路断开、回的不是 JSON）
          // 微信可能已经收到、发出去了，记结果不明、不再发（一次同意只能发一条）
          return NOT_REACHED.has(causeCode(error))
            ? { outcome: 'retry', errcode: null, errmsg: '连不上微信' }
            : { outcome: 'unknown', errcode: null, errmsg: (error as { name?: string }).name === 'TimeoutError' ? '等微信的回音超时' : '没收到微信的回音' };
        }
        const code = Number(r.errcode ?? 0);
        if (TOKEN_INVALID.has(code) && attempt === 0) {
          token = null;
          continue;
        }
        return classifySubscribe(code, typeof r.errmsg === 'string' ? r.errmsg : null);
      }
      return { outcome: 'retry', errcode: null, errmsg: '微信的接口凭据失效' };
    },
    async login(code) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(code)) throw new WechatError('WX_LOGIN_FAILED', '微信登录没成功，请重新打开小程序');
      const q = new URLSearchParams({ appid: appId, secret: appSecret, js_code: code, grant_type: 'authorization_code' });
      const r = await getJson(`${WX}/sns/jscode2session?${q}`);
      if (typeof r.openid !== 'string' || (r.errcode !== undefined && r.errcode !== 0)) throw new WechatError('WX_LOGIN_FAILED', '微信登录没成功，请重新打开小程序');
      return { openid: r.openid };
    },
    async phoneNumber(phoneCode) {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(phoneCode)) throw new WechatError('WX_PHONE_FAILED', '手机号验证没成功，请再试一次');
      const r = await getJson(`${WX}/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(await accessToken())}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: phoneCode }),
      });
      const info = r.phone_info as { purePhoneNumber?: unknown; countryCode?: unknown } | undefined;
      if (r.errcode !== 0 || !info) throw new WechatError('WX_PHONE_FAILED', '手机号验证没成功，请再试一次');
      const phone = String(info.purePhoneNumber ?? '');
      if (String(info.countryCode ?? '') !== '86' || !/^1\d{10}$/.test(phone)) throw new WechatError('WX_PHONE_FAILED', '只支持中国大陆的手机号，请到前台办理');
      return { phone };
    },
  };
}
