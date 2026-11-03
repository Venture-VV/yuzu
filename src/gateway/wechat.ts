// 微信接口（小程序线）：wx.login 的 code 换 openid（code2Session），手机号快速验证的 code 换手机号（getuserphonenumber）。
// AppSecret 只在网关的 .env；接口调用凭据（stable_token）缓存到快过期前 5 分钟。
// 模拟微信（MP_MOCK_WECHAT=true）：code 写成 mock-<名字>、手机号 code 写成 mock-phone-<11 位手机号>，只给本机与测试服的演示库用。

export class WechatError extends Error {
  constructor(readonly code: 'WX_LOGIN_FAILED' | 'WX_PHONE_FAILED', message: string) {
    super(message);
  }
}

export interface WechatClient {
  /** 小程序登录：返回 openid */
  login(code: string): Promise<{ openid: string }>;
  /** 手机号快速验证：返回中国大陆的 11 位手机号 */
  phoneNumber(phoneCode: string): Promise<{ phone: string }>;
  readonly mock: boolean;
}

export function createMockWechat(): WechatClient {
  return {
    mock: true,
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
  const accessToken = async () => {
    if (token && token.until > Date.now()) return token.value;
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
