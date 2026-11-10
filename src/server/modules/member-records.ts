// 前台会员工作台的充值记录与消费记录（8.0.4 需求表 07，docs/MEMBERSHIP_V804.md 第 7 节，HY09）：原来的「余额记录」拆成两块，
// 都读余额流水（唯一的储值账本），各自按种类、营业日起止查询与导出；合计与明细是同一次查询条件算出来的。只读，不加锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import { ENTRY_TYPE_LABELS, PAYMENT_METHOD_LABELS, type EntryType } from '@shared/labels';
import { MAX_RECORD_ROWS, RECORD_SECTION_LABELS, RECORD_SECTIONS, SECTION_TYPES, type MemberRecords, type RecordSection, type RecordTotals } from '@shared/member-records';
import { formatAmount } from '@shared/money';
import { guard } from '../auth/guard';
import { readSnapshot, type Db } from '../db';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { csvReply, toCsv } from '../lib/csv';
import { badRequest } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { listLedger } from './ledger';
import { getMember } from './members';

const RecordsQuery = z
  .object({
    section: z.enum(RECORD_SECTIONS, '请选择充值记录或消费记录'),
    from: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional(),
    to: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional(),
    /** 逗号分隔的几种；不带是这一块的全部种类 */
    types: z.string().max(200).optional(),
  })
  .transform((q) => {
    const all = SECTION_TYPES[q.section];
    const picked = q.types ? q.types.split(',').map((t) => t.trim()).filter(Boolean) : [...all];
    const bad = picked.find((t) => !all.includes(t as EntryType));
    if (bad) throw badRequest(`「${RECORD_SECTION_LABELS[q.section]}」里没有「${bad}」这种记录`);
    if (q.from && q.to && q.from > q.to) throw badRequest('开始日期不能晚于结束日期');
    return { section: q.section, from: q.from ?? null, to: q.to ?? null, types: [...new Set(picked)] as EntryType[] };
  });

/** 合计：充值记录按余额增加记正数；消费记录按余额减少了多少记正数（撤销抵掉一部分） */
async function totalsOf(db: Db, memberId: number, q: { section: RecordSection; from: string | null; to: string | null; types: EntryType[] }): Promise<RecordTotals> {
  const sign = q.section === 'consume' ? -1 : 1;
  const rows = await db<{ entryType: EntryType; n: number; principal: number; bonus: number; paid: number }[]>`
    SELECT le.entry_type, count(*)::int AS n, coalesce(sum(le.principal_delta), 0) AS principal, coalesce(sum(le.bonus_delta), 0) AS bonus,
           coalesce(sum(r.paid_amount), 0) AS paid
    FROM ledger_entries le LEFT JOIN recharges r ON r.id = le.recharge_id
    WHERE le.member_id = ${memberId} AND le.entry_type IN ${db(q.types)}
      ${q.from ? db`AND le.business_date >= ${q.from}` : db``}
      ${q.to ? db`AND le.business_date <= ${q.to}` : db``}
    GROUP BY le.entry_type`;
  const out: RecordTotals = { count: 0, principal: 0, bonus: 0, total: 0, paid: 0, byType: {} };
  for (const r of rows) {
    const principal = sign * Number(r.principal);
    const bonus = sign * Number(r.bonus);
    out.count += r.n;
    out.principal += principal;
    out.bonus += bonus;
    out.total += principal + bonus;
    out.paid += Number(r.paid);
    out.byType[r.entryType] = { count: r.n, total: principal + bonus };
  }
  return out;
}

export async function memberRecords(db: Db, memberId: number, raw: unknown): Promise<MemberRecords> {
  const q = parse(RecordsQuery, raw);
  await getMember(db, memberId);
  const rows = await listLedger(db, { memberId, types: q.types, from: q.from ?? undefined, to: q.to ?? undefined, limit: MAX_RECORD_ROWS + 1 });
  return { ...q, rows: rows.slice(0, MAX_RECORD_ROWS), totals: await totalsOf(db, memberId, q), truncated: rows.length > MAX_RECORD_ROWS };
}

const signed = (cents: number) => (cents < 0 ? '-' : '') + formatAmount(cents);

export function registerMemberRecordRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/members/:id/records', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return readSnapshot(sql, (tx) => memberRecords(tx, id, req.query ?? {}));
  });
  // 两块分别导出（明细 + 最后一行合计）；前台对账、客诉用，能看会员的都能导出这一位的（HY09），导出留审计
  app.get('/api/members/:id/records.csv', { preHandler: guard('member.read') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const q = parse(RecordsQuery, req.query ?? {});
    const member = await getMember(sql, id);
    const { rows, totals } = await readSnapshot(sql, async (tx) => ({
      rows: await listLedger(tx, { memberId: id, types: q.types, from: q.from ?? undefined, to: q.to ?? undefined }),
      totals: await totalsOf(tx, id, q),
    }));
    await writeAudit(sql, {
      staffId: req.actor.id,
      action: 'member_records_exported',
      targetType: 'member',
      targetId: id,
      detail: { section: q.section, from: q.from, to: q.to, types: q.types, count: rows.length },
      ip: req.ip,
    });
    const time = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: deps.config.timezone, hour12: false });
    const body = [...rows].reverse().map((r) => [
      r.businessDate,
      time(r.createdAt),
      r.docNo,
      ENTRY_TYPE_LABELS[r.entryType],
      r.summary,
      r.paidAmount == null ? '' : formatAmount(r.paidAmount),
      r.paymentMethod ? PAYMENT_METHOD_LABELS[r.paymentMethod] : '',
      signed(r.principalDelta),
      signed(r.bonusDelta),
      formatAmount(r.principalAfter),
      formatAmount(r.bonusAfter),
      r.operatorName,
      r.entryType === 'consume' && r.consumptionStatus === 'reversed' ? `已撤销（${r.relatedDocNo ?? ''}）` : '',
    ]);
    const sum = ['合计', '', `${totals.count} 笔`, '', '', q.section === 'recharge' ? formatAmount(totals.paid) : '', '', signed(q.section === 'consume' ? -totals.principal : totals.principal), signed(q.section === 'consume' ? -totals.bonus : totals.bonus), '', '', '', ''];
    const csv = toCsv([['营业日', '时间', '单号', '类型', '内容', '实收', '收款方式', '本金变动', '赠金变动', '本金余额', '赠金余额', '经办人', '状态'], ...body, sum]);
    return csvReply(reply, `${member.name}-${RECORD_SECTION_LABELS[q.section]}${q.from || q.to ? `-${q.from ?? ''}至${q.to ?? ''}` : ''}.csv`, csv);
  });
}
