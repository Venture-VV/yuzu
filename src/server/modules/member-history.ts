// 旧 EBC 逐笔流水只读导入（v0.7.28 ⑩，N12 待确认；设计见 docs/SCHEDULE_FINISH.md 第 11 节）。
//
//   · 预览：解析模板 CSV，按旧卡号（期初导入时记下的）或手机号认会员；格式不对的行列出来（有一行不对整批不导入），
//     认不出会员的行列出来（不导入，其余照常导入）；同一份文件已经有一批有效的导入时提示先作废那一批；
//   · 导入：一个事务里整批写入两张只读表；带操作编号，同一编号重提返回第一次的结果；
//   · 只读、不进正式账：不写余额流水、不改会员余额与档阶；会员详情「旧系统流水」里看（含合并进来的档案的）；
//   · 作废：整批作废后页面上不再显示，同一份文件可以重新导入；
//   · 店主经办（与期初导入同一项权限「导入旧系统会员余额（期初）、旧系统逐笔流水，与作废」）；会员详情里能看会员的岗位都能看。
// 不锁业务行：只写自己的两张表，同一份文件的并发导入靠「一份文件一批有效导入」的唯一索引兜底。

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf, businessDayStart } from '@shared/business-date';
import {
  MEMBER_HISTORY_KINDS,
  parseMemberHistoryCsv,
  type MemberHistoryCsvRow,
  type MemberHistoryEntry,
  type MemberHistoryImportSummary,
  type MemberHistoryKind,
  type MemberHistoryPage,
  type MemberHistoryReport,
} from '@shared/member-history';
import { isUniqueViolation, type Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { ctxOf } from '../lib/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { nextDocNo } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { loadSettings } from './settings';

const FileInput = z.object({
  source: z.string().trim().min(1, '请填写来源系统（例如 EBC）').max(32, '来源最多 32 字').default('EBC'),
  fileName: z.string().trim().max(200).default(''),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
  csv: z.string().min(1, '请选择要导入的文件').max(20_000_000, '文件太大，请按时间分批导出'),
});
export type MemberHistoryInput = z.input<typeof FileInput>;
const ApplyInput = FileInput.extend({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') });
const VoidInput = z.object({ reason: z.string().trim().min(2, '请填写作废原因（至少 2 个字）').max(200, '作废原因最多 200 字') });

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

type PlannedRow = MemberHistoryCsvRow & { memberId: number; matchedBy: 'legacy_no' | 'phone'; occurredAt: Date };

/** 按门店时区把「日期 + 时分秒」换成时刻 */
function occurredAt(date: string, time: string, timeZone: string): Date {
  const [h, m, s] = time.split(':').map(Number) as [number, number, number];
  return new Date(businessDayStart(date, timeZone, 0).getTime() + ((h * 60 + m) * 60 + s) * 1000);
}

async function plan(db: Db, timeZone: string, input: z.infer<typeof FileInput>): Promise<{ rows: PlannedRow[]; report: MemberHistoryReport; sha: string }> {
  const sha = sha256(input.csv);
  const parsed = parseMemberHistoryCsv(input.csv);
  const legacyNos = [...new Set(parsed.rows.map((r) => r.legacyNo).filter(Boolean))];
  const phones = [...new Set(parsed.rows.map((r) => r.phone).filter(Boolean))];
  // 旧卡号：有效的期初导入记下的（同一个旧卡号对应两位会员时不按它认）
  const byLegacy = new Map<string, number>();
  if (legacyNos.length) {
    const rows = await db<{ legacyNo: string; memberId: number }[]>`
      SELECT upper(legacy_no) AS legacy_no, min(member_id) AS member_id FROM opening_balances
      WHERE status = 'active' AND upper(legacy_no) = ANY(${legacyNos}::text[])
      GROUP BY upper(legacy_no) HAVING count(DISTINCT member_id) = 1`;
    for (const r of rows) byLegacy.set(r.legacyNo, Number(r.memberId));
  }
  const byPhone = new Map<string, number>();
  if (phones.length) {
    const rows = await db<{ phone: string; id: number }[]>`SELECT phone, id FROM members WHERE phone = ANY(${phones}::text[])`;
    for (const r of rows) byPhone.set(r.phone, Number(r.id));
  }
  const planned: PlannedRow[] = [];
  const unmatched: MemberHistoryReport['unmatched']['lines'] = [];
  let unmatchedCount = 0;
  for (const r of parsed.rows) {
    const viaLegacy = r.legacyNo ? byLegacy.get(r.legacyNo) : undefined;
    const viaPhone = r.phone ? byPhone.get(r.phone) : undefined;
    const memberId = viaLegacy ?? viaPhone;
    if (memberId === undefined) {
      unmatchedCount += 1;
      if (unmatched.length < 50) unmatched.push({ line: r.line, phone: r.phone, legacyNo: r.legacyNo, name: r.name });
      continue;
    }
    planned.push({ ...r, memberId, matchedBy: viaLegacy !== undefined ? 'legacy_no' : 'phone', occurredAt: occurredAt(r.date, r.time, timeZone) });
  }
  const times = planned.map((r) => r.occurredAt.getTime());
  const kinds = new Map<MemberHistoryKind, { count: number; amount: number }>();
  for (const r of planned) {
    const k = kinds.get(r.kind) ?? { count: 0, amount: 0 };
    kinds.set(r.kind, { count: k.count + 1, amount: k.amount + r.amount });
  }
  const [dup] = await db<{ importNo: string }[]>`SELECT import_no FROM member_history_imports WHERE file_sha256 = ${sha} AND status = 'active'`;
  return {
    rows: planned,
    sha,
    report: {
      fileName: input.fileName,
      totalRows: parsed.rows.length + parsed.errors.length,
      matchedRows: planned.length,
      memberCount: new Set(planned.map((r) => r.memberId)).size,
      byLegacyNo: planned.filter((r) => r.matchedBy === 'legacy_no').length,
      byPhone: planned.filter((r) => r.matchedBy === 'phone').length,
      unmatched: { count: unmatchedCount, lines: unmatched },
      errors: parsed.errors.slice(0, 100),
      firstAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
      lastAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      byKind: MEMBER_HISTORY_KINDS.filter((k) => kinds.has(k)).map((k) => ({ kind: k, ...kinds.get(k)! })),
      duplicateOf: dup?.importNo ?? null,
    },
  };
}

export async function previewMemberHistory(deps: Deps, raw: unknown): Promise<MemberHistoryReport> {
  return (await plan(deps.sql, deps.config.timezone, parse(FileInput, raw))).report;
}

async function reportOfImport(db: Db, id: number): Promise<MemberHistoryReport> {
  const s = await getImport(db, id);
  return {
    importId: s.id,
    importNo: s.importNo,
    fileName: s.fileName,
    totalRows: s.totalRows,
    matchedRows: s.importedRows,
    memberCount: s.memberCount,
    byLegacyNo: 0,
    byPhone: 0,
    unmatched: { count: s.skippedRows, lines: [] },
    errors: [],
    firstAt: s.firstAt,
    lastAt: s.lastAt,
    byKind: [],
    duplicateOf: null,
  };
}

/** 整批导入（格式有一行不对、没有认出会员的行、同一份文件已有有效导入时不导入） */
export async function importMemberHistory(deps: Deps, raw: unknown, ctx: OpContext): Promise<MemberHistoryReport> {
  const input = parse(ApplyInput, raw);
  const replay = async () => {
    const [prev] = await deps.sql<{ id: number }[]>`SELECT id FROM member_history_imports WHERE client_key = ${input.clientKey}`;
    return prev ? { ...(await reportOfImport(deps.sql, Number(prev.id))), replayed: true } : null;
  };
  const replayed = await replay();
  if (replayed) return replayed;
  const p = await plan(deps.sql, deps.config.timezone, input);
  if (p.report.errors.length) {
    throw unprocessable('MEMBER_HISTORY_INVALID', `有 ${p.report.errors.length} 行格式不对，整批没有导入；改好后重新预览`, { errors: p.report.errors });
  }
  if (p.report.duplicateOf) throw conflict('MEMBER_HISTORY_DUPLICATE', `这份文件已经导入过（批次 ${p.report.duplicateOf}）；要重新导入请先作废那一批`);
  if (p.rows.length === 0) throw unprocessable('MEMBER_HISTORY_EMPTY', '没有能认出会员的行，没有导入（按旧卡号或手机号认会员）');
  const at = ctx.at ?? new Date();
  let id: number;
  try {
    id = await deps.sql.begin(async (tx) => {
      const settings = await loadSettings(tx);
      const date = businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
      const importNo = await nextDocNo(tx, 'member_history', 'LS', date);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO member_history_imports (import_no, client_key, source, file_name, file_sha256, note, total_rows, imported_rows, skipped_rows,
                                            member_count, first_at, last_at, created_by, created_at)
        VALUES (${importNo}, ${input.clientKey}, ${input.source}, ${input.fileName}, ${p.sha}, ${input.note}, ${p.report.totalRows}, ${p.rows.length},
                ${p.report.totalRows - p.rows.length}, ${p.report.memberCount}, ${p.report.firstAt}, ${p.report.lastAt}, ${ctx.actor.id}, ${at})
        RETURNING id`;
      const importId = Number(row!.id);
      // 分批写入（一批 1,000 行）
      for (let i = 0; i < p.rows.length; i += 1000) {
        const batch = p.rows.slice(i, i + 1000).map((r) => ({
          import_id: importId,
          line_no: r.line,
          member_id: r.memberId,
          matched_by: r.matchedBy,
          occurred_at: r.occurredAt,
          type_label: r.typeLabel,
          kind: r.kind,
          amount: r.amount,
          bonus: r.bonus,
          balance: r.balance,
          bonus_balance: r.bonusBalance,
          doc_no: r.docNo,
          store: r.store,
          operator: r.operator,
          note: r.note,
          raw: tx.json(r.raw),
        }));
        await tx`INSERT INTO member_history_rows ${tx(batch as never[])}`;
      }
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'member_history_imported',
        targetType: 'member_history_import',
        targetId: importId,
        detail: { docNo: importNo, fileName: input.fileName, rows: p.rows.length, skipped: p.report.totalRows - p.rows.length, members: p.report.memberCount },
        ip: ctx.ip,
        businessDate: date,
      });
      return importId;
    });
  } catch (e) {
    // 同一编号同时提交两次：返回先提交的那一次；同一份文件同时导入两次：后一次拒绝
    if (isUniqueViolation(e, 'member_history_imports_client_key_key')) {
      const again = await replay();
      if (again) return again;
    }
    if (isUniqueViolation(e, 'member_history_imports_file_uq')) throw conflict('MEMBER_HISTORY_DUPLICATE', '这份文件刚刚已经导入过；要重新导入请先作废那一批');
    throw e;
  }
  return { ...p.report, importId: id, importNo: (await getImport(deps.sql, id)).importNo, duplicateOf: null };
}

const summarySql = (db: Db) => db`
  SELECT i.id, i.import_no, i.source, i.file_name, i.note, i.total_rows, i.imported_rows, i.skipped_rows, i.member_count, i.first_at, i.last_at,
         c.display_name AS created_by_name, i.created_at, i.status, i.voided_at, v.display_name AS voided_by_name, i.void_reason
  FROM member_history_imports i JOIN staff c ON c.id = i.created_by LEFT JOIN staff v ON v.id = i.voided_by`;

type SummaryRow = Omit<MemberHistoryImportSummary, 'firstAt' | 'lastAt' | 'createdAt' | 'voidedAt'> & {
  firstAt: Date | null;
  lastAt: Date | null;
  createdAt: Date;
  voidedAt: Date | null;
};
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const toSummary = (r: SummaryRow): MemberHistoryImportSummary => ({
  ...r,
  id: Number(r.id),
  firstAt: iso(r.firstAt),
  lastAt: iso(r.lastAt),
  createdAt: new Date(r.createdAt).toISOString(),
  voidedAt: iso(r.voidedAt),
});

export async function getImport(db: Db, id: number): Promise<MemberHistoryImportSummary> {
  const [r] = await db<SummaryRow[]>`${summarySql(db)} WHERE i.id = ${id}`;
  if (!r) throw notFound('导入记录不存在');
  return toSummary(r);
}

export async function listImports(db: Db): Promise<MemberHistoryImportSummary[]> {
  return (await db<SummaryRow[]>`${summarySql(db)} ORDER BY i.id DESC LIMIT 100`).map(toSummary);
}

export async function voidMemberHistoryImport(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<MemberHistoryImportSummary> {
  const { reason } = parse(VoidInput, raw);
  await deps.sql.begin(async (tx) => {
    const [s] = await tx<{ importNo: string; status: string }[]>`SELECT import_no, status FROM member_history_imports WHERE id = ${id} FOR UPDATE`;
    if (!s) throw notFound('导入记录不存在');
    if (s.status !== 'active') throw conflict('ALREADY_VOIDED', `批次 ${s.importNo} 已作废`);
    const at = ctx.at ?? new Date();
    await tx`UPDATE member_history_imports SET status = 'voided', voided_at = ${at}, voided_by = ${ctx.actor.id}, void_reason = ${reason} WHERE id = ${id}`;
    const settings = await loadSettings(tx);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'member_history_voided',
      targetType: 'member_history_import',
      targetId: id,
      detail: { docNo: s.importNo, reason },
      ip: ctx.ip,
      businessDate: businessDateOf(at, deps.config.timezone, settings.businessDayStartHour),
    });
  });
  return getImport(deps.sql, id);
}

/** 会员详情「旧系统流水」：这位会员与合并进来的档案的旧流水（有效导入的），新的在前，一页最多 50 条 */
export async function memberHistory(db: Db, memberId: number, opts: { before?: number; limit?: number } = {}): Promise<MemberHistoryPage> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const [m] = await db<{ id: number }[]>`SELECT id FROM members WHERE id = ${memberId}`;
  if (!m) throw notFound('会员不存在');
  const ids = await db<{ id: number }[]>`
    WITH RECURSIVE chain AS (
      SELECT id FROM members WHERE id = ${memberId}
      UNION SELECT m.id FROM members m JOIN chain c ON m.merged_into_id = c.id
    )
    SELECT id FROM chain`;
  const memberIds = ids.map((r) => Number(r.id));
  const [t] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM member_history_rows h JOIN member_history_imports i ON i.id = h.import_id
    WHERE h.member_id = ANY(${memberIds}::bigint[]) AND i.status = 'active'`;
  const before = opts.before
    ? (await db<{ occurredAt: Date; id: number }[]>`SELECT occurred_at, id FROM member_history_rows WHERE id = ${opts.before}`)[0]
    : undefined;
  const rows = await db<(Omit<MemberHistoryEntry, 'occurredAt'> & { occurredAt: Date })[]>`
    SELECT h.id, h.occurred_at, h.type_label, h.kind, h.amount, h.bonus, h.balance, h.bonus_balance, h.doc_no, h.store, h.operator, h.note,
           i.import_no, i.source
    FROM member_history_rows h JOIN member_history_imports i ON i.id = h.import_id
    WHERE h.member_id = ANY(${memberIds}::bigint[]) AND i.status = 'active'
      ${before ? db`AND (h.occurred_at, h.id) < (${before.occurredAt}, ${before.id})` : db``}
    ORDER BY h.occurred_at DESC, h.id DESC LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit).map((r) => ({
    ...r,
    id: Number(r.id),
    amount: Number(r.amount),
    bonus: r.bonus === null ? null : Number(r.bonus),
    balance: r.balance === null ? null : Number(r.balance),
    bonusBalance: r.bonusBalance === null ? null : Number(r.bonusBalance),
    occurredAt: new Date(r.occurredAt).toISOString(),
  }));
  return { total: t!.n, entries: page, nextBefore: rows.length > limit ? page[page.length - 1]!.id : null };
}

export function registerMemberHistoryRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const bodyLimit = 24 * 1024 * 1024;
  app.post('/api/member-history-imports/preview', { preHandler: guard('wallet.opening'), bodyLimit }, async (req) => previewMemberHistory(deps, req.body));
  app.post('/api/member-history-imports', { preHandler: guard('wallet.opening'), bodyLimit }, async (req) => importMemberHistory(deps, req.body, ctxOf(req)));
  app.get('/api/member-history-imports', { preHandler: guard('wallet.opening') }, async () => listImports(sql));
  app.post('/api/member-history-imports/:id/void', { preHandler: guard('wallet.opening') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidMemberHistoryImport(deps, id, req.body, ctxOf(req));
  });
  app.get('/api/members/:id/legacy-history', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(50).optional() }), req.query ?? {});
    return memberHistory(sql, id, q);
  });
}
