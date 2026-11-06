import { resolve } from 'node:path';

export interface EmployeeConfig {
  databaseUrl: string;
  host: string;
  port: number;
  syncKey: string;
  publicOrigin: string;
  production: boolean;
  secureCookie: boolean;
  instance: string;
  version: string;
  commit: string;
  staticRoot?: string;
  maxRosterAgeSeconds?: number;
  /** 只列实际反向代理的地址/CIDR；默认不信任客户端转发的 IP。 */
  trustedProxies?: string[];
}

export function loadEmployeeConfig(env: NodeJS.ProcessEnv = process.env): EmployeeConfig {
  const databaseUrl = env.EMPLOYEE_DATABASE_URL;
  if (!databaseUrl) throw new Error('必须显式设置独立员工数据库 EMPLOYEE_DATABASE_URL');
  if (databaseUrl === env.DATABASE_URL) throw new Error('员工服务禁止复用 ERP 的 DATABASE_URL');
  const production = env.NODE_ENV === 'production' || env.APP_ENV === 'production';
  const port = Number(env.EMPLOYEE_PORT ?? '18962');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('EMPLOYEE_PORT 无效');
  const syncKey = env.EMPLOYEE_SYNC_KEY ?? '';
  if (syncKey.length < 32 || new Set(syncKey).size < 12) {
    throw new Error('EMPLOYEE_SYNC_KEY 必须为至少 32 位的随机密钥');
  }
  const rawOrigin = env.PUBLIC_ORIGIN ?? (production ? '' : `http://127.0.0.1:${port}`);
  let origin: URL;
  try { origin = new URL(rawOrigin); } catch { throw new Error('PUBLIC_ORIGIN 必须是有效来源地址'); }
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) throw new Error('PUBLIC_ORIGIN 只能包含协议、主机与端口');
  if (production && origin.protocol !== 'https:') throw new Error('生产员工服务必须使用 HTTPS PUBLIC_ORIGIN');
  if (!production && origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw new Error('HTTP 仅允许本机开发，手机入口必须使用 HTTPS');
  }
  if (production && (!env.YUZU_INSTANCE || !env.BUILD_COMMIT)) throw new Error('生产服务必须设置 YUZU_INSTANCE 与 BUILD_COMMIT');
  return {
    databaseUrl, host: env.EMPLOYEE_HOST ?? '127.0.0.1', port, syncKey,
    publicOrigin: origin.origin, production, secureCookie: origin.protocol === 'https:',
    instance: env.YUZU_INSTANCE ?? 'employee-development',
    version: env.APP_VERSION ?? 'development', commit: env.BUILD_COMMIT ?? 'development',
    staticRoot: resolve(process.cwd(), 'dist/employee/client'), maxRosterAgeSeconds: 300,
    trustedProxies: env.EMPLOYEE_TRUST_PROXY?.split(',').map((value) => value.trim()).filter(Boolean),
  };
}
