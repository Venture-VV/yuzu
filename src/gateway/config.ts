// 小程序网关的配置（小程序线，docs/MINIPROGRAM.md 第 1、6 节）：全部来自环境变量，只放网关服务器的 .env，不进 GitHub。
// 网关是公网入口：微信登录、手机号验证、网关会话、限流、展示内容缓存；业务数据都在 yuzu，网关只转发。

export interface GatewayConfig {
  host: string;
  port: number;
  /** 网关前面有本机的 HTTPS 反向代理（nginx / Caddy）时为 true：按 X-Forwarded-For 认客户端 IP 限流 */
  trustProxy: boolean;
  /** yuzu 的小程序端口（经 Tailscale），例如 http://100.64.0.10:8081 */
  upstreamUrl: string;
  /** 与 yuzu 的 MP_GATEWAY_KEY 相同 */
  gatewayKey: string;
  /** 网关会话的签名密钥（只在网关） */
  sessionSecret: string;
  /** 网关会话有效天数（MP11，默认 7 天） */
  sessionDays: number;
  /** 模拟微信：假登录、假手机号（只给本机与测试服的演示库用；正式、演练的 yuzu 会拒绝模拟绑定） */
  mockWechat: boolean;
  wechat: { appId: string; appSecret: string } | null;
  logLevel: string;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const need = (key: string, min = 1) => {
    const v = env[key]?.trim();
    if (!v || v.length < min) throw new Error(`网关缺少 ${key}${min > 1 ? `（至少 ${min} 个字符）` : ''}`);
    return v;
  };
  const upstreamUrl = need('MP_UPSTREAM_URL').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(upstreamUrl)) throw new Error('MP_UPSTREAM_URL 应为 http(s)://主机:端口（yuzu 的小程序端口）');
  const mockWechat = env.MP_MOCK_WECHAT === 'true';
  const appId = env.WX_APPID?.trim() ?? '';
  const appSecret = env.WX_APPSECRET?.trim() ?? '';
  if (!mockWechat && (!appId || !appSecret)) throw new Error('网关要配 WX_APPID、WX_APPSECRET（或本机测试用 MP_MOCK_WECHAT=true）');
  const sessionDays = Number(env.MP_SESSION_DAYS ?? 7);
  if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 30) throw new Error('MP_SESSION_DAYS 应为 1–30 天');
  const port = Number(env.GATEWAY_PORT ?? 8300);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GATEWAY_PORT 应为 1–65535 的端口号');
  return {
    host: env.GATEWAY_HOST?.trim() || '127.0.0.1',
    port,
    trustProxy: env.GATEWAY_TRUST_PROXY === 'true',
    upstreamUrl,
    gatewayKey: need('MP_GATEWAY_KEY', 32),
    sessionSecret: need('MP_SESSION_SECRET', 32),
    sessionDays,
    mockWechat,
    wechat: appId && appSecret ? { appId, appSecret } : null,
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
