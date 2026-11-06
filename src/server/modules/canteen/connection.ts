import { AppError } from '../../lib/errors';

export interface CanteenConnection { url: string; syncKey: string }
export function loadCanteenConnection(env: NodeJS.ProcessEnv, appEnv: string): CanteenConnection | null {
  const raw = env.EMPLOYEE_PORTAL_URL?.trim();
  const syncKey = env.EMPLOYEE_SYNC_KEY?.trim();
  if (!raw && !syncKey) return null;
  if (!raw || !syncKey || syncKey.length < 32) throw new Error('员工服务需配置 EMPLOYEE_PORTAL_URL 与至少32字符 EMPLOYEE_SYNC_KEY');
  const url = new URL(raw);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && ['test', 'development'].includes(appEnv))) {
    throw new Error('员工服务必须使用 HTTPS；本地开发/测试的回环地址可使用 HTTP');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('EMPLOYEE_PORTAL_URL 只填写服务 origin');
  return { url: url.origin, syncKey };
}

export async function employeeRequest<T>(connection: CanteenConnection | null | undefined, path: string, body: unknown): Promise<T> {
  if (!connection) throw new AppError(503, 'EMPLOYEE_NOT_CONFIGURED', '尚未配置独立员工服务连接');
  let response: Response;
  try {
    response = await fetch(`${connection.url}${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: { 'content-type': 'application/json', 'x-employee-sync-key': connection.syncKey }, body: JSON.stringify(body),
    });
  } catch {
    throw new AppError(503, 'EMPLOYEE_UNREACHABLE', '员工服务暂不可达；写入结果待确认，请保留原请求重试');
  }
  const data = await response.json() as T & { error?: { code?: string; message?: string } };
  if (!response.ok) throw new AppError(response.status, data.error?.code ?? 'EMPLOYEE_ERROR', data.error?.message ?? '员工服务请求失败');
  return data;
}
