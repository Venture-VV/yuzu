import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { businessDateOf, ISO_DATE } from '@shared/business-date';
import { ENTRY_TYPE_LABELS, ENTRY_TYPES, PAYMENT_METHOD_LABELS, type EntryType } from '@shared/labels';
import { formatAmount } from '@shared/money';
import { can } from '@shared/permissions';
import type { LedgerRow } from '@shared/types';
import type { Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { forbidden } from '../lib/errors';
import { toCsv, CSV_TYPE, attachment } from '../lib/csv';
import { parse } from '../lib/validate';
import { loadSettings } from './settings';

export interface LedgerFilter {
  date?: string;
  /** 营业日起止（含两头，8.0.4 会员的充值记录、消费记录） */
  from?: string;
  to?: string;
  memberId?: number;
  type?: EntryType;
  /** 几种余额流水（8.0.4 会员的充值记录、消费记录） */
  types?: readonly EntryType[];
  staffId?: number;
  q?: string;
  limit?: number;
}

export async function listLedger(db: Db, f: LedgerFilter): Promise<LedgerRow[]> {
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  return db<LedgerRow[]>`
    SELECT le.id, le.entry_type, le.doc_no, le.member_id, m.member_no, m.name AS member_name, m.phone AS member_phone,
           le.principal_delta, le.bonus_delta, le.principal_after, le.bonus_after, le.business_date, le.created_at,
           coalesce(s.display_name, '系统') AS operator_name, le.recharge_id, le.consumption_id, le.reversal_id, le.expiry_id, le.opening_id,
           r.paid_amount, r.payment_method,
           CASE WHEN le.entry_type = 'consume' THEN c.status END AS consumption_status,
           CASE WHEN le.entry_type = 'consume' THEN k.checkout_no END AS checkout_no,
           CASE le.entry_type WHEN 'consume' THEN rv.doc_no WHEN 'reversal' THEN c.doc_no END AS related_doc_no,
           CASE WHEN le.entry_type = 'reversal' THEN c.business_date END AS related_business_date,
           coalesce(CASE le.entry_type
             WHEN 'recharge' THEN coalesce(r.plan_name, '自定义充值')
             WHEN 'consume' THEN (
               SELECT string_agg(l.name || CASE WHEN l.quantity > 1 THEN ' ×' || l.quantity ELSE '' END, '、' ORDER BY l.id)
               FROM consumption_lines l WHERE l.consumption_id = c.id)
             WHEN 'reversal' THEN rv.reason
             WHEN 'expire' THEN '赠金到期作废' || CASE WHEN ex.reversal_id IS NOT NULL THEN '（撤销恢复时已过期）' ELSE '' END
             WHEN 'opening' THEN oi.source || ' 期初余额' || CASE WHEN ob.legacy_no <> '' THEN ' · 旧卡号 ' || ob.legacy_no ELSE '' END
             WHEN 'opening_void' THEN '作废期初：' || ob.void_reason
             WHEN 'refund' THEN '储值退回：' || mr.reason
             WHEN 'merge_out' THEN '合并到 ' || mt.name || '（' || mt.member_no || '）'
             WHEN 'merge_in' THEN '合并转入：' || ms.name || '（' || ms.member_no || '）'
           END, '') AS summary
    FROM ledger_entries le
    JOIN members m ON m.id = le.member_id
    LEFT JOIN staff s ON s.id = le.operator_id
    LEFT JOIN recharges r ON r.id = le.recharge_id
    LEFT JOIN bonus_expiries ex ON ex.id = le.expiry_id
    LEFT JOIN opening_balances ob ON ob.id = le.opening_id
    LEFT JOIN opening_imports oi ON oi.id = ob.import_id
    LEFT JOIN consumptions c ON c.id = le.consumption_id
    LEFT JOIN checkouts k ON k.id = c.checkout_id
    LEFT JOIN reversals rv ON rv.consumption_id = le.consumption_id
    LEFT JOIN member_refunds mr ON mr.id = le.member_refund_id
    LEFT JOIN member_merges mg ON mg.id = le.member_merge_id
    LEFT JOIN members ms ON ms.id = mg.source_id
    LEFT JOIN members mt ON mt.id = mg.target_id
    WHERE true
      ${f.date ? db`AND le.business_date = ${f.date}` : db``}
      ${f.memberId ? db`AND le.member_id = ${f.memberId}` : db``}
      ${f.type ? db`AND le.entry_type = ${f.type}` : db``}
      ${f.types ? db`AND le.entry_type IN ${db(f.types.length ? [...f.types] : ['-'])}` : db``}
      ${f.from ? db`AND le.business_date >= ${f.from}` : db``}
      ${f.to ? db`AND le.business_date <= ${f.to}` : db``}
      ${f.staffId ? db`AND le.operator_id = ${f.staffId}` : db``}
      ${like ? db`AND (m.name ILIKE ${like} OR m.phone LIKE ${like} OR m.member_no ILIKE ${like} OR le.doc_no ILIKE ${like})` : db``}
    ORDER BY le.id DESC
    ${f.limit ? db`LIMIT ${f.limit}` : db``}`;
}

const LedgerQuery = z.object({
  date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional(),
  type: z.enum(ENTRY_TYPES).optional(),
  staffId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(32).optional(),
});

/** 当前营业日所有岗位可看；历史营业日需要对应权限。返回实际查询的营业日。 */
export async function resolveReadableDate(deps: Deps, req: FastifyRequest, date: string | undefined): Promise<string> {
  const settings = await loadSettings(deps.sql);
  const today = businessDateOf(new Date(), deps.config.timezone, settings.businessDayStartHour);
  const target = date ?? today;
  if (target !== today && !can(req.actor, 'ledger.readHistory')) {
    throw forbidden('当前岗位只能查看本营业日的记录');
  }
  return target;
}

export function ledgerCsv(rows: LedgerRow[], timeZone: string): string {
  const header = [
    '营业日', '时间', '单号', '类型', '会员号', '会员', '手机号', '实收金额', '收款方式',
    '本金变动', '赠金变动', '本金余额', '赠金余额', '操作人', '关联单号', '内容/原因', '状态',
  ];
  const time = (iso: string) =>
    new Date(iso).toLocaleString('zh-CN', { timeZone, hour12: false });
  const body = [...rows].reverse().map((r) => [
    r.businessDate,
    time(r.createdAt),
    r.docNo,
    ENTRY_TYPE_LABELS[r.entryType],
    r.memberNo,
    r.memberName,
    r.memberPhone,
    r.paidAmount == null ? '' : formatAmount(r.paidAmount),
    r.paymentMethod ? PAYMENT_METHOD_LABELS[r.paymentMethod] : '',
    (r.principalDelta < 0 ? '-' : '') + formatAmount(r.principalDelta),
    (r.bonusDelta < 0 ? '-' : '') + formatAmount(r.bonusDelta),
    formatAmount(r.principalAfter),
    formatAmount(r.bonusAfter),
    r.operatorName,
    r.relatedDocNo ?? '',
    r.summary,
    r.entryType === 'consume' ? (r.consumptionStatus === 'reversed' ? '已撤销' : '已完成') : '已完成',
  ]);
  return toCsv([header, ...body]);
}

export function registerLedgerRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  app.get('/api/ledger', { preHandler: guard('ledger.readToday') }, async (req) => {
    const query = parse(LedgerQuery, req.query);
    const date = await resolveReadableDate(deps, req, query.date);
    return listLedger(sql, { ...query, date });
  });

  app.get('/api/ledger/export', { preHandler: guard('ledger.export') }, async (req, reply) => {
    const query = parse(LedgerQuery, req.query);
    const date = await resolveReadableDate(deps, req, query.date);
    const rows = await listLedger(sql, { date });
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'ledger', targetId: date, ip: req.ip });
    attachment(reply, `浴族流水-${date}.csv`, CSV_TYPE);
    return ledgerCsv(rows, deps.config.timezone);
  });
}
