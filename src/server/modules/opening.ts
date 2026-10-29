// 旧系统（EBC）会员余额期初导入（店主 2026-10-27 #6，Batch 2.4d）。
//
//   · 预览：解析 CSV，按手机号匹配已有会员；姓名不一致、已有有效期初、赠金到期日已过的行报错，不写任何数据；
//   · 导入：一个事务里整批写入 —— 没有的会员新建档案；每位会员一条期初明细（保留原始行与旧卡号）；
//     有余额的记一条「期初导入」流水（本金、赠金分开，不计入充值实收），期初赠金进入赠金批次（可带到期日）；
//     任一行有问题整批不导入；同一操作编号重提返回第一次的结果，重复导入同一位会员会被拒绝；
//     锁住已有会员后按最新资料重新核对，导入期间会员改了姓名或手机号时整批不导入（OPENING_STALE）；
//   · 作废：逐位或整批。这位会员在期初之后还没有其他余额变动时才能作废，记一条「期初作废」流水把期初余额减回去，
//     期初赠金批次清零；原明细保留并标记已作废，会员档案保留。
// 加锁顺序：期初导入咨询锁 → 会员（按 id 升序）→ 赠金批次。

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf, expiryAfterLastUsableDate } from '@shared/business-date';
import { formatYuan } from '@shared/money';
import {
  compareOpeningControl,
  parseOpeningCsv,
  sumOpeningCsv,
  type OpeningBalanceRow,
  type OpeningImportDetail,
  type OpeningImportReport,
  type OpeningImportSummary,
  type OpeningRow,
  type OpeningTotals,
} from '@shared/opening-import';
import { isUniqueViolation, type Db, type Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { expireDueLots } from './bonus';
import { insertMember } from './members';
import { loadSettings } from './settings';
import { applyBalance, lockMember, nextDocNo } from './wallet-core';

// ───────────────────────── 输入 ─────────────────────────

const amount = (label: string) => z.number(`${label}格式不正确`).int(`${label}格式不正确`).min(0, `${label}不能为负`).max(1_000_000_000_00, `${label}太大`);
/** EBC 控制总数（R1.5）：旧系统报表上的人数与合计；金额为分 */
const ControlInput = z.object({
  count: z.number('人数格式不正确').int('人数应为整数').min(0, '人数不能为负').max(1_000_000, '人数太大'),
  principal: amount('本金合计'),
  bonus: amount('赠金合计'),
  legacyRecharged: amount('累计充值合计'),
});

const FileInput = z.object({
  source: z.string().trim().min(1, '请填写来源系统（例如 EBC）').max(32, '来源最多 32 字'),
  fileName: z.string().trim().max(200).default(''),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
  csv: z.string().min(1, '请选择要导入的文件').max(2_000_000, '文件太大，请分批导入'),
  control: ControlInput.nullable().default(null),
  /** 排除清单（这次不导入、之后补导的会员）：只用来对控制总数 */
  excludedCsv: z.string().max(500_000, '排除清单太大').default(''),
});
export type OpeningPreviewInputData = z.input<typeof FileInput>;

const ApplyInput = FileInput.extend({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') });
export type OpeningApplyInputData = z.input<typeof ApplyInput>;

const VoidInput = z.object({ reason: z.string().trim().min(2, '请填写作废原因（至少 2 个字）').max(200, '作废原因最多 200 字') });
export type OpeningVoidInputData = z.input<typeof VoidInput>;

type LineError = { line: number; message: string };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// ───────────────────────── 预览与核对 ─────────────────────────

interface PlannedRow extends OpeningRow {
  /** 按手机号匹配到的已有会员；null 为新建档案 */
  member: { id: number; memberNo: string } | null;
  expiresAt: Date | null;
}

/** 按手机号匹配已有会员并逐行核对（预览与导入共用；导入时在咨询锁内核对，锁住已有会员后再核对一次） */
async function planRows(db: Db, rows: OpeningRow[], today: string, timeZone: string, startHour: number) {
  const existing = rows.length
    ? await db<{ id: number; memberNo: string; name: string; phone: string; openingDocNo: string | null }[]>`
        SELECT m.id, m.member_no, m.name, m.phone,
               (SELECT b.doc_no FROM opening_balances b WHERE b.member_id = m.id AND b.status = 'active') AS opening_doc_no
        FROM members m WHERE m.phone IN ${db(rows.map((r) => r.phone))}`
    : [];
  const byPhone = new Map(existing.map((m) => [m.phone, m]));
  const planned: PlannedRow[] = [];
  const errors: LineError[] = [];
  for (const row of rows) {
    const m = byPhone.get(row.phone);
    const problems: string[] = [];
    if (m && m.name !== row.name) {
      problems.push(`手机号 ${row.phone} 已登记为会员「${m.name}」（${m.memberNo}），与文件里的姓名「${row.name}」不一致，请核对后改成一致`);
    }
    if (m?.openingDocNo) problems.push(`会员「${m.name}」已有期初 ${m.openingDocNo}，不能重复导入；如需更正请先作废那一笔`);
    if (row.bonusExpiresOn && row.bonusExpiresOn < today) {
      problems.push(`赠金到期日 ${row.bonusExpiresOn} 已过（今天是营业日 ${today}），过期的赠金请填 0 或更正到期日`);
    }
    if (problems.length) {
      errors.push({ line: row.line, message: problems.join('；') });
      continue;
    }
    planned.push({
      ...row,
      member: m ? { id: m.id, memberNo: m.memberNo } : null,
      expiresAt: row.bonusExpiresOn ? expiryAfterLastUsableDate(row.bonusExpiresOn, timeZone, startHour) : null,
    });
  }
  return { planned, errors };
}

function sumOf(rows: { principal: number; bonus: number; totalRecharged?: number | null }[]) {
  return {
    principal: rows.reduce((s, r) => s + r.principal, 0),
    bonus: rows.reduce((s, r) => s + r.bonus, 0),
    legacyRecharged: rows.reduce((s, r) => s + (r.totalRecharged ?? 0), 0),
  };
}

/** 与 EBC 控制总数比对：文件里的会员（解析通过的行）+ 排除清单 = 控制总数；没填控制总数时不比对 */
function controlOf(input: { control: OpeningTotals | null; excludedCsv: string }, rows: OpeningRow[]) {
  if (!input.control) return { check: null, errors: [] as LineError[] };
  const excluded = input.excludedCsv.trim() ? sumOpeningCsv(input.excludedCsv) : { totals: { count: 0, principal: 0, bonus: 0, legacyRecharged: 0 }, errors: [] };
  const sums = sumOf(rows);
  return {
    check: compareOpeningControl(input.control, { count: rows.length, ...sums }, excluded.totals),
    errors: excluded.errors.map((e) => ({ line: 0, message: `排除清单第 ${e.line} 行：${e.message}` })),
  };
}

/** 预览：只读，不写任何数据 */
export async function previewOpeningImport(deps: Deps, raw: OpeningPreviewInputData, at = new Date()): Promise<OpeningImportReport> {
  const input = parse(FileInput, raw);
  const parsed = parseOpeningCsv(input.csv);
  const settings = await loadSettings(deps.sql);
  const today = businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
  const { planned, errors } = await planRows(deps.sql, parsed.rows, today, deps.config.timezone, settings.businessDayStartHour);
  const totals = sumOf(planned);
  const control = controlOf(input, parsed.rows);
  return {
    dryRun: true,
    importNo: null,
    replayed: false,
    total: parsed.rows.length,
    createCount: planned.filter((r) => !r.member).length,
    matchCount: planned.filter((r) => r.member).length,
    zeroCount: planned.filter((r) => r.principal + r.bonus === 0).length,
    principalTotal: totals.principal,
    bonusTotal: totals.bonus,
    legacyRechargedTotal: totals.legacyRecharged,
    control: control.check,
    errors: [...parsed.errors, ...errors, ...control.errors].sort((a, b) => a.line - b.line),
    samples: planned.slice(0, 30).map((r) => ({
      line: r.line,
      name: r.name,
      phone: r.phone,
      principal: r.principal,
      bonus: r.bonus,
      action: r.member ? 'match' : 'create',
      memberNo: r.member?.memberNo ?? null,
    })),
  };
}

// ───────────────────────── 导入 ─────────────────────────

/** 已导入批次的结果（导入完成与同一编号重提时返回） */
async function reportOfImport(db: Db, importId: number, replayed: boolean): Promise<OpeningImportReport> {
  const [imp] = await db<{ importNo: string }[]>`SELECT import_no FROM opening_imports WHERE id = ${importId}`;
  if (!imp) throw notFound('期初导入记录不存在');
  const rows = await db<{ line: number; name: string; phone: string; memberNo: string; principal: number; bonus: number; legacyRecharged: number; memberCreated: boolean }[]>`
    SELECT b.line_no AS line, m.name, m.phone, m.member_no, b.principal, b.bonus, b.legacy_recharged, b.member_created
    FROM opening_balances b JOIN members m ON m.id = b.member_id
    WHERE b.import_id = ${importId} ORDER BY b.line_no`;
  return {
    dryRun: false,
    importNo: imp.importNo,
    replayed,
    total: rows.length,
    createCount: rows.filter((r) => r.memberCreated).length,
    matchCount: rows.filter((r) => !r.memberCreated).length,
    zeroCount: rows.filter((r) => r.principal + r.bonus === 0).length,
    principalTotal: rows.reduce((s, r) => s + r.principal, 0),
    bonusTotal: rows.reduce((s, r) => s + r.bonus, 0),
    legacyRechargedTotal: rows.reduce((s, r) => s + r.legacyRecharged, 0),
    control: null,
    errors: [],
    samples: rows.slice(0, 30).map((r) => ({
      line: r.line,
      name: r.name,
      phone: r.phone,
      principal: r.principal,
      bonus: r.bonus,
      action: r.memberCreated ? 'create' : 'match',
      memberNo: r.memberNo,
    })),
  };
}

const invalid = (errors: LineError[]) =>
  unprocessable('OPENING_INVALID', `有 ${errors.length} 处需要修改，整批未导入`, { errors: errors.slice(0, 100) });

/**
 * 导入：整批在一个事务里完成。clientKey 是页面或命令行的操作编号：同一编号重提返回第一次的结果；
 * 编号丢了重新导入同一个文件时，文件里的会员都已有期初，会被逐行拒绝，不会重复记账。
 */
export async function applyOpeningImport(
  deps: Deps,
  raw: OpeningApplyInputData,
  ctx: OpContext,
  options: { via?: 'cli' } = {},
): Promise<OpeningImportReport> {
  const input = parse(ApplyInput, raw);
  const parsed = parseOpeningCsv(input.csv);
  const fileSha = sha256(input.csv);
  const at = ctx.at ?? new Date();
  const replayOf = async (db: Db) => {
    const [prev] = await db<{ id: number; fileSha256: string; source: string }[]>`
      SELECT id, file_sha256, source FROM opening_imports WHERE client_key = ${input.clientKey}`;
    if (!prev) return null;
    if (prev.fileSha256 !== fileSha || prev.source !== input.source) {
      throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次导入，请重新预览后再导入');
    }
    return prev.id;
  };
  try {
    const run = await deps.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '10s'");
      // 期初导入之间串行：同一时间只有一批在导入
      await tx`SELECT pg_advisory_xact_lock(hashtext('opening_import'))`;
      const prevId = await replayOf(tx);
      if (prevId) return { id: prevId, replayed: true };
      if (parsed.errors.length) throw invalid(parsed.errors);
      const control = controlOf(input, parsed.rows);
      if (control.errors.length) throw invalid(control.errors);
      if (control.check && !control.check.ok) {
        throw unprocessable('OPENING_CONTROL_MISMATCH', `与 EBC 控制总数不一致，整批未导入：${control.check.mismatches.join('；')}`, { control: control.check });
      }
      if (!control.check && deps.config.env === 'production') {
        throw unprocessable('OPENING_CONTROL_REQUIRED', '正式环境导入期初必须填写 EBC 控制总数（人数、本金、赠金、累计充值），核对一致后才能导入');
      }

      const settings = await loadSettings(tx);
      const businessDate = businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
      const { planned, errors } = await planRows(tx, parsed.rows, businessDate, deps.config.timezone, settings.businessDayStartHour);
      if (errors.length) throw invalid(errors);

      // 已有会员按 id 升序加锁（其他记账每次只锁一位会员，不会与这里形成死锁）
      const existingIds = planned.flatMap((r) => (r.member ? [r.member.id] : [])).sort((a, b) => a - b);
      if (existingIds.length) await tx`SELECT id FROM members WHERE id IN ${tx(existingIds)} ORDER BY id FOR UPDATE`;
      // 上面的核对是加锁前读的：期间提交的会员改名、改手机号（或别的会员改用了文件里的手机号）会让期初记到身份已变的会员上。
      // 锁住之后按最新资料再核对一次（姓名、手机号、有效期初），匹配结果有任何变化整批不导入
      const again = await planRows(tx, parsed.rows, businessDate, deps.config.timezone, settings.businessDayStartHour);
      const stale = again.errors.length
        ? again.errors
        : planned.flatMap((r, i) => (r.member?.id === again.planned[i]!.member?.id ? [] : [{ line: r.line, message: `手机号 ${r.phone} 对应的会员刚刚有变动` }]));
      if (stale.length) {
        throw conflict('OPENING_STALE', '导入期间会员资料有变动，整批未导入；请重新预览后再导入', { errors: stale.slice(0, 100) });
      }

      const totals = sumOf(planned);
      const importNo = await nextDocNo(tx, 'opening', businessDate);
      const createdCount = planned.filter((r) => !r.member).length;
      const [imp] = await tx<{ id: number }[]>`
        INSERT INTO opening_imports (import_no, client_key, source, file_name, file_sha256, note, row_count, created_count,
                                     principal_total, bonus_total, business_date, imported_by, created_at)
        VALUES (${importNo}, ${input.clientKey}, ${input.source}, ${input.fileName}, ${fileSha}, ${input.note}, ${planned.length},
                ${createdCount}, ${totals.principal}, ${totals.bonus}, ${businessDate}, ${ctx.actor.id}, ${at})
        RETURNING id`;
      let seq = 0;
      for (const row of planned) {
        seq += 1;
        const memberId =
          row.member?.id ??
          (await insertMember(
            tx,
            { name: row.name, phone: row.phone, gender: row.gender, birthday: row.birthday, note: row.note },
            ctx,
            { enforceRequired: false, audit: false },
          ));
        const docNo = `${importNo}-${String(seq).padStart(4, '0')}`;
        const [ob] = await tx<{ id: number }[]>`
          INSERT INTO opening_balances (import_id, member_id, doc_no, line_no, source_row, legacy_no, principal, bonus,
                                        bonus_expires_at, legacy_recharged, member_created)
          VALUES (${imp!.id}, ${memberId}, ${docNo}, ${row.line}, ${tx.json(row.raw)}, ${row.legacyNo}, ${row.principal}, ${row.bonus},
                  ${row.expiresAt}, ${row.totalRecharged ?? 0}, ${!row.member})
          RETURNING id`;
        if (row.principal + row.bonus === 0) continue;
        let member = await lockMember(tx, memberId);
        // 已有会员先作废到期的赠金，与其他记账一致
        if (row.member) member = await expireDueLots(tx, deps, member, at);
        await applyBalance(tx, member, { principal: row.principal, bonus: row.bonus }, {
          entryType: 'opening', docNo, openingId: ob!.id, businessDate, operatorId: ctx.actor.id, at,
        });
        if (row.bonus > 0) {
          await tx`
            INSERT INTO bonus_lots (member_id, source, opening_id, amount, remaining, expires_at, created_at)
            VALUES (${memberId}, 'opening', ${ob!.id}, ${row.bonus}, ${row.bonus}, ${row.expiresAt}, ${at})`;
        }
      }
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'opening_imported',
        targetType: 'opening_import',
        targetId: imp!.id,
        detail: {
          docNo: importNo,
          source: input.source,
          fileName: input.fileName,
          rows: planned.length,
          createdMembers: createdCount,
          principal: totals.principal,
          bonus: totals.bonus,
          summary: `${input.source} 期初 ${planned.length} 位会员（新建 ${createdCount}），本金 ${formatYuan(totals.principal)}，赠金 ${formatYuan(totals.bonus)}`,
          ...(control.check ? { control: control.check.expected, excluded: control.check.excluded } : {}),
          ...(options.via ? { via: options.via } : {}),
        },
        ip: ctx.ip,
        businessDate,
      });
      return { id: imp!.id, replayed: false };
    });
    return reportOfImport(deps.sql, run.id, run.replayed);
  } catch (error) {
    // 同一编号并发提交：后到的一笔在咨询锁后会看到第一笔的结果；这里只兜底唯一约束
    if (isUniqueViolation(error, 'opening_imports_client_key_key')) {
      const prevId = await replayOf(deps.sql);
      if (prevId) return reportOfImport(deps.sql, prevId, true);
    }
    if (isUniqueViolation(error, 'members_phone_key')) {
      throw conflict('PHONE_EXISTS', '导入期间有会员刚刚建档，手机号与文件里的重复，整批未导入；请重新预览后再导入');
    }
    if (isUniqueViolation(error, 'opening_balances_member_uq')) {
      throw conflict('OPENING_EXISTS', '文件里有会员刚刚已导入期初，整批未导入；请重新预览后再导入');
    }
    throw error;
  }
}

// ───────────────────────── 作废 ─────────────────────────

interface VoidTarget {
  id: number;
  memberId: number;
  docNo: string;
  principal: number;
  bonus: number;
  status: 'active' | 'voided';
  memberName: string;
}

/**
 * 作废期初明细（调用方已按 id 升序锁住这些明细）：逐位核对「期初之后没有其他余额变动」，
 * 记一条期初作废流水把余额减回去，期初赠金批次清零。任一位不满足整笔不作废。
 */
async function voidRows(tx: Tx, deps: Deps, targets: VoidTarget[], reason: string, ctx: OpContext, at: Date) {
  const settings = await loadSettings(tx);
  const businessDate = businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
  const memberIds = [...new Set(targets.map((t) => t.memberId))].sort((a, b) => a - b);
  if (memberIds.length) await tx`SELECT id FROM members WHERE id IN ${tx(memberIds)} ORDER BY id FOR UPDATE`;

  const withBalance = targets.filter((t) => t.principal + t.bonus > 0);
  const blocked = withBalance.length
    ? await tx<{ id: number; memberName: string; docNo: string }[]>`
        SELECT b.id, m.name AS member_name, b.doc_no FROM opening_balances b
        JOIN members m ON m.id = b.member_id
        JOIN ledger_entries o ON o.opening_id = b.id AND o.entry_type = 'opening'
        WHERE b.id IN ${tx(withBalance.map((t) => t.id))}
          AND EXISTS (SELECT 1 FROM ledger_entries l WHERE l.member_id = b.member_id AND l.id > o.id)
        ORDER BY b.id`
    : [];
  if (blocked.length) {
    throw conflict(
      'OPENING_IN_USE',
      `${blocked.map((b) => `「${b.memberName}」`).slice(0, 5).join('、')}${blocked.length > 5 ? ` 等 ${blocked.length} 位会员` : ''}在期初之后已有消费、充值或赠金过期等余额变动，不能作废期初；请改为按实际情况办理后续业务`,
      { blocked },
    );
  }
  for (const t of targets) {
    if (t.principal + t.bonus > 0) {
      const member = await lockMember(tx, t.memberId);
      await applyBalance(tx, member, { principal: -t.principal, bonus: -t.bonus }, {
        entryType: 'opening_void', docNo: t.docNo, openingId: t.id, businessDate, operatorId: ctx.actor.id, at,
      });
      if (t.bonus > 0) {
        const [lot] = await tx<{ id: number; remaining: number }[]>`SELECT id, remaining FROM bonus_lots WHERE opening_id = ${t.id} FOR UPDATE`;
        // 期初之后没有余额变动，批次一定原封未动
        if (!lot || lot.remaining !== t.bonus) throw conflict('OPENING_IN_USE', `会员「${t.memberName}」的期初赠金已被使用，不能作废`);
        await tx`UPDATE bonus_lots SET remaining = 0 WHERE id = ${lot.id}`;
        await tx`INSERT INTO bonus_lot_moves (lot_id, kind, amount, opening_id, created_at) VALUES (${lot.id}, 'void', ${-lot.remaining}, ${t.id}, ${at})`;
      }
    }
    await tx`
      UPDATE opening_balances SET status = 'voided', voided_at = ${at}, voided_by = ${ctx.actor.id}, void_reason = ${reason},
                                  void_business_date = ${businessDate}
      WHERE id = ${t.id}`;
  }
  return businessDate;
}

async function lockTargets(tx: Tx, where: { importId: number } | { balanceId: number }): Promise<VoidTarget[]> {
  return 'importId' in where
    ? tx<VoidTarget[]>`
        SELECT b.id, b.member_id, b.doc_no, b.principal, b.bonus, b.status, m.name AS member_name
        FROM opening_balances b JOIN members m ON m.id = b.member_id
        WHERE b.import_id = ${where.importId} ORDER BY b.id FOR UPDATE OF b`
    : tx<VoidTarget[]>`
        SELECT b.id, b.member_id, b.doc_no, b.principal, b.bonus, b.status, m.name AS member_name
        FROM opening_balances b JOIN members m ON m.id = b.member_id
        WHERE b.id = ${where.balanceId} FOR UPDATE OF b`;
}

/** 作废一位会员的期初 */
export async function voidOpeningBalance(deps: Deps, balanceId: number, raw: OpeningVoidInputData, ctx: OpContext): Promise<OpeningBalanceRow> {
  const { reason } = parse(VoidInput, raw);
  const at = ctx.at ?? new Date();
  const importId = await deps.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '10s'");
    await tx`SELECT pg_advisory_xact_lock(hashtext('opening_import'))`;
    const [target] = await lockTargets(tx, { balanceId });
    if (!target) throw notFound('期初明细不存在');
    if (target.status === 'voided') throw conflict('ALREADY_VOIDED', `期初 ${target.docNo} 已作废，不会重复扣回`);
    const businessDate = await voidRows(tx, deps, [target], reason, ctx, at);
    const [row] = await tx<{ importId: number }[]>`SELECT import_id FROM opening_balances WHERE id = ${balanceId}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'opening_voided',
      targetType: 'member',
      targetId: target.memberId,
      detail: { docNo: target.docNo, memberName: target.memberName, principal: target.principal, bonus: target.bonus, reason },
      ip: ctx.ip,
      businessDate,
    });
    return row!.importId;
  });
  const detail = await getOpeningImport(deps.sql, importId);
  return detail.rows.find((r) => r.id === balanceId)!;
}

/** 整批作废：批内仍有效的期初逐位作废；任一位不满足条件整批不作废 */
export async function voidOpeningImport(deps: Deps, importId: number, raw: OpeningVoidInputData, ctx: OpContext): Promise<OpeningImportDetail> {
  const { reason } = parse(VoidInput, raw);
  const at = ctx.at ?? new Date();
  await deps.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '10s'");
    await tx`SELECT pg_advisory_xact_lock(hashtext('opening_import'))`;
    const [imp] = await tx<{ importNo: string }[]>`SELECT import_no FROM opening_imports WHERE id = ${importId}`;
    if (!imp) throw notFound('期初导入记录不存在');
    const targets = (await lockTargets(tx, { importId })).filter((t) => t.status === 'active');
    if (targets.length === 0) throw conflict('ALREADY_VOIDED', `批次 ${imp.importNo} 的期初都已作废`);
    const businessDate = await voidRows(tx, deps, targets, reason, ctx, at);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'opening_voided',
      targetType: 'opening_import',
      targetId: importId,
      detail: {
        docNo: imp.importNo,
        rows: targets.length,
        principal: targets.reduce((s, t) => s + t.principal, 0),
        bonus: targets.reduce((s, t) => s + t.bonus, 0),
        reason,
      },
      ip: ctx.ip,
      businessDate,
    });
  });
  return getOpeningImport(deps.sql, importId);
}

// ───────────────────────── 查询 ─────────────────────────

const SUMMARY_COLUMNS = (db: Db) => db`
  i.id, i.import_no, i.source, i.file_name, i.note, i.row_count, i.created_count, i.principal_total, i.bonus_total,
  i.business_date, s.display_name AS imported_by_name, i.created_at,
  (SELECT count(*) FROM opening_balances b WHERE b.import_id = i.id AND b.status = 'active')::int AS active_count,
  (SELECT count(*) FROM opening_balances b WHERE b.import_id = i.id AND b.status = 'voided')::int AS voided_count`;

export async function listOpeningImports(db: Db): Promise<OpeningImportSummary[]> {
  return db<OpeningImportSummary[]>`
    SELECT ${SUMMARY_COLUMNS(db)} FROM opening_imports i JOIN staff s ON s.id = i.imported_by ORDER BY i.id DESC`;
}

export async function getOpeningImport(db: Db, importId: number): Promise<OpeningImportDetail> {
  const [summary] = await db<OpeningImportSummary[]>`
    SELECT ${SUMMARY_COLUMNS(db)} FROM opening_imports i JOIN staff s ON s.id = i.imported_by WHERE i.id = ${importId}`;
  if (!summary) throw notFound('期初导入记录不存在');
  const rows = await db<OpeningBalanceRow[]>`
    SELECT b.id, b.line_no, b.doc_no, b.member_id, m.member_no, m.name AS member_name, m.phone AS member_phone, b.legacy_no,
           b.principal, b.bonus, b.bonus_expires_at, b.legacy_recharged, b.member_created, b.status, b.voided_at,
           v.display_name AS voided_by_name, b.void_reason, b.source_row,
           coalesce((
             SELECT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.member_id = b.member_id AND l.id > o.id)
             FROM ledger_entries o WHERE o.opening_id = b.id AND o.entry_type = 'opening'), false) AS later_activity
    FROM opening_balances b JOIN members m ON m.id = b.member_id LEFT JOIN staff v ON v.id = b.voided_by
    WHERE b.import_id = ${importId} ORDER BY b.line_no`;
  return { ...summary, rows };
}

/** 按操作编号查回导入结果（页面超时后核对是否已导入；只读） */
export async function findOpeningImportByKey(db: Db, clientKey: string): Promise<OpeningImportReport | null> {
  const [row] = await db<{ id: number }[]>`SELECT id FROM opening_imports WHERE client_key = ${clientKey}`;
  return row ? reportOfImport(db, row.id, true) : null;
}

// ───────────────────────── 路由 ─────────────────────────

export function registerOpeningRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const ctxOf = (req: import('fastify').FastifyRequest): OpContext => ({ actor: req.actor, ip: req.ip });
  // 文件内容随请求提交（最多 OPENING_MAX_ROWS 行）
  const bodyLimit = 4 * 1024 * 1024;

  app.post('/api/opening-imports/preview', { preHandler: guard('wallet.opening'), bodyLimit }, async (req) =>
    previewOpeningImport(deps, req.body as OpeningPreviewInputData),
  );

  app.post('/api/opening-imports', { preHandler: guard('wallet.opening'), bodyLimit }, async (req) =>
    applyOpeningImport(deps, req.body as OpeningApplyInputData, ctxOf(req)),
  );

  app.get('/api/opening-imports', { preHandler: guard('wallet.opening') }, async () => listOpeningImports(sql));

  app.get('/api/opening-imports/by-key/:key', { preHandler: guard('wallet.opening') }, async (req) => {
    const { key } = parse(z.object({ key: z.uuid('操作编号格式不正确') }), req.params);
    const report = await findOpeningImportByKey(sql, key);
    return { found: !!report, report };
  });

  app.get('/api/opening-imports/:id', { preHandler: guard('wallet.opening') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getOpeningImport(sql, id);
  });

  app.post('/api/opening-imports/:id/void', { preHandler: guard('wallet.opening') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidOpeningImport(deps, id, req.body as OpeningVoidInputData, ctxOf(req));
  });

  app.post('/api/opening-balances/:id/void', { preHandler: guard('wallet.opening') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidOpeningBalance(deps, id, req.body as OpeningVoidInputData, ctxOf(req));
  });
}
