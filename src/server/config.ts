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
  return {
    env,
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 8080),
    databaseUrl,
    timezone: process.env.APP_TIMEZONE ?? 'Asia/Shanghai',
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    logLevel: process.env.LOG_LEVEL ?? (env === 'test' ? 'silent' : 'info'),
    // update.sh 用 git describe 写入的版本带 v 前缀，页面统一加 v，这里去掉
    version: (process.env.APP_VERSION || '0.7.26').replace(/^v/, ''),
    commit: /^[0-9a-f]{7,40}$/.test(process.env.APP_COMMIT ?? '') ? process.env.APP_COMMIT! : '',
    instance: resolveInstance(env, process.env.YUZU_INSTANCE),
    initOwner:
      ownerUser && ownerPass
        ? { username: ownerUser, password: ownerPass, displayName: process.env.INIT_OWNER_NAME?.trim() || '店主' }
        : null,
    mp: loadMpConfig(process.env, Number(process.env.PORT ?? 8080)),
    ...overrides,
  };
}
