// 部门备用金台账（v0.7.29 ERP 采购五项③，E3，见 docs/ERP_PURCHASING.md 第 4 节）。
//
// 口径：余额 = 有效打款 − 用备用金的已确认报销 − 退回 + 补付 = 这个部门各笔打款的「未退回」之和（与每日平账同一口径）；
// 在手 = 余额为正的打款合计，待补付 = 为负的合计。台账按发生日期逐笔列出，每笔之后的余额 = 期初 + 累计进出。
// 部门的保管人、定额（可空）存在 petty_accounts（只放设置，余额都按单据算）；改设置只锁这一行、核对版本号。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PETTY_JOURNAL_LABELS,
  type PettyAccountRow,
  type PettyJournal,
  type PettyJournalEntry,
  type PettyJournalKind,
} from '@shared/expenses';
import { formatAmount } from '@shared/money';
import { PAY_METHOD_LABELS, type PayMethod } from '@shared/purchasing';
import { formatQty } from '@shared/quantity';
import { readSnapshot, type Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps } from '../lib/context';
import { csvReply, toCsv } from '../lib/csv';
import { checkDateRange, todayIn } from '../lib/dates';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { setTxTimeouts } from '../lib/tx';
import { docDateSchema } from './inventory/common';
import { advanceRows, listClaimsForAdvanceDept, loadExpenseRules, toAdvanceSummary } from './expenses';

const JOURNAL_LIMIT = 3000;
const yuan = (cents: number) => (cents < 0 ? '-' : '') + formatAmount(Math.abs(cents)).replace(/,/g, '');

/** 一个部门（或全部部门）备用金的每一笔进出：打款 +、用备用金的已确认报销 −、退回 −、补付 +（只算有效的） */
const events = (db: Db, departmentId: number | null) => db`
  SELECT 'advance'::text AS kind, a.advance_date AS date, a.doc_no, a.id AS ref_id, a.id AS advance_id, a.doc_no AS advance_no,
         a.department_id, a.handler_id, h.display_name AS handler_name, a.method::text AS method, a.evidence, NULL::text AS purpose,
         NULL::text AS channel_label, ''::text AS channel_note, NULL::text AS po_no, a.amount_cents AS delta_cents, 0 AS kind_order
  FROM petty_advances a JOIN staff h ON h.id = a.handler_id
  WHERE a.status = 'active' ${departmentId ? db`AND a.department_id = ${departmentId}` : db``}
  UNION ALL
  SELECT 'expense', c.expense_date, c.doc_no, c.id, a.id, a.doc_no, a.department_id, c.handler_id, h.display_name, NULL, '', c.purpose,
         c.channel_label, c.channel_note, po.doc_no, -c.amount_cents, 1
  FROM expense_claims c JOIN petty_advances a ON a.id = c.advance_id JOIN staff h ON h.id = c.handler_id
  LEFT JOIN purchase_orders po ON po.id = c.purchase_order_id
  WHERE c.status = 'confirmed' AND a.status = 'active' ${departmentId ? db`AND a.department_id = ${departmentId}` : db``}
  UNION ALL
  SELECT s.kind, s.settle_date, s.doc_no, s.id, a.id, a.doc_no, a.department_id, a.handler_id, h.display_name, s.method::text, s.evidence, NULL,
         NULL, '', NULL, CASE WHEN s.kind = 'topup' THEN s.amount_cents ELSE -s.amount_cents END, CASE WHEN s.kind = 'return' THEN 2 ELSE 3 END
  FROM petty_settlements s JOIN petty_advances a ON a.id = s.advance_id JOIN staff h ON h.id = a.handler_id
  WHERE s.status = 'active' AND a.status = 'active' ${departmentId ? db`AND a.department_id = ${departmentId}` : db``}`;

interface EventRow {
  kind: PettyJournalKind;
  date: string;
  docNo: string;
  refId: number;
  advanceId: number;
  advanceNo: string;
  departmentId: number;
  handlerId: number;
  handlerName: string;
  method: string | null;
  evidence: string;
  purpose: string | null;
  channelLabel: string | null;
  channelNote: string;
  poNo: string | null;
  deltaCents: number;
}

// ───────────────────────── 看板 ─────────────────────────

export async function listPettyAccounts(db: Db, timezone: string): Promise<PettyAccountRow[]> {
  const rules = await loadExpenseRules(db);
  const today = todayIn(timezone);
  const monthStart = `${today.slice(0, 8)}01`;
  const advances = (await advanceRows(db, {})).map((r) => toAdvanceSummary(r, today, rules.overdueDays));
  const depts = await db<{ id: number; name: string; active: boolean; custodianId: number | null; custodianName: string | null; limitCents: number | null; note: string | null; version: number | null }[]>`
    SELECT d.id, d.name, d.active, pa.custodian_id, cs.display_name AS custodian_name, pa.limit_cents, pa.note, pa.version
    FROM departments d LEFT JOIN petty_accounts pa ON pa.department_id = d.id LEFT JOIN staff cs ON cs.id = pa.custodian_id
    ORDER BY d.active DESC, d.sort_order, d.id`;
  const monthly = await db<{ departmentId: number; spent: number; last: string | null }[]>`
    SELECT e.department_id, coalesce(-sum(e.delta_cents) FILTER (WHERE e.kind = 'expense' AND e.date >= ${monthStart}), 0)::bigint AS spent, max(e.date)::text AS last
    FROM (${events(db, null)}) e GROUP BY e.department_id`;
  const byDept = new Map(monthly.map((m) => [Number(m.departmentId), m]));
  const rows: PettyAccountRow[] = [];
  for (const d of depts) {
    const mine = advances.filter((a) => a.department.id === Number(d.id));
    const m = byDept.get(Number(d.id));
    // 停用、没设置、也没有往来的部门不列
    if (!d.active && mine.length === 0 && !m) continue;
    const balance = mine.reduce((t, a) => t + a.outstandingCents, 0);
    const limit = d.limitCents === null ? null : Number(d.limitCents);
    rows.push({
      department: { id: Number(d.id), name: d.name, active: d.active },
      custodian: d.custodianId ? { id: Number(d.custodianId), name: d.custodianName ?? '' } : null,
      limitCents: limit,
      note: d.note ?? '',
      version: d.version ?? 0,
      balanceCents: balance,
      inHandCents: mine.reduce((t, a) => t + Math.max(0, a.outstandingCents), 0),
      owedCents: mine.reduce((t, a) => t + Math.max(0, -a.outstandingCents), 0),
      pendingCents: mine.reduce((t, a) => t + a.pendingCents, 0),
      monthSpentCents: m ? Number(m.spent) : 0,
      openAdvances: mine.filter((a) => a.state !== 'settled').length,
      overdue: mine.filter((a) => a.state === 'overdue').length,
      topUpCents: limit !== null && balance < limit ? limit - balance : null,
      lastDate: m?.last ?? null,
    });
  }
  return rows;
}

// ───────────────────────── 台账 ─────────────────────────

export async function pettyJournal(db: Db, departmentId: number, f: { from: string; to: string }): Promise<PettyJournal> {
  const [dept] = await db<{ id: number; name: string; custodianId: number | null; custodianName: string | null; limitCents: number | null }[]>`
    SELECT d.id, d.name, pa.custodian_id, cs.display_name AS custodian_name, pa.limit_cents
    FROM departments d LEFT JOIN petty_accounts pa ON pa.department_id = d.id LEFT JOIN staff cs ON cs.id = pa.custodian_id
    WHERE d.id = ${departmentId}`;
  if (!dept) throw notFound('部门不存在');
  const [sums] = await db<{ opening: number; inCents: number; outCents: number }[]>`
    SELECT coalesce(sum(e.delta_cents) FILTER (WHERE e.date < ${f.from}), 0)::bigint AS opening,
           coalesce(sum(e.delta_cents) FILTER (WHERE e.date BETWEEN ${f.from} AND ${f.to} AND e.delta_cents > 0), 0)::bigint AS in_cents,
           coalesce(-sum(e.delta_cents) FILTER (WHERE e.date BETWEEN ${f.from} AND ${f.to} AND e.delta_cents < 0), 0)::bigint AS out_cents
    FROM (${events(db, departmentId)}) e`;
  const rows = await db<EventRow[]>`
    SELECT * FROM (${events(db, departmentId)}) e
    WHERE e.date BETWEEN ${f.from} AND ${f.to}
    ORDER BY e.date, e.kind_order, e.doc_no, e.ref_id
    LIMIT ${JOURNAL_LIMIT + 1}`;
  const truncated = rows.length > JOURNAL_LIMIT;
  const page = rows.slice(0, JOURNAL_LIMIT);
  const claimIds = page.filter((r) => r.kind === 'expense').map((r) => Number(r.refId));
  const items = claimIds.length
    ? await db<{ claimId: number; name: string; boughtMilli: number; unit: string; amountCents: number }[]>`
        SELECT claim_id, name, bought_milli, unit, amount_cents FROM expense_claim_lines WHERE claim_id IN ${db(claimIds)} ORDER BY claim_id, line_no`
    : [];
  const itemsBy = new Map<number, PettyJournalEntry['items']>();
  for (const i of items) {
    const list = itemsBy.get(Number(i.claimId)) ?? [];
    list.push({ name: i.name, boughtMilli: Number(i.boughtMilli), unit: i.unit, amountCents: Number(i.amountCents) });
    itemsBy.set(Number(i.claimId), list);
  }
  const opening = Number(sums!.opening);
  let balance = opening;
  const entries: PettyJournalEntry[] = page.map((r) => {
    const delta = Number(r.deltaCents);
    balance += delta;
    const method = r.method ? (PAY_METHOD_LABELS[r.method as PayMethod] ?? r.method) : '';
    return {
      kind: r.kind,
      date: r.date,
      docNo: r.docNo,
      refId: Number(r.refId),
      advanceId: Number(r.advanceId),
      advanceNo: r.advanceNo,
      handler: { id: Number(r.handlerId), name: r.handlerName },
      description: r.kind === 'expense' ? (r.purpose ?? '') : [method, r.evidence].filter(Boolean).join(' · '),
      items: r.kind === 'expense' ? (itemsBy.get(Number(r.refId)) ?? []) : [],
      channel: r.channelLabel ? (r.channelNote ? `${r.channelLabel} · ${r.channelNote}` : r.channelLabel) : null,
      poNo: r.poNo,
      deltaCents: delta,
      balanceCents: balance,
    };
  });
  const inCents = Number(sums!.inCents);
  const outCents = Number(sums!.outCents);
  return {
    department: { id: Number(dept.id), name: dept.name },
    from: f.from,
    to: f.to,
    custodian: dept.custodianId ? { id: Number(dept.custodianId), name: dept.custodianName ?? '' } : null,
    limitCents: dept.limitCents === null ? null : Number(dept.limitCents),
    openingCents: opening,
    entries,
    closingCents: opening + inCents - outCents,
    inCents,
    outCents,
    pending: await listClaimsForAdvanceDept(db, departmentId),
    truncated,
  };
}

function journalCsv(j: PettyJournal) {
  return toCsv([
    [`${j.department.name}备用金台账 ${j.from} 至 ${j.to}（余额 = 打款 − 已确认支出 − 退回 + 补付；待确认的报销不算）`],
    ['日期', '类型', '单号', '打款单', '经办人', '内容', '明细', '采购途径', '采购单', '进（元）', '出（元）', '余额（元）'],
    ['', '期初余额', '', '', '', '', '', '', '', '', '', yuan(j.openingCents)],
    ...j.entries.map((e) => [
      e.date,
      PETTY_JOURNAL_LABELS[e.kind],
      e.docNo,
      e.advanceNo,
      e.handler.name,
      e.description,
      e.items.map((i) => `${i.name} ${formatQty(i.boughtMilli)}${i.unit} ¥${yuan(i.amountCents)}`).join('；'),
      e.channel ?? '',
      e.poNo ?? '',
      e.deltaCents > 0 ? yuan(e.deltaCents) : '',
      e.deltaCents < 0 ? yuan(-e.deltaCents) : '',
      yuan(e.balanceCents),
    ]),
    ['', '期末余额', '', '', '', '', '', '', '', yuan(j.inCents), yuan(j.outCents), yuan(j.closingCents)],
  ]);
}

// ───────────────────────── 设置 ─────────────────────────

const AccountInput = z.object({
  custodianId: z.number().int().positive().nullable(),
  limitCents: z.number().int().positive('定额要大于 0').max(100_000_000, '定额不能超过 100 万元').nullable(),
  note: z.string().trim().max(200, '备注最多 200 个字').default(''),
  /** 打开时的版本号；还没设过的是 0 */
  version: z.number().int().min(0),
});

export async function savePettyAccount(deps: Deps, departmentId: number, raw: unknown, ctx: { actor: { id: number }; ip?: string }) {
  const input = parse(AccountInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [dept] = await tx<{ active: boolean }[]>`SELECT active FROM departments WHERE id = ${departmentId}`;
    if (!dept) throw notFound('部门不存在');
    if (!dept.active) throw unprocessable('DEPARTMENT_INVALID', '部门已停用');
    if (input.custodianId) {
      const [s] = await tx<{ active: boolean }[]>`SELECT active FROM staff WHERE id = ${input.custodianId}`;
      if (!s?.active) throw unprocessable('HANDLER_INVALID', '保管人不存在或已停用');
    }
    const stale = () => conflict('VERSION_CONFLICT', '这个部门的备用金设置刚被别人改过，请刷新后重新填写');
    if (input.version === 0) {
      const inserted = await tx`
        INSERT INTO petty_accounts (department_id, custodian_id, limit_cents, note, updated_by)
        VALUES (${departmentId}, ${input.custodianId}, ${input.limitCents}, ${input.note}, ${ctx.actor.id})
        ON CONFLICT (department_id) DO NOTHING RETURNING department_id`;
      if (inserted.length === 0) throw stale();
    } else {
      const updated = await tx`
        UPDATE petty_accounts SET custodian_id = ${input.custodianId}, limit_cents = ${input.limitCents}, note = ${input.note},
               version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now()
        WHERE department_id = ${departmentId} AND version = ${input.version} RETURNING department_id`;
      if (updated.length === 0) throw stale();
    }
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'petty_account', targetType: 'department', targetId: departmentId, detail: input, ip: ctx.ip });
  });
}

// ───────────────────────── 自检 ─────────────────────────

/** 部门备用金台账的期末余额 = 这个部门各笔打款的未退回之和（与每日平账同一口径） */
export async function pettyAccountChecks(db: Db): Promise<{ key: string; label: string; ok: boolean; detail: string }[]> {
  const journal = await db<{ departmentId: number; total: number }[]>`
    SELECT e.department_id, sum(e.delta_cents)::bigint AS total FROM (${events(db, null)}) e GROUP BY e.department_id`;
  const perAdvance = new Map<number, number>();
  for (const a of (await advanceRows(db, {})).map((r) => toAdvanceSummary(r, '2000-01-01', 1))) {
    perAdvance.set(a.department.id, (perAdvance.get(a.department.id) ?? 0) + a.outstandingCents);
  }
  const bad: string[] = [];
  const keys = new Set([...journal.map((j) => Number(j.departmentId)), ...perAdvance.keys()]);
  for (const k of keys) {
    const j = Number(journal.find((x) => Number(x.departmentId) === k)?.total ?? 0);
    const a = perAdvance.get(k) ?? 0;
    if (j !== a) bad.push(`部门 ${k}：台账 ¥${yuan(j)}，平账 ¥${yuan(a)}`);
  }
  return [
    {
      key: 'petty_accounts',
      label: '部门备用金台账与平账一致',
      ok: bad.length === 0,
      detail: bad.length ? bad.join('；') : `${keys.size} 个部门：台账余额 = 各笔打款的未退回之和`,
    },
  ];
}

// ───────────────────────── 路由 ─────────────────────────

const RangeQuery = z.object({ from: docDateSchema, to: docDateSchema });

export function registerPettyAccountRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const deptId = (req: { params: unknown }) => parse(idParam, req.params).id;
  app.get('/api/erp/petty/accounts', { preHandler: guard('expense.read') }, async () => readSnapshot(sql, (tx) => listPettyAccounts(tx, config.timezone)));
  app.put('/api/erp/petty/accounts/:id', { preHandler: guard('petty.manage') }, async (req) => {
    await savePettyAccount(deps, deptId(req), req.body, ctxOf(req));
    return (await readSnapshot(sql, (tx) => listPettyAccounts(tx, config.timezone))).find((r) => r.department.id === deptId(req));
  });
  app.get('/api/erp/petty/accounts/:id/journal', { preHandler: guard('expense.read') }, async (req) => {
    const f = parse(RangeQuery, req.query);
    checkDateRange(f.from, f.to);
    return readSnapshot(sql, (tx) => pettyJournal(tx, deptId(req), f));
  });
  app.get('/api/erp/petty/accounts/:id/journal/export', { preHandler: guard('expense.export') }, async (req, reply) => {
    const f = parse(RangeQuery, req.query);
    checkDateRange(f.from, f.to);
    const j = await readSnapshot(sql, (tx) => pettyJournal(tx, deptId(req), f));
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'petty_journal', detail: { departmentId: deptId(req), ...f }, ip: req.ip });
    return csvReply(reply, `${j.department.name}备用金台账_${f.from}_${f.to}.csv`, journalCsv(j));
  });
}
