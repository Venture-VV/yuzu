// 运行配置全部来自环境变量；本地开发可放在 .env（不进入 Git）。

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
  version: string;
  initOwner: { username: string; password: string; displayName: string } | null;
}

function readEnvFile() {
  // 仅在开发时读取 .env；容器内由 docker compose 注入环境变量。
  try {
    process.loadEnvFile?.('.env');
  } catch {
    /* 没有 .env 时忽略 */
  }
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  if (!overrides.databaseUrl) readEnvFile();
  const env = (process.env.APP_ENV ?? 'development') as AppEnv;
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
    version: process.env.APP_VERSION ?? '0.3.0',
    initOwner:
      ownerUser && ownerPass
        ? { username: ownerUser, password: ownerPass, displayName: process.env.INIT_OWNER_NAME?.trim() || '店主' }
        : null,
    ...overrides,
  };
}
