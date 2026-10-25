import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import type { AuditRecord } from '@shared/types';
import { guard } from '../auth/guard';
import type { Deps } from '../lib/context';
import { parse } from '../lib/validate';

const AuditQuery = z.object({
  /** 按自然日（门店时区）筛选 */
  date: z.string().regex(ISO_DATE).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export function registerAuditRoutes(app: FastifyInstance, { sql, config }: Deps) {
  app.get('/api/audit', { preHandler: guard('audit.read') }, async (req): Promise<AuditRecord[]> => {
    const { date, limit } = parse(AuditQuery, req.query);
    return sql<AuditRecord[]>`
      SELECT a.id, a.action, s.display_name AS staff_name, a.target_type, a.target_id, a.detail, a.ip, a.created_at
      FROM audit_logs a LEFT JOIN staff s ON s.id = a.staff_id
      ${date ? sql`WHERE (a.created_at AT TIME ZONE ${config.timezone})::date = ${date}` : sql``}
      ORDER BY a.id DESC LIMIT ${limit}`;
  });
}
