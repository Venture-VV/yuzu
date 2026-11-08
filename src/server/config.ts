// 运行配置全部来自环境变量；本地开发可放在 .env（不进入 Git）。

import { SETTABLE_INSTANCES, type InstanceKind } from '@shared/instance';

export type AppEnv = 'development' | 'trial' | 'production' | 'test';

export interface AppConfig {
  env: AppEnv;
  host: string;
  port: number;
  databaseUrl: string;
  timezone: string;
  sessionTtlHours: number;
  cookieSecure: boolean;
  /** 前面的反向代理（Caddy）的地址（TRUST_PROXY，逗号分隔、可写网段）：认它转来的真实来源 IP 与 https；空为不信任转发头 */
  trustProxy: string[];
  logLevel: string;
  /** 页面显示的版本号（不带开头的 v） */
  version: string;
  /** 构建时写入的提交 SHA；直接构建、没有传入时为空 */
  commit: string;
  /** 实例标识（YUZU_INSTANCE） */
  instance: InstanceKind;
  initOwner: { username: string; password: string; displayName: string } | null;
  /** 微信小程序（小程序线，docs/MINIPROGRAM.md 第 12 节）：单开的小程序端口，只挂给网关的 /api/mp/*；没设 MP_PORT 就不开 */
  mp: MpConfig;
  /** 员工食堂 · 柚子饭堂（docs/CANTEEN.md）：单开的员工端口，只挂柚子饭堂的页面与 /api/canteen/*；没设 CANTEEN_PORT 就不开 */
  canteen: CanteenConfig;
}

export interface CanteenConfig {
  port: number | null;
  host: string;
  /** 饭卡码的密钥（CANTEEN_CODE_SECRET）：员工的码钥匙由它算出；只在 yuzu */
  codeSecret: string | null;
  /** 员工端走 HTTPS 时设 true（Cookie 加 Secure；店里局域网用 http 打开的不加，K18）。https 打开的不设也加 */
  cookieSecure: boolean;
  /** 前面的转发服务器（Caddy）的地址：限次按它转来的真实来源 IP 算；空为不信任转发头 */
  trustProxy: string[];
}

/** 员工端口：没设 CANTEEN_PORT 不开；开了就必须配足够长的饭卡码密钥，端口不能与员工后台、小程序端口相同 */
export function loadCanteenConfig(env: NodeJS.ProcessEnv, mainPort: number, mpPort: number | null): CanteenConfig {
  const host = env.CANTEEN_HOST?.trim() || env.HOST || '0.0.0.0';
  const codeSecret = env.CANTEEN_CODE_SECRET?.trim() || null;
  const cookieSecure = env.CANTEEN_COOKIE_SECURE === 'true';
  const trustProxy = (env.CANTEEN_TRUST_PROXY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const raw = env.CANTEEN_PORT?.trim();
  if (!raw) return { port: null, host, codeSecret, cookieSecure, trustProxy };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`CANTEEN_PORT 应为 1–65535 的端口号，当前是「${raw}」`);
  if (port === mainPort || port === mpPort) throw new Error('CANTEEN_PORT 不能与 PORT、MP_PORT 相同：员工端口只挂柚子饭堂');
  if (!codeSecret || codeSecret.length < 32) throw new Error('开了 CANTEEN_PORT 就要配 CANTEEN_CODE_SECRET（至少 32 个字符，可以用 openssl rand -hex 32 生成）');
  return { port, host, codeSecret, cookieSecure, trustProxy };
}

export interface MpConfig {
  port: number | null;
  host: string;
  /** 网关的服务密钥（MP_GATEWAY_KEY）：小程序端口只认它 */
  gatewayKey: string | null;
  /** 会员码的签名密钥（MP_CODE_SECRET）：只在 yuzu，网关不存 */
  codeSecret: string | null;
}

/** 小程序端口只有配了足够长的网关密钥才开；端口不能与员工用的 PORT 相同 */
export function loadMpConfig(env: NodeJS.ProcessEnv, mainPort: number): MpConfig {
  const host = env.MP_HOST?.trim() || env.HOST || '0.0.0.0';
  const gatewayKey = env.MP_GATEWAY_KEY?.trim() || null;
  const codeSecret = env.MP_CODE_SECRET?.trim() || null;
  if (codeSecret && codeSecret.length < 32) throw new Error('MP_CODE_SECRET 至少 32 个字符（可以用 openssl rand -hex 32 生成）');
  const raw = env.MP_PORT?.trim();
  if (!raw) return { port: null, host, gatewayKey, codeSecret };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`MP_PORT 应为 1–65535 的端口号，当前是「${raw}」`);
  if (port === mainPort) throw new Error('MP_PORT 不能与 PORT 相同：小程序端口只挂给网关的接口');
  if (!gatewayKey || gatewayKey.length < 32) throw new Error('开了 MP_PORT 就要配 MP_GATEWAY_KEY（至少 32 个字符，可以用 openssl rand -hex 32 生成）');
  return { port, host, gatewayKey, codeSecret };
}

function readEnvFile() {
  // 仅在开发时读取 .env；容器内由 docker compose 注入环境变量。
  try {
    process.loadEnvFile?.('.env');
  } catch {
    /* 没有 .env 时忽略 */
  }
}

/** YUZU_INSTANCE 没设置时按 APP_ENV 推出；正式环境不推断，页面显示「未设置实例标识」，提醒在 .env 里设置 */
export function resolveInstance(env: AppEnv, raw: string | undefined): InstanceKind {
  const value = raw?.trim();
  if (!value) return env === 'production' ? 'unset' : env === 'trial' ? 'trial' : 'dev';
  if (!(SETTABLE_INSTANCES as readonly string[]).includes(value)) {
    throw new Error(`YUZU_INSTANCE 只能是 ${SETTABLE_INSTANCES.join(' / ')}，当前是「${value}」`);
  }
  if (value === 'prod' && env !== 'production') {
    throw new Error('YUZU_INSTANCE=prod（正式服）只能用于 APP_ENV=production');
  }
  return value as InstanceKind;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  if (!overrides.databaseUrl) readEnvFile();
  const env = overrides.env ?? ((process.env.APP_ENV ?? 'development') as AppEnv);
  const databaseUrl = overrides.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('缺少 DATABASE_URL 环境变量，请参考 .env.example 配置数据库连接。');
  }
  const ownerUser = process.env.INIT_OWNER_USERNAME?.trim();
  const ownerPass = process.env.INIT_OWNER_PASSWORD;
  const mainPort = Number(process.env.PORT ?? 8080);
  const mp = overrides.mp ?? loadMpConfig(process.env, mainPort);
  return {
    env,
    host: process.env.HOST ?? '0.0.0.0',
    port: mainPort,
    databaseUrl,
    timezone: process.env.APP_TIMEZONE ?? 'Asia/Shanghai',
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    trustProxy: (process.env.TRUST_PROXY ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    logLevel: process.env.LOG_LEVEL ?? (env === 'test' ? 'silent' : 'info'),
    // update.sh 用 git describe 写入的版本带 v 前缀，页面统一加 v，这里去掉
    version: (process.env.APP_VERSION || '8.0.2').replace(/^v/, ''),
    commit: /^[0-9a-f]{7,40}$/.test(process.env.APP_COMMIT ?? '') ? process.env.APP_COMMIT! : '',
    instance: resolveInstance(env, process.env.YUZU_INSTANCE),
    initOwner:
      ownerUser && ownerPass
        ? { username: ownerUser, password: ownerPass, displayName: process.env.INIT_OWNER_NAME?.trim() || '店主' }
        : null,
    mp,
    canteen: overrides.canteen ?? loadCanteenConfig(process.env, mainPort, mp.port),
    ...overrides,
  };
}
