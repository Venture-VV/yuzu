import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditRecord } from '@shared/types';
import { guard } from '../auth/guard';
import type { Deps } from '../lib/context';
import { dateSchema, parse } from '../lib/validate';
import { storeIn } from '../lib/store-context';
import { withReportScope } from './stores';

const AuditQuery = z.object({
  /** 按自然日（门店时区）筛选 */
  date: dateSchema().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export function registerAuditRoutes(app: FastifyInstance, { sql, config }: Deps) {
  app.get('/api/audit', { preHandler: guard('audit.read') }, async (req): Promise<AuditRecord[]> => {
    const { date, limit } = parse(AuditQuery, req.query);
    return withReportScope(sql, req, () => sql<AuditRecord[]>`
      SELECT a.id, a.action, s.display_name AS staff_name, a.target_type, a.target_id, a.detail, a.ip, a.created_at
      FROM audit_logs a LEFT JOIN staff s ON s.id = a.staff_id
      -- 审计按店看（8.0.22）：当前门店的；店主「合并看」（?scope=all）看能进的几家店
      WHERE ${storeIn(sql, 'a.store_id')}
      ${date ? sql`AND (a.created_at AT TIME ZONE ${config.timezone})::date = ${date}` : sql``}
      ORDER BY a.id DESC LIMIT ${limit}`);
  });
}
