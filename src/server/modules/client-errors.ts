// 页面报错（8.1.3，docs/RESILIENCE_V813.md 第 3.4 节，WL7）：页面出错、页面代码下载失败、没接住的异常由页面报上来，
// 写进日志，并在内存里留最近 200 条给店主在「网络与同步」页看（重启清空，不进数据库）。
// 不用登录（登录页也可能出错）；只收本站页面发来的（修改类请求的来源检查在 app.ts），每个 IP 每分钟最多 20 条，每条 8 KB 以内；
// 页面只报错误本身与地址（去掉查询参数），不带填的内容。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ClientErrorRecord } from '@shared/resilience';
import { guard } from '../auth/guard';
import { TokenBuckets } from '../lib/protect';
import { parse } from '../lib/validate';

const KEEP = 200;

const Report = z.object({
  kind: z.enum(['render', 'chunk', 'error', 'rejection']),
  message: z.string().trim().min(1).max(500),
  stack: z.string().max(4000).optional(),
  path: z.string().max(300),
  /** 这一页的入口文件（看是不是旧版本的页面） */
  entry: z.string().max(200).optional(),
});

export function registerClientErrorRoutes(app: FastifyInstance): void {
  const recent: ClientErrorRecord[] = [];
  const perIp = new TokenBuckets(20, 20 / 60);
  let seq = 0;

  app.post('/api/client-errors', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    if (!perIp.take(`ip:${req.ip}`).ok) {
      reply.code(429).header('retry-after', '60');
      return { error: { code: 'RATE_LIMITED', message: '报得太多了，先不收' } };
    }
    const input = parse(Report, req.body);
    const record: ClientErrorRecord = {
      id: ++seq,
      at: new Date().toISOString(),
      kind: input.kind,
      message: input.message,
      stack: input.stack?.slice(0, 1500) ?? null,
      path: input.path.split('?')[0]!.slice(0, 200),
      entry: input.entry ?? null,
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
      ip: req.ip,
      staff: req.actor ? { id: req.actor.id, name: req.actor.displayName } : null,
    };
    recent.unshift(record);
    if (recent.length > KEEP) recent.length = KEEP;
    req.log.warn({ clientError: { kind: record.kind, message: record.message, path: record.path, entry: record.entry, staffId: record.staff?.id ?? null, stack: record.stack?.slice(0, 600) } }, '页面报错');
    return { ok: true };
  });

  // 全店最近的页面报错：店主、店长（看审计的人）在「网络与同步」页看
  app.get('/api/client-errors', { preHandler: guard('audit.read') }, async (): Promise<ClientErrorRecord[]> => recent);
}
